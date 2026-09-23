// The project bit depth → the precision of every float intermediate (D3).
//
// After Effects' Project Settings ▸ Color ▸ Depth is 8, 16 or 32 bits per
// channel, per project; the render graph maps it onto the precision of every
// target the graph declares float (scene-color, layer, blur ping-pongs,
// precomps, DOF, generators…). Coverage buffers (mattes, SSAO) stay 8-bit.
//
//   32  rgba32float — scene-referred values far above 1.0 and sub-1e-4 steps
//       survive every pass; MSAA is off (RenderGraph.resolveTargets: an
//       rgba32float target is never multisampled). Needs the device to FILTER
//       and BLEND rgba32float (float32-filterable + float32-blendable); a
//       device without both renders the frame at 16.
//   16  rgba16float — today's default and the golden gate's precision.
//    8  rgba8unorm — the TS renderer's no-float tier (a backend without
//       float16 render targets): linear light in 8 bits, so darks band.
//       Chosen for bit depth 8, or whenever the producer had no float16.
//
// GPU-free on purpose: the selection rule is unit-tested without a device.
#pragma once

#include <cstdint>

namespace premation::rg {

enum class IntermediatePrecision : std::uint8_t { unorm8, float16, float32 };

struct BitDepthInputs {
  std::uint32_t bitDepth = 16;   // RenderView.bitDepth (the project's)
  bool float16Textures = true;   // RenderView.float16Textures (producer capability)
  bool float32Textures = false;  // RenderView.float32Textures (producer capability)
  bool deviceFloat32 = false;    // this device filters AND blends rgba32float
};

/// colorPipeline.ts `intermediateFloatFormat`, plus the 8-bit project depth and
/// the blendable requirement the TS path does not check.
constexpr IntermediatePrecision select_intermediate(const BitDepthInputs& in) noexcept {
  if (in.bitDepth == 8 || !in.float16Textures) return IntermediatePrecision::unorm8;
  if (in.bitDepth == 32 && in.float32Textures && in.deviceFloat32) return IntermediatePrecision::float32;
  return IntermediatePrecision::float16;
}

constexpr std::uint32_t bits_of(IntermediatePrecision p) noexcept {
  switch (p) {
    case IntermediatePrecision::unorm8: return 8;
    case IntermediatePrecision::float32: return 32;
    default: return 16;
  }
}

}  // namespace premation::rg
