// The vector painter: Canvas2DVectorRasterizer.drawPath + vectorDraw.ts
// (src/core/rendering/raster) ported call for call onto the C++ Canvas2D.
// Trim, repeaters, offset, zig-zag and the other path operators are already
// baked into the layer's resolved subpaths by the snapshot (buildSnapshot), as
// they are for the TS rasterizer: the painter draws what it is given.
#pragma once

#include <string>
#include <vector>

#include "canvas.hpp"
#include "json.hpp"

namespace premation::raster {

/// Draw a RenderLayer's shape into `ctx`, already scaled + centred (the caller
/// has applied `scale(ss, ss); translate(bw / 2, bh / 2)`). Features the port
/// does not draw are appended to `unsupported`.
void paint_path_layer(Canvas2D& ctx, const json::Value& layer, std::vector<std::string>& unsupported);

}  // namespace premation::raster
