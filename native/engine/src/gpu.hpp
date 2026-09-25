// Dawn instance / adapter / device for the engine.
#pragma once

#include <webgpu/webgpu_cpp.h>

#include <atomic>
#include <memory>
#include <optional>
#include <string>

namespace premation {

struct Gpu {
  wgpu::Instance instance;
  wgpu::Adapter adapter;
  wgpu::Device device;
  wgpu::Queue queue;
  std::string adapterName;
  std::string backend;
  bool sharedTextureCapable = false;  // DXGI shared-handle import + fences
  /// Float32Filterable + Float32Blendable on (the render graph's float32 working space).
  bool float32 = false;
  /// Set (from any thread) once the device is lost for a reason other than its
  /// own destruction: driver reset, TDR, GPU removed. shared_ptr: Dawn's
  /// device-lost callback holds the other reference, and may run after this
  /// struct is gone (anything still holding the device keeps it alive).
  std::shared_ptr<std::atomic<bool>> lost = std::make_shared<std::atomic<bool>>(false);
  [[nodiscard]] bool device_lost() const noexcept { return lost->load(); }
};

// D3D12 on Windows, Metal on macOS, Vulkan on Linux. `wantSharedTexture`
// requests the DXGI shared-handle features route C needs (Windows only).
// `highPerformance`: the discrete GPU on a hybrid laptop. Routes B and C must
// use the SAME adapter as Chromium's GPU process: the host passes Chromium's
// active PCI `vendorId` (app.getGPUInfo), which wins over the power preference.
std::optional<Gpu> create_gpu(bool wantSharedTexture, bool highPerformance, std::uint32_t vendorId = 0);

// Block until everything submitted so far has finished on the GPU.
void wait_idle(const Gpu& gpu);

}  // namespace premation
