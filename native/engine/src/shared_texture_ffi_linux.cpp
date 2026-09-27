// Route C on Linux: the shared-texture ring over dmabufs (shared_texture_ffi.hpp).
//
// UNVERIFIED — written on a Windows box with no Linux GPU; CI compiles it
// (native.yml `engine` on ubuntu, where libgbm-dev is installed) but nothing
// has run it. docs/VERIFY_ON_TEST_MACHINE.md "platform-plumbing" lists what
// to check. Where GBM is not found CMake leaves this file out and Linux keeps
// the route-A copy.
//
// Each slot is a GBM buffer object, ABGR8888 (bytes R, G, B, A in memory —
// what Chromium maps `pixelFormat: 'rgba'` to, and what Dawn imports as
// RGBA8Unorm), LINEAR (one plane, no modifier negotiation with Chromium: any
// importer takes linear), allocated on the DRM render node of the adapter
// Dawn opened (matched by PCI vendor through sysfs, else the first node).
// Its dmabuf fd is imported into the Dawn (Vulkan) device as
// SharedTextureMemoryDmaBuf; access is bracketed by BeginAccess/EndAccess and
// the SyncFD fences an EndAccess exports are handed to the same slot's next
// BeginAccess. As on Windows and macOS, Electron's rgba import takes no fence,
// so the render thread CPU-waits its queue before it announces a slot.
//
// Cross-process: a dmabuf fd is process-local. The engine announces its OWN fd
// numbers with each plane's stride / offset / size; Electron main (the
// engine's parent, so Yama ptrace_scope 1 allows it) duplicates each with
// pidfd_open + pidfd_getfd (Linux ≥ 5.6) through premation-host-bridge.node
// and imports `handle: { nativePixmap: { planes, modifier } }`. The engine
// keeps its fds open while the ring lives; main closes its duplicates when the
// ring is retired.
#include "shared_texture_ffi.hpp"

#include <fcntl.h>
#include <gbm.h>
#include <unistd.h>

#include <cstdint>
#include <cstdio>
#include <fstream>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace premation::shared {
namespace {

/// DRM_FORMAT_ABGR8888 ('AB24') without including drm_fourcc.h.
constexpr std::uint32_t kDrmFormatAbgr8888 = (std::uint32_t{'A'}) | (std::uint32_t{'B'} << 8U) |
                                             (std::uint32_t{'2'} << 16U) | (std::uint32_t{'4'} << 24U);
constexpr std::uint64_t kDrmFormatModLinear = 0;

/// An owned file descriptor.
class UniqueFd {
 public:
  UniqueFd() = default;
  explicit UniqueFd(int fd) noexcept : fd_(fd) {}
  UniqueFd(const UniqueFd&) = delete;
  UniqueFd& operator=(const UniqueFd&) = delete;
  UniqueFd(UniqueFd&& o) noexcept : fd_(std::exchange(o.fd_, -1)) {}
  UniqueFd& operator=(UniqueFd&& o) noexcept {
    if (this != &o) {
      reset();
      fd_ = std::exchange(o.fd_, -1);
    }
    return *this;
  }
  ~UniqueFd() { reset(); }
  void reset() noexcept {
    if (fd_ >= 0) (void)::close(fd_);
    fd_ = -1;
  }
  [[nodiscard]] int get() const noexcept { return fd_; }
  explicit operator bool() const noexcept { return fd_ >= 0; }

 private:
  int fd_ = -1;
};

struct GbmDeviceDeleter {
  void operator()(gbm_device* d) const noexcept {
    if (d != nullptr) gbm_device_destroy(d);
  }
};
struct GbmBoDeleter {
  void operator()(gbm_bo* b) const noexcept {
    if (b != nullptr) gbm_bo_destroy(b);
  }
};
using UniqueGbmDevice = std::unique_ptr<gbm_device, GbmDeviceDeleter>;
using UniqueGbmBo = std::unique_ptr<gbm_bo, GbmBoDeleter>;

/// The PCI vendor of a render node (sysfs), 0 when unknown.
std::uint32_t node_vendor(int minor) {
  std::ifstream in("/sys/class/drm/renderD" + std::to_string(minor) + "/device/vendor");
  std::string text;
  if (!(in >> text)) return 0;
  try {
    return static_cast<std::uint32_t>(std::stoul(text, nullptr, 16));
  } catch (...) {
    return 0;
  }
}

/// The render node of `vendor` (0 = any): renderD128 … renderD191.
UniqueFd open_render_node(std::uint32_t vendor) {
  UniqueFd first;
  for (int minor = 128; minor < 192; ++minor) {
    const std::string path = "/dev/dri/renderD" + std::to_string(minor);
    UniqueFd fd(::open(path.c_str(), O_RDWR | O_CLOEXEC));
    if (!fd) continue;
    if (vendor == 0 || node_vendor(minor) == vendor) return fd;
    if (!first) first = std::move(fd);
  }
  return first;
}

}  // namespace

struct SharedTexturePool::Native {
  // Destroyed in reverse: the buffers and their fds before the device and its node.
  UniqueFd node;
  UniqueGbmDevice device;
  std::vector<UniqueGbmBo> buffers;
  std::vector<UniqueFd> fds;
  std::vector<std::vector<wgpu::SharedFence>> fences;
  std::vector<std::vector<std::uint64_t>> signaledValues;
};

SharedTexturePool::SharedTexturePool() = default;
SharedTexturePool::~SharedTexturePool() = default;

