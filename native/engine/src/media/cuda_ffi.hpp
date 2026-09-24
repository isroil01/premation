// Windows: which CUDA device (NVDEC) sits on a given DXGI adapter.
//
// ffmpeg's CUDA device context is created from a device ORDINAL ("0", "1"…),
// and CUDA's ordinals are not DXGI's adapter order. The engine renders on one
// adapter (Dawn's, by LUID) and a decoded frame must reach that adapter, so
// the NVDEC path asks the CUDA driver for each device's LUID and picks the one
// that matches. The driver (nvcuda.dll) is loaded at run time: a machine with
// no NVIDIA driver simply has no match.
#pragma once

#include <cstdint>
#include <string>

namespace premation::media::cuda {

struct DeviceMatch {
  int ordinal = -1;  // CUDA device ordinal; -1 = none
  std::string name;
};

/// The CUDA device on the adapter with `luid` (0 = ordinal 0). `ordinal` −1
/// (with `error`) when there is no CUDA driver, no device, or no device on that adapter.
[[nodiscard]] DeviceMatch device_for_luid(std::uint64_t luid, std::string& error);

}  // namespace premation::media::cuda
