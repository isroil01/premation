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

#include <string>

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
/// Every operator is ported; `unported` (layer left untouched) is returned only
/// when Offset Paths' non-convex cleanup leaves several loops that the
/// TypeScript merges with polygon-clipping's union (Martinez), not ported.
GeometryStatus apply_path_ops(const doc::Node& n, const Values& a, double layerTime, RLayer& layer);

/// The parametric Polystar outline (buildSnapshot: "Parametric Polystar") —
/// sets `pathPoints` and the layer box (`layerW`/`layerH`) as the TypeScript does.
GeometryStatus apply_polystar(const doc::Node& n, const Values& a, Json& pathPoints, double& layerW, double& layerH);

}  // namespace premation::scene
