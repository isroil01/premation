// A layer's spatial effect chain — CompositionPass.runEffectsChain.
//
// Ping-pongs a pool of full-viewport targets (pool[0] holds the input), one
// branch per effect family, with Compositing ▸ Effect Opacity blended back and
// the fail-safe that an effect producing no draw leaves the chain untouched.
// Each entry's passes are scissored to the layer's reach so far (fx_bounds.hpp).
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "fx_bounds.hpp"
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
  /// Stream D (2026-11-02): the scene under the layer whose chain is running —
  /// copied into kFxBackdrop by the composition pass before the chain of a
  /// layer flagged `readsBackdrop` (an effect with Source: Backdrop, the
  /// fx-graph's BACKDROP slot). Empty = unavailable (the 3D route's layer-space
  /// chains, a chain run without the flag): such an effect reads transparent black.
  virtual TexRef backdrop(PassContext& /*ctx*/) { return {}; }
  /// Camera program D1: the composition's scene depth (camera-space z of the
  /// nearest 3D surface other than `selfId`, comp px, +inf where none; an
  /// r32float read with textureLoad) in a w × h buffer placed by `compToWorld`
  /// (comp px → buffer px, row-major 3×3). Empty = unavailable.
  virtual TexRef scene_depth(PassContext& /*ctx*/, std::uint32_t /*w*/, std::uint32_t /*h*/,
                             const std::array<double, 9>& /*compToWorld*/, std::string_view /*selfId*/) {
    return {};
  }
  /// AE parity 4.2: composite a 3D-run layer that needs its own compositing
  /// step (a track matte, an advanced blend / Preserve Transparency, glass, a
  /// backdrop blur) onto `out`, from images already drawn in 3D — `predrawn`
  /// holds the layer (and its matte source) by id. False = not handled; the
  /// caller lays the layer's image over the run as is.
  virtual bool composite_special_3d(PassContext& /*ctx*/, const api::Renderable& /*r*/,
                                    const std::unordered_map<std::string, TexRef>& /*predrawn*/, std::string_view /*out*/,
                                    const ById& /*byId*/) {
    return false;
  }
  /// E1: an earlier frame's effect-chain result of a 3D surface under `key`
  /// (fx_keys.hpp layer_fx_key over the surface's content) in a w × h buffer;
  /// empty = none kept. The texture outlives the frame.
  virtual TexRef reuse_surface_fx(PassContext& /*ctx*/, std::uint64_t /*key*/, std::uint32_t /*w*/, std::uint32_t /*h*/) {
    return {};
  }
  /// E1: keep `result`, the chain output of layer `id` under `key`, for later
  /// frames. The kept copy's texture when it was kept this frame (the caller
  /// samples it instead of its own copy); empty = not kept.
  virtual TexRef keep_surface_fx(PassContext& /*ctx*/, const std::string& /*id*/, std::uint64_t /*key*/,
                                 const RenderTarget& /*result*/) {
    return {};
  }
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
  /// Where `tex` can be non-zero, in buffer texels (fx_bounds.hpp); absent = anywhere.
  std::optional<PxBox> covered;
};

/// G1: native SDK plugin effects — a `native-plugin` chain entry (written by
/// the scene builder, src/plugins/scene_native_fx.cpp) is handed to this host
/// (the plugin host's render glue, src/plugins/render_glue.cpp), which runs the
/// plugin on the CPU or on this device and leaves its result in `dest`.
class NativeEffectHost {
 public:
  struct Call {
    const api::RenderEffect* effect = nullptr;
    /// The chain's current buffer (a pool target), and its name.
    RenderTarget* source = nullptr;
    std::string_view sourceName;
    /// A free pool target of the same size for the result.
    std::string_view dest;
    const api::Renderable* self = nullptr;
    std::string_view selfId;
    const ById* byId = nullptr;
    MapLayerSource* maps = nullptr;
    const FxSpace* space = nullptr;
    /// The pool itself uses MATTE_TARGET: layer checkouts are unavailable (as for displacement maps).
    bool poolHasMatte = false;
  };
  NativeEffectHost() = default;
  virtual ~NativeEffectHost() = default;
  NativeEffectHost(const NativeEffectHost&) = delete;
  NativeEffectHost& operator=(const NativeEffectHost&) = delete;
  NativeEffectHost(NativeEffectHost&&) = delete;
  NativeEffectHost& operator=(NativeEffectHost&&) = delete;
  /// True: `dest` holds the effect's output. False: the effect is skipped (the
  /// chain continues with its input; the host recorded why — layerErrors).
  virtual bool apply(PassContext& ctx, const Call& call) = 0;
};

