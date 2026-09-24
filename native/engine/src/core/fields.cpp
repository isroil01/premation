#include "fields.hpp"

#include <array>
#include <cmath>
#include <tuple>

#include "catalog_data.hpp"
#include "fail.hpp"
#include "fxstate.hpp"
#include "meta.hpp"
#include "plugin_props.hpp"
#include "scene.hpp"
#include "strokes.hpp"
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

// ── layer fields (B3z, layerFieldSpecs.ts) ───────────────────────────────

const Json* layer_spec(std::string_view path) {
  const Json& list = fields_of("layer");
  if (!list.is_array()) return nullptr;
  for (const Json& s : list.arr()) {
    if (s.at("path").is_string() && s.at("path").str() == path) return &s;
  }
  return nullptr;
}

std::vector<std::string> component_types(const Json& store) {
  const Json& c = store.at("component");
  std::vector<std::string> out;
  if (c.is_string()) out.push_back(c.str());
  else if (c.is_array()) {
    for (const Json& t : c.arr()) {
      if (t.is_string()) out.push_back(t.str());
    }
  }
  return out;
}

/// The component a store names (the first of its types the layer carries).
const Component* store_component(const Node& n, const Json& store) {
  for (const auto& t : component_types(store)) {
    if (const Component* c = n.comp(t)) return c;
  }
  return nullptr;
}

bool layer_field_present(const Node& n, const Json& spec) {
  const Json& store = spec.at("store");
  if (!store.at("component").is_undefined() && store_component(n, store) == nullptr) return false;
  if (store.at("fx").is_string() && store.at("key").is_string() && !n.fx().at(store.at("fx").str()).is_object()) return false;
  const Json& w = spec.at("when");
  if (!w.is_object()) return true;
  if (w.at("component").is_string() && n.comp(w.at("component").str()) == nullptr) return false;
  if (w.at("fx").is_string() && n.fx().at(w.at("fx").str()).is_undefined()) return false;
  if (w.at("threeD").is_bool() && w.at("threeD").b() && !is_3d_enabled(n)) return false;
  if (w.at("kinds").is_array() || w.at("notKinds").is_array()) {
    const std::string kind = n.kind();
    if (w.at("kinds").is_array() && !contains_str(w.at("kinds"), kind)) return false;
    if (w.at("notKinds").is_array() && contains_str(w.at("notKinds"), kind)) return false;
  }
  return true;
}

Json read_stored(const Node& n, const Json& store) {
  if (store.at("fx").is_string()) {
    const Json& v = n.fx().at(store.at("fx").str());
    if (!store.at("key").is_string()) return v;
    return v.is_object() ? v.at(store.at("key").str()) : Json();
  }
  const Component* c = store_component(n, store);
  return c != nullptr ? c->props.at(store.at("key").str()) : Json();
}

void write_stored(Document& d, std::string_view layer, const Json& store, Json raw, const std::string& path) {
  const std::string L(layer);
  if (store.at("fx").is_string()) {
    const std::string& fxKey = store.at("fx").str();
    if (!store.at("key").is_string()) {
      sg_set_fx(d, layer, fxKey, std::move(raw));
      return;
    }
    const Json cur = d.node(layer)->fx().at(fxKey);
    if (!cur.is_object()) fail(ErrorCode::not_found, "layer '" + L + "' has no " + fxKey, {.layer = L, .path = path});
    Json next = cur;
    if (raw.is_undefined()) next.erase(store.at("key").str());
    else next.set(store.at("key").str(), std::move(raw));
    sg_set_fx(d, layer, fxKey, std::move(next));
    return;
  }
  const Component* c = store_component(*d.node(layer), store);
  if (c == nullptr) {
    std::string types;
    for (const auto& t : component_types(store)) types += (types.empty() ? "" : " / ") + t;
    fail(ErrorCode::not_found, "layer '" + L + "' has no " + types + " component", {.layer = L, .path = path});
  }
  const std::string cid = c->id;
  (void)sg_write_prop(d, layer, cid, store.at("key").str(), std::move(raw));
}

/// fields.ts `sameRaw`: stored `null` in a pair = absent (or null).
bool same_raw(const Json& stored, const Json& raw) {
  if (raw.is_null()) return stored.is_undefined() || stored.is_null();
  if (stored.is_undefined()) return false;
  return stringify(stored) == stringify(raw);
}

api::Value read_layer_field(const Node& n, const Json& spec) {
  const Json stored = read_stored(n, spec.at("store"));
  const Json& enc = spec.at("encode");
  if (enc.is_array()) {
    for (const Json& pair : enc.arr()) {
      if (same_raw(stored, pair.arr()[1])) return spec_value(spec, pair.arr()[0]);
    }
    return spec_value(spec, Json());
  }
  return spec_value(spec, stored.is_null() ? Json() : stored);
}

