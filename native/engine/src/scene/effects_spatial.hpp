// The rest of `extractSpatialEffects` (src/core/rendering/snapshotToFrameScene.ts):
// every GPU effect kind beyond the eight effects_port.cpp writes itself (blur,
// glow, drop-shadow, gradient-ramp, fill, stroke, sharpen, noise), each ported
// branch for branch into its FrameScene chain entry (api::RenderEffect, the
// frameSceneExport.ts `effectToWire` encoding — see FxWriter).
#pragma once

#include <string_view>
#include <vector>

#include "engine_api.hpp"
#include "scene_types.hpp"

namespace premation::scene {

/// True when `extract_more_spatial` writes this effect type.
[[nodiscard]] bool is_more_spatial(std::string_view type);

/// Append the chain entries of one ENABLED effect `e` whose type
/// `is_more_spatial`; `params` is `paramsOf(e)` (declared defaults ← legacy
/// amount ← stored params). Returns false when the type is not handled here.
bool extract_more_spatial(const Json& e, const Json& params, const RLayer& layer, std::vector<api::RenderEffect>& out);

// The two halves (effects_spatial_a.cpp, effects_spatial_b.cpp), same contract.
[[nodiscard]] bool spatial_a_handles(std::string_view type);
bool spatial_a(const Json& e, const Json& params, const RLayer& layer, std::vector<api::RenderEffect>& out);
[[nodiscard]] bool spatial_b_handles(std::string_view type);
bool spatial_b(const Json& e, const Json& params, const RLayer& layer, std::vector<api::RenderEffect>& out);

}  // namespace premation::scene
