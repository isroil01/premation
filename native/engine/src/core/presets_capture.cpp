#include "presets_capture.hpp"

#include <algorithm>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#include "anim.hpp"
#include "anim_json.hpp"
#include "fxstate.hpp"
#include "scene.hpp"

namespace premation::doc {
namespace {

/// presetUnits.ts PresetContext (DEFAULT_PRESET_CONTEXT's values).
struct UnitContext {
  double compWidth = 1920;
  double compHeight = 1080;
  double layerWidth = 400;
  double layerHeight = 200;
  double fontSize = 48;
};

/// presetContext.ts `nodeNumber`: the first finite number stored under `key` across the node's components.
std::optional<double> node_number(const Node& n, std::string_view key) {
  for (const Component& c : n.components) {
    const Json& v = c.props.at(key);
    if (v.is_finite_number()) return v.num();
  }
  return std::nullopt;
}

/// presetContext.ts `presetContextFor(layer, compOfLayer(layer))` (the duration is unused by a capture).
UnitContext context_for(const Document& d, const Node& n) {
  UnitContext c;
  const auto comp = comp_of_layer(d, n.id);
  const Json* rec = comp ? d.comp(*comp) : nullptr;
  if (rec != nullptr) {
    if (rec->at("width").is_number()) c.compWidth = rec->at("width").num();
    if (rec->at("height").is_number()) c.compHeight = rec->at("height").num();
  }
  if (auto v = node_number(n, "width")) c.layerWidth = *v;
  if (auto v = node_number(n, "height")) c.layerHeight = *v;
  if (auto v = node_number(n, "fontSize")) c.fontSize = *v;
  return c;
}

/// presetUnits.ts `defaultUnitForProp`: by the prop path's last segment.
std::string_view default_unit_for_prop(std::string_view prop) {
  const std::size_t dot = prop.rfind('.');
  const std::string_view leaf = dot == std::string_view::npos ? prop : prop.substr(dot + 1);
  if (leaf == "x" || leaf == "positionX") return "compW";
  if (leaf == "y" || leaf == "positionY") return "compH";
  if (leaf == "z") return "compMin";
  if (leaf == "tracking" || leaf == "lineSpacing" || leaf == "blur" || leaf == "strokeWidth") return "fontSize";
  return "abs";
}

/// presetUnits.ts `unitScale`.
double unit_scale(std::string_view unit, const UnitContext& c) {
  if (unit == "compW") return c.compWidth;
  if (unit == "compH") return c.compHeight;
  if (unit == "compMin") return std::min(c.compWidth, c.compHeight);
  if (unit == "layerW") return c.layerWidth;
  if (unit == "layerH") return c.layerHeight;
  if (unit == "fontSize") return c.fontSize;
  return 1;
}

/// AnimationEngine.animatedProps: the scalar tracks, then the expressions, once each, in insertion order.
std::vector<std::string> animated_props(const NodeAnim& a) {
  std::vector<std::string> out;
  for (const auto& [prop, keys] : a.tracks) out.push_back(prop);
  for (const auto& [prop, st] : a.exprs) {
    if (std::find(out.begin(), out.end(), prop) == out.end()) out.push_back(prop);
  }
  return out;
}

/// JS `String.prototype.trim() !== ''` over the whitespace an expression source holds.
bool has_non_blank(std::string_view s) {
  return std::any_of(s.begin(), s.end(), [](char ch) {
    return ch != ' ' && ch != '\t' && ch != '\n' && ch != '\r' && ch != '\f' && ch != '\v';
  });
}

struct CapturedTrack {
  std::string prop;
  std::string unit;
  std::vector<Key> keys;
};

/// `effect.<id>.<rest>` → the id and the rest (the regex `^effect\.([^.]+)\.(.*)$`).
std::optional<std::pair<std::string, std::string>> split_effect_prop(std::string_view prop) {
  constexpr std::string_view kPrefix = "effect.";
  if (!prop.starts_with(kPrefix)) return std::nullopt;
  const std::string_view rest = prop.substr(kPrefix.size());
  const std::size_t dot = rest.find('.');
  if (dot == std::string_view::npos || dot == 0) return std::nullopt;
  return std::pair<std::string, std::string>{std::string(rest.substr(0, dot)), std::string(rest.substr(dot + 1))};
}

}  // namespace

std::optional<Json> capture_preset_body(const Document& d, std::string_view layer) {
  const Node* n = d.node(layer);
  if (n == nullptr) return std::nullopt;
  const UnitContext ctx = context_for(d, *n);
  const NodeAnim* anim = d.anim(layer);
  const std::vector<std::string> props = anim != nullptr ? animated_props(*anim) : std::vector<std::string>{};

  // captureAnimation: every keyed track, its values out of pixels, then normalizeTracks (t = 0 at the earliest key).
  std::vector<CapturedTrack> tracks;
  double minT = std::numeric_limits<double>::infinity();
  for (const std::string& prop : props) {
    const std::vector<Key>* kfs = anim->tracks.find(prop);
    if (kfs == nullptr || kfs->empty()) continue;
    CapturedTrack t{prop, std::string(default_unit_for_prop(prop)), *kfs};
    if (t.unit != "abs") {
      const double s = unit_scale(t.unit, ctx);
      for (Key& k : t.keys) k.value = s == 0 ? k.value : k.value / s;
    }
    for (const Key& k : t.keys) minT = std::min(minT, k.t);
    tracks.push_back(std::move(t));
  }
  const double base = minT == std::numeric_limits<double>::infinity() ? 0 : minT;
  for (CapturedTrack& t : tracks) {
    for (Key& k : t.keys) k.t -= base;
  }

  // readAnimatorData (text layers only).
  const std::vector<Json> animators = text_component(*n) != nullptr ? read_animator_data(*n) : std::vector<Json>{};

  // captureExpressions: enabled, non-blank.
  Json expressions = Json::array();
  for (const std::string& prop : props) {
    const ExprState* st = anim_expr(d, layer, prop);
    if (st == nullptr || !st->enabled || !has_non_blank(st->src)) continue;
    Json e = Json::object();
    e.set("prop", Json::string(prop));
    e.set("expr", Json::string(st->src));
    expressions.arr_mut().push_back(std::move(e));
  }

  // captureEffects: the stack renumbered fx0, fx1, … and its tracks re-pointed.
  Json effects = Json::array();
  std::vector<std::pair<std::string, std::string>> mapping;
  const std::vector<Json> stack = get_node_effects(d, layer);
  for (std::size_t i = 0; i < stack.size(); ++i) {
    const Json& e = stack[i];
    std::string presetId = "fx" + std::to_string(i);
    mapping.emplace_back(e.at("id").is_string() ? e.at("id").str() : std::string{}, presetId);
    Json out = Json::object();
    out.set("id", Json::string(presetId));
    out.set("type", e.at("type"));
    const Json& params = e.at("params");
    if (!params.is_undefined() && !params.is_null()) out.set("params", params);
    effects.arr_mut().push_back(std::move(out));
  }
  if (!mapping.empty()) {
    for (CapturedTrack& t : tracks) {
      const auto parts = split_effect_prop(t.prop);
      if (!parts) continue;
      const auto it = std::find_if(mapping.begin(), mapping.end(), [&](const auto& m) { return m.first == parts->first; });
      if (it != mapping.end()) t.prop = "effect." + it->second + "." + parts->second;
    }
  }

  if (tracks.empty() && animators.empty() && effects.arr().empty() && expressions.arr().empty()) return std::nullopt;

  Json body = Json::object();
  Json trackList = Json::array();
  for (const CapturedTrack& t : tracks) {
    Json tj = Json::object();
    tj.set("prop", Json::string(t.prop));
    tj.set("unit", Json::string(t.unit));
    Json keys = Json::array();
    for (const Key& k : t.keys) keys.arr_mut().push_back(key_to_json(k));
    tj.set("keyframes", std::move(keys));
    trackList.arr_mut().push_back(std::move(tj));
  }
  body.set("tracks", std::move(trackList));
  if (!animators.empty()) {
    body.set("animators", Json::array(animators));
    body.set("requires", Json::string("text"));
  }
  if (!effects.arr().empty()) body.set("effects", std::move(effects));
  if (!expressions.arr().empty()) body.set("expressions", std::move(expressions));
  return body;
}

}  // namespace premation::doc
