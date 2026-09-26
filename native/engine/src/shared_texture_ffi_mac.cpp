// Route C on macOS: the shared-texture ring over IOSurfaces (shared_texture_ffi.hpp).
//
// Each slot is an IOSurface ('RGBA', 4 bytes per pixel — what Electron's
// sharedTexture maps `pixelFormat: 'rgba'` to, and what Dawn imports as
// RGBA8Unorm), imported into the Dawn (Metal) device as SharedTextureMemory
// through SharedTextureMemoryIOSurfaceDescriptor. Access is bracketed by
// BeginAccess/EndAccess; the MTLSharedEvent fences an EndAccess exports are
// handed to the same slot's next BeginAccess, so the GPU orders successive
// writes to one surface without a CPU round trip. As on Windows, Chromium
// takes no fence for `rgba`, so the render thread still waits for its queue
// before it announces a slot (docs/VIEWPORT_ROUTE.md, implication 6).
//
// Cross-process naming: Electron main needs an IOSurfaceRef local to ITS
// process (`handle: { ioSurface: <Buffer holding the pointer> }`). The engine
// announces each surface's IOSurfaceID and main resolves it with
// IOSurfaceLookup (electron/ioSurfaceBridge.ts → native/engine/host_bridge).
// IOSurfaceLookup only finds surfaces created with kIOSurfaceIsGlobal, which
// Apple deprecated in 10.11 in favour of mach-port transfer but still honours
// for unsandboxed processes. The trade-off (any process of the same user that
// guesses an id can read a viewport frame) is recorded in docs/VIEWPORT_ROUTE.md;
// moving to IOSurfaceCreateMachPort needs a mach rendezvous with main and
// changes only this file and the host bridge.
//
// Plain C++ over the IOSurface / CoreFoundation C APIs: no Objective-C is
// needed (the MTLSharedEvent fences stay inside Dawn as wgpu::SharedFence).
#include "shared_texture_ffi.hpp"

#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurfaceRef.h>

#include <cstddef>
#include <cstdint>
#include <type_traits>
#include <utility>

namespace premation::shared {
namespace {

struct CfReleaser {
  void operator()(CFTypeRef ref) const noexcept {
    if (ref != nullptr) CFRelease(ref);
  }
};
using UniqueSurface = std::unique_ptr<std::remove_pointer_t<IOSurfaceRef>, CfReleaser>;
using UniqueDictionary = std::unique_ptr<std::remove_pointer_t<CFMutableDictionaryRef>, CfReleaser>;

/// kCVPixelFormatType_32RGBA ('RGBA') without linking CoreVideo.
constexpr std::uint32_t kPixelFormatRGBA = (std::uint32_t{'R'} << 24U) | (std::uint32_t{'G'} << 16U) |
                                           (std::uint32_t{'B'} << 8U) | std::uint32_t{'A'};
constexpr std::size_t kBytesPerPixel = 4;

void put_number(CFMutableDictionaryRef dict, CFStringRef key, std::int64_t value) {
  CFNumberRef n = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt64Type, &value);
  if (n == nullptr) return;
  CFDictionarySetValue(dict, key, n);
  CFRelease(n);
}

UniqueSurface create_surface(std::uint32_t width, std::uint32_t height) {
  UniqueDictionary props(CFDictionaryCreateMutable(kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
                                                   &kCFTypeDictionaryValueCallBacks));
  if (!props) return nullptr;
  const std::size_t rowBytes = IOSurfaceAlignProperty(kIOSurfaceBytesPerRow, std::size_t{width} * kBytesPerPixel);
  const std::size_t allocBytes = IOSurfaceAlignProperty(kIOSurfaceAllocSize, rowBytes * std::size_t{height});
  put_number(props.get(), kIOSurfaceWidth, std::int64_t{width});
  put_number(props.get(), kIOSurfaceHeight, std::int64_t{height});
  put_number(props.get(), kIOSurfaceBytesPerElement, static_cast<std::int64_t>(kBytesPerPixel));
  put_number(props.get(), kIOSurfaceBytesPerRow, static_cast<std::int64_t>(rowBytes));
  put_number(props.get(), kIOSurfaceAllocSize, static_cast<std::int64_t>(allocBytes));
  put_number(props.get(), kIOSurfacePixelFormat, std::int64_t{kPixelFormatRGBA});
  // Deprecated, still honoured: without it IOSurfaceLookup in Electron main
  // cannot resolve the id (see the header comment of this file).
#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
#endif
  CFDictionarySetValue(props.get(), kIOSurfaceIsGlobal, kCFBooleanTrue);
#if defined(__clang__)
#pragma clang diagnostic pop
#endif
  return UniqueSurface(IOSurfaceCreate(props.get()));
}

}  // namespace

