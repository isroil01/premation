#include "fxstate.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

#include "jsmath.hpp"
#include "scene.hpp"
#include "strutil.hpp"

namespace premation::doc {
namespace {

bool is_hex_digit(char c) noexcept {
  return is_ascii_digit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

std::string_view trim(std::string_view s) {
  auto ws = [](char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; };
  while (!s.empty() && ws(s.front())) s.remove_prefix(1);
  while (!s.empty() && ws(s.back())) s.remove_suffix(1);
  return s;
}

const Json* fx_member(const Node& n, std::string_view key) {
  const Component* fx = n.comp("fx");
  return fx != nullptr ? fx->props.find(key) : nullptr;
}

}  // namespace

// ── generic ──────────────────────────────────────────────────────────────

Json spread(const Json& a, const Json& b) {
  Json out = a.is_object() ? a : Json::object();
  if (b.is_object()) {
    for (const auto& m : b.obj()) out.set(m.key, m.value);
  }
  return out;
}

const Json& nn(const Json& v, const Json& fallback) {
  return v.is_undefined() || v.is_null() ? fallback : v;
}

double num_or(const Json& v, double fb) { return v.is_number() ? v.num() : fb; }

// ── colours ──────────────────────────────────────────────────────────────

std::array<double, 4> parse_color_channels(std::string_view hex) {
  std::string h(trim(hex));
  if (!h.empty() && h.front() == '#') h.erase(0, 1);
  if (h.size() == 3) {
    std::string e;
    for (const char c : h) {
      e.push_back(c);
      e.push_back(c);
    }
    h = e;
  }
  if (h.size() == 6) h += "ff";
  if (h.size() != 8 || !std::all_of(h.begin(), h.end(), is_hex_digit)) return {1, 1, 1, 1};
  auto byte = [&](std::size_t i) {
    return static_cast<double>(std::stoi(h.substr(i, 2), nullptr, 16)) / 255.0;
  };
  return {byte(0), byte(2), byte(4), byte(6)};
}

std::string channels_to_color(double r, double g, double b, double a) {
  auto c = [](double v) {
    const double x = motion::js::round(std::max(0.0, std::min(1.0, v)) * 255.0);
    const int i = static_cast<int>(x);
    static constexpr char kHex[] = "0123456789abcdef";
    std::string s;
    s.push_back(kHex[(i >> 4) & 0xF]);
    s.push_back(kHex[i & 0xF]);
    return s;
  };
  std::string base = "#" + c(r) + c(g) + c(b);
  return a >= 1 ? base : base + c(a);
}

bool is_hex_color(std::string_view s) {
  std::string_view t = trim(s);
  if (!t.empty() && t.front() == '#') t.remove_prefix(1);
  if (t.size() < 3 || t.size() > 8) return false;
  return std::all_of(t.begin(), t.end(), is_hex_digit);
}

// ── effects ──────────────────────────────────────────────────────────────

Json default_params(const EffectDef& def) {
  Json out = Json::object();
  for (const auto& p : def.params) out.set(p.key, p.def);
  return out;
}

Json new_instance_params_of(const EffectDef& def) {
  return def.newInstanceParams ? spread(default_params(def), *def.newInstanceParams) : default_params(def);
}

Json params_of(const Json& effect) {
  const EffectDef* def = registry().effect(effect.at("type").str());
  if (def == nullptr) {
    const Json& p = effect.at("params");
    return p.is_undefined() || p.is_null() ? Json::object() : p;
  }
  Json out = default_params(*def);
  if (const auto amount = effect.number_at("amount")) {
    if (const EffectParamDef* primary = def->primary()) out.set(primary->key, Json::number(*amount));
  }
  const Json& params = effect.at("params");
  return params.is_object() ? spread(out, params) : out;
}

Json migrate_effect(const Json& raw) {
  if (!raw.is_object() || registry().effect(raw.at("type").str()) == nullptr) return raw;
  Json out = raw;
  out.erase("amount");
  out.set("params", params_of(raw));
  return out;
}

std::vector<Json> read_node_effects(const Node& n) {
  std::vector<Json> out;
  const Json* list = fx_member(n, "effects");
  if (list == nullptr || !list->is_array()) return out;
  out.reserve(list->arr().size());
  for (const Json& e : list->arr()) out.push_back(migrate_effect(e));
  return out;
}

std::vector<Json> get_node_effects(const Document& d, std::string_view nodeId) {
  const Node* n = d.node(nodeId);
  return n != nullptr ? read_node_effects(*n) : std::vector<Json>{};
}

const Json* find_by_id(const std::vector<Json>& list, std::string_view id) {
  for (const Json& e : list) {
    const Json* i = e.find("id");
    if (i != nullptr && i->is_string() && i->str() == id) return &e;
  }
  return nullptr;
}

void write_node_effects(Document& d, std::string_view nodeId, std::vector<Json> effects) {
  sg_set_fx(d, nodeId, "effects", Json::array(std::move(effects)));
}

void update_effect_param(Document& d, std::string_view nodeId, std::string_view effectId, std::string_view key,
                         Json value) {
  std::vector<Json> list = get_node_effects(d, nodeId);
  for (Json& e : list) {
    if (e.at("id").is_string() && e.at("id").str() == effectId) {
      Json params = e.at("params").is_object() ? e.at("params") : Json::object();
      params.set(key, value);
      e.set("params", std::move(params));
    }
  }
  write_node_effects(d, nodeId, std::move(list));
}

bool effect_has_opacity(const Json& e) { return e.at("opacity").is_finite_number(); }

// ── masks ────────────────────────────────────────────────────────────────

std::optional<Json> read_node_mask(const Node& n) {
  const Json* m = fx_member(n, "mask");
  if (m == nullptr || !m->is_object()) return std::nullopt;
  const Json& paths = m->at("paths");
  if (!paths.is_array() || paths.arr().empty()) return std::nullopt;
  return *m;
}

Json get_node_mask(const Node& n) {
  if (auto m = read_node_mask(n)) return *m;
  Json out = Json::object();
  out.set("paths", Json::array());
  return out;
}

std::vector<Json> read_node_mask_anim(const Node& n) {
  const Json* a = fx_member(n, "maskAnim");
  if (a == nullptr || !a->is_array()) return {};
  return a->arr();
}

const Json* mask_path_by_id(const Json& mask, std::string_view id) {
  const Json& paths = mask.at("paths");
  if (!paths.is_array()) return nullptr;
  for (const Json& p : paths.arr()) {
    if (p.at("id").is_string() && p.at("id").str() == id) return &p;
  }
  return nullptr;
}

void write_node_mask(Document& d, std::string_view nodeId, const Json& mask) {
  const Json& paths = mask.at("paths");
  sg_set_fx(d, nodeId, "mask", paths.is_array() && !paths.arr().empty() ? mask : Json());
}

void set_mask_anim(Document& d, std::string_view nodeId, std::optional<std::vector<Json>> keys) {
  sg_set_fx(d, nodeId, "maskAnim", keys ? Json::array(std::move(*keys)) : Json());
}

void edit_every_mask_state(Document& d, std::string_view nodeId, const std::function<Json(const Json&)>& fn) {
  const Node* n = d.node(nodeId);
  if (n == nullptr) return;
  write_node_mask(d, nodeId, fn(get_node_mask(*n)));
  const std::vector<Json> anim = read_node_mask_anim(*d.node(nodeId));
  if (!anim.empty()) {
    std::vector<Json> next;
    for (const Json& k : anim) {
      Json e = Json::object();
      e.set("t", k.at("t"));
      e.set("mask", fn(k.at("mask")));
      next.push_back(std::move(e));
    }
    set_mask_anim(d, nodeId, std::move(next));
  }
}

void update_mask_path(Document& d, std::string_view nodeId, std::string_view pathId, const Json& patch) {
  const Node* n = d.node(nodeId);
  if (n == nullptr) return;
  const Json mask = get_node_mask(*n);
  Json paths = Json::array();
  for (const Json& p : mask.at("paths").arr()) {
    paths.arr_mut().push_back(p.at("id").is_string() && p.at("id").str() == pathId ? spread(p, patch) : p);
  }
  Json next = Json::object();
  next.set("paths", std::move(paths));
  write_node_mask(d, nodeId, next);
}

namespace {

double lerp(double a, double b, double f) { return a + (b - a) * f; }

Json lerp_point(const Json& p, const Json& q, double f) {
  Json out = Json::object();
  for (const char* k : {"x", "y", "inX", "inY", "outX", "outY"}) {
    out.set(k, Json::number(lerp(p.at(k).num(), q.at(k).num(), f)));
  }
  const Json& pf = p.at("feather");
  const Json& qf = q.at("feather");
  if (pf.is_number() || qf.is_number()) {
    const double a = pf.is_number() ? pf.num() : (qf.is_number() ? qf.num() : 0.0);
    const double b = qf.is_number() ? qf.num() : (pf.is_number() ? pf.num() : 0.0);
    out.set("feather", Json::number(lerp(a, b, f)));
  }
  const Json& broken = f < 0.5 ? p.at("broken") : q.at("broken");
  if (broken.is_bool() ? broken.b() : (!broken.is_undefined() && !broken.is_null() && broken.is_number() && broken.num() != 0)) {
    out.set("broken", Json::boolean(true));
  }
  const Json& pt = p.at("tension");
  const Json& qt = q.at("tension");
  if (pt.is_number() || qt.is_number()) {
    const double third = 1.0 / 3.0;
    const double a = pt.is_number() ? pt.num() : (qt.is_number() ? qt.num() : third);
    const double b = qt.is_number() ? qt.num() : (pt.is_number() ? pt.num() : third);
    out.set("tension", Json::number(lerp(a, b, f)));
  }
  return out;
}

}  // namespace

std::optional<Json> interpolate_mask(const std::vector<Json>& kfs, double t) {
  if (kfs.empty()) return std::nullopt;
  std::vector<const Json*> s;
  for (const Json& k : kfs) s.push_back(&k);
  std::stable_sort(s.begin(), s.end(), [](const Json* a, const Json* b) { return a->at("t").num() < b->at("t").num(); });
  if (s.size() == 1 || t <= s.front()->at("t").num()) return s.front()->at("mask");
  if (t >= s.back()->at("t").num()) return s.back()->at("mask");
  const Json* a = s.front();
  const Json* b = s.back();
  for (std::size_t i = 0; i + 1 < s.size(); ++i) {
    if (t >= s[i]->at("t").num() && t <= s[i + 1]->at("t").num()) {
      a = s[i];
      b = s[i + 1];
      break;
    }
  }
  const double span = b->at("t").num() - a->at("t").num();
  const double f = (t - a->at("t").num()) / (span != 0 ? span : 1);
  Json paths = Json::array();
  const Json& pa = a->at("mask").at("paths");
  const Json& pb = b->at("mask").at("paths");
  for (std::size_t i = 0; i < pa.arr().size(); ++i) {
    const Json& x = pa.arr()[i];
    const Json* y = i < pb.arr().size() ? &pb.arr()[i] : nullptr;
    if (y == nullptr || y->at("points").arr().size() != x.at("points").arr().size()) {
      paths.arr_mut().push_back(f < 0.5 ? x : (y != nullptr ? *y : x));
      continue;
    }
    Json e = x;
    e.set("feather", Json::number(lerp(x.at("feather").num(), y->at("feather").num(), f)));
    e.set("opacity", Json::number(lerp(x.at("opacity").num(), y->at("opacity").num(), f)));
    e.set("expansion", Json::number(lerp(num_or(nn(x.at("expansion"), Json::number(0)), 0),
                                         num_or(nn(y->at("expansion"), Json::number(0)), 0), f)));
    Json pts = Json::array();
    for (std::size_t j = 0; j < x.at("points").arr().size(); ++j) {
      pts.arr_mut().push_back(lerp_point(x.at("points").arr()[j], y->at("points").arr()[j], f));
    }
    e.set("points", std::move(pts));
    paths.arr_mut().push_back(std::move(e));
  }
  Json out = Json::object();
  out.set("paths", std::move(paths));
  return out;
}

std::optional<MaskPropRef> parse_mask_prop_path(std::string_view prop) {
  auto r = parse_prefixed_id_rest(prop, "mask.");
  if (!r) return std::nullopt;
  if (r->rest != "feather" && r->rest != "opacity" && r->rest != "expansion") return std::nullopt;
  return MaskPropRef{r->id, r->rest};
}

// ── layer styles ─────────────────────────────────────────────────────────

std::optional<std::string> style_key_from_effect_id(std::string_view effectId) {
  constexpr std::string_view kPrefix = "layerstyle:";
  if (!effectId.starts_with(kPrefix)) return std::nullopt;
  return std::string(effectId.substr(kPrefix.size()));
}

std::string layer_style_effect_id(std::string_view styleKey) { return "layerstyle:" + std::string(styleKey); }

std::optional<std::string> style_field_for_param(std::string_view styleKey, std::string_view param) {
  const Json& nums = registry().layerStyles.at("numberParams").at(styleKey);
  if (nums.is_object()) {
    for (const auto& m : nums.obj()) {
      if (m.value.at("param").is_string() && m.value.at("param").str() == param) return m.key;
    }
  }
  const Json& cols = registry().layerStyles.at("colorParams").at(styleKey);
  if (cols.is_object()) {
    for (const auto& m : cols.obj()) {
      if (m.value.is_string() && m.value.str() == param) return m.key;
    }
  }
  return std::nullopt;
}

const Json* style_number_binding(std::string_view styleKey, std::string_view field) {
  const Json& nums = registry().layerStyles.at("numberParams").at(styleKey);
  return nums.is_object() ? nums.find(field) : nullptr;
}

Json get_node_layer_styles(const Node& n) {
  const Json* s = fx_member(n, "layerStyles");
  return s != nullptr && !s->is_undefined() && !s->is_null() ? *s : Json::object();
}

void set_layer_styles(Document& d, std::string_view nodeId, const Json& styles) {
  bool empty = true;
  if (styles.is_object()) {
    for (const auto& m : styles.obj()) {
      if (!m.value.is_undefined()) empty = false;
    }
  }
  sg_set_fx(d, nodeId, "layerStyles", empty ? Json() : styles);
}

// ── path operators ───────────────────────────────────────────────────────

namespace {
bool is_path_op_type(const Json& v) {
  static constexpr std::string_view kTypes[] = {"none",    "zigzag", "roundCorners", "pucker",  "twist",
                                                "offset",  "roughen", "trim",        "repeater", "wiggleTransform"};
  if (!v.is_string()) return false;
  return std::find(std::begin(kTypes), std::end(kTypes), v.str()) != std::end(kTypes);
}
}  // namespace

Json coerce_path_op(const Json& o) {
  auto num = [&](std::string_view k, double fb) { return num_or(o.at(k), fb); };
  Json out = Json::object();
  const Json& id = o.at("id");
  // A stored op with no id is repaired (TS mints a random one; the engine a fixed one).
  out.set("id", id.is_string() && !id.str().empty() ? id : Json::string("op_repaired"));
  out.set("type", is_path_op_type(o.at("type")) ? o.at("type") : Json::string("zigzag"));
  out.set("amount", Json::number(num("amount", 20)));
  out.set("detail", Json::number(num("detail", 4)));
  out.set("wigglesPerSecond", Json::number(std::max(0.0, num("wigglesPerSecond", 0))));
  out.set("seed", Json::number(num("seed", 0)));
  out.set("correlation", Json::number(std::max(0.0, std::min(100.0, num("correlation", 0)))));
  out.set("wiggleRotation", Json::number(std::max(0.0, num("wiggleRotation", 0))));
  out.set("wiggleScale", Json::number(std::max(0.0, num("wiggleScale", 0))));
  const Json& lj = o.at("lineJoin");
  out.set("lineJoin", lj.is_string() && (lj.str() == "round" || lj.str() == "bevel") ? lj : Json::string("miter"));
  out.set("miterLimit", Json::number(std::max(1.0, num("miterLimit", 4))));
  out.set("start", Json::number(num("start", 0)));
  out.set("end", Json::number(num("end", 100)));
  out.set("offset", Json::number(num("offset", 0)));
  const Json& tm = o.at("trimMultipleShapes");
  out.set("trimMultipleShapes", Json::string(tm.is_string() && tm.str() == "individually" ? "individually" : "simultaneously"));
  out.set("copies", Json::number(num("copies", 1)));
  out.set("offsetX", Json::number(num("offsetX", 0)));
  out.set("offsetY", Json::number(num("offsetY", 0)));
  out.set("offsetRotation", Json::number(num("offsetRotation", 0)));
  out.set("offsetScale", Json::number(num("offsetScale", 1)));
  out.set("offsetOpacity", Json::number(num("offsetOpacity", 1)));
  out.set("anchorX", Json::number(num("anchorX", 0)));
  out.set("anchorY", Json::number(num("anchorY", 0)));
  const Json& comp = o.at("composite");
  out.set("composite", Json::string(comp.is_string() && comp.str() == "below" ? "below" : "above"));
  return out;
}

std::vector<Json> read_path_ops(const Node& n) {
  const Json* raw = fx_member(n, "pathOps");
  std::vector<Json> out;
  if (raw == nullptr || !raw->is_array()) return out;
  for (const Json& e : raw->arr()) {
    if (e.is_object()) out.push_back(coerce_path_op(e));
  }
  return out;
}

void set_path_ops(Document& d, std::string_view nodeId, const std::vector<Json>& ops) {
  sg_set_fx(d, nodeId, "pathOps", ops.empty() ? Json() : Json::array(ops));
}

void update_path_op(Document& d, std::string_view nodeId, std::string_view opId, const Json& patch) {
  const Node* n = d.node(nodeId);
  if (n == nullptr) return;
  std::vector<Json> ops = read_path_ops(*n);
  for (Json& o : ops) {
    if (o.at("id").str() == opId) {
      Json id = o.at("id");
      o = spread(o, patch);
      o.set("id", id);
    }
  }
  set_path_ops(d, nodeId, ops);
}

std::vector<std::string> path_op_params(std::string_view type) {
  std::vector<std::string> out;
  // `none` is not in PATH_OP_CATALOG; pathOpParamSpecs gives it the default rows (zigzag's).
  const Json& entry = registry().pathOps.at(type).is_object() ? registry().pathOps.at(type) : registry().pathOps.at("zigzag");
  if (!entry.is_object()) return out;
  for (const Json& p : entry.at("params").arr()) out.push_back(p.at("param").str());
  return out;
}

// ── polystar ─────────────────────────────────────────────────────────────

std::optional<Json> read_node_polystar(const Node& n) {
  const Json* raw = fx_member(n, "polystar");
  if (raw == nullptr || !raw->is_object()) return std::nullopt;
  const Json& o = *raw;
  Json out = Json::object();
  out.set("starType", Json::string(o.at("starType").is_string() && o.at("starType").str() == "polygon" ? "polygon" : "star"));
  out.set("points", Json::number(std::max(3.0, motion::js::round(num_or(o.at("points"), 5)))));
  out.set("rotation", Json::number(num_or(o.at("rotation"), 0)));
  out.set("outerRadius", Json::number(std::max(0.0, num_or(o.at("outerRadius"), 100))));
  out.set("innerRadius", Json::number(std::max(0.0, num_or(o.at("innerRadius"), 50))));
  out.set("outerRoundness", Json::number(num_or(o.at("outerRoundness"), 0)));
  out.set("innerRoundness", Json::number(num_or(o.at("innerRoundness"), 0)));
  return out;
}

bool update_node_polystar(Document& d, std::string_view nodeId, const Json& patch) {
  const Node* n = d.node(nodeId);
  const auto current = n != nullptr ? read_node_polystar(*n) : std::nullopt;
  if (!current) return false;
  // polystar.ts updateNodePolystar: {...current, ...patch}, re-validated whole.
  Json next = spread(*current, patch);
  const auto fin = [](const Json& v, double fb) { return v.is_finite_number() ? v.num() : fb; };
  next.set("points", Json::number(std::max(3.0, motion::js::round(fin(next.at("points"), current->at("points").num())))));
  next.set("outerRadius", Json::number(std::max(0.0, fin(next.at("outerRadius"), current->at("outerRadius").num()))));
  next.set("innerRadius", Json::number(std::max(0.0, fin(next.at("innerRadius"), current->at("innerRadius").num()))));
  sg_set_fx(d, nodeId, "polystar", std::move(next));
  return true;
}

std::vector<std::string> polystar_params(std::string_view starType) {
  std::vector<std::string> out;
  const Json& specs = registry().polystar.at(starType == "polygon" ? "polygon" : "star");
  for (const Json& p : specs.arr()) out.push_back(p.at("param").str());
  return out;
}

// ── text animators ───────────────────────────────────────────────────────

const Component* text_component(const Node& n) { return n.comp("Text"); }

Json default_selector(std::string_view kind) {
  const Json& sels = registry().animators.at("selectors");
  const Json& base = sels.at(kind == "wiggly" || kind == "expression" ? kind : "range");
  // The TypeScript default carries a freshly minted id as its SECOND key
  // (after `kind`); the slot is kept so a spread over it lands in place.
  Json out = Json::object();
  bool placed = false;
  for (const auto& m : base.obj()) {
    out.set(m.key, m.value);
    if (!placed && m.key == "kind") {
      out.set("id", Json());
      placed = true;
    }
  }
  return out;
}

Json normalize_selector(const Json& s) {
  const Json& k = s.at("kind");
  const std::string kind = k.is_string() ? k.str() : "range";
  Json out = spread(default_selector(kind), s);
  out.set("kind", Json::string(kind));
  return out;
}

namespace {

Json legacy_selector(const Json& d) {
  const Json id = Json::string(d.at("id").str() + "_s0");
  const Json& mode = d.at("mode");
  if (mode.is_string() && mode.str() == "wiggly") {
    Json out = default_selector("wiggly");
    out.set("id", id);
    out.set("basedOn", nn(d.at("basedOn"), Json::string("characters")));
    out.set("wigglesPerSecond", nn(d.at("wiggleFreq"), Json::number(2)));
    out.set("mode", Json::string("intersect"));
    return out;
  }
  Json out = default_selector("range");
  out.set("id", id);
  out.set("basedOn", nn(d.at("basedOn"), Json::string("characters")));
  out.set("shape", nn(d.at("shape"), Json::string("square")));
  out.set("start", nn(d.at("start"), Json::number(0)));
  out.set("end", nn(d.at("end"), Json::number(100)));
  out.set("offset", nn(d.at("offset"), Json::number(0)));
  out.set("smoothness", Json::number(0));
  return out;
}

}  // namespace

Json normalize_animator(const Json& d) {
  Json selectors = Json::array();
  const Json& sels = d.at("selectors");
  if (sels.is_array() && !sels.arr().empty()) {
    for (const Json& s : sels.arr()) selectors.arr_mut().push_back(normalize_selector(s));
  } else {
    selectors.arr_mut().push_back(legacy_selector(d));
  }
  Json out = d.is_object() ? d : Json::object();
  const Json& en = d.at("enabled");
  out.set("enabled", Json::boolean(!(en.is_bool() && !en.b())));
  out.set("selectors", std::move(selectors));
  auto dflt = [&](std::string_view k, double v) { out.set(k, nn(d.at(k), Json::number(v))); };
  dflt("x", 0);
  dflt("y", 0);
  dflt("z", 0);
  dflt("scale", 100);
  out.set("scaleY", nn(d.at("scaleY"), nn(d.at("scale"), Json::number(100))));
  dflt("rotation", 0);
  dflt("rotationX", 0);
  dflt("rotationY", 0);
  dflt("opacity", 100);
  dflt("fillOpacity", 100);
  dflt("tracking", 0);
  dflt("lineSpacing", 0);
  dflt("characterOffset", 0);
  dflt("blur", 0);
  dflt("skew", 0);
  dflt("strokeWidth", 0);
  return out;
}

std::vector<Json> read_animator_data(const Node& n) {
  const Component* t = text_component(n);
  if (t == nullptr) return {};
  const Json& raw = t->props.at("__animators");
  if (!raw.is_array()) return {};
  std::vector<Json> out;
  for (const Json& a : raw.arr()) out.push_back(normalize_animator(a));
  return out;
}

void write_animators(Document& d, std::string_view nodeId, std::vector<Json> animators) {
  const Node* n = d.node(nodeId);
  if (n == nullptr) return;
  const Component* t = text_component(*n);
  if (t == nullptr) return;
  (void)sg_write_prop(d, nodeId, t->id, "__animators", Json::array(std::move(animators)));
}

void update_animator(Document& d, std::string_view nodeId, std::size_t index, const Json& patch) {
  const Node* n = d.node(nodeId);
  if (n == nullptr) return;
  std::vector<Json> data = read_animator_data(*n);
  if (index >= data.size()) return;
  data[index] = normalize_animator(spread(data[index], patch));
  write_animators(d, nodeId, std::move(data));
}

void update_selector(Document& d, std::string_view nodeId, std::size_t index, std::size_t selectorIndex,
                     const Json& patch) {
  const Node* n = d.node(nodeId);
  if (n == nullptr) return;
  const std::vector<Json> data = read_animator_data(*n);
  if (index >= data.size()) return;
  const Json& cur = data[index];
  const Json& sels = cur.at("selectors");
  if (!sels.is_array() || selectorIndex >= sels.arr().size()) return;
  const Json& sel = sels.arr()[selectorIndex];
  Json next;
  const Json& pk = patch.at("kind");
  if (pk.is_string() && !pk.str().empty() && !(sel.at("kind").is_string() && sel.at("kind").str() == pk.str())) {
    Json fresh = default_selector(pk.str());
    fresh.set("id", sel.at("id"));
    fresh.set("basedOn", sel.at("basedOn"));
    fresh.set("mode", sel.at("mode"));
    fresh.set("enabled", sel.at("enabled"));
    next = spread(fresh, patch);
  } else {
    next = spread(sel, patch);
  }
  Json selectors = sels;
  selectors.arr_mut()[selectorIndex] = std::move(next);
  Json p = Json::object();
  p.set("selectors", std::move(selectors));
  update_animator(d, nodeId, index, p);
}

std::optional<AnimatorTrackRef> parse_animator_track(std::string_view prop) {
  if (!prop.starts_with("ta.")) return std::nullopt;
  const std::string_view rest = prop.substr(3);
  const std::size_t dot = rest.find('.');
  if (dot == std::string_view::npos) return std::nullopt;
  const auto anim = parse_index(rest.substr(0, dot));
  if (!anim) return std::nullopt;
  const std::string_view tail = rest.substr(dot + 1);
  if (tail.empty()) return std::nullopt;
  // `ta.<i>.s<j>.<param>`
  if (tail.size() > 1 && tail[0] == 's') {
    const std::size_t d2 = tail.find('.');
    if (d2 != std::string_view::npos && d2 > 1) {
      if (const auto sel = parse_index(tail.substr(1, d2 - 1)); sel && d2 + 1 < tail.size()) {
        return AnimatorTrackRef{*anim, *sel, std::string(tail.substr(d2 + 1))};
      }
    }
  }
  const std::string param(tail);
  if (param == "start" || param == "end" || param == "offset") return AnimatorTrackRef{*anim, 0, param};
  if (param == "wiggleFreq") return AnimatorTrackRef{*anim, 0, "wigglesPerSecond"};
  return AnimatorTrackRef{*anim, std::nullopt, param};
}

std::optional<AnimatorPath> parse_animator_path(std::string_view prop) {
  if (!prop.starts_with("ta.")) return std::nullopt;
  std::string_view rest = prop.substr(3);
  const std::size_t dot = rest.find('.');
  if (dot == std::string_view::npos) return std::nullopt;
  const auto index = parse_index(rest.substr(0, dot));
  if (!index) return std::nullopt;
  rest = rest.substr(dot + 1);
  std::optional<int> selector;
  if (rest.size() > 1 && rest[0] == 's') {
    const std::size_t d2 = rest.find('.');
    if (d2 != std::string_view::npos) {
      if (const auto s = parse_index(rest.substr(1, d2 - 1))) {
        selector = *s;
        rest = rest.substr(d2 + 1);
      }
    }
  }
  if (rest.empty() || !is_ascii_alpha(rest[0])) return std::nullopt;
  for (const char c : rest) {
    if (!is_ascii_alnum(c)) return std::nullopt;
  }
  return AnimatorPath{*index, selector, std::string(rest)};
}

std::string animator_prop_path(std::size_t index, std::string_view param) {
  return "ta." + std::to_string(index) + "." + std::string(param);
}

std::string animator_axis_prop_path(std::size_t index, std::string_view tag) {
  return "ta." + std::to_string(index) + ".axis" + std::string(tag);
}

std::string selector_prop_path(std::size_t index, std::size_t selectorIndex, std::string_view param) {
  if (selectorIndex == 0) {
    if (param == "start" || param == "end" || param == "offset") return animator_prop_path(index, param);
    if (param == "wigglesPerSecond") return animator_prop_path(index, "wiggleFreq");
  }
  return "ta." + std::to_string(index) + ".s" + std::to_string(selectorIndex) + "." + std::string(param);
}

std::optional<std::string> axis_tag_of_param(std::string_view param) {
  if (param.size() == 8 && param.starts_with("axis") && is_axis_tag(param.substr(4))) {
    return std::string(param.substr(4));
  }
  return std::nullopt;
}

// ── text path, font axes ─────────────────────────────────────────────────

std::optional<Json> read_text_path_config(const Node& n) {
  const Json* raw = fx_member(n, "textPath");
  if (raw == nullptr || !raw->is_object()) return std::nullopt;
  const Json& t = *raw;
  Json out = Json::object();
  out.set("pathId", t.at("pathId").is_string() ? t.at("pathId") : Json::string(""));
  out.set("firstMargin", Json::number(num_or(t.at("firstMargin"), 0)));
  out.set("reversed", Json::boolean(t.at("reversed").is_bool() ? t.at("reversed").b() : false));
  out.set("perpendicular", Json::boolean(t.at("perpendicular").is_bool() ? t.at("perpendicular").b() : true));
  if (t.at("forceAlignment").is_bool() && t.at("forceAlignment").b()) out.set("forceAlignment", Json::boolean(true));
  const Json& lm = t.at("lastMargin");
  if (lm.is_finite_number() && lm.num() != 0) out.set("lastMargin", lm);
  return out;
}

double text_path_param_value(const Json& cfg, std::string_view param) {
  if (param == "firstMargin") return cfg.at("firstMargin").num();
  if (param == "lastMargin") return num_or(cfg.at("lastMargin"), 0);
  if (param == "reversed") return cfg.at("reversed").b() ? 1 : 0;
  if (param == "perpendicular") return cfg.at("perpendicular").b() ? 1 : 0;
  if (param == "forceAlignment") return cfg.at("forceAlignment").b() ? 1 : 0;
  return 0;
}

std::optional<std::string> parse_text_path_prop_path(std::string_view path) {
  if (!path.starts_with("textPath.")) return std::nullopt;
  const std::string p(path.substr(9));
  for (const std::string& k : registry().textPathParams) {
    if (k == p) return p;
  }
  return std::nullopt;
}

void update_text_path(Document& d, std::string_view nodeId, const Json& patch) {
  const Node* n = d.node(nodeId);
  if (n == nullptr) return;
  Json base = read_text_path_config(*n).value_or(Json());
  if (!base.is_object()) {
    base = Json::object();
    base.set("pathId", Json::string(""));
    base.set("firstMargin", Json::number(0));
    base.set("reversed", Json::boolean(false));
    base.set("perpendicular", Json::boolean(true));
  }
  sg_set_fx(d, nodeId, "textPath", spread(base, patch));
}

namespace {
bool legacy_axis(std::string_view tag) { return tag == "wght" || tag == "wdth" || tag == "slnt"; }
}  // namespace

Json read_font_axes_prop(const Node& n) {
  Json out = Json::object();
  for (const Component& c : n.components) {
    if (c.type != "Text") continue;
    const Json& raw = c.props.at("fontAxes");
    if (raw.is_object()) {
      for (const auto& m : raw.obj()) {
        if (!is_axis_tag(m.key) || legacy_axis(m.key)) continue;
        if (m.value.is_finite_number()) out.set(m.key, m.value);
      }
    }
    return out;
  }
  return out;
}

std::string axis_prop_path(std::string_view tag) {
  if (tag == "wght") return "fontWeight";
  if (tag == "wdth") return "fontWidth";
  if (tag == "slnt") return "fontSlant";
  return "text.axis." + std::string(tag);
}

std::optional<std::string> parse_axis_prop_path(std::string_view path) {
  if (!path.starts_with("text.axis.")) return std::nullopt;
  const std::string_view tag = path.substr(10);
  return is_axis_tag(tag) ? std::optional<std::string>(std::string(tag)) : std::nullopt;
}

// ── paint ────────────────────────────────────────────────────────────────

std::optional<std::vector<Json>> read_node_paint(const Node& n) {
  const Json* raw = fx_member(n, "paint");
  if (raw == nullptr || !raw->is_object()) return std::nullopt;
  const Json& strokes = raw->at("strokes");
  if (!strokes.is_array() || strokes.arr().empty()) return std::nullopt;
  std::vector<Json> out;
  for (const Json& s : strokes.arr()) {
    if (s.is_object() && s.at("points").is_array() && !s.at("points").arr().empty()) out.push_back(s);
  }
  if (out.empty()) return std::nullopt;
  return out;
}

bool paint_on_transparent(const Node& n) {
  const Json* raw = fx_member(n, "paint");
  return raw != nullptr && raw->at("onTransparent").is_bool() && raw->at("onTransparent").b();
}

std::map<std::string, std::string> stroke_display_names(const std::vector<Json>& strokes) {
  int paint = 0;
  int erase = 0;
  int clone = 0;
  std::map<std::string, std::string> out;
  for (const Json& s : strokes) {
    const std::string mode = s.at("mode").is_string() ? s.at("mode").str() : "paint";
    int n = 0;
    std::string base = "Brush";
    if (mode == "erase") {
      n = ++erase;
      base = "Eraser";
    } else if (mode == "clone") {
      n = ++clone;
      base = "Clone";
    } else {
      n = ++paint;
    }
    const Json& name = s.at("name");
    out[s.at("id").str()] = name.is_string() ? name.str() : base + " " + std::to_string(n);
  }
  return out;
}

namespace {
bool paint_numeric_key(std::string_view k) {
  const Json& p = registry().paint;
  for (const char* list : {"optionKeys", "cloneKeys", "transformKeys"}) {
    for (const Json& x : p.at(list).arr()) {
      if (x.str() == k) return true;
    }
  }
  return false;
}
}  // namespace

std::optional<PaintPropRef> parse_paint_prop_path(std::string_view prop) {
  auto r = parse_prefixed_id_rest(prop, "paint.");
  if (!r) return std::nullopt;
  for (const char c : r->rest) {
    if (!is_ascii_alpha(c)) return std::nullopt;
  }
  if (!paint_numeric_key(r->rest)) return std::nullopt;
  return PaintPropRef{r->id, r->rest};
}

std::optional<PaintColorRef> parse_paint_color_path(std::string_view prop) {
  auto r = parse_prefixed_id_rest(prop, "paint.");
  if (!r || r->rest.size() != 7 || !r->rest.starts_with("color_")) return std::nullopt;
  const char ch = r->rest[6];
  if (ch != 'r' && ch != 'g' && ch != 'b' && ch != 'a') return std::nullopt;
  return PaintColorRef{r->id, ch};
}

namespace {
struct Pt {
  double x = 0;
  double y = 0;
};
Pt first_point(const Json& s) {
  const Json& pts = s.at("points");
  if (!pts.is_array() || pts.arr().empty()) return {};
  return {pts.arr()[0].at("x").num(), pts.arr()[0].at("y").num()};
}
Json transform_of(const Json& s) {
  const Json& t = s.at("transform");
  if (!t.is_undefined() && !t.is_null()) return t;
  const Pt p = first_point(s);
  Json out = Json::object();
  out.set("anchorX", Json::number(p.x));
  out.set("anchorY", Json::number(p.y));
  out.set("x", Json::number(p.x));
  out.set("y", Json::number(p.y));
  out.set("scale", Json::number(100));
  out.set("rotation", Json::number(0));
  return out;
}
}  // namespace

std::optional<double> read_paint_stroke_value(const Json& s, std::string_view key) {
  // paintValues.ts readPaintStrokeValue with JavaScript arithmetic on a raw
  // (possibly un-normalised) stroke: `x ?? fb` for the optional fields, a bare
  // field that is absent reads undefined (nullopt), `undefined * 100` is NaN.
  const Json t = transform_of(s);
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const auto js = [nan](const Json& v) {
    if (v.is_number()) return v.num();
    if (v.is_bool()) return v.b() ? 1.0 : 0.0;
    if (v.is_null()) return 0.0;
    return nan;
  };
  auto v = [&](std::string_view k, double fb) { return nn(s.at(k), Json::number(fb)).is_number() ? nn(s.at(k), Json::number(fb)).num() : js(s.at(k)); };
  auto raw = [&](const Json& x) -> std::optional<double> {
    if (x.is_undefined()) return std::nullopt;
    return js(x);
  };
  if (key == "start") return v("start", 0) * 100;
  if (key == "end") return v("end", 1) * 100;
  if (key == "diameter") return raw(s.at("size"));
  if (key == "angle") return v("angle", 0);
  if (key == "hardness") return js(s.at("hardness")) * 100;
  if (key == "roundness") return v("roundness", 1) * 100;
  if (key == "spacing") return v("spacing", 0.25) * 100;
  if (key == "opacity") return js(s.at("opacity")) * 100;
  if (key == "flow") return v("flow", 1) * 100;
  if (key == "clonePositionX") return first_point(s).x + v("cloneOffsetX", 0);
  if (key == "clonePositionY") return first_point(s).y + v("cloneOffsetY", 0);
  if (key == "cloneTime") return v("cloneSourceTime", 0);
  if (key == "cloneTimeShift") return v("cloneTimeShift", 0);
  if (key == "anchorX") return raw(t.at("anchorX"));
  if (key == "anchorY") return raw(t.at("anchorY"));
  if (key == "positionX") return raw(t.at("x"));
  if (key == "positionY") return raw(t.at("y"));
  if (key == "scale") return raw(t.at("scale"));
  if (key == "rotation") return raw(t.at("rotation"));
  return std::nullopt;
}

Json paint_stroke_patch(const Json& s, std::string_view key, double value) {
  const double pct = value / 100;
  Json out = Json::object();
  auto tset = [&](std::string_view field) {
    Json t = transform_of(s);
    t.set(field, Json::number(value));
    out.set("transform", std::move(t));
  };
  if (key == "start") out.set("start", Json::number(pct));
  else if (key == "end") out.set("end", Json::number(pct));
  else if (key == "diameter") out.set("size", Json::number(std::max(0.1, value)));
  else if (key == "angle") out.set("angle", Json::number(value));
  else if (key == "hardness") out.set("hardness", Json::number(pct));
  else if (key == "roundness") out.set("roundness", Json::number(pct));
  else if (key == "spacing") out.set("spacing", Json::number(pct));
  else if (key == "opacity") out.set("opacity", Json::number(pct));
  else if (key == "flow") out.set("flow", Json::number(pct));
  else if (key == "clonePositionX") out.set("cloneOffsetX", Json::number(value - first_point(s).x));
  else if (key == "clonePositionY") out.set("cloneOffsetY", Json::number(value - first_point(s).y));
  else if (key == "cloneTime") {
    out.set("cloneLockTime", Json::boolean(true));
    out.set("cloneSourceTime", Json::number(value));
  } else if (key == "cloneTimeShift") out.set("cloneTimeShift", Json::number(value));
  else if (key == "anchorX") tset("anchorX");
  else if (key == "anchorY") tset("anchorY");
  else if (key == "positionX") tset("x");
  else if (key == "positionY") tset("y");
  else if (key == "scale") tset("scale");
  else if (key == "rotation") tset("rotation");
  return out;
}

namespace {

/// @utils/lang `clamp01` (NaN → 0).
double clamp01(double v) { return v > 0 ? (v > 1 ? 1 : v) : 0; }
bool finite_num(const Json& v) { return v.is_number() && std::isfinite(v.num()); }

}  // namespace

Json normalize_paint_stroke(const Json& raw, const std::string& id) {
  Json out = Json::object();
  const Json& rid = raw.at("id");
  out.set("id", rid.is_undefined() || rid.is_null() ? Json::string(id) : rid);
  out.set("points", raw.at("points"));
  out.set("color", raw.at("color").is_string() ? raw.at("color") : Json::string("#ffffff"));
  out.set("size", Json::number(raw.at("size").is_number() && raw.at("size").num() > 0 ? raw.at("size").num() : 12));
  out.set("opacity", Json::number(clamp01(raw.at("opacity").is_number() ? raw.at("opacity").num() : 1)));
  out.set("hardness", Json::number(clamp01(raw.at("hardness").is_number() ? raw.at("hardness").num() : 1)));
  const Json& m = raw.at("mode");
  const std::string mode = m.is_string() && (m.str() == "erase" || m.str() == "clone") ? m.str() : "paint";
  out.set("mode", Json::string(mode));
  if (m.is_string() && m.str() == "clone") {
    out.set("cloneOffsetX", Json::number(raw.at("cloneOffsetX").is_number() ? raw.at("cloneOffsetX").num() : 0));
    out.set("cloneOffsetY", Json::number(raw.at("cloneOffsetY").is_number() ? raw.at("cloneOffsetY").num() : 0));
  }
  if (raw.at("name").is_string() && !raw.at("name").str().empty()) out.set("name", raw.at("name"));
  if (finite_num(raw.at("start"))) out.set("start", Json::number(clamp01(raw.at("start").num())));
  if (finite_num(raw.at("end"))) out.set("end", Json::number(clamp01(raw.at("end").num())));
  if (finite_num(raw.at("angle"))) out.set("angle", raw.at("angle"));
  if (finite_num(raw.at("roundness"))) out.set("roundness", Json::number(std::max(0.01, clamp01(raw.at("roundness").num()))));
  if (finite_num(raw.at("spacing"))) out.set("spacing", Json::number(std::max(0.01, std::min(10.0, raw.at("spacing").num()))));
  if (finite_num(raw.at("flow"))) out.set("flow", Json::number(clamp01(raw.at("flow").num())));
  const Json& ch = raw.at("channels");
  if (ch.is_string() && (ch.str() == "rgb" || ch.str() == "alpha" || ch.str() == "rgba")) out.set("channels", ch);
  if (raw.at("blend").is_string()) out.set("blend", raw.at("blend"));
  if (mode == "erase") {
    const Json& em = raw.at("eraseMode");
    if (em.is_string() && (em.str() == "paintOnly" || em.str() == "lastStroke" || em.str() == "layerAndPaint")) out.set("eraseMode", em);
    if (raw.at("eraseTargetId").is_string()) out.set("eraseTargetId", raw.at("eraseTargetId"));
  }
  if (finite_num(raw.at("inPoint"))) out.set("inPoint", raw.at("inPoint"));
  if (finite_num(raw.at("outPoint"))) out.set("outPoint", raw.at("outPoint"));
  if (raw.at("visible").is_bool() && !raw.at("visible").b()) out.set("visible", Json::boolean(false));
  const std::size_t n = raw.at("points").is_array() ? raw.at("points").arr().size() : 0;
  for (const char* k : {"pressure", "tiltX", "tiltY"}) {
    if (raw.at(k).is_array() && raw.at(k).arr().size() == n) out.set(k, raw.at(k));
  }
  for (const char* k : {"dynamics", "transform"}) {
    const Json& v = raw.at(k);
    if (v.is_object()) out.set(k, spread(Json::object(), v));
  }
  if (mode == "clone") {
    const Json& src = raw.at("cloneSourceId");
    if (src.is_string() && !src.str().empty()) out.set("cloneSourceId", src);
    if (finite_num(raw.at("cloneTimeShift")) && raw.at("cloneTimeShift").num() != 0) out.set("cloneTimeShift", raw.at("cloneTimeShift"));
    if (raw.at("cloneLockTime").is_bool() && raw.at("cloneLockTime").b()) {
      out.set("cloneLockTime", Json::boolean(true));
      out.set("cloneSourceTime", finite_num(raw.at("cloneSourceTime")) ? raw.at("cloneSourceTime") : Json::number(0));
    }
    if (raw.at("cloneAligned").is_bool()) out.set("cloneAligned", raw.at("cloneAligned"));
  }
  return out;
}

void update_paint_stroke(Document& d, std::string_view nodeId, std::string_view strokeId, const Json& patch) {
  const Node* n = d.node(nodeId);
  if (n == nullptr) return;
  const Json* raw = fx_member(*n, "paint");
  auto strokes = read_node_paint(*n);
  if (!strokes) return;
  bool hit = false;
  for (Json& s : *strokes) {
    if (s.at("id").str() != strokeId) continue;
    hit = true;
    // paintStrokes.updatePaintStroke: merge, an `undefined` in the patch clears
    // the key, then normalizeStroke (clamps, defaults, the editor's key order).
    Json merged = spread(s, patch);
    if (patch.is_object()) {
      for (const auto& m : patch.obj()) {
        if (m.value.is_undefined()) merged.erase(m.key);
      }
    }
    s = normalize_paint_stroke(merged, s.at("id").is_string() ? s.at("id").str() : std::string());
  }
  if (!hit) return;
  const bool onTransparent = raw != nullptr && raw->at("onTransparent").is_bool() && raw->at("onTransparent").b();
  Json cfg = Json::object();
  cfg.set("strokes", Json::array(std::move(*strokes)));
  if (onTransparent) cfg.set("onTransparent", Json::boolean(true));
  sg_set_fx(d, nodeId, "paint", std::move(cfg));
}

// ── gradient geometry (inspector/gradientGeometryProps.ts) ──────────────────

namespace {

enum class GradField : std::uint8_t { angle, cx, cy, radius };
enum class GradChannel : std::uint8_t { fill, textStroke };

struct GradLoc {
  GradChannel channel;
  GradField field;
};

std::optional<GradLoc> locate_gradient(std::string_view prop) {
  for (const auto& [prefix, ch] : {std::pair<std::string_view, GradChannel>{"fill", GradChannel::fill},
                                   std::pair<std::string_view, GradChannel>{"stroke", GradChannel::textStroke}}) {
    if (!prop.starts_with(prefix)) continue;
    const std::string_view rest = prop.substr(prefix.size());
    if (rest == "Angle") return GradLoc{ch, GradField::angle};
    if (rest == "CenterX") return GradLoc{ch, GradField::cx};
    if (rest == "CenterY") return GradLoc{ch, GradField::cy};
    if (rest == "Radius") return GradLoc{ch, GradField::radius};
  }
  return std::nullopt;
}

bool is_gradient_paint(const Json& p) {
  return p.is_object() && p.at("type").is_string() && (p.at("type").str() == "linear" || p.at("type").str() == "radial");
}

/// fill.ts isFillPaint.
bool is_fill_paint(const Json& p) {
  return p.is_object() && p.at("type").is_string() &&
         (p.at("type").str() == "solid" || p.at("type").str() == "linear" || p.at("type").str() == "radial");
}

/// The channel's gradient paint: readNodeFill (fx.fill; a legacy colour string
/// is solid) / readTextStrokePaint (the FIRST Text component's strokePaint,
/// with at least one stop).
std::optional<Json> gradient_paint(const Node& n, GradChannel ch) {
  if (ch == GradChannel::fill) {
    const Json& f = n.fx().at("fill");
    if (is_gradient_paint(f)) return f;
    return std::nullopt;
  }
  for (const Component& c : n.components) {
    if (c.type != "Text") continue;
    const Json& p = c.props.at("strokePaint");
    if (is_gradient_paint(p) && p.at("stops").is_array() && !p.at("stops").arr().empty()) return p;
    return std::nullopt;
  }
  return std::nullopt;
}

const char* field_key(GradField f) {
  switch (f) {
    case GradField::angle: return "angle";
    case GradField::cx: return "cx";
    case GradField::cy: return "cy";
    case GradField::radius: return "radius";
  }
  return "angle";
}

bool has_field(const Json& paint, GradField f) {
  return paint.at("type").str() == "linear" ? f == GradField::angle : f != GradField::angle;
}

}  // namespace

bool is_gradient_geometry_prop(std::string_view prop) { return locate_gradient(prop).has_value(); }

std::optional<double> read_gradient_geometry_prop(const Node& n, std::string_view prop) {
  const auto at = locate_gradient(prop);
  if (!at) return std::nullopt;
  const auto paint = gradient_paint(n, at->channel);
  if (!paint || !has_field(*paint, at->field)) return std::nullopt;
  const Json& v = paint->at(field_key(at->field));
  // `(paint as Record<Field, number>)[field]`: whatever the paint holds; a
  // non-number reads as absent here (the TS would hand it on as-is).
  return v.is_number() ? std::optional<double>(v.num()) : std::nullopt;
}

bool write_gradient_geometry_prop(Document& d, std::string_view nodeId, std::string_view prop, double value) {
  const Node* np = d.node(nodeId);
  const auto at = locate_gradient(prop);
  if (np == nullptr || !at) return false;
  const auto paint = gradient_paint(*np, at->channel);
  if (!paint || !has_field(*paint, at->field) || !std::isfinite(value)) return false;
  // The renderer floors the radius at 0.01; store what it will draw.
  const double v = at->field == GradField::radius ? std::max(0.01, value) : value;
  Json next = *paint;
  next.set(field_key(at->field), Json::number(v));
  if (at->channel == GradChannel::textStroke) {
    for (const Component& c : np->components) {
      if (c.type == "Text") return sg_write_prop(d, nodeId, c.id, "strokePaint", std::move(next));
    }
    return false;
  }
  // fill.ts setNodeFill: with a fill STACK, the first entry is replaced.
  const Json& stack = np->fx().at("fills");
  std::vector<Json> valid;
  if (stack.is_array()) {
    for (const Json& f : stack.arr()) {
      if (is_fill_paint(f)) valid.push_back(f);
    }
  }
  if (!valid.empty()) {
    Json fills = Json::array();
    fills.arr_mut().push_back(next);
    for (std::size_t i = 1; i < valid.size(); ++i) fills.arr_mut().push_back(valid[i]);
    sg_set_fx(d, nodeId, "fills", fills.arr().size() > 1 ? fills : Json());
  }
  sg_set_fx(d, nodeId, "fill", std::move(next));
  return true;
}

std::vector<std::string> gradient_geometry_props_for(const Node& n) {
  if (n.comp("Text") == nullptr) return {};
  std::vector<std::string> out;
  for (const auto& [ch, prefix] : {std::pair<GradChannel, std::string>{GradChannel::fill, "fill"},
                                   std::pair<GradChannel, std::string>{GradChannel::textStroke, "stroke"}}) {
    const auto paint = gradient_paint(n, ch);
    if (!paint) continue;
    if (paint->at("type").str() == "linear") {
      out.push_back(prefix + "Angle");
    } else {
      out.push_back(prefix + "CenterX");
      out.push_back(prefix + "CenterY");
      out.push_back(prefix + "Radius");
    }
  }
  return out;
}

}  // namespace premation::doc
