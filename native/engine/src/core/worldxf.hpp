// Layer space at a time — src/core/scene/layerSpace.ts `world2DAt` /
// `localTransformAt` over the document: each node's local transform with its
// ANIMATED values winning (keyframes and expressions, sampled on the node's
// keyframe axis), composed up the parent chain (worldTransform.ts
// `worldMatrixOf`, motion_transform's `local_matrix`).
#pragma once

#include <optional>
#include <string_view>
#include <variant>

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

/// What the layer-space functions read (a const document: the expression host holds one).
struct SpaceCtx {
  const Document& d;
  const EditorView& view;
  const ExprEnv& expr;
  ExprCache& cache;
};

/// layerSpace.ts `layerSpaceAt(node, seconds, {width, height})`: a 2D layer's affine
/// space, or a 3D layer's / camera's / light's 4x4 seen through the active camera
/// (`readSceneCamera` over the whole scene, as the editor's expression provider
/// asks); nullopt when the node is gone or a 3D node has no geometry.
using LayerSpace = std::variant<motion::xf::LayerSpace2D, motion::xf::LayerSpace3D>;
/// layerSpace.ts `world3DAt(node, seconds, {width, height})`: a 3D layer's /
/// camera's / light's layer → world 4x4 (what layer_space_at converts through);
/// nullopt for a 2D layer, a missing node or a 3D node with no geometry.
[[nodiscard]] std::optional<motion::xf::Mat4> world_3d_at(const SpaceCtx& c, std::string_view node, double seconds,
                                                          double compWidth, double compHeight);
[[nodiscard]] std::optional<LayerSpace> layer_space_at(const SpaceCtx& c, std::string_view node, double seconds,
                                                       double compWidth, double compHeight);

// B4 round 5 — the view half of the overlay push (overlay_geometry.cpp) reads the same resolvers.
/// nodeMatrix.ts `resolveNode3DTransform(node, seconds)`: the node's 3D transform, animated values winning
/// (nullopt for a kind with no geometry). B4 round 8: the IK solver's joint locals.
[[nodiscard]] std::optional<motion::xf::Node3DTransform> local_3d_at(const SpaceCtx& c, const Node& n, double seconds);
/// liveWorld3d.ts `parentWorldMatrixAt(node, seconds)`: nullopt without a parent.
[[nodiscard]] std::optional<motion::xf::Mat4> parent_world_at(const SpaceCtx& c, std::string_view node, double seconds);
/// liveWorld3d.ts `toWorldPointAt(node, seconds, p)`: a point in the node's parent space → world.
[[nodiscard]] motion::xf::Vec3 world_point_at(const SpaceCtx& c, std::string_view node, double seconds, motion::xf::Vec3 p);
/// liveWorld3d.ts `nodeWorldWithParents3d(node, seconds)`.
[[nodiscard]] std::optional<motion::xf::Mat4> node_world_3d_at(const SpaceCtx& c, const Node& n, double seconds);
/// camera3d.ts `cameraFromNode(node, w, h, sample, toWorldPointAt)` at comp `seconds` (animated values winning).
[[nodiscard]] motion::xf::Camera camera_at(const SpaceCtx& c, const Node& n, double w, double h, double seconds);

}  // namespace premation::doc