/// `contentKey` (E4): a hash of what the chain's input was drawn from
/// (composition_pass.cpp chain_content_key), 0 = unknown. Equal keys promise
/// equal input pixels, so the styles' distance fields are kept across frames
/// under it (fx_cache.hpp) while only effect params change.
///
/// `content`: where the input can be non-zero, in buffer texels (fx_bounds.hpp
/// content_box); absent = anywhere. A screen-space chain that knows it
/// scissors each entry's passes to the reach of the entries so far.
ChainResult run_effects_chain(PassContext& ctx, const std::vector<api::RenderEffect>& effects, TexRef input,
                              std::span<const std::string_view> pool, const ById& byId, std::string_view selfId,
                              MapLayerSource& maps, const FxSpace* space = nullptr, std::uint64_t contentKey = 0,
                              const std::optional<PxBox>& content = std::nullopt);

/// Whether the C++ chain renders this effect entry (support.cpp's gate).
[[nodiscard]] bool effect_ported(const api::RenderEffect& e, std::string& why);

/// P7: the material a single-pass effect type draws with (nullopt: multi-pass
/// or not a table entry) — what pipeline warm-up compiles ahead of first use.
[[nodiscard]] std::optional<Mat> effect_material(std::string_view type);
/// P7: every (material, blend) pass `type` draws in a chain — its table entry
/// and the special-cased families' passes (the blurs, glow, drop shadow, deep
/// glow) — what the render thread compiles ahead while idle.
[[nodiscard]] std::vector<std::pair<Mat, Blend>> effect_warm_passes(std::string_view type);
/// E4: whether `type` builds an alpha distance field (fx_distance.hpp).
[[nodiscard]] bool effect_uses_fields(std::string_view type);
/// E4: the passes that BUILD the field for `type` (seed / flood / resolve),
/// drawn into rgba16float field targets — warmed at that format, not the
/// chain's. Empty for a type without a field.
[[nodiscard]] std::vector<std::pair<Mat, Blend>> effect_field_warm_passes(std::string_view type);

// emit helpers shared with the composition (passUtils.ts twins).
void emit_textured(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& tint, double opacity, Blend blend,
                   const TexRef& tex, const SamplerRef& smp, const Rect& uv, const ColorTransform& ct, bool sampleLinear,
                   const LayerEdge& edge = {});
void emit_silhouette(PassContext& ctx, Commands& cmds, const Mat3& mvp, const Color& c, double opacity, Blend blend,
                     const TexRef& tex, const SamplerRef& smp, const Rect& uv);
void emit_matte_combine(PassContext& ctx, Commands& cmds, const Mat3& mvp, Blend blend, const TexRef& tex,
                        const SamplerRef& smp, const TexRef& matte, const ColorTransform& mode, const Rect& uv);
/// blend-combine.wgsl: `tex` (source) composited over `backdrop` with the W3C
/// separable / non-separable blend `mode.m[0]` (1 multiply, 2 screen, …).
void emit_blend_combine(PassContext& ctx, Commands& cmds, const Mat3& mvp, Blend blend, const TexRef& tex,
                        const SamplerRef& smp, const TexRef& backdrop, const ColorTransform& mode, const Rect& uv);

}  // namespace premation::rg
