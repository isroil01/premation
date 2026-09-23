#include "meta.hpp"

#include <array>
#include <cmath>

#include "catalog_data.hpp"
#include "fxstate.hpp"
#include "strutil.hpp"

namespace premation::doc {
namespace {

using js::stringify;

// ORDER slots are not carried (the API does not read them).

PropertyMeta from_static(const StaticMeta& s) {
  PropertyMeta m;
  m.label = s.label;
  m.group = s.group;
  m.type = s.type;
  m.unit = s.unit;
  m.min = s.min;
  m.max = s.max;
  m.defaultValue = s.defaultValue.is_undefined() ? Json::null() : s.defaultValue;
  m.keyframeable = s.keyframeable;
  m.displayScale = s.displayScale;
  return m;
}

PropertyMeta number_meta(std::string label, std::string group, std::string unit, Json dflt) {
  PropertyMeta m;
  m.label = std::move(label);
  m.group = std::move(group);
  m.type = "number";
  m.unit = std::move(unit);
  m.defaultValue = std::move(dflt);
  return m;
}

/// An effect parameter definition → metadata (`fromEffectParam`).
PropertyMeta from_effect_param(std::string_view effectLabel, const EffectParamDef& p) {
  PropertyMeta m;
  m.label = std::string(effectLabel) + " " + p.label;
  m.group = "effects";
  m.type = "number";
  m.unit = p.unit.value_or("");
  m.min = p.min;
  m.max = p.max;
  m.defaultValue = p.def.is_number() || p.def.is_string() || p.def.is_bool() ? p.def : Json::null();
  if (p.type == "color") {
    m.type = "color";
    m.defaultValue = p.def.is_undefined() || p.def.is_null() ? Json::string("#000000")
                     : p.def.is_string()                      ? p.def
                                                               : Json::string(stringify(p.def));
  } else if (p.type == "checkbox") {
    m.type = "boolean";
    m.defaultValue = Json::boolean(p.def.is_bool() && p.def.b());
  } else if (p.type == "layer") {
    m.type = "enum";
    m.defaultValue = Json::string("");
  } else if (p.type == "curve") {
    m.type = "path";
    m.defaultValue = Json::null();
  }
  return m;
}

const Json& fx_prop(const Node* n, std::string_view key) {
  static const Json kUndef;
  if (n == nullptr) return kUndef;
  return n->fx().at(key);
}

// ── strokes ──

const std::array<std::pair<std::string_view, std::string_view>, 26> kPrimaryTracks{{
    {"color", "stroke"},
    {"opacity", "strokeOpacity"},
    {"width", "strokeWidth"},
    {"miterLimit", "strokeMiterLimit"},
    {"dash1", "strokeDash1"},
    {"gap1", "strokeGap1"},
    {"dash2", "strokeDash2"},
    {"gap2", "strokeGap2"},
    {"dash3", "strokeDash3"},
    {"gap3", "strokeGap3"},
    {"dashOffset", "strokeDashOffset"},
    {"taperStartLength", "strokeTaperStartLength"},
    {"taperEndLength", "strokeTaperEndLength"},
    {"taperStartWidth", "strokeTaperStartWidth"},
    {"taperEndWidth", "strokeTaperEndWidth"},
    {"taperStartEase", "strokeTaperStartEase"},
    {"taperEndEase", "strokeTaperEndEase"},
    {"waveAmount", "strokeWaveAmount"},
    {"waveWavelength", "strokeWaveWavelength"},
    {"wavePhase", "strokeWavePhase"},
    {"gradientStartX", "strokeGradientStartX"},
    {"gradientStartY", "strokeGradientStartY"},
    {"gradientEndX", "strokeGradientEndX"},
    {"gradientEndY", "strokeGradientEndY"},
    {"highlightLength", "strokeHighlightLength"},
    {"highlightAngle", "strokeHighlightAngle"},
}};

bool is_stroke_param(std::string_view p) {
  for (const auto& [param, name] : kPrimaryTracks) {
    if (param == p) return true;
  }
  return false;
}

/// The stored stroke at `index` of a node's stack.
const Json* stored_stroke_at(const Node* n, std::size_t index) {
  if (n == nullptr) return nullptr;
  const Json& strokes = fx_prop(n, "strokes");
  if (strokes.is_array() && !strokes.arr().empty()) {
    return index < strokes.arr().size() ? &strokes.arr()[index] : nullptr;
  }
  const Json& one = fx_prop(n, "stroke");
  if (!one.is_undefined() && !one.is_null() && !(one.is_bool() && !one.b()) && !(one.is_number() && one.num() == 0) &&
      !(one.is_string() && one.str().empty())) {
    return index == 0 ? &one : nullptr;
  }
  return nullptr;
}

PropertyMeta with_stroke_units(PropertyMeta meta, std::string_view path, const Node* n) {
  const auto parsed = parse_stroke_track_path(path);
  if (!parsed) return meta;
  if (parsed->param == "waveWavelength") {
    const Json* s = stored_stroke_at(n, parsed->index);
    if (s != nullptr && s->at("wave").at("units").is_string() && s->at("wave").at("units").str() == "cycles") {
      if (meta.label.ends_with("Wavelength")) meta.label = meta.label.substr(0, meta.label.size() - 10) + "Cycles";
      meta.unit = "";
      meta.min = 0;
    }
    return meta;
  }
  if (parsed->param != "taperStartLength" && parsed->param != "taperEndLength") return meta;
  const Json* s = stored_stroke_at(n, parsed->index);
  if (s == nullptr || !(s->at("taper").at("lengthUnits").is_string() && s->at("taper").at("lengthUnits").str() == "pixels")) {
    return meta;
  }
  meta.displayScale.reset();
  meta.max.reset();
  meta.type = "number";
  meta.unit = "px";
  meta.min = 0;
  return meta;
}

std::optional<PropertyMeta> resolve_stroke_stack(std::string_view path, const Node* n) {
  if (!path.starts_with("stroke.")) return std::nullopt;
  const auto parsed = parse_stroke_track_path(path);
  if (!parsed || parsed->index == 0) return std::nullopt;
  const std::string primary = !parsed->channel.empty() ? "stroke" + parsed->channel : stroke_track_path(0, parsed->param);
  PropertyMeta base = resolve_property_meta(primary, nullptr);
  const std::string num = std::to_string(parsed->index + 1);
  base.label = base.label.starts_with("Stroke ") ? "Stroke " + num + " " + base.label.substr(7)
                                                 : "Stroke " + num + " " + base.label;
  return n != nullptr ? with_stroke_units(std::move(base), path, n) : base;
}

// ── paint ──

std::optional<PropertyMeta> resolve_paint(std::string_view path, const Node* n) {
  if (!path.starts_with("paint.")) return std::nullopt;
  const auto num = parse_paint_prop_path(path);
  const auto col = num ? std::nullopt : parse_paint_color_path(path);
  std::optional<std::string> pathRowId;
  if (!num && !col) {
    if (auto r = parse_prefixed_id_rest(path, "paint."); r && r->rest == "path") pathRowId = r->id;
  }
  const std::string strokeId = num ? num->strokeId : col ? col->strokeId : pathRowId.value_or("");
  if (strokeId.empty()) return std::nullopt;
  std::string name = "Paint";
  if (n != nullptr) {
    const Json& strokes = n->fx().at("paint").at("strokes");
    if (strokes.is_array()) {
      const auto names = stroke_display_names(strokes.arr());
      if (auto it = names.find(strokeId); it != names.end()) name = it->second;
    }
  }
  PropertyMeta m;
  m.group = "effects";
  if (pathRowId) {
    m.label = name + " Path";
    m.type = "path";
    return m;
  }
  if (col) {
    m.label = name + " Color " + std::string(1, static_cast<char>(col->channel - 'a' + 'A'));
    m.type = "colorChannel";
    m.min = 0;
    m.max = 1;
    m.defaultValue = Json::number(1);
    return m;
  }
  const std::string& key = num->key;
  const Json& p = registry().paint;
  m.label = name + " " + p.at("label").at(key).str();
  m.unit = p.at("unit").at(key).is_string() ? p.at("unit").at(key).str() : "";
  bool pct = false;
  for (const Json& k : p.at("percentKeys").arr()) {
    if (k.str() == key) pct = true;
  }
  if (pct) {
    m.type = "percent";
    m.min = key == "spacing" ? 1 : 0;
    if (key != "spacing") m.max = 100;
    m.defaultValue = Json::number(key == "start" ? 0 : key == "spacing" ? 25 : 100);
    return m;
  }
  if (key == "angle" || key == "rotation") {
    m.type = "angle";
    m.defaultValue = Json::number(0);
    return m;
  }
  if (key == "cloneTime" || key == "cloneTimeShift") {
    m.type = "time";
    m.defaultValue = Json::number(0);
    return m;
  }
  if (key == "scale") {
    m.type = "percent";
    m.defaultValue = Json::number(100);
    return m;
  }
  m.type = "number";
  if (key == "diameter") m.min = 0.1;
  m.defaultValue = Json::number(key == "diameter" ? 12 : 0);
  return m;
}

// ── masks ──

std::optional<PropertyMeta> resolve_mask(std::string_view path, const Node* n) {
  const auto r = parse_mask_prop_path(path);
  if (!r) return std::nullopt;
  std::string maskName = "Mask";
  if (n != nullptr) {
    const Json& paths = n->fx().at("mask").at("paths");
    if (paths.is_array()) {
      for (std::size_t i = 0; i < paths.arr().size(); ++i) {
        const Json& p = paths.arr()[i];
        if (p.at("id").is_string() && p.at("id").str() == r->pathId) {
          const Json& nm = p.at("name");
          maskName = !nm.is_undefined() && !nm.is_null() ? (nm.is_string() ? nm.str() : stringify(nm))
                                                         : "Mask " + std::to_string(i + 1);
          break;
        }
      }
    }
  }
  PropertyMeta m;
  m.group = "other";
  if (r->key == "opacity") {
    m.label = maskName + " Opacity";
    m.type = "percent";
    m.unit = "%";
    m.min = 0;
    m.max = 100;
    m.defaultValue = Json::number(100);
  } else if (r->key == "feather") {
    m.label = maskName + " Feather";
    m.type = "number";
    m.unit = "px";
    m.min = 0;
    m.defaultValue = Json::number(0);
  } else {
    m.label = maskName + " Expansion";
    m.type = "number";
    m.unit = "px";
    m.defaultValue = Json::number(0);
  }
  return m;
}

// ── group placeholders ──

std::optional<PropertyMeta> resolve_group_placeholder(std::string_view path) {
  constexpr std::string_view kPrefix = "__static:";
  if (!path.starts_with(kPrefix)) return std::nullopt;
  const std::string_view key = path.substr(kPrefix.size());
  struct G {
    std::string_view key;
    std::string_view label;
    std::string_view rep;
  };
  static constexpr G kGroups[] = {{"anchor", "Anchor Point", "anchorX"},       {"position", "Position", "x"},
                                  {"scale", "Scale", "scaleX"},                {"rotation", "Rotation", "rotation"},
                                  {"orientation", "Orientation", "orientationX"}, {"opacity", "Opacity", "opacity"}};
  for (const G& g : kGroups) {
    if (g.key != key) continue;
    const StaticMeta* rep = registry().meta(g.rep);
    PropertyMeta m;
    m.label = std::string(g.label);
    m.group = rep != nullptr ? rep->group : "transform";
    m.type = "group";
    m.unit = rep != nullptr ? rep->unit : "";
    if (rep != nullptr) {
      m.min = rep->min;
      m.max = rep->max;
      m.defaultValue = rep->defaultValue.is_undefined() ? Json::null() : rep->defaultValue;
      m.displayScale = rep->displayScale;
    }
    return m;
  }
  return std::nullopt;
}

std::optional<PropertyMeta> resolve_control(std::string_view path) {
  if (!path.starts_with("ctrl_")) return std::nullopt;
  PropertyMeta m = number_meta(title_case(path.substr(5)) + " (Control)", "controls", "", Json::number(0));
  return m;
}

std::optional<PropertyMeta> resolve_light_option(std::string_view path, const Node* n) {
  if (path != "intensity" && path != "radius") return std::nullopt;
  if (n == nullptr || n->kind() != "light") return std::nullopt;
  PropertyMeta m;
  m.group = "light";
  if (path == "intensity") {
    m.label = "Intensity";
    m.type = "percent";
    m.unit = "%";
    m.min = 0;
    m.defaultValue = Json::number(100);
  } else {
    m.label = "Radius";
    m.type = "number";
    m.unit = "px";
    m.min = 1;
    m.defaultValue = Json::number(500);
  }
  return m;
}

std::optional<PropertyMeta> resolve_point_of_interest(std::string_view path, const Node* n) {
  const char* axis = path == "poiX" ? "X" : path == "poiY" ? "Y" : path == "poiZ" ? "Z" : nullptr;
  if (axis == nullptr) return std::nullopt;
  const bool light = n != nullptr && n->kind() == "light";
  PropertyMeta m = number_meta(std::string("Point of Interest ") + axis, light ? "light" : "camera", "px", Json::null());
  return m;
}

std::optional<PropertyMeta> resolve_color_channel(std::string_view path, const Node* n) {
  if (path.size() < 3) return std::nullopt;
  const std::string_view suffix = path.substr(path.size() - 2);
  if (suffix != "_r" && suffix != "_g" && suffix != "_b" && suffix != "_a") return std::nullopt;
  const std::string base(path.substr(0, path.size() - 2));
  std::string baseLabel;
  if (base == "fill") baseLabel = "Fill Color";
  else if (base == "stroke") baseLabel = "Stroke Color";
  else if (base == "color") baseLabel = "Color";
  else if (base.starts_with("effect.")) baseLabel = resolve_property_meta(base, n).label;
  else baseLabel = title_case(base);
  const char* ch = suffix == "_r" ? "Red" : suffix == "_g" ? "Green" : suffix == "_b" ? "Blue" : "Alpha";
  PropertyMeta m;
  m.label = baseLabel + " " + ch;
  m.group = base.starts_with("effect.") ? "effects" : base.starts_with("stroke") ? "stroke" : "fill";
  m.type = "colorChannel";
  m.min = 0;
  m.max = 1;
  m.defaultValue = Json::number(1);
  return m;
}

struct AnimParamMeta {
  std::string_view param;
  std::string_view label;
  std::string_view unit;
  std::string_view type;
};
constexpr AnimParamMeta kAnimatorParamMeta[] = {
    {"start", "Start", "%", "percent"},
    {"end", "End", "%", "percent"},
    {"offset", "Offset", "%", "percent"},
    {"amount", "Amount", "%", "percent"},
    {"smoothness", "Smoothness", "%", "percent"},
    {"easeHigh", "Ease High", "%", "percent"},
    {"easeLow", "Ease Low", "%", "percent"},
    {"maxAmount", "Max Amount", "%", "percent"},
    {"minAmount", "Min Amount", "%", "percent"},
    {"wigglesPerSecond", "Wiggles/Second", "Hz", "number"},
    {"wiggleFreq", "Wiggles/Second", "Hz", "number"},
    {"correlation", "Correlation", "%", "percent"},
    {"temporalPhase", "Temporal Phase", "\xC2\xB0", "angle"},
    {"spatialPhase", "Spatial Phase", "\xC2\xB0", "angle"},
    {"x", "Position X", "px", "number"},
    {"y", "Position Y", "px", "number"},
    {"z", "Position Z", "px", "number"},
    {"scale", "Scale X", "%", "percent"},
    {"scaleY", "Scale Y", "%", "percent"},
    {"rotation", "Rotation", "\xC2\xB0", "angle"},
    {"rotationX", "Rotation X", "\xC2\xB0", "angle"},
    {"rotationY", "Rotation Y", "\xC2\xB0", "angle"},
    {"skew", "Skew", "\xC2\xB0", "angle"},
    {"opacity", "Opacity", "%", "percent"},
    {"fillOpacity", "Fill Opacity", "%", "percent"},
    {"tracking", "Tracking", "px", "number"},
    {"lineSpacing", "Line Spacing", "px", "number"},
    {"characterOffset", "Character Offset", "", "number"},
    {"blur", "Blur X", "px", "number"},
    {"blurY", "Blur Y", "px", "number"},
    {"strokeWidth", "Stroke Width", "px", "number"},
    {"anchorX", "Anchor Point X", "px", "number"},
    {"anchorY", "Anchor Point Y", "px", "number"},
    {"anchorZ", "Anchor Point Z", "px", "number"},
    {"skewAxis", "Skew Axis", "\xC2\xB0", "angle"},
    {"lineAnchor", "Line Anchor", "%", "percent"},
    {"characterValue", "Character Value", "", "number"},
    {"fillHue", "Fill Hue", "\xC2\xB0", "angle"},
    {"fillSaturation", "Fill Saturation", "%", "percent"},
    {"fillBrightness", "Fill Brightness", "%", "percent"},
    {"strokeOpacity", "Stroke Opacity", "%", "percent"},
    {"strokeHue", "Stroke Hue", "\xC2\xB0", "angle"},
    {"strokeSaturation", "Stroke Saturation", "%", "percent"},
    {"strokeBrightness", "Stroke Brightness", "%", "percent"},
};

const AnimParamMeta* animator_param_meta(std::string_view p) {
  for (const auto& m : kAnimatorParamMeta) {
    if (m.param == p) return &m;
  }
  return nullptr;
}

std::optional<PropertyMeta> resolve_text_animator(std::string_view path, const Node* n) {
  const auto r = parse_animator_path(path);
  if (!r) return std::nullopt;
  const AnimParamMeta* meta = animator_param_meta(r->param);
  std::optional<int> selIndex = r->selector;
  if (!selIndex && (r->param == "start" || r->param == "end" || r->param == "offset" || r->param == "wiggleFreq")) selIndex = 0;
  std::vector<Json> animators;
  if (n != nullptr) animators = read_animator_data(*n);
  const Json* animator = r->index < static_cast<int>(animators.size()) ? &animators[static_cast<std::size_t>(r->index)] : nullptr;
  std::string animLabel = "Animator " + std::to_string(r->index + 1);
  if (animator != nullptr && !animator->at("name").is_undefined() && !animator->at("name").is_null()) {
    animLabel = animator->at("name").is_string() ? animator->at("name").str() : stringify(animator->at("name"));
  }
  std::string selLabel;
  if (selIndex && animator != nullptr) {
    const Json& sels = animator->at("selectors");
    if (sels.is_array() && sels.arr().size() > 1) {
      const auto si = static_cast<std::size_t>(*selIndex);
      std::string kind = "range";
      if (si < sels.arr().size() && sels.arr()[si].at("kind").is_string()) kind = sels.arr()[si].at("kind").str();
      const char* kl = kind == "wiggly" ? "Wiggly" : kind == "expression" ? "Expression" : "Range";
      selLabel = std::string(kl) + " Selector " + std::to_string(*selIndex + 1) + " ";
    }
  }
  std::string paramLabel;
  if (meta != nullptr) paramLabel = std::string(meta->label);
  else if (auto tag = axis_tag_of_param(r->param)) paramLabel = "Font Axis " + *tag;
  else paramLabel = title_case(r->param);
  PropertyMeta m;
  m.label = animLabel + " " + selLabel + paramLabel;
  m.group = "text";
  m.type = meta != nullptr ? std::string(meta->type) : "number";
  m.unit = meta != nullptr ? std::string(meta->unit) : "";
  return m;
}

std::optional<PropertyMeta> resolve_text_option(std::string_view path) {
  if (auto tag = parse_axis_prop_path(path)) {
    PropertyMeta m;
    m.label = "Font Axis " + *tag;
    m.group = "text";
    m.type = "number";
    return m;
  }
  if (!path.starts_with("textPath.")) return std::nullopt;
  const std::string_view param = path.substr(9);
  const char* label = param == "firstMargin"      ? "First Margin"
                      : param == "lastMargin"     ? "Last Margin"
                      : param == "reversed"       ? "Reverse Path"
                      : param == "perpendicular"  ? "Perpendicular To Path"
                      : param == "forceAlignment" ? "Force Alignment"
                                                  : nullptr;
  if (label == nullptr) return std::nullopt;
  const bool flag = param == "reversed" || param == "perpendicular" || param == "forceAlignment";
  PropertyMeta m;
  m.label = std::string("Path Options ") + label;
  m.group = "text";
  m.type = flag ? "boolean" : "number";
  m.unit = flag ? "" : "px";
  if (flag) {
    m.min = 0;
    m.max = 1;
  }
  return m;
}

std::optional<PropertyMeta> resolve_effect_param(std::string_view path, const Node* n) {
  if (!path.starts_with("effect.")) return std::nullopt;
  const std::string_view tail = path.substr(7);
  if (tail.empty()) return std::nullopt;
  const std::size_t dot = tail.find('.');
  const std::string effectId(dot == std::string_view::npos ? tail : tail.substr(0, dot));
  if (effectId.empty()) return std::nullopt;
  std::optional<std::string> rawKey;
  if (dot != std::string_view::npos) {
    if (dot + 1 >= tail.size()) return std::nullopt;  // `effect.x.` does not match
    rawKey = std::string(tail.substr(dot + 1));
  }
  const auto styleKey = style_key_from_effect_id(effectId);
  const EffectDef* def = nullptr;
  if (styleKey) {
    const Json& type = registry().layerStyles.at("effectType").at(*styleKey);
    def = type.is_string() ? registry().effect(type.str()) : nullptr;
  } else if (n != nullptr) {
    const std::vector<Json> effects = read_node_effects(*n);
    if (const Json* fx = find_by_id(effects, effectId)) def = registry().effect(fx->at("type").str());
  }
  if (rawKey && *rawKey == kEffectOpacityKey) {
    std::optional<std::string> owner;
    if (styleKey) {
      const Json& l = registry().layerStyles.at("label").at(*styleKey);
      owner = l.is_string() ? l.str() : title_case(*styleKey);
    } else if (def != nullptr) {
      owner = def->label;
    }
    PropertyMeta m = number_meta(owner ? *owner + " Effect Opacity" : "Effect Opacity", "effects", "%", Json::number(100));
    m.min = 0;
    m.max = 100;
    return m;
  }
  std::optional<std::string> key = rawKey;
  if (!key && def != nullptr) {
    if (const EffectParamDef* p = def->primary()) key = p->key;
  }
  if (!key) return number_meta("Effect", "effects", "", Json::number(0));
  if (def != nullptr) {
    if (const EffectParamDef* p = def->param(*key)) {
      if (styleKey) {
        const Json& l = registry().layerStyles.at("label").at(*styleKey);
        const std::string styleLabel = l.is_string() ? l.str() : title_case(*styleKey);
        const auto field = style_field_for_param(*styleKey, *key);
        PropertyMeta m = from_effect_param(styleLabel, *p);
        m.label = styleLabel + " " + (field ? title_case(*field) : p->label);
        return m;
      }
      return from_effect_param(def->label, *p);
    }
  }
  for (const EffectDef& d : registry().effects) {
    if (const EffectParamDef* p = d.param(*key)) return from_effect_param(d.label, *p);
  }
  return number_meta(title_case(*key), "effects", "", Json::number(0));
}

std::optional<PropertyMeta> resolve_path_op(std::string_view path, const Node* n) {
  const auto r = parse_prefixed_id_rest(path, "pathop.");
  if (!r) return std::nullopt;
  const std::string& param = r->rest;
  std::string type = "none";
  if (n != nullptr) {
    const Json& ops = n->fx().at("pathOps");
    if (ops.is_array()) {
      for (const Json& o : ops.arr()) {
        if (o.at("id").is_string() && o.at("id").str() == r->id) {
          type = o.at("type").is_string() ? o.at("type").str() : "none";
          break;
        }
      }
    }
  }
  struct L {
    std::string_view type;
    std::string_view param;
    std::string_view label;
  };
  static constexpr L kParamLabels[] = {
      {"roundCorners", "amount", "Radius"},  {"roundCorners", "detail", "Steps"},
      {"pucker", "amount", "Amount"},        {"twist", "amount", "Angle"},
      {"offset", "amount", "Amount"},        {"offset", "miterLimit", "Miter Limit"},
      {"roughen", "amount", "Size"},         {"roughen", "detail", "Detail"},
      {"zigzag", "amount", "Amount"},        {"zigzag", "detail", "Ridges"},
      {"repeater", "copies", "Copies"},      {"repeater", "offset", "Offset"},
      {"repeater", "anchorX", "Anchor X"},   {"repeater", "anchorY", "Anchor Y"},
      {"repeater", "offsetX", "Position X"}, {"repeater", "offsetY", "Position Y"},
      {"repeater", "offsetRotation", "Rotation"}, {"repeater", "offsetScale", "Scale"},
      {"repeater", "offsetOpacity", "Opacity"},   {"wiggleTransform", "amount", "Position"},
      {"wiggleTransform", "wiggleRotation", "Rotation"}, {"wiggleTransform", "wiggleScale", "Scale"},
      {"wiggleTransform", "anchorX", "Anchor X"},        {"wiggleTransform", "anchorY", "Anchor Y"},
      {"wiggleTransform", "wigglesPerSecond", "Wiggles/Second"},
      {"wiggleTransform", "correlation", "Correlation"},
  };
  std::string label = title_case(param);
  for (const L& l : kParamLabels) {
    if (l.type == type && l.param == param) label = std::string(l.label);
  }
  struct T {
    std::string_view type;
    std::string_view label;
  };
  static constexpr T kTypeLabels[] = {{"zigzag", "Zig-Zag"},        {"roundCorners", "Round Corners"},
                                      {"pucker", "Pucker & Bloat"}, {"twist", "Twist"},
                                      {"offset", "Offset Paths"},   {"roughen", "Wiggle Paths"},
                                      {"trim", "Trim Paths"},       {"repeater", "Repeater"},
                                      {"wiggleTransform", "Wiggle Transform"}, {"none", "Path Operator"}};
  std::string typeLabel = "Path Operator";
  for (const T& t : kTypeLabels) {
    if (t.type == type) typeLabel = std::string(t.label);
  }
  const bool pct = type == "trim" && (param == "start" || param == "end" || param == "offset");
  PropertyMeta m;
  m.label = typeLabel + " " + label;
  m.group = type == "repeater" ? "repeater" : "trim";
  m.type = pct ? "percent" : "number";
  m.unit = pct ? "%" : "";
  if (pct) {
    m.min = -100;
    m.max = 200;
  }
  m.defaultValue = Json::number(param == "end" ? 100 : 0);
  if (type == "repeater") {
    struct R {
      std::string_view param;
      std::optional<std::string_view> unit;
      std::optional<double> min;
      std::optional<double> max;
      std::optional<double> dflt;
    };
    static const R kRep[] = {
        {"copies", std::nullopt, 1, 200, 6},
        {"offset", std::nullopt, std::nullopt, std::nullopt, 0},
        {"anchorX", "px", std::nullopt, std::nullopt, std::nullopt},
        {"anchorY", "px", std::nullopt, std::nullopt, std::nullopt},
        {"offsetX", "px", std::nullopt, std::nullopt, 80},
        {"offsetY", "px", std::nullopt, std::nullopt, std::nullopt},
        {"offsetRotation", "\xC2\xB0", std::nullopt, std::nullopt, std::nullopt},
        {"offsetScale", std::nullopt, 0, std::nullopt, 1},
        {"offsetOpacity", std::nullopt, 0, 1, 1},
    };
    for (const R& x : kRep) {
      if (x.param != param) continue;
      if (x.unit) m.unit = std::string(*x.unit);
      if (x.min) m.min = x.min;
      if (x.max) m.max = x.max;
      if (x.dflt) m.defaultValue = Json::number(*x.dflt);
    }
  } else if (type == "offset" && param == "miterLimit") {
    m.min = 1;
    m.defaultValue = Json::number(4);
  }
  return m;
}

std::optional<PropertyMeta> resolve_polystar(std::string_view path) {
  if (!path.starts_with("polystar.")) return std::nullopt;
  const std::string_view p = path.substr(9);
  struct P {
    std::string_view param;
    std::string_view label;
    std::string_view unit;
    std::optional<double> min;
    std::optional<double> max;
    double dflt;
  };
  static const P kMeta[] = {
      {"points", "Points", "", 3, 100, 5},
      {"rotation", "Rotation", "\xC2\xB0", std::nullopt, std::nullopt, 0},
      {"outerRadius", "Outer Radius", "px", 0, std::nullopt, 100},
      {"innerRadius", "Inner Radius", "px", 0, std::nullopt, 50},
      {"outerRoundness", "Outer Roundness", "%", std::nullopt, std::nullopt, 0},
      {"innerRoundness", "Inner Roundness", "%", std::nullopt, std::nullopt, 0},
  };
  for (const P& x : kMeta) {
    if (x.param != p) continue;
    PropertyMeta m = number_meta("Polystar " + std::string(x.label), "trim", std::string(x.unit), Json::number(x.dflt));
    m.min = x.min;
    m.max = x.max;
    return m;
  }
  return std::nullopt;
}

std::optional<PropertyMeta> run_resolvers(std::string_view path, const Node* n) {
  if (auto m = resolve_stroke_stack(path, n)) return m;
  if (auto m = resolve_paint(path, n)) return m;
  if (auto m = resolve_mask(path, n)) return m;
  if (auto m = resolve_group_placeholder(path)) return m;
  if (auto m = resolve_control(path)) return m;
  if (auto m = resolve_light_option(path, n)) return m;
  if (auto m = resolve_point_of_interest(path, n)) return m;
  if (auto m = resolve_color_channel(path, n)) return m;
  if (auto m = resolve_text_animator(path, n)) return m;
  if (auto m = resolve_text_option(path)) return m;
  if (auto m = resolve_effect_param(path, n)) return m;
  // resolvePluginParam: plugin UI params are an editor surface (no plugins in the engine).
  if (auto m = resolve_path_op(path, n)) return m;
  if (auto m = resolve_polystar(path)) return m;
  return std::nullopt;
}

}  // namespace

std::string stroke_track_path(std::size_t index, std::string_view param) {
  if (index == 0) {
    for (const auto& [p, name] : kPrimaryTracks) {
      if (p == param) return std::string(name);
    }
    return "stroke";
  }
  return "stroke." + std::to_string(index) + "." + std::string(param);
}

std::optional<StrokeTrackRef> parse_stroke_track_path(std::string_view path) {
  if (path.size() == 8 && path.starts_with("stroke_") &&
      (path[7] == 'r' || path[7] == 'g' || path[7] == 'b' || path[7] == 'a')) {
    return StrokeTrackRef{0, "color", std::string(path.substr(6))};
  }
  for (const auto& [p, name] : kPrimaryTracks) {
    if (p != "color" && name == path) return StrokeTrackRef{0, std::string(p), ""};
  }
  if (!path.starts_with("stroke.")) return std::nullopt;
  const std::string_view rest = path.substr(7);
  const std::size_t dot = rest.find('.');
  if (dot == std::string_view::npos) return std::nullopt;
  const auto index = parse_index(rest.substr(0, dot));
  if (!index || *index < 1) return std::nullopt;
  std::string_view tail = rest.substr(dot + 1);
  std::string channel;
  if (tail.size() > 2 && tail[tail.size() - 2] == '_') {
    const char c = tail.back();
    if (c == 'r' || c == 'g' || c == 'b' || c == 'a') {
      channel = std::string(tail.substr(tail.size() - 2));
      tail = tail.substr(0, tail.size() - 2);
    }
  }
  if (tail.empty()) return std::nullopt;
  for (const char c : tail) {
    if (!is_ascii_alnum(c)) return std::nullopt;
  }
  if (!is_stroke_param(tail)) return std::nullopt;
  if (!channel.empty()) {
    if (tail != "color") return std::nullopt;
    return StrokeTrackRef{static_cast<std::size_t>(*index), "color", channel};
  }
  if (tail == "color") return std::nullopt;
  return StrokeTrackRef{static_cast<std::size_t>(*index), std::string(tail), ""};
}

PropertyMeta resolve_property_meta(std::string_view path, const Node* node) {
  if (const StaticMeta* s = registry().meta(path)) {
    PropertyMeta m = from_static(*s);
    return node != nullptr && s->group == "stroke" ? with_stroke_units(std::move(m), path, node) : m;
  }
  if (auto m = run_resolvers(path, node)) return std::move(*m);
  PropertyMeta m;
  m.label = title_case(path);
  m.group = "other";
  m.type = "number";
  return m;
}

bool has_property_meta(std::string_view path, const Node* node) {
  return registry().meta(path) != nullptr || run_resolvers(path, node).has_value();
}

}  // namespace premation::doc