struct SharedTexturePool::Native {
  std::vector<UniqueSurface> surfaces;
  /// Per slot: the fences the last EndAccess exported (waited on by the next BeginAccess).
  std::vector<std::vector<wgpu::SharedFence>> fences;
  std::vector<std::vector<std::uint64_t>> signaledValues;
};

SharedTexturePool::SharedTexturePool() = default;
SharedTexturePool::~SharedTexturePool() = default;

bool SharedTexturePool::init(const Gpu& gpu, std::uint32_t width, std::uint32_t height, std::uint32_t count,
                             std::uint32_t /*targetPid*/, std::string& error) {
  if (!gpu.sharedTextureCapable) {
    error = "Dawn device lacks SharedTextureMemoryIOSurface + SharedFenceMTLSharedEvent";
    return false;
  }
  if (width == 0 || height == 0) {
    error = "empty shared texture size";
    return false;
  }
  native_ = std::make_unique<Native>();
  native_->fences.resize(count);
  native_->signaledValues.resize(count);

  for (std::uint32_t i = 0; i < count; ++i) {
    UniqueSurface surface = create_surface(width, height);
    if (!surface) {
      error = "IOSurfaceCreate failed";
      return false;
    }
    wgpu::SharedTextureMemoryIOSurfaceDescriptor ios{};
    ios.ioSurface = surface.get();
    ios.allowStorageBinding = false;  // render attachment + copies only
    wgpu::SharedTextureMemoryDescriptor md{};
    md.nextInChain = &ios;
    Slot slot;
    slot.memory = gpu.device.ImportSharedTextureMemory(&md);
    if (slot.memory == nullptr) {
      error = "ImportSharedTextureMemory(IOSurface) failed";
      return false;
    }
    wgpu::TextureDescriptor desc{};
    desc.size = {width, height, 1};
    desc.format = wgpu::TextureFormat::RGBA8Unorm;
    // D4: copies in (a frame-cache hit) and out (a drawn frame kept) where the
    // imported memory allows them; without them the cache simply never hits.
    wgpu::SharedTextureMemoryProperties props{};
    slot.memory.GetProperties(&props);
    const wgpu::TextureUsage copies = wgpu::TextureUsage::CopySrc | wgpu::TextureUsage::CopyDst;
    desc.usage = wgpu::TextureUsage::RenderAttachment | (props.usage & copies);
    slot.copyable = (props.usage & copies) == copies;
    slot.texture = slot.memory.CreateTexture(&desc);
    if (slot.texture == nullptr) {
      error = "SharedTextureMemory::CreateTexture(IOSurface) failed";
      return false;
    }
    slot.view = slot.texture.CreateView();
    slot.remoteHandle = std::uint64_t{IOSurfaceGetID(surface.get())};
    native_->surfaces.push_back(std::move(surface));
    slots_.push_back(std::move(slot));
  }
  return true;
}

void SharedTexturePool::close_remote_handles() {
  // An IOSurfaceID is not a handle: nothing in the host to close. The host's
  // IOSurfaceLookup references are its own (dropped when the ring is replaced).
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
  // Consumed: the next EndAccess exports the fences that follow this access.
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
  // Kept for this slot's next BeginAccess. Chromium is not given them
  // (Electron's rgba import has no fence input); the caller CPU-waits instead.
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