void write_layer_field(Document& d, std::string_view layer, const PropBinding& b, const Json& spec, const api::Value& value) {
  Json raw = stored_value(b, spec, value);
  const Json& shape = spec.at("json");
  if (shape.is_string() && !raw.is_undefined()) {
    const bool ok = shape.str() == "array" ? raw.is_array() : raw.is_object();
    if (!ok) fail(ErrorCode::invalid_argument, "'" + b.path + "' takes null or a JSON " + shape.str(), {.path = b.path});
  }
  const Json& enc = spec.at("encode");
  if (enc.is_array()) {
    const Json api = raw.is_undefined() ? spec.at("default") : raw;
    for (const Json& pair : enc.arr()) {
      if (pair.arr()[0] == api) {
        raw = pair.arr()[1].is_null() ? Json() : pair.arr()[1];
        break;
      }
    }
  }
  write_stored(d, layer, spec.at("store"), raw, b.path);
  if (spec.at("mirror").is_object()) write_stored(d, layer, spec.at("mirror"), raw, b.path);
}

// ── effect fields (B3z, effectFieldSpecs.ts) ─────────────────────────────

/// fields.ts `writeEffectField`: Effect Mask ('' = whole layer, else one of the
/// layer's masks) and the label colour ('' = none, else #rrggbb); '' removes the key.
void write_effect_field(Document& d, std::string_view layer, const PropBinding& b, const FieldRef& f, const api::Value& value) {
  const std::string L(layer);
  if (value.kind() != VK::string) {
    fail(ErrorCode::type_mismatch, "'" + b.path + "' takes a string, got " + std::string(kind_name(value.kind())),
         {.path = b.path, .detail = "{\"expected\":\"string\"}"});
  }
  const std::string& v = get<VK::string>(value);
  const std::string effectId = f.animatorId.value_or("");
  std::vector<Json> effects = get_node_effects(d, layer);
  if (find_by_id(effects, effectId) == nullptr) {
    fail(ErrorCode::not_found, "layer '" + L + "' has no effect '" + effectId + "'", {.layer = L, .path = b.path});
  }
  if (!v.empty() && f.key == "maskId") {
    const auto mask = read_node_mask(*d.node(layer));
    bool found = false;
    if (mask) {
      for (const Json& p : mask->at("paths").arr()) found = found || (p.at("id").is_string() && p.at("id").str() == v);
    }
    if (!found) fail(ErrorCode::not_found, "layer '" + L + "' has no mask '" + v + "'", {.layer = L, .path = b.path});
  }
  if (!v.empty() && f.key == "labelColor") {
    bool ok = v.size() == 7 && v[0] == '#';
    for (std::size_t i = 1; ok && i < v.size(); ++i) {
      const char c = v[i];
      ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    }
    if (!ok) fail(ErrorCode::invalid_argument, "'" + b.path + "' takes '' or a #rrggbb colour", {.path = b.path});
  }
  for (Json& e : effects) {
    if (!(e.at("id").is_string() && e.at("id").str() == effectId)) continue;
    if (v.empty()) e.erase(f.key);
    else e.set(f.key, Json::string(v));
  }
  write_node_effects(d, layer, std::move(effects));
}

}  // namespace

const Json* field_spec(const FieldRef& f) {
  if (f.owner == "text") return spec_in(fields_of("text"), f.key);
  if (f.owner == "animator") {
    if (const Json* s = spec_in(fields_of("animator"), f.key)) return s;
    return spec_in(fields_of("animatorOptional"), f.key);
  }
  if (f.owner == "selector") return spec_in(fields_of("selector"), f.key);
  if (f.owner == "layer") return layer_spec(f.key);
  // B3z (shapeFieldSpecs.ts): a path operator's field (FieldRef.animatorId = the operator id) / the Polystar's.
  if (f.owner == "pathOp") return spec_in(fields_of("pathOp"), f.key);
  if (f.owner == "polystar") return spec_in(fields_of("polystar"), f.key);
  if (f.owner == "effect") return spec_in(fields_of("effect"), f.key);
  if (f.owner == "style") {
    // FieldRef.animatorId carries the style key (fields.ts FieldRef.groupId).
    for (const Json& s : fields_of("style").arr()) {
      if (s.at("style").str() == f.animatorId.value_or("") && s.at("key").str() == f.key) return &s;
    }
  }
  return nullptr;
}

PropBinding effect_field_binding(const std::string& effectId, const Json& spec) {
  const std::string key = spec.at("key").str();
  return field_binding("effects/" + effectId + "/" + spec.at("path").str(), spec, FieldRef{"effect", key, effectId, std::nullopt});
}

