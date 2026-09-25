// Live Merge Paths for the scene builder (D2w) — src/core/scene/mergePaths.ts:
// readLiveBoolean, nodeWorldOutline / nodeWorldPolygon (the operand's outline in
// world px: animated path, Geometry points or the primitive, then its world
// transform), booleanPolygons over polygon_clipping.cpp, and evaluateLiveBoolean
// (the rings recentred onto the result layer, holes as subpaths).
#pragma once

#include <functional>
#include <optional>
#include <string>

#include "model.hpp"
#include "readers.hpp"
#include "scene_types.hpp"
#include "transform.hpp"

namespace premation::scene {

/// What evaluateLiveBoolean reads about one operand (buildSnapshot's resolvers).
struct OperandReader {
  /// `graph.getNode(id)` (the document's own node).
  std::function<const doc::Node*(const std::string&)> node;
  /// `worldTransformOf(id, …)` (the operand's world pose).
  std::function<motion::xf::Local2D(const std::string&)> world;
  /// `valuesOf(id)` (its animated values).
  std::function<const Values&(const std::string&)> values;
  /// `anim.sampleData(id, 'path.points', remapOf(id)(t))`, normalised (≥ 3 points), or undefined.
  std::function<Json(const std::string&)> pathPoints;
};

struct LiveBooleanResult {
  Json points;    ///< BezierPoint[] (the first ring)
  Json subpaths;  ///< Subpath[] when there is more than one ring, else undefined
  double width = 1, height = 1, cx = 0, cy = 0;
};

/// `readLiveBoolean(node) !== null`.
[[nodiscard]] bool has_live_boolean(const doc::Node& n);

/// `evaluateLiveBoolean(result, …)`; nullopt when operands are gone or the
/// boolean is empty. Throws what polygon-clipping throws.
[[nodiscard]] std::optional<LiveBooleanResult> evaluate_live_boolean(const doc::Node& result, const OperandReader& r);

}  // namespace premation::scene
