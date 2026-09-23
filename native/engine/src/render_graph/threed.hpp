// The depth-tested 3D group path — CompositionPass.render3DGroup +
// emitExtrudedMesh + resolveEffect3DTexture, and the shade tail
// (uniforms.ts packShade3D) every lit-3d material reads.
#pragma once

#include <functional>
#include <optional>
#include <span>
#include <string>
#include <string_view>

#include "effect_chain.hpp"

namespace premation::rg {

/// FrameScene.depthEligible3D.
[[nodiscard]] bool depth_eligible_3d(const api::Renderable& r) noexcept;

using TexFor = std::function<TexRef(const std::optional<std::string>&)>;

/// Render a contiguous run of depth-eligible renderables into `out` (an
/// offscreen target with a depth attachment).
void render_3d_group(PassContext& ctx, std::span<const api::Renderable* const> group, std::string_view out,
                     const ById& byId, const TexFor& texFor, MapLayerSource& maps);

/// Whether the 3D path can render this frame's 3D features (shadow maps, SSAO,
/// camera DOF gather are not ported yet). Appends reasons.
void unported_3d(const api::RenderFrameFile& f, std::vector<std::string>& reasons);

}  // namespace premation::rg
