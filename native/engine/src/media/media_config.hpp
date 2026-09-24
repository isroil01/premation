// The engine's footage-decode setup for a render device: which hardware decode
// device to open, on which adapter, and whether decoded surfaces may stay on
// the GPU. The decision and the numbers behind it are docs/NATIVE_CORE_PLAN.md
// Phase E, "E1 local results":
//
//   1. d3d11va on the render adapter (found by LUID): the decoder's slice is
//      copied GPU→GPU into a shared surface and imported into Dawn — no CPU
//      copy. On NVIDIA this IS NVDEC (the same silicon behind D3D11 Video).
//   2. else nvdec (CUDA) on the render adapter: frames are downloaded to system
//      memory and uploaded again (no CUDA↔D3D12 interop in the engine).
//   3. else software. Every hardware path also falls back per clip (refused
//      stream, mid-stream failure) — MediaSystem logs media_hw_fallback.
//
// Intra codecs (ProRes, DNxHR) have no hardware decoder on Windows GPUs and
// always decode in software, slice-threaded.
#pragma once

#include <webgpu/webgpu_cpp.h>

#include <string>

#include "media_system.hpp"

namespace premation::media {

/// A MediaConfig whose hwContext decodes on `device`'s adapter (see above).
/// `note` says what was chosen and why ("d3d11va on NVIDIA GeForce …",
/// "software: d3d11va: …; nvdec: …"). Never fails: software is the floor.
[[nodiscard]] MediaConfig media_config_for(const wgpu::Device& device, std::string& note);

}  // namespace premation::media
