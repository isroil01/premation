#include "gpu.hpp"

#include <cstdint>
#include <cstdio>
#include <string_view>
#include <vector>

namespace premation {
namespace {

std::string_view view(wgpu::StringView s) {
  if (s.data == nullptr) return {};
  return s.length == wgpu::kStrlen ? std::string_view(s.data) : std::string_view(s.data, s.length);
}

const char* backend_name(wgpu::BackendType t) {
  switch (t) {
    case wgpu::BackendType::D3D12: return "D3D12";
    case wgpu::BackendType::D3D11: return "D3D11";
    case wgpu::BackendType::Metal: return "Metal";
    case wgpu::BackendType::Vulkan: return "Vulkan";
    case wgpu::BackendType::OpenGL: return "OpenGL";
    case wgpu::BackendType::OpenGLES: return "OpenGLES";
    case wgpu::BackendType::Null: return "Null";
    default: return "unknown";
  }
}

wgpu::BackendType native_backend() {
#if defined(_WIN32)
  return wgpu::BackendType::D3D12;
#elif defined(__APPLE__)
  return wgpu::BackendType::Metal;
#else
  return wgpu::BackendType::Vulkan;
#endif
}

}  // namespace

std::optional<Gpu> create_gpu(bool wantSharedTexture, bool highPerformance, std::uint32_t vendorId) {
  Gpu gpu;

  static constexpr auto kTimedWaitAny = wgpu::InstanceFeatureName::TimedWaitAny;
  wgpu::InstanceDescriptor instanceDesc{};
  instanceDesc.requiredFeatureCount = 1;
  instanceDesc.requiredFeatures = &kTimedWaitAny;
  gpu.instance = wgpu::CreateInstance(&instanceDesc);
  if (gpu.instance == nullptr) {
    std::fprintf(stderr, "engine: wgpu::CreateInstance failed\n");
    return std::nullopt;
  }

  const auto request = [&gpu](wgpu::PowerPreference pref) {
    wgpu::Adapter found;
    wgpu::RequestAdapterOptions adapterOpts{};
    adapterOpts.backendType = native_backend();
    adapterOpts.powerPreference = pref;
    gpu.instance.WaitAny(
        gpu.instance.RequestAdapter(&adapterOpts, wgpu::CallbackMode::WaitAnyOnly,
                                    [&found](wgpu::RequestAdapterStatus status, wgpu::Adapter adapter,
                                             wgpu::StringView msg) {
                                      if (status == wgpu::RequestAdapterStatus::Success) {
                                        found = std::move(adapter);
                                      } else {
                                        std::fprintf(stderr, "engine: RequestAdapter: %.*s\n",
                                                     static_cast<int>(view(msg).size()), view(msg).data());
                                      }
                                    }),
        UINT64_MAX);
    return found;
  };
  const auto hi = wgpu::PowerPreference::HighPerformance;
  const auto lo = wgpu::PowerPreference::LowPower;
  gpu.adapter = request(highPerformance ? hi : lo);
  if (gpu.adapter == nullptr) return std::nullopt;

  wgpu::AdapterInfo info{};
  gpu.adapter.GetInfo(&info);
  if (vendorId != 0 && info.vendorID != vendorId) {
    // Chromium's GPU process is on the other adapter: shared handles and
    // cross-process presentation must stay on ONE device (route C crashes the
    // page's renderer otherwise — measured, docs/VIEWPORT_ROUTE.md).
    wgpu::Adapter other = request(highPerformance ? lo : hi);
    wgpu::AdapterInfo otherInfo{};
    if (other != nullptr) other.GetInfo(&otherInfo);
    if (other != nullptr && otherInfo.vendorID == vendorId) {
      gpu.adapter = std::move(other);
      info = std::move(otherInfo);
    } else {
      std::fprintf(stderr, "engine: no adapter with vendor 0x%04x; staying on 0x%04x\n", vendorId, info.vendorID);
    }
  }
  gpu.adapterName = std::string(view(info.device));
  gpu.backend = backend_name(info.backendType);

  std::vector<wgpu::FeatureName> features;
  if (wantSharedTexture && gpu.adapter.HasFeature(wgpu::FeatureName::SharedTextureMemoryDXGISharedHandle) &&
      gpu.adapter.HasFeature(wgpu::FeatureName::SharedFenceDXGISharedHandle)) {
    features.push_back(wgpu::FeatureName::SharedTextureMemoryDXGISharedHandle);
    features.push_back(wgpu::FeatureName::SharedFenceDXGISharedHandle);
    gpu.sharedTextureCapable = true;
  }
  // D2w: the render graph (float32 working space, rendering.ts's float32 path)
  // and E1's footage conversion (multi-planar NV12/P010 import, R16 planes) run
  // on this device when the adapter offers them; every one is optional.
  if (gpu.adapter.HasFeature(wgpu::FeatureName::Float32Filterable) &&
      gpu.adapter.HasFeature(wgpu::FeatureName::Float32Blendable)) {
    features.push_back(wgpu::FeatureName::Float32Filterable);
    features.push_back(wgpu::FeatureName::Float32Blendable);
    gpu.float32 = true;
  }
  for (const wgpu::FeatureName f : {wgpu::FeatureName::DawnMultiPlanarFormats, wgpu::FeatureName::MultiPlanarFormatP010,
                                    wgpu::FeatureName::Unorm16TextureFormats}) {
    if (gpu.adapter.HasFeature(f)) features.push_back(f);
  }

  wgpu::DeviceDescriptor deviceDesc{};
  deviceDesc.requiredFeatureCount = features.size();
  deviceDesc.requiredFeatures = features.data();
  deviceDesc.SetUncapturedErrorCallback([](const wgpu::Device&, wgpu::ErrorType type, wgpu::StringView msg) {
    std::fprintf(stderr, "engine: GPU error %d: %.*s\n", static_cast<int>(type), static_cast<int>(view(msg).size()),
                 view(msg).data());
  });
  deviceDesc.SetDeviceLostCallback(wgpu::CallbackMode::AllowSpontaneous,
                                   [lost = gpu.lost](const wgpu::Device&, wgpu::DeviceLostReason reason, wgpu::StringView msg) {
                                     if (reason == wgpu::DeviceLostReason::Destroyed) return;
                                     lost->store(true);
                                     std::fprintf(stderr, "engine: device lost (%d): %.*s\n",
                                                  static_cast<int>(reason), static_cast<int>(view(msg).size()),
                                                  view(msg).data());
                                   });
  gpu.instance.WaitAny(gpu.adapter.RequestDevice(&deviceDesc, wgpu::CallbackMode::WaitAnyOnly,
                                                 [&gpu](wgpu::RequestDeviceStatus status, wgpu::Device device,
                                                        wgpu::StringView msg) {
                                                   if (status == wgpu::RequestDeviceStatus::Success) {
                                                     gpu.device = std::move(device);
                                                   } else {
                                                     std::fprintf(stderr, "engine: RequestDevice: %.*s\n",
                                                                  static_cast<int>(view(msg).size()),
                                                                  view(msg).data());
                                                   }
                                                 }),
                       UINT64_MAX);
  if (gpu.device == nullptr) return std::nullopt;
  gpu.queue = gpu.device.GetQueue();
  return gpu;
}

void wait_idle(const Gpu& gpu) {
  gpu.instance.WaitAny(gpu.queue.OnSubmittedWorkDone(wgpu::CallbackMode::WaitAnyOnly,
                                                     [](wgpu::QueueWorkDoneStatus, wgpu::StringView) {}),
                       UINT64_MAX);
}

}  // namespace premation
