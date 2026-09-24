// The rig block over the engine's own document (buildSnapshot's
// `layer.deformedMesh`): rig_mesh.cpp's port fed by the document's animation
// — the one entry point snapshot_build and the cross-engine rig parity test
// (tests/test_rig_parity.cpp) share, so what the test pins is what renders.
// GPU-free (engine_scene_core).
#pragma once

#include <string_view>

#include "anim.hpp"
#include "rig_mesh.hpp"

namespace premation::scene {

/// `build_rig_mesh` for node `node`, sampling its pin / bone / IK tracks from
/// `d` (AnimationEngine.sample / sampleData over the document).
[[nodiscard]] RigResult build_rig_mesh_for(const doc::Document& d, const doc::ExprEnv& env, doc::ExprCache& cache,
                                           std::string_view node, const RigInputs& in);

}  // namespace premation::scene
