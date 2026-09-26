// Shape geometry the snapshot resolves per frame — the TypeScript it ports:
//
//   the path-operator chain   buildSnapshot.ts (the `layerKind === 'shape'` block
//                             after "The shape geometry chain (`fx.pathOps`)"),
//                             src/core/scene/pathOps.ts (resolvePathOps,
//                             applyPathOpChain, shapeOutline), mergePaths.ts
//                             flattenOutline, and runPaints
//   parametric polystar       src/core/scene/polystar.ts (readNodePolystar,
//                             resolvePolystar, polystarOutline)
#pragma once

#include <array>
#include <optional>
#include <string>
#include <vector>

#include "model.hpp"
#include "readers.hpp"
#include "scene_types.hpp"

namespace premation::scene {

enum class GeometryStatus : std::uint8_t {
  none,      ///< the node has no such geometry: nothing changed
  applied,   ///< ported and applied to the layer
  unported,  ///< present, outside the port: the caller reports it
};

/// buildSnapshot's `fx.pathOps` chain over a SHAPE layer that already carries
/// its primitive / pathPoints / subpaths / corner radii / strokes: rewrites
/// pathPoints / subpaths / pathOpen / primitive / corner radii / visible /
/// width / height exactly as the TypeScript does. `layerTime` is the layer's
/// own time (remapOf(id)(t)), the axis Roughen's wiggle rides.
/// Every operator is ported (Offset Paths' non-convex cleanup through
/// polygon_clipping.cpp); `unported` is kept for operators added later.

GeometryStatus apply_path_ops(const doc::Node& n, const Values& a, double layerTime, RLayer& layer);

/// pathOps.ts `shapeOutline(primitive, w, h, ellipseSteps, subdivide, radii, axisScale)` —
/// the primitive's outline in layer px (what mergePaths' nodeWorldOutline seeds from).
[[nodiscard]] std::vector<std::array<double, 2>> shape_outline_points(const std::string& primitive, double w, double h,
                                                                   double ellipseSteps, double subdivide,
                                                                   const std::optional<std::array<double, 4>>& radii,
                                                                   const std::optional<std::array<double, 2>>& axisScale);

/// The parametric Polystar outline (buildSnapshot: "Parametric Polystar") —
/// sets `pathPoints` and the layer box (`layerW`/`layerH`) as the TypeScript does.
GeometryStatus apply_polystar(const doc::Node& n, const Values& a, Json& pathPoints, double& layerW, double& layerH);

/// audioWaveformGen.ts `audioWaveformPoints`. Empty when there is nothing to draw.
[[nodiscard]] Json waveform_points(std::span<const float> peaks, double duration, double width, double height, double timeSec,
                                   std::string_view mode, double samples, double heightScale, double thickness, double windowSec);

}  // namespace premation::scene
