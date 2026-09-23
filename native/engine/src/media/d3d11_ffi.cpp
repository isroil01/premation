#include "d3d11_ffi.hpp"

#include <d3d11_4.h>
#include <dxgi1_6.h>
#include <windows.h>
#include <wrl/client.h>

#include <array>
#include <vector>

// COM's IID_PPV_ARGS is __uuidof, a Microsoft extension. Confined to this FFI file.
#ifdef __clang__
#pragma clang diagnostic ignored "-Wlanguage-extension-token"
#endif

namespace premation::media::d3d11 {

using Microsoft::WRL::ComPtr;

namespace {

struct HandleCloser {
  void operator()(void* h) const {
    if (h != nullptr && h != INVALID_HANDLE_VALUE) CloseHandle(h);
  }
};
using UniqueHandle = std::unique_ptr<void, HandleCloser>;

DXGI_FORMAT dxgi_of(SurfaceFormat f) {
  switch (f) {
    case SurfaceFormat::nv12: return DXGI_FORMAT_NV12;
    case SurfaceFormat::p010: return DXGI_FORMAT_P010;
    case SurfaceFormat::p016: return DXGI_FORMAT_P016;
    case SurfaceFormat::y210: return DXGI_FORMAT_Y210;
    case SurfaceFormat::y410: return DXGI_FORMAT_Y410;
    case SurfaceFormat::ayuv: return DXGI_FORMAT_AYUV;
  }
  return DXGI_FORMAT_UNKNOWN;
}

bool surface_of(DXGI_FORMAT f, SurfaceFormat& out) {
  switch (f) {
    case DXGI_FORMAT_NV12: out = SurfaceFormat::nv12; return true;
    case DXGI_FORMAT_P010: out = SurfaceFormat::p010; return true;
    case DXGI_FORMAT_P016: out = SurfaceFormat::p016; return true;
    default: return false;  // 4:2:2 / 4:4:4 hardware surfaces: Dawn has no import format for them here
  }
}

std::uint64_t luid_value(const LUID& l) {
  return (static_cast<std::uint64_t>(static_cast<std::uint32_t>(l.HighPart)) << 32U) | l.LowPart;
}

}  // namespace

/// One pooled shared texture.
struct Slot {
  ComPtr<ID3D11Texture2D> texture;
  ComPtr<IDXGIKeyedMutex> mutex;
  UniqueHandle handle;
  SurfaceInfo info;
};

/// The pool. Shared (shared_ptr) between the Device and every surface handle it
/// gave out: a frame can outlive the Device in a cache being torn down on
/// another thread, and its slot must still have somewhere to go back to.
struct Pool {
  std::mutex mu;
  std::vector<std::unique_ptr<Slot>> free;
  std::size_t alive = 0;
  std::size_t max = 1024;  // the frame cache's GPU budget is the real bound
  std::uint64_t nextId = 1;
};

namespace {

/// A GpuSurface = one borrowed pool slot; returns it on destruction.
class PooledSurface final : public GpuSurface {
 public:
  PooledSurface(std::shared_ptr<Pool> pool, std::unique_ptr<Slot> slot) : pool_(std::move(pool)), slot_(std::move(slot)) {}
  ~PooledSurface() override {
    try {
      const std::scoped_lock lock(pool_->mu);
      pool_->free.push_back(std::move(slot_));
    } catch (...) {  // NOLINT(bugprone-empty-catch): out of memory returning a slot — the slot is simply released
      const std::scoped_lock lock(pool_->mu);  // std::mutex::lock only throws on a deadlock, which can't happen here
      --pool_->alive;
    }
  }
  PooledSurface(const PooledSurface&) = delete;
  PooledSurface& operator=(const PooledSurface&) = delete;
  PooledSurface(PooledSurface&&) = delete;
  PooledSurface& operator=(PooledSurface&&) = delete;
  [[nodiscard]] const SurfaceInfo& info() const noexcept { return slot_->info; }

 private:
  std::shared_ptr<Pool> pool_;
  std::unique_ptr<Slot> slot_;
};

}  // namespace

struct Device::Impl {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  std::string adapterName;
  std::uint32_t vendorId = 0;
  std::uint64_t luid = 0;
  std::shared_ptr<Pool> pool = std::make_shared<Pool>();
};

Device::Device(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
Device::~Device() = default;

std::unique_ptr<Device> Device::create(std::uint64_t luid, std::string& error) {
  auto impl = std::make_unique<Impl>();
  ComPtr<IDXGIFactory4> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
    error = "CreateDXGIFactory1 failed";
    return nullptr;
  }
  ComPtr<IDXGIAdapter1> adapter;
  if (luid != 0) {
    LUID l{};
    l.LowPart = static_cast<DWORD>(luid & 0xFFFFFFFFULL);
    l.HighPart = static_cast<LONG>(luid >> 32U);
    if (FAILED(factory->EnumAdapterByLuid(l, IID_PPV_ARGS(&adapter)))) {
      error = "EnumAdapterByLuid failed";
      return nullptr;
    }
  } else if (FAILED(factory->EnumAdapters1(0, &adapter))) {
    error = "EnumAdapters1 failed";
    return nullptr;
  }
  DXGI_ADAPTER_DESC1 desc{};
  adapter->GetDesc1(&desc);
  impl->vendorId = desc.VendorId;
  impl->luid = luid_value(desc.AdapterLuid);
  const int n = WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, nullptr, 0, nullptr, nullptr);
  if (n > 1) {
    impl->adapterName.resize(static_cast<std::size_t>(n - 1));
    WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, impl->adapterName.data(), n, nullptr, nullptr);
  }

  const std::array<D3D_FEATURE_LEVEL, 2> levels{D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
  const UINT flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
  if (FAILED(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags, levels.data(), static_cast<UINT>(levels.size()), D3D11_SDK_VERSION,
                               &impl->device, nullptr, &impl->context))) {
    error = "D3D11CreateDevice(VIDEO_SUPPORT) failed";
    return nullptr;
  }
  // The immediate context is shared by several decode threads (all under Device::lock).
  ComPtr<ID3D10Multithread> mt;
  if (SUCCEEDED(impl->device.As(&mt))) mt->SetMultithreadProtected(TRUE);
  return std::unique_ptr<Device>(new Device(std::move(impl)));  // NOLINT(cppcoreguidelines-owning-memory): private constructor; owned at once
}

