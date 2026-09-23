// The mask painter (E3): src/core/effects/mask.ts paintMaskMatte on the C++
// Canvas2D. The caller has applied the raster's scale and centred the origin.
#pragma once

#include <string>
#include <vector>

#include "canvas.hpp"
#include "json.hpp"

namespace premation::raster {

void paint_mask_matte(Canvas2D& g, const json::Value& mask, double w, double h, std::vector<std::string>& unsupported);

}  // namespace premation::raster
