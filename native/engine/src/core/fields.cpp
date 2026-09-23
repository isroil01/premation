#include "fields.hpp"

#include <array>
#include <cmath>
#include <tuple>

#include "catalog_data.hpp"
#include "fail.hpp"
#include "fxstate.hpp"
#include "meta.hpp"
#include "scene.hpp"
#include "strutil.hpp"

namespace premation::doc {
namespace {

using api::ErrorCode;
using api::ValueType;
using js::stringify;

const Json& fields_of(std::string_view owner) { return registry().fields.at(owner); }

const Json* spec_in(const Json& list, std::string_view key) {
  if (!list.is_array()) return nullptr;
  for (const Json& s : list.arr()) {
    if (s.at("key").is_string() && s.at("key").str() == key) return &s;
  }
  return nullptr;
}

ValueType type_of_spec(const Json& spec) {
  const std::string& t = spec.at("type").str();
  if (t == "string") return ValueType::string;
  if (t == "choice") return ValueType::choice;
  if (t == "bool") return ValueType::bool_;
  if (t == "scalar") return ValueType::scalar;
  if (t == "color") return ValueType::color;
  if (t == "scalars") return ValueType::scalars;
  if (t == "json") return ValueType::json;
  return ValueType::none;
}

api::Value color_value(std::string_view hex) {
  const auto c = parse_color_channels(hex);
  return v_color(c[0], c[1], c[2], c[3]);
}

std::string js_string(const Json& v) {
  if (v.is_string()) return v.str();
  if (v.is_number()) return js::number_to_string(v.num());
  if (v.is_bool()) return v.b() ? "true" : "false";
  return stringify(v);
}

/// fields.ts `specValue(spec, raw)`.
api::Value spec_value(const Json& spec, const Json& raw) {
  const Json& def = spec.at("default");
  const Json& v = raw.is_undefined() ? def : raw;
  switch (type_of_spec(spec)) {
    case ValueType::string: return v_string(v.is_string() ? v.str() : js_string(def));
    case ValueType::choice: return v_choice(v.is_string() ? v.str() : js_string(def));
    case ValueType::bool_: return v_bool(v.is_bool() ? v.b() : (def.is_bool() && def.b()));
    case ValueType::scalar: return v_scalar(v.is_finite_number() ? v.num() : def.num());
    case ValueType::color: return color_value(v.is_string() && is_hex_color(v.str()) ? v.str() : js_string(def));
    case ValueType::scalars: {
      api::F64List out;
      if (v.is_array()) {
        for (const Json& x : v.arr()) {
          if (x.is_number()) out.values.push_back(x.num());
        }
      }
      return make_value<VK::scalars>(std::move(out));
    }
    case ValueType::json: return v_json(stringify(v.is_undefined() ? Json::null() : v));
    default: return v_none();
  }
}

PropBinding field_binding(std::string path, const Json& spec, FieldRef field) {
  PropBinding b;
  b.path = std::move(path);
  b.name = spec.at("label").str();
  b.matchName = spec.at("key").str();
  b.valueType = type_of_spec(spec);
  b.special = Special::field;
  b.field = std::move(field);
  b.animatable = false;
  b.min = spec.number_at("min");
  b.max = spec.number_at("max");
  if (spec.at("choices").is_array()) {
    b.choices = std::vector<std::string>{};
    for (const Json& c : spec.at("choices").arr()) b.choices->push_back(c.str());
  }
  b.defaultValue = spec_value(spec, Json());
  return b;
}

// ── the layer's fill colour ──────────────────────────────────────────────

std::optional<std::string> paint_type(const Json& v) {
  if (!v.is_object()) return std::nullopt;
  const Json& t = v.at("type");
  if (t.is_string() && (t.str() == "solid" || t.str() == "linear" || t.str() == "radial")) return t.str();
  return std::nullopt;
}

struct StringFill {
  std::string componentId;
  std::string hex;
};

std::optional<StringFill> string_fill(const Node& n) {
  for (const Component& c : n.components) {
    const Json& f = c.props.at("fill");
    if (f.is_string()) return StringFill{c.id, f.str()};
  }
  return std::nullopt;
}

/// A layer that carries a fill: a Style or Text component, or a paint on its fx.
bool has_paint_host(const Node& n) {
  return n.comp("Style") != nullptr || n.comp("Text") != nullptr || !n.fx().at("fill").is_undefined() ||
         !n.fx().at("fills").is_undefined();
}

/// fill.ts `setNodeFills`: the stack (kept only when > 1) and its mirror in the single slot.
void set_fill_stack(Document& d, std::string_view layer, const std::vector<Json>& fills) {
  sg_set_fx(d, layer, "fills", fills.size() > 1 ? Json::array(fills) : Json());
  sg_set_fx(d, layer, "fill", fills.empty() ? Json() : fills[0]);
}

/// fill.ts `setNodeFill`: the primary fill; with a stack, its first entry (undefined drops it from the stack).
void set_primary_fill(Document& d, std::string_view layer, const Json& paint) {
  const Json& stack = d.node(layer)->fx().at("fills");
  std::vector<Json> valid;
  if (stack.is_array()) {
    for (const Json& p : stack.arr()) {
      if (paint_type(p)) valid.push_back(p);
    }
  }
  if (!valid.empty()) {
    std::vector<Json> next;
    if (!paint.is_undefined()) next.push_back(paint);
    for (std::size_t i = 1; i < valid.size(); ++i) next.push_back(valid[i]);
    set_fill_stack(d, layer, next);
    return;
  }
  sg_set_fx(d, layer, "fill", paint);
}

bool has_fill_color(const Node& n) {
  if (auto t = paint_type(n.fx().at("fill"))) return *t == "solid";
  return string_fill(n).has_value() || n.comp("Text") != nullptr;
}

api::Value read_layer_fill(const Node& n) {
  const Json& paint = n.fx().at("fill");
  if (paint_type(paint) == std::optional<std::string>("solid")) {
    const Json& c = paint.at("color");
    return color_value(c.is_string() ? c.str() : "#ffffff");
  }
  if (auto s = string_fill(n)) return color_value(s->hex);
  const Component* text = n.comp("Text");
  const Json& legacy = text != nullptr ? text->props.at("color") : Json::null();
  return color_value(legacy.is_string() && is_hex_color(legacy.str()) ? legacy.str() : "#ffffff");
}

void write_layer_fill(Document& d, std::string_view layer, const std::string& hex) {
  const Node& n = *d.node(layer);
  const Json paint = n.fx().at("fill");
  const auto type = paint_type(paint);
  if (type == std::optional<std::string>("solid")) {
    Json next = paint;
    next.set("color", Json::string(hex));
    const Json stack = n.fx().at("fills");
    if (stack.is_array() && stack.arr().size() > 1) {
      Json fills = Json::array();
      fills.arr_mut().push_back(next);
      for (std::size_t i = 1; i < stack.arr().size(); ++i) fills.arr_mut().push_back(stack.arr()[i]);
      sg_set_fx(d, layer, "fills", std::move(fills));
    }
    sg_set_fx(d, layer, "fill", std::move(next));
    return;
  }
  if (type) {
    fail(ErrorCode::invalid_argument, "layer '" + std::string(layer) + "' has a gradient fill; its colour is a gradient",
         {.layer = std::string(layer), .path = "layer/fill"});
  }
  if (auto s = string_fill(n)) {
    (void)sg_write_prop(d, layer, s->componentId, "fill", Json::string(hex));
    return;
  }
  const Component* text = n.comp("Text");
  if (text == nullptr) fail(ErrorCode::not_found, "layer '" + std::string(layer) + "' has no fill", {.layer = std::string(layer), .path = "layer/fill"});
  const std::string cid = text->id;
  (void)sg_write_prop(d, layer, cid, "fill", Json::string(hex));
}

// ── animator / selector lookup ───────────────────────────────────────────

struct AnimLoc {
  std::vector<Json> data;
  int index = -1;
  int sel = -1;
};

AnimLoc locate_animator(const Node& n, const FieldRef& f) {
  AnimLoc out;
  out.data = read_animator_data(n);
  for (std::size_t i = 0; i < out.data.size(); ++i) {
    const Json& id = out.data[i].at("id");
    if (f.animatorId && id.is_string() && id.str() == *f.animatorId) {
      out.index = static_cast<int>(i);
      break;
    }
  }
  if (out.index >= 0 && f.selectorId) {
    const Json& sels = out.data[static_cast<std::size_t>(out.index)].at("selectors");
    if (sels.is_array()) {
      for (std::size_t j = 0; j < sels.arr().size(); ++j) {
        const Json& id = sels.arr()[j].at("id");
        if (id.is_string() && id.str() == *f.selectorId) {
          out.sel = static_cast<int>(j);
          break;
        }
      }
    }
  }
  return out;
}

// ── writes ───────────────────────────────────────────────────────────────

/// fields.ts `storedValue`: the raw value to store (undefined = clear).
Json stored_value(const PropBinding& b, const Json& spec, const api::Value& value) {
  const ValueType t = type_of_spec(spec);
  auto mismatch = [&]() {
    fail(ErrorCode::type_mismatch,
         "'" + b.path + "' takes a " + std::string(value_type_name(t)) + ", got " + std::string(kind_name(value.kind())),
         {.path = b.path, .detail = "{\"expected\":\"" + std::string(value_type_name(t)) + "\"}"});
  };
  auto finite = [&](double x) {
    if (!std::isfinite(x)) fail(ErrorCode::invalid_argument, "'" + b.path + "': value must be finite", {.path = b.path});
  };
  Json raw;
  switch (t) {
    case ValueType::string:
      if (value.kind() != VK::string) mismatch();
      raw = Json::string(get<VK::string>(value));
      break;
    case ValueType::choice: {
      if (value.kind() != VK::choice) mismatch();
      const std::string& v = get<VK::choice>(value);
      bool ok = false;
      for (const Json& c : spec.at("choices").arr()) ok = ok || (c.is_string() && c.str() == v);
      if (!ok) {
        fail(ErrorCode::out_of_range, "'" + v + "' is not a choice of '" + b.path + "'",
             {.path = b.path, .detail = "{\"choices\":" + stringify(spec.at("choices")) + "}"});
      }
      raw = Json::string(v);
      break;
    }
    case ValueType::bool_:
      if (value.kind() != VK::bool_) mismatch();
      raw = Json::boolean(get<VK::bool_>(value));
      break;
    case ValueType::scalar: {
      if (value.kind() != VK::scalar) mismatch();
      const double v = get<VK::scalar>(value);
      finite(v);
      const auto lo = spec.number_at("min");
      const auto hi = spec.number_at("max");
      if ((lo && v < *lo) || (hi && v > *hi)) {
        fail(ErrorCode::out_of_range, "'" + b.path + "': " + js::number_to_string(v) + " is outside its range", {.path = b.path});
      }
      raw = Json::number(v);
      break;
    }
    case ValueType::color: {
      if (value.kind() != VK::color) mismatch();
      const api::Color& c = get<VK::color>(value);
      finite(c.r);
      finite(c.g);
      finite(c.b);
      finite(c.a);
      raw = Json::string(channels_to_color(c.r, c.g, c.b, c.a));
      break;
    }
    case ValueType::scalars: {
      if (value.kind() != VK::scalars) mismatch();
      Json arr = Json::array();
      for (const double x : get<VK::scalars>(value).values) {
        if (!std::isfinite(x)) fail(ErrorCode::invalid_argument, "'" + b.path + "': values must be finite", {.path = b.path});
        arr.arr_mut().push_back(Json::number(x));
      }
      raw = std::move(arr);
      break;
    }
    case ValueType::json: {
      if (value.kind() != VK::json) mismatch();
      auto parsed = js::parse(get<VK::json>(value));
      if (!parsed) fail(ErrorCode::invalid_argument, "invalid json", {.path = b.path});
      raw = parsed->is_null() ? Json() : std::move(*parsed);
      break;
    }
    default:
      mismatch();
  }
  if (spec.at("clearAtDefault").is_bool() && spec.at("clearAtDefault").b() && !raw.is_undefined() &&
      stringify(raw) == stringify(spec.at("default"))) {
    return Json();
  }
  return raw;
}

bool contains_str(const Json& list, std::string_view v) {
  if (!list.is_array()) return false;
  for (const Json& x : list.arr()) {
    if (x.is_string() && x.str() == v) return true;
  }
  return false;
}

}  // namespace

const Json* field_spec(const FieldRef& f) {
  if (f.owner == "text") return spec_in(fields_of("text"), f.key);
  if (f.owner == "animator") {
    if (const Json* s = spec_in(fields_of("animator"), f.key)) return s;
    return spec_in(fields_of("animatorOptional"), f.key);
  }
  if (f.owner == "selector") return spec_in(fields_of("selector"), f.key);
  return nullptr;
}

void add_field_bindings(const Node& node, std::string_view layerId, const std::vector<Json>& animators,
                        const std::function<void(PropBinding)>& add,
                        const std::function<bool(std::string_view)>& has) {
  (void)layerId;
  const Component* text = node.comp("Text");
  if (text != nullptr) {
    static constexpr std::array<std::pair<std::string_view, std::string_view>, 3> kAxes{
        {{"wght", "fontWeight"}, {"wdth", "fontWidth"}, {"slnt", "fontSlant"}}};
    for (const auto& [tag, member] : kAxes) {
      std::string path = "text/axes/" + std::string(tag);
      if (has(path)) continue;
      const PropertyMeta meta = resolve_property_meta(member, &node);
      PropBinding b;
      b.path = std::move(path);
      b.name = meta.label;
      b.matchName = std::string(member);
      b.valueType = ValueType::scalar;
      b.members = {std::string(member)};
      b.unit = meta.unit;
      b.min = meta.min;
      b.max = meta.max;
      if (meta.defaultValue.is_number()) b.defaultValue = v_scalar(meta.defaultValue.num());
      add(std::move(b));
    }
    for (const Json& spec : fields_of("text").arr()) {
      const std::string key = spec.at("key").str();
      add(field_binding("text/" + key, spec, FieldRef{"text", key, std::nullopt, std::nullopt}));
    }
    {
      PropBinding b;
      b.path = "text/styleRuns";
      b.name = "Character Styles";
      b.matchName = "styleRuns";
      b.valueType = ValueType::json;
      b.special = Special::field;
      b.field = FieldRef{"styleRuns", "", std::nullopt, std::nullopt};
      b.animatable = false;
      b.defaultValue = v_json("[]");
      add(std::move(b));
    }
    {
      PropBinding b;
      b.path = "text/pathOptions/path";
      b.name = "Path";
      b.matchName = "ADBE Text Path";
      b.valueType = ValueType::string;
      b.special = Special::field;
      b.field = FieldRef{"textPath", "", std::nullopt, std::nullopt};
      b.animatable = false;
      b.defaultValue = v_string("");
      add(std::move(b));
    }
    // The layer box a text layer wraps within (the Transform's width / height).
    for (const char* key : {"width", "height"}) {
      std::string path = std::string("layer/") + key;
      if (has(path)) continue;
      const PropertyMeta meta = resolve_property_meta(key, &node);
      PropBinding b;
      b.path = std::move(path);
      b.name = meta.label;
      b.matchName = key;
      b.valueType = ValueType::scalar;
      b.members = {std::string(key)};
      b.animatable = meta.keyframeable;
      b.unit = meta.unit;
      b.min = meta.min;
      b.max = meta.max;
      if (meta.defaultValue.is_number()) b.defaultValue = v_scalar(meta.defaultValue.num());
      add(std::move(b));
    }
  }
  for (std::size_t i = 0; i < animators.size(); ++i) {
    const Json& a = animators[i];
    const std::string aid = a.at("id").is_string() ? a.at("id").str() : "undefined";
    const std::string base = "text/animators/" + aid + "/props";
    const std::string blurY = base + "/blurY";
    if (!has(blurY)) {
      const std::string m = animator_prop_path(i, "blurY");
      const PropertyMeta meta = resolve_property_meta(m, &node);
      PropBinding b;
      b.path = blurY;
      b.name = meta.label.empty() ? std::string("Blur Y") : meta.label;
      b.matchName = m;
      b.valueType = ValueType::scalar;
      b.members = {m};
      b.unit = meta.unit;
      add(std::move(b));
    }
    for (const Json& spec : fields_of("animator").arr()) {
      const std::string key = spec.at("key").str();
      add(field_binding(base + "/" + key, spec, FieldRef{"animator", key, aid, std::nullopt}));
    }
    for (const Json& spec : fields_of("animatorOptional").arr()) {
      const std::string key = spec.at("key").str();
      if (!a.at(key).is_string()) continue;
      add(field_binding(base + "/" + key, spec, FieldRef{"animator", key, aid, std::nullopt}));
    }
    const Json& sels = a.at("selectors");
    if (!sels.is_array()) continue;
    for (const Json& s : sels.arr()) {
      const std::string sid = s.at("id").is_string() ? s.at("id").str() : "undefined";
      const std::string kind = s.at("kind").is_string() ? s.at("kind").str() : "range";
      const std::string sbase = "text/animators/" + aid + "/selectors/" + sid;
      for (const Json& spec : fields_of("selector").arr()) {
        if (spec.at("kinds").is_array() && !contains_str(spec.at("kinds"), kind)) continue;
        const std::string key = spec.at("key").str();
        add(field_binding(sbase + "/" + key, spec, FieldRef{"selector", key, aid, sid}));
      }
    }
  }
  if (has_paint_host(node)) {
    for (const auto& [path, owner, def] : {std::tuple<const char*, const char*, const char*>{"layer/fillPaint", "fillPaint", "null"},
                                           std::tuple<const char*, const char*, const char*>{"layer/fills", "fills", "[]"}}) {
      PropBinding b;
      b.path = path;
      b.name = std::string(owner) == "fills" ? "Fills" : "Fill Paint";
      b.matchName = owner;
      b.valueType = ValueType::json;
      b.special = Special::field;
      b.field = FieldRef{owner, "", std::nullopt, std::nullopt};
      b.animatable = false;
      b.defaultValue = v_json(def);
      add(std::move(b));
    }
  }
  if (has_fill_color(node)) {
    PropBinding b;
    b.path = "layer/fill";
    b.name = "Fill Color";
    b.matchName = "ADBE Fill Color";
    b.valueType = ValueType::color;
    b.members = {"fill_r", "fill_g", "fill_b", "fill_a"};
    b.colorBase = "fill";
    b.special = Special::layerFill;
    add(std::move(b));
  }
}

api::Value read_field(const Node& node, const PropBinding& b) {
  if (b.special == Special::layerFill) return read_layer_fill(node);
  const FieldRef& f = *b.field;
  const Component* text = node.comp("Text");
  const Json& tp = text != nullptr ? text->props : Json::null();
  if (f.owner == "styleRuns") {
    const Json& runs = tp.at("__runs");
    return v_json(runs.is_array() ? stringify(runs) : std::string("[]"));
  }
  if (f.owner == "fillPaint") {
    const Json& paint = node.fx().at("fill");
    return v_json(paint_type(paint) ? stringify(paint) : std::string("null"));
  }
  if (f.owner == "fills") {
    const Json& stack = node.fx().at("fills");
    return v_json(stack.is_array() ? stringify(stack) : std::string("[]"));
  }
  if (f.owner == "textPath") {
    const auto cfg = read_text_path_config(node);
    if (!cfg) return v_string("");
    const std::string& pid = cfg->at("pathId").str();
    if (!pid.empty()) return v_string(pid);
    const auto mask = read_node_mask(node);
    if (mask && !mask->at("paths").arr().empty()) {
      const Json& id = mask->at("paths").arr()[0].at("id");
      return v_string(id.is_string() ? id.str() : std::string());
    }
    return v_string("");
  }
  const Json* spec = field_spec(f);
  if (spec == nullptr) return v_none();
  if (f.owner == "text") return spec_value(*spec, tp.at(f.key));
  const AnimLoc loc = locate_animator(node, f);
  if (f.owner == "animator") {
    return spec_value(*spec, loc.index >= 0 ? loc.data[static_cast<std::size_t>(loc.index)].at(f.key) : Json());
  }
  if (f.owner == "selector") {
    if (loc.index < 0 || loc.sel < 0) return spec_value(*spec, Json());
    const Json& s = loc.data[static_cast<std::size_t>(loc.index)].at("selectors").arr()[static_cast<std::size_t>(loc.sel)];
    return spec_value(*spec, s.at(f.key));
  }
  return v_none();
}

void drop_track_props(Document& d, std::string_view layer, const std::set<std::string>& props) {
  const NodeAnim* a = d.anim(layer);
  if (a == nullptr) return;
  bool any = false;
  for (const auto& p : props) any = any || a->tracks.contains(p) || a->exprs.contains(p) || a->data.contains(p);
  if (!any) return;
  NodeAnim next = *a;
  for (const auto& p : props) {
    (void)next.tracks.erase(p);
    (void)next.exprs.erase(p);
    (void)next.data.erase(p);
  }
  if (next.empty()) d.set_anim(layer, std::nullopt);
  else d.set_anim(layer, std::move(next));
}

void write_field(Document& d, std::string_view layer, const PropBinding& b, const api::Value& value) {
  const std::string L(layer);
  if (b.special == Special::layerFill) {
    if (value.kind() != VK::color) {
      fail(ErrorCode::type_mismatch, "'" + b.path + "' takes a color, got " + std::string(kind_name(value.kind())),
           {.path = b.path, .detail = "{\"expected\":\"color\"}"});
    }
    const api::Color& c = get<VK::color>(value);
    if (!std::isfinite(c.r) || !std::isfinite(c.g) || !std::isfinite(c.b) || !std::isfinite(c.a)) {
      fail(ErrorCode::invalid_argument, "'" + b.path + "': value must be finite", {.path = b.path});
    }
    write_layer_fill(d, layer, channels_to_color(c.r, c.g, c.b, c.a));
    return;
  }
  const FieldRef& f = *b.field;
  const Node& node = *d.node(layer);
  const Component* text = node.comp("Text");
  const std::string textId = text != nullptr ? text->id : std::string();
  if (f.owner == "styleRuns") {
    if (value.kind() != VK::json) {
      fail(ErrorCode::type_mismatch, "'" + b.path + "' takes json, got " + std::string(kind_name(value.kind())),
           {.path = b.path, .detail = "{\"expected\":\"json\"}"});
    }
    auto runs = js::parse(get<VK::json>(value));
    if (!runs) fail(ErrorCode::invalid_argument, "invalid json", {.path = b.path});
    if (!runs->is_array()) fail(ErrorCode::invalid_argument, "'" + b.path + "' takes a JSON array of runs", {.path = b.path});
    if (text == nullptr) fail(ErrorCode::not_found, "not a text layer", {.layer = L});
    (void)sg_write_prop(d, layer, textId, "__runsIndex", Json::string("grapheme"));
    (void)sg_write_prop(d, layer, textId, "__runs", std::move(*runs));
    return;
  }
  if (f.owner == "fillPaint" || f.owner == "fills") {
    if (value.kind() != VK::json) {
      fail(ErrorCode::type_mismatch, "'" + b.path + "' takes json, got " + std::string(kind_name(value.kind())),
           {.path = b.path, .detail = "{\"expected\":\"json\"}"});
    }
    auto v = js::parse(get<VK::json>(value));
    if (!v) fail(ErrorCode::invalid_argument, "invalid json", {.path = b.path});
    if (f.owner == "fillPaint") {
      if (!v->is_null() && !paint_type(*v)) {
        fail(ErrorCode::invalid_argument, "'" + b.path + "' takes null or a paint {type: solid | linear | radial}", {.path = b.path});
      }
      set_primary_fill(d, layer, v->is_null() ? Json() : *v);
      return;
    }
    bool ok = v->is_array();
    if (ok) {
      for (const Json& p : v->arr()) ok = ok && paint_type(p).has_value();
    }
    if (!ok) fail(ErrorCode::invalid_argument, "'" + b.path + "' takes an array of paints {type: solid | linear | radial}", {.path = b.path});
    set_fill_stack(d, layer, v->arr());
    return;
  }
  if (f.owner == "textPath") {
    if (value.kind() != VK::string) {
      fail(ErrorCode::type_mismatch, "'" + b.path + "' takes a string, got " + std::string(kind_name(value.kind())),
           {.path = b.path, .detail = "{\"expected\":\"string\"}"});
    }
    const std::string& id = get<VK::string>(value);
    if (id.empty()) {
      sg_set_fx(d, layer, "textPath", Json());
      return;
    }
    const auto mask = read_node_mask(node);
    bool found = false;
    if (mask) {
      for (const Json& p : mask->at("paths").arr()) found = found || (p.at("id").is_string() && p.at("id").str() == id);
    }
    if (!found) fail(ErrorCode::not_found, "layer '" + L + "' has no mask '" + id + "'", {.layer = L, .path = b.path});
    Json patch = Json::object();
    patch.set("pathId", Json::string(id));
    update_text_path(d, layer, patch);
    return;
  }
  const Json* spec = field_spec(f);
  if (spec == nullptr) fail(ErrorCode::unsupported, "'" + b.path + "' has no writer", {.path = b.path});
  Json raw = stored_value(b, *spec, value);
  if (f.owner == "text") {
    if (text == nullptr) fail(ErrorCode::not_found, "not a text layer", {.layer = L});
    const bool strokeOrder = f.key == "strokeOrder";
    const std::string order = raw.is_string() ? raw.str() : std::string();
    (void)sg_write_prop(d, layer, textId, f.key, std::move(raw));
    if (strokeOrder) {
      (void)sg_write_prop(d, layer, textId, "strokeOverFill",
                          Json::boolean(order == "stroke-over-fill" || order == "all-strokes-over-all-fills"));
    }
    return;
  }
  const AnimLoc loc = locate_animator(node, f);
  if (f.owner == "animator") {
    if (loc.index < 0) fail(ErrorCode::not_found, "no animator '" + f.animatorId.value_or("") + "'", {.layer = L, .path = b.path});
    Json patch = Json::object();
    patch.set(f.key, std::move(raw));
    update_animator(d, layer, static_cast<std::size_t>(loc.index), patch);
    return;
  }
  if (f.owner == "selector") {
    if (loc.index < 0 || loc.sel < 0) {
      fail(ErrorCode::not_found, "no selector '" + f.selectorId.value_or("") + "'", {.layer = L, .path = b.path});
    }
    const auto ai = static_cast<std::size_t>(loc.index);
    const auto si = static_cast<std::size_t>(loc.sel);
    const Json& cur = loc.data[ai].at("selectors").arr()[si];
    if (f.key == "kind") {
      if (cur.at("kind").is_string() && raw.is_string() && cur.at("kind").str() == raw.str()) return;
      // A kind switch in place keeps id, Based On, Mode and enable; the params
      // the new kind lacks lose their keyframes and expressions.
      const Json& keep = fields_of("selectorKindParams").at(raw.str());
      std::set<std::string> drop;
      for (const Json& p : registry().animators.at("selectorParams").arr()) {
        if (!contains_str(keep, p.str())) drop.insert(selector_prop_path(ai, si, p.str()));
      }
      drop_track_props(d, layer, drop);
    }
    Json patch = Json::object();
    patch.set(f.key, std::move(raw));
    update_selector(d, layer, ai, si, patch);
    return;
  }
  fail(ErrorCode::unsupported, "'" + b.path + "' has no writer", {.path = b.path});
}

}  // namespace premation::doc
