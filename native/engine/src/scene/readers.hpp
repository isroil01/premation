// The scene-node readers buildSnapshot calls, ported from their TypeScript
// modules (each function cites its twin). Pure reads of one node's components
// (and, for animated state, of values the caller sampled).
#pragma once

#include <array>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "model.hpp"
#include "scene_types.hpp"

namespace premation::scene {

using doc::Node;

/// A node's sampled animated values at one time (AnimationEngine.evaluateNode):
/// prop path → value, in the engine's order. `get` is a linear scan — a node
/// carries a handful of tracks, and a scan beats hashing at that size.
class Values {
 public:
  Values() = default;
  explicit Values(std::vector<std::pair<std::string, double>> v) : v_(std::move(v)) {}
  [[nodiscard]] std::optional<double> get(std::string_view k) const noexcept {
    for (const auto& [key, val] : v_) {
      if (key == k) return val;
    }
    return std::nullopt;
  }
  [[nodiscard]] bool has(std::string_view k) const noexcept { return get(k).has_value(); }
  [[nodiscard]] bool empty() const noexcept { return v_.empty(); }
  [[nodiscard]] std::size_t size() const noexcept { return v_.size(); }
  [[nodiscard]] const std::vector<std::pair<std::string, double>>& items() const noexcept { return v_; }
  void erase(std::string_view k) {
    std::erase_if(v_, [k](const auto& p) { return p.first == k; });
  }

 private:
  std::vector<std::pair<std::string, double>> v_;
};

// ── JSON helpers (typeof checks as the TypeScript writes them) ────────────
[[nodiscard]] std::optional<double> jnum(const Json& v) noexcept;  ///< typeof v === 'number'
[[nodiscard]] std::optional<std::string> jstr(const Json& v);      ///< typeof v === 'string'
/// The first component of `type` (renderComponentsOf(node).find(c => c.type === type)).
[[nodiscard]] const Json& comp_props(const Node& n, std::string_view type) noexcept;
/// fx props (the first `fx` component; an empty object when absent).
[[nodiscard]] const Json& fx_props(const Node& n) noexcept;
/// `readNumProp(node, prop)`: the first numeric value of `prop` across components.
[[nodiscard]] std::optional<double> read_num_prop(const Node& n, std::string_view prop) noexcept;

// ── colours ───────────────────────────────────────────────────────────────
struct Rgba {
  double r = 0, g = 0, b = 0, a = 1;
};
/// `Color.fromHex(hex)` (packages/renderer Color): #rgb/#rrggbb/#rrggbbaa or rgb()/rgba() → 0..1.
[[nodiscard]] Rgba color_from_hex(std::string_view hex);
/// `Color.toHex(c)`: always `#rrggbbaa`.
[[nodiscard]] std::string color_to_hex(const Rgba& c);

// ── fx flags (effects/*.ts one-line readers) ─────────────────────────────
[[nodiscard]] std::string read_node_blend(const Node& n);            ///< blendMode.ts readNodeBlend
[[nodiscard]] bool read_node_preserve_transparency(const Node& n);   ///< preserveTransparency.ts
[[nodiscard]] bool read_node_adjustment(const Node& n);              ///< adjustment.ts
[[nodiscard]] bool read_node_motion_blur(const Node& n);             ///< motionBlur.ts
[[nodiscard]] bool read_is_guide_layer(const Node& n);               ///< guideLayer.ts
[[nodiscard]] std::string read_node_quality_s(const Node& n);        ///< layerQuality.ts ('best' default)
[[nodiscard]] std::optional<Matte> read_matte(const Json& v);        ///< matte.ts readMatte
[[nodiscard]] std::optional<Matte> read_matte_of(const Node& n);   ///< matte.ts readNodeMatte
[[nodiscard]] bool is_precomp_node(const Node& n);                   ///< precomp.ts isPrecomp
[[nodiscard]] bool composites_as_unit(const Node& n);                ///< precomp.ts compositesAsUnit
/// `readNodeAnchor`: the Transform's anchorX/anchorY (0 when unset).
[[nodiscard]] std::pair<double, double> read_node_anchor(const Node& n);

// ── paint (paint/fill.ts, paint/stroke.ts, rendering/strokeTracks.ts) ────
[[nodiscard]] bool is_fill_paint(const Json& v);
[[nodiscard]] Json read_node_fill(const Node& n);                    ///< FillPaint | undefined
[[nodiscard]] std::vector<Json> read_node_fills(const Node& n);
[[nodiscard]] Json normalize_stroke(const Json& v);
[[nodiscard]] std::vector<Json> read_node_strokes(const Node& n);
struct StrokeStack {
  Json stroke;   ///< undefined when absent
  Json strokes;  ///< undefined when absent
};
[[nodiscard]] StrokeStack resolve_stroke_stack(const std::vector<Json>& stack, const Values& a, double w, double h);

// ── corners (scene/cornerRadii.ts) ───────────────────────────────────────
using Radii = std::array<double, 4>;
[[nodiscard]] Radii resolve_corner_radii(std::optional<double> r, std::optional<double> tl, std::optional<double> tr,
                                         std::optional<double> br, std::optional<double> bl);
[[nodiscard]] Radii clamp_corner_radii(double w, double h, Radii r);
[[nodiscard]] bool has_independent_corner_radii(const Radii& r);

// ── masks (effects/mask.ts) ──────────────────────────────────────────────
/// `readNodeMaskAt(node, t)` (undefined = none).
[[nodiscard]] Json read_node_mask_at(const Node& n, double t);
/// `applyMaskPropertyTracks(mask, av)`.
[[nodiscard]] Json apply_mask_property_tracks(const Json& mask, const Values& av);
/// `roundedRectMask(w, h, radii)` (id supplied by the caller).
[[nodiscard]] Json rounded_rect_mask(double w, double h, const Radii& radii, std::string_view id);

}  // namespace premation::scene
