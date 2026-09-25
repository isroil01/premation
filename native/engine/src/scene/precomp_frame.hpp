// The frame side of composition instances (D2w time / comp): snapshotToFrameScene's
// `precompCamera3d` (a sealed comp's own 3D scope, its projection lifted onto the
// instance placement) and the 3D comp card's `squareToQuad` homography.
#pragma once

#include <array>
#include <optional>

#include "engine_api.hpp"
#include "scene_math.hpp"
#include "scene_types.hpp"

namespace premation::scene {

/// packages/renderer Homography.ts `squareToQuad(quad)` (TL, TR, BR, BL), float32
/// column-major; null for a degenerate quad.
[[nodiscard]] std::optional<Mat3> square_to_quad(const std::array<double, 8>& q);

/// `precomp: { renderables, ...precompCamera3d(own, childParent), flat }` without
/// the renderables: the inner camera (projection lifted by `placement`), lights
/// and environment when `own` is set, the flat card size when `card`.
[[nodiscard]] api::RenderPrecompFrame precomp_frame(const RLayer& l, const Mat3& placement, bool card);

}  // namespace premation::scene
