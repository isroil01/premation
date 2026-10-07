// The mask painter (E3): src/core/effects/mask.ts paintMaskMatte on the C++
// Canvas2D. The caller has applied the raster's scale and centred the origin.
#pragma once

#include <cstdint>
#include <span>
#include <string>
#include <vector>

#include "canvas.hpp"
#include "json.hpp"

namespace premation::raster {

void paint_mask_matte(Canvas2D& g, const json::Value& mask, double w, double h, std::vector<std::string>& unsupported);

/// One outline sample for variable (per-vertex) feather: pixel position and
/// the local feather DIAMETER (px) interpolated between its vertices.
struct FeatherSample {
  double x = 0;
  double y = 0;
  double f = 0;
};

/// maskFeather.ts `computeVariableFeatherAlpha`: hard coverage (one byte per
/// pixel) in, feathered alpha out. A signed 3-4 chamfer distance to the
/// outline, each edge-band pixel takes the feather of its nearest outline
/// sample, alpha = smoothstep(distance / width + ½). Pixels beyond the band
/// keep their coverage. Pure and deterministic.
[[nodiscard]] std::vector<std::uint8_t> variable_feather_alpha(std::span<const std::uint8_t> coverage, int w, int h,
                                                              std::span<const FeatherSample> samples, double maxFeather);

}  // namespace premation::raster
