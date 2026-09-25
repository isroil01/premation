// Paint strokes in the scene builder (D2w): buildSnapshot's
// resolveLayerPaintAt — paintTime.ts resolvePaintAt / resolveStrokeAt over the
// node's stored strokes (fxstate read_node_paint), so the raster painters
// (raster/paint_raster.cpp) get the frame's strokes as `layer.paint`.
#pragma once

#include <string>
#include <vector>

#include "model.hpp"
#include "readers.hpp"
#include "scene_types.hpp"

namespace premation::scene {

struct LayerPaint {
  /// `PaintConfig` for the frame ({strokes, onTransparent?}); undefined when none is live.
  Json paint;
  /// What the port does not resolve (clone time warps), reported by the caller.
  std::vector<std::string> unported;
};

/// `resolveLayerPaintAt(node, layerT, values, …)`.
[[nodiscard]] LayerPaint resolve_layer_paint(const doc::Document& d, const doc::Node& n, double layerT, const Values& a,
                                             std::string_view animId = {});

/// paintRaster.ts `paintReach(layer.paint)` (raster/paint_raster.cpp), 0 for no paint.
[[nodiscard]] double paint_pad(const Json& paint);

}  // namespace premation::scene