bool SharedTexturePool::init(const Gpu& gpu, std::uint32_t width, std::uint32_t height, std::uint32_t count,
                             std::uint32_t /*targetPid*/, std::string& error) {
  if (!gpu.sharedTextureCapable) {
    error = "Dawn device lacks SharedTextureMemoryDmaBuf + SharedFenceSyncFD";
    return false;
  }
  if (width == 0 || height == 0) {
    error = "empty shared texture size";
    return false;
  }
  wgpu::AdapterInfo info{};
  gpu.adapter.GetInfo(&info);
  native_ = std::make_unique<Native>();
  native_->node = open_render_node(info.vendorID);
  if (!native_->node) {
    error = "no DRM render node (/dev/dri/renderD*) could be opened";
    return false;
  }
  native_->device.reset(gbm_create_device(native_->node.get()));
  if (!native_->device) {
    error = "gbm_create_device failed";
    return false;
  }
  native_->fences.resize(count);
  native_->signaledValues.resize(count);
  modifier_ = kDrmFormatModLinear;

  for (std::uint32_t i = 0; i < count; ++i) {
    UniqueGbmBo bo(gbm_bo_create(native_->device.get(), width, height, GBM_FORMAT_ABGR8888,
                                 GBM_BO_USE_RENDERING | GBM_BO_USE_LINEAR));
    if (!bo) {
      error = "gbm_bo_create(ABGR8888, linear) failed";
      return false;
    }
    UniqueFd fd(gbm_bo_get_fd(bo.get()));
    if (!fd) {
      error = "gbm_bo_get_fd failed";
      return false;
    }
    const std::uint32_t stride = gbm_bo_get_stride(bo.get());
    const std::uint32_t offset = gbm_bo_get_offset(bo.get(), 0);
    wgpu::SharedTextureMemoryDmaBufPlane plane{};
    plane.fd = fd.get();  // Dawn duplicates what it keeps; this fd stays the engine's
    plane.offset = offset;
    plane.stride = stride;
    wgpu::SharedTextureMemoryDmaBufDescriptor dmabuf{};
    dmabuf.size = {width, height, 1};
    dmabuf.drmFormat = kDrmFormatAbgr8888;
    dmabuf.drmModifier = kDrmFormatModLinear;
    dmabuf.planeCount = 1;
    dmabuf.planes = &plane;
    wgpu::SharedTextureMemoryDescriptor md{};
    md.nextInChain = &dmabuf;
    Slot slot;
    slot.memory = gpu.device.ImportSharedTextureMemory(&md);
    if (slot.memory == nullptr) {
      error = "ImportSharedTextureMemory(DmaBuf) failed";
      return false;
    }
    wgpu::SharedTextureMemoryProperties props{};
    slot.memory.GetProperties(&props);
    const wgpu::TextureUsage copies = wgpu::TextureUsage::CopySrc | wgpu::TextureUsage::CopyDst;
    wgpu::TextureDescriptor desc{};
    desc.size = {width, height, 1};
    desc.format = wgpu::TextureFormat::RGBA8Unorm;
    desc.usage = wgpu::TextureUsage::RenderAttachment | (props.usage & copies);
    slot.copyable = (props.usage & copies) == copies;
    slot.texture = slot.memory.CreateTexture(&desc);
    if (slot.texture == nullptr) {
      error = "SharedTextureMemory::CreateTexture(DmaBuf) failed";
      return false;
    }
    slot.view = slot.texture.CreateView();
    slot.remoteHandle = static_cast<std::uint64_t>(fd.get());
    slot.stride = stride;
    slot.offset = offset;
    slot.planeSize = std::uint64_t{stride} * height;
    native_->fds.push_back(std::move(fd));
    native_->buffers.push_back(std::move(bo));
    slots_.push_back(std::move(slot));
  }
  return true;
}

void SharedTexturePool::close_remote_handles() {
  // The host's duplicates are its own (it closes them when the ring is
  // retired); the engine's fds go with the pool. Only the announcement is forgotten.
  for (Slot& slot : slots_) slot.remoteHandle = 0;
}

bool SharedTexturePool::begin_access(Slot& slot) {
  if (!native_) return false;
  const auto index = static_cast<std::size_t>(&slot - slots_.data());
  if (index >= slots_.size()) return false;
  std::vector<wgpu::SharedFence>& fences = native_->fences[index];
  std::vector<std::uint64_t>& values = native_->signaledValues[index];
  wgpu::SharedTextureMemoryBeginAccessDescriptor begin{};
  begin.concurrentRead = false;
  begin.initialized = false;  // every frame clears (or copies over) the whole target
  begin.fenceCount = fences.size();
  begin.fences = fences.empty() ? nullptr : fences.data();
  begin.signaledValues = values.empty() ? nullptr : values.data();
  const bool ok = slot.memory.BeginAccess(slot.texture, &begin) == wgpu::Status::Success;
  fences.clear();
  values.clear();
  return ok;
}

bool SharedTexturePool::end_access(Slot& slot) {
  if (!native_) return false;
  const auto index = static_cast<std::size_t>(&slot - slots_.data());
  if (index >= slots_.size()) return false;
  wgpu::SharedTextureMemoryEndAccessState state{};
  if (slot.memory.EndAccess(slot.texture, &state) != wgpu::Status::Success) return false;
  std::vector<wgpu::SharedFence>& fences = native_->fences[index];
  std::vector<std::uint64_t>& values = native_->signaledValues[index];
  fences.clear();
  values.clear();
  for (std::size_t i = 0; i < state.fenceCount; ++i) {
    fences.push_back(state.fences[i]);
    values.push_back(state.signaledValues[i]);
  }
  return true;
}

}  // namespace premation::shared
