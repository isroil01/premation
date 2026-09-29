// getLayerFaces (B4 round 8) — face picking's geometry, the C++ twin of
// src/core/scene/facePicking.ts `projectedFaces` before its projection: an
// extruded 3D layer's faces in WORLD px. The renderer's own extrusion mesh
// (extrusion_mesh.hpp, the layer's outline — traced text included — at its
// static depth / bevel / bevel style, the front cap requested so a click beside
// a glyph misses), one face per triangle carrying its vertex indices; else the
// flat quads of extrusion_faces.hpp (the renderer's fallback) and the front cap
// inset by the clamped bevel. The UI projects them through the view it shows.
#pragma once

#include <string_view>

#include "engine_api.hpp"
#include "model.hpp"
#include "scene_types.hpp"

namespace premation::raster {
struct CanvasOptions;
}

namespace premation::scene {

/// The faces of `layer` in `snap` (the snapshot of its composition at the time);
/// empty when it is not a 3D layer with an extrusion.
[[nodiscard]] api::LayerFaces layer_faces_of(const Snapshot& snap, const doc::Node& node, std::string_view layer,
                                             const raster::CanvasOptions* canvas);

}  // namespace premation::scene
