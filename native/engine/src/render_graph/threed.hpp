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

/// AE parity 4.4: the environment as the comp's backdrop (a visible sky), drawn
/// into `out` before the first layer. A no-op without a perspective 3D camera or
/// an environment that asks for it.
void render_sky(PassContext& ctx, std::string_view out, const TexFor& texFor);

/// E8: the viewport's ground grid (scene.groundGrid) when no 3D run of the
/// frame drew it — over `out`, against a fresh depth. Clears `groundGridPending`.
void render_ground_grid(PassContext& ctx, std::string_view out);

/// SDK 1.4 (D3): plugin materials. A source is refused before linking when it declares bindings,
/// entry points or directives (`plugin_material_refusal`: why, "" = fine); one that fails to compile
/// is drawn with the standard material and remembered by hash, so the next frame build reports it on
/// layerErrors (`plugin_material_error`).
[[nodiscard]] std::string plugin_material_refusal(std::string_view wgsl);
[[nodiscard]] std::uint64_t plugin_material_hash(std::string_view wgsl) noexcept;
[[nodiscard]] std::optional<std::string> plugin_material_error(std::uint64_t hash);
void note_plugin_material_error(std::uint64_t hash, std::string message);
/// The full module a plugin material links into (the solid mesh shader with its `fs` replaced).
[[nodiscard]] std::string plugin_material_wgsl(std::string_view solidWgsl, std::string_view pluginWgsl);

/// Whether the 3D path can render this frame's 3D features (shadow maps, SSAO,
/// camera DOF gather are not ported yet). Appends reasons.
void unported_3d(const api::RenderFrameFile& f, std::vector<std::string>& reasons);

}  // namespace premation::rg
