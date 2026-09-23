// OS / Dawn-native calls the media system needs (FFI only in *_ffi.cpp).
#pragma once

#include <webgpu/webgpu_cpp.h>

#include <cstdint>

namespace premation::media::platform {

/// The DXGI adapter LUID a Dawn D3D12 device runs on (0 elsewhere / unknown):
/// hardware decode must happen on the same adapter for zero-copy import.
[[nodiscard]] std::uint64_t adapter_luid(const wgpu::Device& device);

/// This process: user + kernel CPU milliseconds; working set and its peak (bytes).
struct ProcessUsage {
  double cpuMs = 0;
  std::uint64_t workingSet = 0;
  std::uint64_t peakWorkingSet = 0;
  std::uint64_t privateBytes = 0;
};
[[nodiscard]] ProcessUsage process_usage();

}  // namespace premation::media::platform
