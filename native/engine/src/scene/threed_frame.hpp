// snapshotToFrameScene's 3D half (D2w 3D): the depth-tested placement of a 3D
// layer (`threeD`: model3dFor, castsShadow, per-fragment shade vs the per-quad
// tint fold), the light-wash quad, and the frame's camera3d / lights3d / ssao
// gated on a 3D renderable existing. Ported branch by branch from
// src/core/rendering/snapshotToFrameScene.ts; frame_build.cpp calls these at
// the TypeScript's call sites.
#pragma once

#include <vector>

#include "engine_api.hpp"
#include "scene_math.hpp"
#include "scene_types.hpp"

namespace premation::scene {

/// `layerToRenderable`'s 3D tail: `threeD` (quad model or extruded mesh), then
/// castsShadow, then the Accepts-Lights routing. `parent` is the flatten parent.
void apply_three_d(const RLayer& l, const Mat3& parent, api::Renderable& r);

/// FrameScene.ts `depthEligible3D(r)`.
[[nodiscard]] bool depth_eligible_3d(const api::Renderable& r);

/// `lightToRenderable(layer, parent, parentOpacity)`.
[[nodiscard]] api::Renderable light_to_renderable(const RLayer& l, const Mat3& parent, double parentOpacity);

/// The end of `snapshotToFrameScene`: enforceExtrusionPathAgreement, has3d,
/// dropMeshesEverywhere and the scene's 3D fields. Returns has3d (it forces
/// hasEffects).
bool finish_frame_3d(const Snapshot& s, api::RenderFrameScene& sc);

}  // namespace premation::scene