void* Device::native_device() const noexcept { return impl_->device.Get(); }
void* Device::native_context() const noexcept { return impl_->context.Get(); }
const std::string& Device::adapter_name() const noexcept { return impl_->adapterName; }
std::uint32_t Device::vendor_id() const noexcept { return impl_->vendorId; }
std::uint64_t Device::luid() const noexcept { return impl_->luid; }

void Device::set_max_surfaces(std::size_t n) noexcept {
  const std::scoped_lock lock(impl_->pool->mu);
  impl_->pool->max = n;
}

std::size_t Device::surfaces_alive() const noexcept {
  const std::scoped_lock lock(impl_->pool->mu);
  return impl_->pool->alive;
}

std::size_t Device::surface_bytes(SurfaceFormat f, std::uint32_t w, std::uint32_t h) const noexcept {
  const std::size_t px = std::size_t{w} * h;
  switch (f) {
    case SurfaceFormat::nv12: return px * 3 / 2;
    case SurfaceFormat::p010:
    case SurfaceFormat::p016: return px * 3;
    case SurfaceFormat::y210:
    case SurfaceFormat::y410:
    case SurfaceFormat::ayuv: break;
  }
  return px * 4;
}

std::unique_ptr<GpuSurface> Device::copy_slice(void* srcTexture, unsigned slice, std::uint32_t width,
                                               std::uint32_t height, std::string& error) {
  auto* src = static_cast<ID3D11Texture2D*>(srcTexture);
  D3D11_TEXTURE2D_DESC sd{};
  src->GetDesc(&sd);
  SurfaceFormat fmt{};
  if (!surface_of(sd.Format, fmt)) {
    error = "hardware surface format has no shared import route";
    return nullptr;
  }
  // Decoder surfaces are padded (e.g. 1920×1088); the shared surface is the
  // visible size rounded up to the chroma grid.
  const std::uint32_t w = (width + 1U) & ~1U;
  const std::uint32_t h = (height + 1U) & ~1U;
  Pool& pool = *impl_->pool;

  std::unique_ptr<Slot> slot;
  {
    const std::scoped_lock lock(pool.mu);
    for (auto it = pool.free.begin(); it != pool.free.end(); ++it) {
      if ((*it)->info.format == fmt && (*it)->info.width == w && (*it)->info.height == h) {
        slot = std::move(*it);
        pool.free.erase(it);
        break;
      }
    }
    if (!slot) {
      // Drop free slots of other shapes before growing (a size change on a source).
      if (pool.alive >= pool.max && !pool.free.empty()) {
        pool.free.erase(pool.free.begin());
        --pool.alive;
      }
      if (pool.alive >= pool.max) {
        error = "shared surface pool exhausted";
        return nullptr;
      }
      ++pool.alive;
    }
  }
  const std::scoped_lock deviceLock(mu_);
  if (!slot) {
    slot = std::make_unique<Slot>();
    D3D11_TEXTURE2D_DESC td{};
    td.Width = w;
    td.Height = h;
    td.MipLevels = 1;
    td.ArraySize = 1;
    td.Format = dxgi_of(fmt);
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    td.MiscFlags = static_cast<UINT>(D3D11_RESOURCE_MISC_SHARED_NTHANDLE) | static_cast<UINT>(D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX);
    auto fail = [&](const char* what) {
      error = what;
      const std::scoped_lock lock(pool.mu);
      --pool.alive;
      return nullptr;
    };
    if (FAILED(impl_->device->CreateTexture2D(&td, nullptr, &slot->texture))) return fail("CreateTexture2D(shared NV12/P010) failed");
    if (FAILED(slot->texture.As(&slot->mutex))) return fail("shared surface has no keyed mutex");
    ComPtr<IDXGIResource1> res;
    if (FAILED(slot->texture.As(&res))) return fail("IDXGIResource1 missing");
    HANDLE h0 = nullptr;
    if (FAILED(res->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &h0))) {
      return fail("CreateSharedHandle failed");
    }
    slot->handle.reset(h0);
    slot->info = {h0, 0, fmt, w, h};
    const std::scoped_lock lock(pool.mu);
    slot->info.id = pool.nextId++;
  }
  // Key 0 on both sides: waits for Dawn to finish any read of this slot.
  if (FAILED(slot->mutex->AcquireSync(0, INFINITE))) {
    error = "keyed mutex AcquireSync failed";
    const std::scoped_lock lock(pool.mu);
    pool.free.push_back(std::move(slot));
    return nullptr;
  }
  D3D11_BOX box{0, 0, 0, std::min(w, sd.Width), std::min(h, sd.Height), 1};
  impl_->context->CopySubresourceRegion(slot->texture.Get(), 0, 0, 0, 0, src, slice, &box);
  slot->mutex->ReleaseSync(0);
  return std::make_unique<PooledSurface>(impl_->pool, std::move(slot));
}

const SurfaceInfo* surface_info(const GpuSurface* s) noexcept {
  const auto* p = dynamic_cast<const PooledSurface*>(s);
  return p == nullptr ? nullptr : &p->info();
}

}  // namespace premation::media::d3d11
