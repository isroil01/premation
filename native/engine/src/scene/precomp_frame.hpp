// The frame side of composition instances (D2w time / comp): snapshotToFrameScene's
// `precompCamera3d` (a sealed comp's own 3D scope, its projection lifted onto the
// instance placement). The 3D comp card's homography is corner_pin.hpp's
// `square_to_quad`.
#pragma once

#include "corner_pin.hpp"
#include "engine_api.hpp"
#include "scene_math.hpp"
#include "scene_types.hpp"

namespace premation::scene {

/// `precomp: { renderables, ...precompCamera3d(own, childParent), flat }` without
/// the renderables: the inner camera (projection lifted by `placement`), lights
/// and environment when `own` is set, the flat card size when `card`.
[[nodiscard]] api::RenderPrecompFrame precomp_frame(const RLayer& l, const Mat3& placement, bool card);

}  // namespace premation::scene