PropBinding style_field_binding(const Json& spec) {
  const std::string style = spec.at("style").str();
  const std::string key = spec.at("key").str();
  return field_binding("styles/" + style + "/" + key, spec, FieldRef{"style", key, style, std::nullopt});
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
  if (has_stroke_host(node, has_paint_host(node))) {
    // B3z: the shape STROKE stack (fx.stroke / fx.strokes) — strokes.cpp.
    PropBinding b;
    b.path = "layer/strokes";
    b.name = "Strokes";
    b.matchName = "strokes";
    b.valueType = ValueType::json;
    b.special = Special::field;
    b.field = FieldRef{"strokes", "", std::nullopt, std::nullopt};
    b.animatable = false;
    b.defaultValue = v_json("[]");
    add(std::move(b));
  }
  if ((node.kind() == "camera" || node.kind() == "light") && node.comp("Transform") != nullptr) {
    // B3z: AE's Auto-Orientation ▸ Orient Towards Point of Interest (strokes.cpp).
    PropBinding b;
    b.path = std::string(kPoiPath);
    b.name = "Orient Towards Point of Interest";
    b.matchName = "orientTowardsPointOfInterest";
    b.valueType = ValueType::bool_;
    b.special = Special::field;
    b.field = FieldRef{"poi", "", std::nullopt, std::nullopt};
    b.animatable = false;
    b.defaultValue = v_bool(false);
    add(std::move(b));
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
  // B3z: the layer fields (layerFieldSpecs.ts), in table order.
  for (const Json& spec : fields_of("layer").arr()) {
    const std::string& path = spec.at("path").str();
    if (has(path) || !layer_field_present(node, spec)) continue;
    add(field_binding(path, spec, FieldRef{"layer", path, std::nullopt, std::nullopt}));
  }
  // B3z: path-operator and Polystar fields (shapeFieldSpecs.ts), operators in chain order.
  for (const Json& op : read_path_ops(node)) {
    const std::string id = op.at("id").str();
    const std::string type = op.at("type").str();
    for (const Json& spec : fields_of("pathOp").arr()) {
      const std::string key = spec.at("key").str();
      std::string path = "contents/" + id + "/" + key;
      if (!contains_str(spec.at("ops"), type) || has(path)) continue;
      add(field_binding(std::move(path), spec, FieldRef{"pathOp", key, id, std::nullopt}));
    }
  }
  if (read_node_polystar(node)) {
    for (const Json& spec : fields_of("polystar").arr()) {
      std::string path = "contents/polystar/" + spec.at("path").str();
      if (has(path)) continue;
      add(field_binding(std::move(path), spec, FieldRef{"polystar", spec.at("key").str(), std::nullopt, std::nullopt}));
    }
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
  if (f.owner == "strokes") return read_stroke_stack(node);
  if (f.owner == "poi") return read_point_of_interest(node);
  if (f.owner == "plugin") return read_plugin_field(node, b);
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
  if (f.owner == "layer") return read_layer_field(node, *spec);
  if (f.owner == "pathOp") {
    const std::vector<Json> ops = read_path_ops(node);
    const Json* op = find_by_id(ops, f.animatorId.value_or(""));
    return spec_value(*spec, op != nullptr ? op->at(f.key) : Json());
  }
  if (f.owner == "polystar") {
    const auto ps = read_node_polystar(node);
    return spec_value(*spec, ps ? ps->at(f.key) : Json());
  }
  if (f.owner == "effect") {
    const std::vector<Json> effects = read_node_effects(node);
    const Json* e = find_by_id(effects, f.animatorId.value_or(""));
    const Json raw = e != nullptr && e->at(f.key).is_string() ? e->at(f.key) : Json();
    return spec_value(*spec, raw);
  }
  if (f.owner == "style") return spec_value(*spec, get_node_layer_styles(node).at(f.animatorId.value_or("")).at(f.key));
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

void set_primary_fill_paint(Document& d, std::string_view layer, const Json& paint) { set_primary_fill(d, layer, paint); }

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
  if (f.owner == "strokes") {
    write_stroke_stack(d, layer, b.path, value);
    return;
  }
  if (f.owner == "poi") {
    write_point_of_interest(d, layer, value);
    return;
  }
  if (f.owner == "plugin") {
    write_plugin_field(d, layer, b, value);
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
  if (f.owner == "layer") {
    write_layer_field(d, layer, b, *spec, value);
    return;
  }
  if (f.owner == "effect") {
    write_effect_field(d, layer, b, f, value);
    return;
  }
  Json raw = stored_value(b, *spec, value);
  if (f.owner == "pathOp") {
    // The chain re-validated whole, as the editor's picker wrote it (pathOps.ts updatePathOp).
    const std::string opId = f.animatorId.value_or("");
    const std::vector<Json> ops = read_path_ops(node);
    if (find_by_id(ops, opId) == nullptr) {
      fail(ErrorCode::not_found, "layer '" + L + "' has no path operator '" + opId + "'", {.layer = L, .path = b.path});
    }
    Json patch = Json::object();
    patch.set(f.key, std::move(raw));
    update_path_op(d, layer, opId, patch);
    return;
  }
  if (f.owner == "polystar") {
    if (!read_node_polystar(node)) fail(ErrorCode::not_found, "layer '" + L + "' has no polystar", {.layer = L, .path = b.path});
    Json patch = Json::object();
    patch.set(f.key, std::move(raw));
    (void)update_node_polystar(d, layer, patch);
    return;
  }
  if (f.owner == "style") {
    const std::string style = f.animatorId.value_or("");
    Json styles = get_node_layer_styles(node);
    const Json& st = styles.at(style);
    if (!st.is_object()) fail(ErrorCode::not_found, "layer '" + L + "' has no " + style + " style", {.layer = L, .path = b.path});
    Json next = st;
    next.set(f.key, std::move(raw));
    styles.set(style, std::move(next));
    set_layer_styles(d, layer, styles);
    return;
  }
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
