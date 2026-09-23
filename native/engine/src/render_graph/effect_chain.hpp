// A layer's spatial effect chain — CompositionPass.runEffectsChain.
//
// Ping-pongs a pool of full-viewport targets (pool[0] holds the input), one
// branch per effect family, with Compositing ▸ Effect Opacity blended back and
// the fail-safe that an effect producing no draw leaves the chain untouched.
#pragma once

#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "render_context.hpp"

namespace premation::rg {

using ById = std::unordered_map<std::string_view, const api::Renderable*>;

/// Renders a sibling layer into MATTE_TARGET for map-reading effects
/// (displacement map, compound blur, set matte, plugin layer inputs).
class MapLayerSource {
 public:
  MapLayerSource() = default;
  virtual ~MapLayerSource() = default;
  MapLayerSource(const MapLayerSource&) = delete;
  MapLayerSource& operator=(const MapLayerSource&) = delete;
  MapLayerSource(MapLayerSource&&) = delete;
  MapLayerSource& operator=(MapLayerSource&&) = delete;
  virtual TexRef map_layer(PassContext& ctx, const ById& byId, std::string_view mapLayerId, std::string_view selfId) = 0;
};

/// The buffer a chain runs in when it is NOT screen space (the 3D route: layer
/// space plus a margin). Absent = screen space, where one comp px is one texel.
struct FxSpace {
  double pxToTexelX = 1;
  double pxToTexelY = 1;
  Rect box;
};

struct ChainResult {
  TexRef tex;
  std::string_view name;
};

ChainResult run_effects_chain(PassContext& ctx, const std::vector<api::RenderEffect>& effects, TexRef input,
                              std::span<const std::string_view> pool, const ById& byId, std::string_view selfId,
                              MapLayerSource& maps, const FxSpace* space = nullptr);

/// Whether the C++ chain renders this effect entry (support.cpp's gate).
[[nodiscard]] bool effect_ported(const api::RenderEffect& e, std::string& why);

// emit helpers shared with the composition (passUtils.ts twins).
void emit_textured(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& tint, double opacity, Blend blend,
                   const TexRef& tex, const SamplerRef& smp, const Rect& uv, const ColorTransform& ct, bool sampleLinear);
void emit_silhouette(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& c, double opacity, Blend blend,
                     const TexRef& tex, const SamplerRef& smp, const Rect& uv);

}  // namespace premation::rg
