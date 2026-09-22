#include "shared_texture_ffi.hpp"

#include <d3d11_1.h>
#include <d3d12.h>
#include <dxgi1_6.h>
#include <windows.h>
#include <wrl/client.h>

#include <dawn/native/D3D12Backend.h>

#include <cstdio>

// COM's IID_PPV_ARGS is __uuidof, a Microsoft extension. Confined to this FFI file.
#ifdef __clang__
#pragma clang diagnostic ignored "-Wlanguage-extension-token"
#endif

namespace premation::shared {

using Microsoft::WRL::ComPtr;

namespace {

// RAII for a kernel HANDLE this process owns.
struct HandleCloser {
  void operator()(void* h) const {
    if (h != nullptr && h != INVALID_HANDLE_VALUE) CloseHandle(h);
  }
};
using UniqueHandle = std::unique_ptr<void, HandleCloser>;

}  // namespace

struct SharedTexturePool::Native {
  ComPtr<ID3D11Device> device;
  std::vector<ComPtr<ID3D11Texture2D>> textures;
  std::vector<UniqueHandle> localHandles;
  UniqueHandle targetProcess;
};

SharedTexturePool::SharedTexturePool() = default;
SharedTexturePool::~SharedTexturePool() = default;

bool SharedTexturePool::init(const Gpu& gpu, std::uint32_t width, std::uint32_t height, std::uint32_t count,
                             std::uint32_t targetPid, std::string& error) {
  if (!gpu.sharedTextureCapable) {
    error = "Dawn device lacks SharedTextureMemoryDXGISharedHandle";
    return false;
  }
  native_ = std::make_unique<Native>();

  // Same adapter as Dawn (and, on a one-GPU laptop, as Chromium's GPU process).
  const ComPtr<ID3D12Device> d3d12 = dawn::native::d3d12::GetD3D12Device(gpu.device.Get());
  if (!d3d12) {
    error = "GetD3D12Device failed";
    return false;
  }
  const LUID luid = d3d12->GetAdapterLuid();
  ComPtr<IDXGIFactory4> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
    error = "CreateDXGIFactory1 failed";
    return false;
  }
  ComPtr<IDXGIAdapter1> adapter;
  if (FAILED(factory->EnumAdapterByLuid(luid, IID_PPV_ARGS(&adapter)))) {
    error = "EnumAdapterByLuid failed";
    return false;
  }
  const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1};
  if (FAILED(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0, levels, 1, D3D11_SDK_VERSION,
                               &native_->device, nullptr, nullptr))) {
    error = "D3D11CreateDevice failed";
    return false;
  }

  native_->targetProcess.reset(OpenProcess(PROCESS_DUP_HANDLE, FALSE, targetPid));
  if (!native_->targetProcess) {
    error = "OpenProcess(PROCESS_DUP_HANDLE) on the host failed";
    return false;
  }

  for (std::uint32_t i = 0; i < count; ++i) {
    D3D11_TEXTURE2D_DESC td{};
    td.Width = width;
    td.Height = height;
    td.MipLevels = 1;
    td.ArraySize = 1;
    td.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    td.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;
    ComPtr<ID3D11Texture2D> tex;
    if (FAILED(native_->device->CreateTexture2D(&td, nullptr, &tex))) {
      error = "CreateTexture2D(shared) failed";
      return false;
    }
    ComPtr<IDXGIResource1> res;
    tex.As(&res);
    HANDLE local = nullptr;
    if (FAILED(res->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr,
                                       &local))) {
      error = "CreateSharedHandle failed";
      return false;
    }
    native_->localHandles.emplace_back(local);

    HANDLE remote = nullptr;
    if (DuplicateHandle(GetCurrentProcess(), local, native_->targetProcess.get(), &remote, 0, FALSE,
                        DUPLICATE_SAME_ACCESS) == 0) {
      error = "DuplicateHandle into the host failed";
      return false;
    }

    wgpu::SharedTextureMemoryDXGISharedHandleDescriptor dxgi{};
    dxgi.handle = local;
    dxgi.useKeyedMutex = false;
    wgpu::SharedTextureMemoryDescriptor md{};
    md.nextInChain = &dxgi;
    Slot slot;
    slot.memory = gpu.device.ImportSharedTextureMemory(&md);
    if (slot.memory == nullptr) {
      error = "ImportSharedTextureMemory failed";
      return false;
    }
    wgpu::TextureDescriptor desc{};
    desc.size = {width, height, 1};
    desc.format = wgpu::TextureFormat::RGBA8Unorm;
    desc.usage = wgpu::TextureUsage::RenderAttachment;
    slot.texture = slot.memory.CreateTexture(&desc);
    slot.view = slot.texture.CreateView();
    slot.remoteHandle = static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(remote));
    native_->textures.push_back(std::move(tex));
    slots_.push_back(std::move(slot));
  }
  return true;
}

bool SharedTexturePool::begin_access(Slot& slot) {
  wgpu::SharedTextureMemoryBeginAccessDescriptor begin{};
  begin.concurrentRead = false;
  begin.initialized = false;  // every frame clears the whole target
  begin.fenceCount = 0;
  return slot.memory.BeginAccess(slot.texture, &begin) == wgpu::Status::Success;
}

bool SharedTexturePool::end_access(Slot& slot) {
  // The fences Dawn hands back are not given to Chromium (Electron's rgba
  // import has no fence input); the caller CPU-waits for the queue instead.
  wgpu::SharedTextureMemoryEndAccessState state{};
  return slot.memory.EndAccess(slot.texture, &state) == wgpu::Status::Success;
}

}  // namespace premation::shared
