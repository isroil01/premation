// A layer's structured state beside its transform — the node readers and
// writers the TypeScript engine reaches through the editor's modules:
//
//   effects      src/core/effects/effects.ts   (fx.effects, migrateEffect, paramsOf)
//   masks        src/core/effects/mask.ts      (fx.mask, fx.maskAnim)
//   layer styles src/core/effects/layerStyles.ts (fx.layerStyles)
//   path ops     src/core/scene/pathOps.ts     (fx.pathOps, coercePathOp)
//   polystar     src/core/scene/polystar.ts    (fx.polystar)
//   animators    src/core/text/textAnimators.ts (Text.__animators, normalizeAnimator)
//   text path    src/core/text/textPath.ts     (fx.textPath)
//   font axes    src/core/text/fontAxes.ts     (Text.fontAxes)
//   paint        src/core/paint/*.ts           (fx.paint)
//
// The TypeScript stores all of these as plain JSON on the node, so they stay
// JSON here (js::Json, insertion-ordered like a JavaScript object) and each
// function reproduces its TypeScript twin's object shape — key order included,
// because a stored value is observable through JSON-typed property values and
// through the saved document.
#pragma once

#include <array>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "catalog_data.hpp"
#include "model.hpp"

namespace premation::doc {

/// `{...a, ...b}` — b's keys replace in place, new keys append.
[[nodiscard]] Json spread(const Json& a, const Json& b);
/// `v ?? fallback` (undefined or null → fallback).
[[nodiscard]] const Json& nn(const Json& v, const Json& fallback);
[[nodiscard]] double num_or(const Json& v, double fb);  ///< `typeof v === 'number' ? v : fb`

// ── colours (effects.ts) ─────────────────────────────────────────────────
/// `parseColorChannels(hex)`: 0..1 RGBA; `[1,1,1,1]` for anything unparseable.
[[nodiscard]] std::array<double, 4> parse_color_channels(std::string_view hex);
/// `channelsToColor(r,g,b,a)`: `#rrggbb`, or `#rrggbbaa` when a < 1.
[[nodiscard]] std::string channels_to_color(double r, double g, double b, double a);
/// `/^#?[0-9a-fA-F]{3,8}$/.test(s.trim())`.
[[nodiscard]] bool is_hex_color(std::string_view s);

// ── effects ──────────────────────────────────────────────────────────────
[[nodiscard]] Json default_params(const EffectDef& def);
[[nodiscard]] Json new_instance_params_of(const EffectDef& def);
[[nodiscard]] Json params_of(const Json& effect);
[[nodiscard]] Json migrate_effect(const Json& raw);
/// `readNodeEffects(node)` (migrated).
[[nodiscard]] std::vector<Json> read_node_effects(const Node& n);
[[nodiscard]] std::vector<Json> get_node_effects(const Document& d, std::string_view nodeId);
[[nodiscard]] const Json* find_by_id(const std::vector<Json>& list, std::string_view id);
void write_node_effects(Document& d, std::string_view nodeId, std::vector<Json> effects);
/// `updateEffectParam`: `{...e, params: {...e.params, [key]: value}}` on the migrated stack.
void update_effect_param(Document& d, std::string_view nodeId, std::string_view effectId, std::string_view key,
                         Json value);
[[nodiscard]] bool effect_has_opacity(const Json& e);
inline constexpr std::string_view kEffectOpacityKey = "fx.opacity";

// ── masks ────────────────────────────────────────────────────────────────
/// `readNodeMask`: the fx.mask object when it has at least one path.
[[nodiscard]] std::optional<Json> read_node_mask(const Node& n);
/// `getNodeMask`: the mask or `{paths: []}`.
[[nodiscard]] Json get_node_mask(const Node& n);
[[nodiscard]] std::vector<Json> read_node_mask_anim(const Node& n);
[[nodiscard]] const Json* mask_path_by_id(const Json& mask, std::string_view id);
/// `writeNodeMask`: fx.mask = mask, or undefined when it has no paths.
void write_node_mask(Document& d, std::string_view nodeId, const Json& mask);
void set_mask_anim(Document& d, std::string_view nodeId, std::optional<std::vector<Json>> keys);
/// `editEveryMaskState(node, fn)`: the static mask and every shape keyframe.
void edit_every_mask_state(Document& d, std::string_view nodeId, const std::function<Json(const Json&)>& fn);
/// `updateMaskPath(node, pathId, patch)` with no time: the static mask.
void update_mask_path(Document& d, std::string_view nodeId, std::string_view pathId, const Json& patch);
/// `interpolateMask(kfs, t)` (nullopt for no keyframes).
[[nodiscard]] std::optional<Json> interpolate_mask(const std::vector<Json>& kfs, double t);

// ── layer styles ─────────────────────────────────────────────────────────
[[nodiscard]] std::optional<std::string> style_key_from_effect_id(std::string_view effectId);
[[nodiscard]] std::string layer_style_effect_id(std::string_view styleKey);
[[nodiscard]] std::optional<std::string> style_field_for_param(std::string_view styleKey, std::string_view param);
/// The style's number binding `{param, scale?}` for `field` (nullptr when none).
[[nodiscard]] const Json* style_number_binding(std::string_view styleKey, std::string_view field);
/// `getNodeLayerStyles`: fx.layerStyles or `{}`.
[[nodiscard]] Json get_node_layer_styles(const Node& n);
/// `setLayerStyles` (undefined when every value is undefined).
void set_layer_styles(Document& d, std::string_view nodeId, const Json& styles);

// ── path operators ───────────────────────────────────────────────────────
[[nodiscard]] Json coerce_path_op(const Json& raw);
[[nodiscard]] std::vector<Json> read_path_ops(const Node& n);
void set_path_ops(Document& d, std::string_view nodeId, const std::vector<Json>& ops);
void update_path_op(Document& d, std::string_view nodeId, std::string_view opId, const Json& patch);
/// `pathOpParamSpecs(type)` param names, in row order.
[[nodiscard]] std::vector<std::string> path_op_params(std::string_view type);

// ── polystar ─────────────────────────────────────────────────────────────
[[nodiscard]] std::optional<Json> read_node_polystar(const Node& n);
[[nodiscard]] std::vector<std::string> polystar_params(std::string_view starType);
/// polystar.ts `updateNodePolystar`: patch the validated config and store it re-validated (false: no polystar).
bool update_node_polystar(Document& d, std::string_view nodeId, const Json& patch);

// ── text animators ───────────────────────────────────────────────────────
[[nodiscard]] const Component* text_component(const Node& n);
[[nodiscard]] Json default_selector(std::string_view kind);  ///< with an `id` slot (undefined)
[[nodiscard]] Json normalize_selector(const Json& s);
[[nodiscard]] Json normalize_animator(const Json& d);
[[nodiscard]] std::vector<Json> read_animator_data(const Node& n);
/// writeAnimators: Text.__animators = animators (as given).
void write_animators(Document& d, std::string_view nodeId, std::vector<Json> animators);
void update_animator(Document& d, std::string_view nodeId, std::size_t index, const Json& patch);
void update_selector(Document& d, std::string_view nodeId, std::size_t index, std::size_t selectorIndex,
                     const Json& patch);
struct AnimatorTrackRef {
  int anim = 0;
  std::optional<int> sel;
  std::string param;
};
/// `parseAnimatorTrack(prop)`.
[[nodiscard]] std::optional<AnimatorTrackRef> parse_animator_track(std::string_view prop);
/// `/^ta\.(\d+)\.(?:s(\d+)\.)?([A-Za-z][A-Za-z0-9]*)$/` (propertyValue/propertyMeta's parser).
struct AnimatorPath {
  int index = 0;
  std::optional<int> selector;
  std::string param;
};
[[nodiscard]] std::optional<AnimatorPath> parse_animator_path(std::string_view prop);
[[nodiscard]] std::string animator_prop_path(std::size_t index, std::string_view param);
[[nodiscard]] std::string animator_axis_prop_path(std::size_t index, std::string_view tag);
[[nodiscard]] std::string selector_prop_path(std::size_t index, std::size_t selectorIndex, std::string_view param);
[[nodiscard]] std::optional<std::string> axis_tag_of_param(std::string_view param);

// ── text path, font axes ─────────────────────────────────────────────────
[[nodiscard]] std::optional<Json> read_text_path_config(const Node& n);
[[nodiscard]] double text_path_param_value(const Json& cfg, std::string_view param);
[[nodiscard]] std::optional<std::string> parse_text_path_prop_path(std::string_view path);
void update_text_path(Document& d, std::string_view nodeId, const Json& patch);
/// `readFontAxesProp` (sanitised: valid tags, finite numbers, legacy tags dropped).
[[nodiscard]] Json read_font_axes_prop(const Node& n);
[[nodiscard]] std::string axis_prop_path(std::string_view tag);
[[nodiscard]] std::optional<std::string> parse_axis_prop_path(std::string_view path);

// ── paint ────────────────────────────────────────────────────────────────
/// `readNodePaint`: the strokes that have points (nullopt when none).
[[nodiscard]] std::optional<std::vector<Json>> read_node_paint(const Node& n);
[[nodiscard]] std::map<std::string, std::string> stroke_display_names(const std::vector<Json>& strokes);
struct PaintPropRef {
  std::string strokeId;
  std::string key;
};
[[nodiscard]] std::optional<PaintPropRef> parse_paint_prop_path(std::string_view prop);
struct PaintColorRef {
  std::string strokeId;
  char channel = 'r';
};
[[nodiscard]] std::optional<PaintColorRef> parse_paint_color_path(std::string_view prop);
[[nodiscard]] std::optional<double> read_paint_stroke_value(const Json& stroke, std::string_view key);
[[nodiscard]] Json paint_stroke_patch(const Json& stroke, std::string_view key, double value);
void update_paint_stroke(Document& d, std::string_view nodeId, std::string_view strokeId, const Json& patch);

// ── mask property paths ──────────────────────────────────────────────────
struct MaskPropRef {
  std::string pathId;
  std::string key;  ///< feather | opacity | expansion
};
[[nodiscard]] std::optional<MaskPropRef> parse_mask_prop_path(std::string_view prop);

// ── gradient geometry (inspector/gradientGeometryProps.ts) ──────────────────
// fillAngle / fillCenterX|Y / fillRadius (the layer's gradient fill) and
// strokeAngle / strokeCenterX|Y / strokeRadius (a text layer's stroke gradient):
// keyframeable scalars whose static value lives inside a paint object.

[[nodiscard]] bool is_gradient_geometry_prop(std::string_view prop);
/// The static value; nullopt when the layer has no such gradient or its type lacks the field.
[[nodiscard]] std::optional<double> read_gradient_geometry_prop(const Node& n, std::string_view prop);
/// Write it back into its paint (a fill: setNodeFill incl. the fill stack; a text stroke).
bool write_gradient_geometry_prop(Document& d, std::string_view nodeId, std::string_view prop, double value);
/// A TEXT layer's gradient geometry rows: the fill gradient's, then the stroke gradient's.
[[nodiscard]] std::vector<std::string> gradient_geometry_props_for(const Node& n);

}  // namespace premation::doc
