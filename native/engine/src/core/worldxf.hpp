// Layer space at a time — src/core/scene/layerSpace.ts `world2DAt` /
// `localTransformAt` over the document: each node's local transform with its
// ANIMATED values winning (keyframes and expressions, sampled on the node's
// keyframe axis), composed up the parent chain (worldTransform.ts
// `worldMatrixOf`, motion_transform's `local_matrix`).
#pragma once

#include <optional>
#include <string_view>

#include "props.hpp"
#include "transform.hpp"

namespace premation::doc {

/// `readGeometry`'s transform fields (last component carrying each wins), or
/// nullopt for a kind with no geometry.
[[nodiscard]] std::optional<motion::xf::Local2D> read_geometry_local(const Node& n);
/// `localTransformAt(node, seconds)` (comp seconds).
[[nodiscard]] std::optional<motion::xf::Local2D> local_transform_at(const PCtx& c, std::string_view node, double seconds);
/// `world2DAt(node, seconds)`.
[[nodiscard]] motion::xf::Mat2D world_2d_at(const PCtx& c, std::string_view node, double seconds);

}  // namespace premation::doc
