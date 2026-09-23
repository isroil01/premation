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
[[nodiscard]] std::optional<LayerSpace> layer_space_at(const SpaceCtx& c, std::string_view node, double seconds,
                                                       double compWidth, double compHeight);

}  // namespace premation::doc
