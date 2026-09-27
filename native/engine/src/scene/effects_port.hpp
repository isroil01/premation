// Effect stacks for the scene builder — the TypeScript it ports:
//
//   resolveEffectParams      src/core/effects/effects.ts (keyframed params, colour channel tracks, fx opacity)
//   effectColorMatrix        src/core/effects/effectColorMatrix.ts (the CSS-family grades as one 3×3 + offset)
//   layerIsBaked / effectsNeedCpuBake   src/core/effects/effectBake.ts
//   extractSpatialEffects    src/core/rendering/snapshotToFrameScene.ts (effect → FrameScene chain entry)
//
// A chain entry is written in the FrameScene wire form directly
// (api::RenderEffect, the param bag frameSceneExport.ts `effectToWire` makes):
// fields in the TypeScript object's declaration order, colours as `color`
// quadruples, booleans as `flag`, nested objects flattened to dotted names.
#pragma once

#include <array>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "engine_api.hpp"
#include "readers.hpp"
#include "scene_types.hpp"

namespace premation::scene {

/// `resolveEffectParams(effects, sample, layerTimeSec)` over migrated effects.
[[nodiscard]] std::vector<Json> resolve_effect_params(const std::vector<Json>& effects, const Values& a,
                                                      std::optional<double> layerTimeSec);

/// Why the port cannot render this (enabled) effect yet — nullptr when it can.
[[nodiscard]] const char* effect_unported_reason(const Json& e);

[[nodiscard]] bool effect_enabled(const Json& e);
/// `effectNumber(e, key)` — the param, else its declared default, else 0.
[[nodiscard]] double effect_number(const Json& e, std::string_view key);

struct ColorMatrix {
  std::array<double, 9> m{1, 0, 0, 0, 1, 0, 0, 0, 1};
  std::array<double, 3> offset{0, 0, 0};
  bool identity = true;
};
/// `effectColorMatrix(effects)`.
[[nodiscard]] ColorMatrix effect_color_matrix(const std::vector<Json>& effects);
/// `applyColorMatrix(cm, rgb)` (clamped).
[[nodiscard]] std::array<double, 3> apply_color_matrix(const ColorMatrix& cm, const std::array<double, 3>& rgb);

/// `effectsNeedCpuBake(effects)`.
[[nodiscard]] bool effects_need_cpu_bake(const std::vector<Json>& effects);
/// `layerIsBaked(layer)`.
[[nodiscard]] bool layer_is_baked(const RLayer& l);
/// A per-channel LUT effect (Levels, Curves, …) is enabled on the layer (`hasLutEffect`).
[[nodiscard]] bool has_lut_effect(const RLayer& l);
/// `isGpuOnlyEffect(type)`.
[[nodiscard]] bool is_gpu_only_effect(std::string_view type);

/// `extractSpatialEffects(layer, onlyGpuOnly)` for the ported effect kinds.
/// Kinds outside the port are skipped here and reported by the snapshot
/// (effect_unported_reason).
[[nodiscard]] std::vector<api::RenderEffect> extract_spatial_effects(const RLayer& l, bool onlyGpuOnly);

// ── E4: the GPU route ────────────────────────────────────────────────────────
//
// The TypeScript bakes a layer's WHOLE stack on the CPU (layerIsBaked: fill
// opacity, an effect-scoped mask, an effect opacity, a Canvas2D-only effect) —
// 0.1–1 s a frame at 1080p for the styles. When the frame renders on a device,
// a baked layer whose every reason and every effect the render graph's chain
// can express runs there instead: the same chain entries an unbaked layer gets
// (extract_spatial_effects' per-effect writer), preceded by a `fill-opacity`
// entry, with `effectOpacity` / `scopeMaskKey` on the entries the bake would
// have blended back. What the chain cannot express keeps the CPU bake, the
// reference and the fallback (no device, PREMATION_CPU_BAKE=1, the parity gate).

/// Why this layer's stack cannot take the GPU route (nullptr = it can).
[[nodiscard]] const char* gpu_effect_route_blocker(const RLayer& l);
/// The layer is baked by the TypeScript rule and can run on the GPU chain instead.
[[nodiscard]] bool gpu_effect_route(const RLayer& l);
/// The chain of a GPU-routed layer (see above).
[[nodiscard]] std::vector<api::RenderEffect> extract_gpu_route_effects(const RLayer& l);
/// Texture key of an effect-scoped mask (a TexKind::mask raster of one path, mode add).
[[nodiscard]] std::string scope_mask_key(std::string_view layerId, std::string_view maskId);
/// The scoped masks a GPU-routed layer's chain reads: (texture key, `{paths: [path]}`).
[[nodiscard]] std::vector<std::pair<std::string, Json>> gpu_route_scope_masks(const RLayer& l);
/// A Canvas2D-only effect the GPU draws itself on this layer (Vegas over the
/// layer's own alpha: gpu_canvas_fx.cpp), and its chain entry.
[[nodiscard]] bool gpu_draws_canvas_effect(const RLayer& l, const Json& e);
[[nodiscard]] std::optional<api::RenderEffect> gpu_canvas_effect_entry(const RLayer& l, const Json& e);
/// Texture key of a GPU Vegas' contours (TexKind::contours).
[[nodiscard]] std::string contour_key(std::string_view layerId);
/// The contour request of a GPU-routed layer drawing Vegas on the GPU:
/// {source: the content raster's key, threshold, width, height, padding}.
[[nodiscard]] std::optional<Json> contour_request_spec(const RLayer& l);

/// RenderEffect param-bag writer (effectToWire's encoding).
class FxWriter {
 public:
  explicit FxWriter(std::string type) { e_.type = std::move(type); }
  FxWriter& num(std::string name, double v);
  FxWriter& flag(std::string name, bool v);
  FxWriter& color(std::string name, const Rgba& c);
  FxWriter& nums(std::string name, std::vector<double> v);
  FxWriter& text(std::string name, std::string v);
  [[nodiscard]] api::RenderEffect done() { return std::move(e_); }

 private:
  api::RenderEffect e_;
};

}  // namespace premation::scene
