#include "strokes.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <set>

#include "catalog_data.hpp"
#include "fail.hpp"
#include "fields.hpp"
#include "fxstate.hpp"
#include "jsmath.hpp"
#include "meta.hpp"
#include "scene.hpp"
#include "strutil.hpp"

namespace premation::doc {
namespace {

using api::ErrorCode;
using js::stringify;

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

/// A JSON value as a JS number would read it (`undefined` / non-numbers → NaN).
double js_num(const Json& v) { return v.is_number() ? v.num() : kNaN; }
/// JS Math.max / Math.min of two (NaN propagates).
double js_max(double a, double b) {
  const std::array<double, 2> v{a, b};
  return motion::js::max_of(v);
}
double js_min(double a, double b) {
  const std::array<double, 2> v{a, b};
  return motion::js::min_of(v);
}
double clamp01(double v) { return js_max(0, js_min(1, v)); }

bool is_stroke(const Json& v) { return v.is_object() && v.at("width").is_number(); }

// ── normalizeStroke (stroke.ts) ──────────────────────────────────────────

Json norm_taper(const Json& v) {
  if (!v.is_object()) return {};
  const auto fin = [](const Json& x, double d) { return x.is_finite_number() ? x.num() : d; };
  const auto n01 = [&](const Json& x, double d) { return clamp01(fin(x, d)); };
  const bool pixels = v.at("lengthUnits").is_string() && v.at("lengthUnits").str() == "pixels";
  const auto len = [&](const Json& x) { return pixels ? std::max(0.0, fin(x, 0)) : n01(x, 0); };
  const auto ease = [&](const Json& x) { return std::max(-1.0, std::min(1.0, fin(x, 0))); };
  const double sw = n01(v.at("startWidth"), 1);
  const double ew = n01(v.at("endWidth"), 1);
  const double sl = len(v.at("startLength"));
  const double el = len(v.at("endLength"));
  if ((sl <= 0 && el <= 0) || (sw == 1 && ew == 1)) return {};
  Json o = Json::object();
  o.set("startWidth", Json::number(sw));
  o.set("endWidth", Json::number(ew));
  o.set("startLength", Json::number(sl));
  o.set("endLength", Json::number(el));
  o.set("startEase", Json::number(ease(v.at("startEase"))));
  o.set("endEase", Json::number(ease(v.at("endEase"))));
  if (pixels) o.set("lengthUnits", Json::string("pixels"));
  return o;
}

Json norm_wave(const Json& v) {
  if (!v.is_object()) return {};
  const auto num = [](const Json& x, double d) { return x.is_finite_number() ? x.num() : d; };
  const double amount = num(v.at("amount"), 0);
  const double wl = std::max(0.0, num(v.at("wavelength"), 0));
  if (amount == 0 || wl <= 0) return {};
  Json o = Json::object();
  o.set("amount", Json::number(amount));
  o.set("wavelength", Json::number(wl));
  o.set("phase", Json::number(num(v.at("phase"), 0)));
  if (v.at("units").is_string() && v.at("units").str() == "cycles") o.set("units", Json::string("cycles"));
  return o;
}

Json norm_gradient(const Json& v) {
  if (!v.is_object()) return {};
  for (const char* k : {"startX", "startY", "endX", "endY"}) {
    if (!v.at(k).is_finite_number()) return {};
  }
  Json o = Json::object();
  for (const char* k : {"startX", "startY", "endX", "endY"}) o.set(k, v.at(k));
  const Json& hl = v.at("highlightLength");
  if (hl.is_finite_number() && hl.num() != 0) o.set("highlightLength", Json::number(std::max(-1.0, std::min(1.0, hl.num()))));
  const Json& ha = v.at("highlightAngle");
  if (ha.is_finite_number() && ha.num() != 0) o.set("highlightAngle", ha);
  return o;
}

bool is_paint_blend_mode(std::string_view m) {
  // paintBlend.ts PAINT_BLEND_MODES.
  static constexpr std::array<std::string_view, 17> kModes = {
      "normal", "darken", "multiply", "color-burn", "add", "lighten", "screen", "color-dodge", "overlay",
      "soft-light", "hard-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"};
  return std::find(kModes.begin(), kModes.end(), m) != kModes.end();
}

// ── strokeValues.ts ──────────────────────────────────────────────────────

constexpr std::array<std::string_view, 6> kDash = {"dash1", "gap1", "dash2", "gap2", "dash3", "gap3"};
constexpr std::array<std::pair<std::string_view, std::string_view>, 6> kTaper = {{
    {"taperStartLength", "startLength"}, {"taperEndLength", "endLength"}, {"taperStartWidth", "startWidth"},
    {"taperEndWidth", "endWidth"}, {"taperStartEase", "startEase"}, {"taperEndEase", "endEase"}}};
constexpr std::array<std::pair<std::string_view, std::string_view>, 3> kWave = {{
    {"waveAmount", "amount"}, {"waveWavelength", "wavelength"}, {"wavePhase", "phase"}}};
constexpr std::array<std::pair<std::string_view, std::string_view>, 6> kGradient = {{
    {"gradientStartX", "startX"}, {"gradientStartY", "startY"}, {"gradientEndX", "endX"}, {"gradientEndY", "endY"},
    {"highlightLength", "highlightLength"}, {"highlightAngle", "highlightAngle"}}};

template <std::size_t N>
std::optional<std::string_view> field_of(const std::array<std::pair<std::string_view, std::string_view>, N>& t,
                                         std::string_view param) {
  for (const auto& [p, f] : t) {
    if (p == param) return f;
  }
  return std::nullopt;
}

std::optional<std::size_t> dash_slot(std::string_view param) {
  for (std::size_t k = 0; k < kDash.size(); ++k) {
    if (kDash[k] == param) return k;
  }
  return std::nullopt;
}

Json identity_taper() {
  Json o = Json::object();
  o.set("startLength", Json::number(0));
  o.set("endLength", Json::number(0));
  o.set("startWidth", Json::number(1));
  o.set("endWidth", Json::number(1));
  o.set("startEase", Json::number(0));
  o.set("endEase", Json::number(0));
  return o;
}

Json identity_wave() {
  Json o = Json::object();
  o.set("amount", Json::number(0));
  o.set("wavelength", Json::number(0));
  o.set("phase", Json::number(0));
  return o;
}

/// `{ ...a, ...b }` for JSON objects.
Json spread_obj(const Json& a, const Json& b) {
  Json o = a.is_object() ? a : Json::object();
  if (b.is_object()) {
    for (const auto& m : b.obj()) o.set(m.key, m.value);
  }
  return o;
}

/// strokeValues.ts `staticLayerSize`.
std::pair<double, double> static_layer_size(const Node& n) {
  std::optional<double> w;
  std::optional<double> h;
  for (const Component& c : n.components) {
    if (!w && c.props.at("width").is_number()) w = c.props.at("width").num();
    if (!h && c.props.at("height").is_number()) h = c.props.at("height").num();
  }
  return {w.value_or(0), h.value_or(0)};
}

bool gradient_paint(const Json& s) {
  const Json& p = s.at("paint");
  return p.is_object() && p.at("type").is_string() && p.at("type").str() != "solid";
}

/// strokeTracks.ts `strokeGradientGeometryFor` at the layer's static size.
Json gradient_of(const Node& n, const Json& s) {
  if (s.at("gradient").is_object()) return s.at("gradient");
  const auto [w, h] = static_layer_size(n);
  const auto rel = [](double px, double extent) { return extent > 0 ? 0.5 + px / extent : 0.5; };
  const Json& paint = s.at("paint");
  Json g = Json::object();
  auto put = [&g](double sx, double sy, double ex, double ey) {
    g.set("startX", Json::number(sx));
    g.set("startY", Json::number(sy));
    g.set("endX", Json::number(ex));
    g.set("endY", Json::number(ey));
  };
  const std::string type = paint.at("type").is_string() ? paint.at("type").str() : "";
  if (!paint.is_object() || type == "solid") {
    put(0.5, 0, 0.5, 1);
  } else if (type == "linear") {
    const double a = (js_num(paint.at("angle")) * 3.141592653589793) / 180;
    const double dx = motion::js::cos(a);
    const double dy = motion::js::sin(a);
    const double half = (std::abs(dx) * w + std::abs(dy) * h) / 2;
    put(rel(-dx * half, w), rel(-dy * half, h), rel(dx * half, w), rel(dy * half, h));
  } else {
    const std::array<double, 2> wh{w, h};
    const double r = (js_max(0.01, js_num(paint.at("radius"))) * motion::js::hypot(wh)) / 2;
    const double cx = js_num(paint.at("cx"));
    const double cy = js_num(paint.at("cy"));
    put(cx, cy, cx + (w > 0 ? r / w : 0), cy);
  }
  return g;
}

/// `Json::number` that keeps NaN as NaN (JSON would print null, the TS keeps NaN in memory too).
std::optional<Json> with_stroke_param(const Node& n, const Json& s, std::string_view param, double value) {
  if (!std::isfinite(value)) return std::nullopt;
  Json next = s;
  if (param == "color") return std::nullopt;
  if (param == "opacity" || param == "width" || param == "miterLimit" || param == "dashOffset") {
    next.set(param, Json::number(value));
    return normalize_shape_stroke(next);
  }
  if (auto k = dash_slot(param)) {
    const Json& dash = s.at("dash");
    if (!dash.is_array() || *k >= dash.arr().size()) return std::nullopt;
    Json d = dash;
    d.arr_mut()[*k] = Json::number(std::max(0.0, value));
    next.set("dash", std::move(d));
    return normalize_shape_stroke(next);
  }
  if (auto f = field_of(kTaper, param)) {
    Json t = spread_obj(identity_taper(), s.at("taper"));
    t.set(*f, Json::number(value));
    next.set("taper", std::move(t));
    return normalize_shape_stroke(next);
  }
  if (auto f = field_of(kWave, param)) {
    Json w = spread_obj(identity_wave(), s.at("wave"));
    w.set(*f, Json::number(value));
    next.set("wave", std::move(w));
    return normalize_shape_stroke(next);
  }
  if (auto f = field_of(kGradient, param)) {
    if (!gradient_paint(s)) return std::nullopt;
    Json g = gradient_of(n, s);
    g.set(*f, Json::number(value));
    next.set("gradient", std::move(g));
    return normalize_shape_stroke(next);
  }
  return std::nullopt;
}

/// strokeTracks.ts `strokeTrackPathsFor(index)`.
std::vector<std::string> stroke_track_paths_for(std::size_t index) {
  std::vector<std::string> out;
  const std::string prefix = stroke_track_path(index, "color");
  for (const char* c : {"_r", "_g", "_b", "_a"}) out.push_back(prefix + c);
  for (const Json& p : registry().strokeTracks.at("params").arr()) {
    if (p.str() != "color") out.push_back(stroke_track_path(index, p.str()));
  }
  return out;
}

const Json& primary_fill(const Node& n) { return n.fx().at("fill"); }

std::optional<std::string> gradient_kind(const Node& n) {
  const Json& f = primary_fill(n);
  if (!f.is_object() || !f.at("type").is_string()) return std::nullopt;
  const std::string& t = f.at("type").str();
  if (t == "linear" || t == "radial") return t;
  return std::nullopt;
}

/// fillStops.ts `storedStops`: sorted by offset (stable for ties / NaN).
std::vector<Json> stored_stops(const Node& n) {
  const Json& raw = primary_fill(n).at("stops");
  std::vector<std::pair<Json, std::size_t>> list;
  if (raw.is_array()) {
    for (const Json& s : raw.arr()) {
      if (s.is_object()) list.emplace_back(s, list.size());
    }
  }
  std::stable_sort(list.begin(), list.end(), [](const auto& x, const auto& y) {
    const double d = js_num(x.first.at("offset")) - js_num(y.first.at("offset"));
    if (d != 0 && !std::isnan(d)) return d < 0;
    return x.second < y.second;
  });
  std::vector<Json> out;
  for (auto& e : list) out.push_back(std::move(e.first));
  return out;
}

api::Color color_of(const Json& hex) {
  const auto c = parse_color_channels(hex.is_string() ? hex.str() : "#000000");
  return api::Color{c[0], c[1], c[2], c[3]};
}

api::Value gradient_value(const std::string& kind, const std::vector<std::pair<double, Json>>& stops) {
  api::Gradient g;
  g.kind = kind == "radial" ? api::GradientKind::radial : api::GradientKind::linear;
  for (const auto& [offset, color] : stops) {
    api::GradientStop s;
    s.offset = offset;
    s.color = color_of(color);
    g.stops.push_back(s);
  }
  return make_value<VK::gradient>(std::move(g));
}

struct WrittenStop {
  double offset = 0;
  std::string color;
};

std::vector<WrittenStop> written_stops(const PropBinding& b, const api::Value& value) {
  if (value.kind() != VK::gradient) {
    fail(ErrorCode::type_mismatch, "'" + b.path + "' takes a gradient, got " + std::string(kind_name(value.kind())),
         {.path = b.path, .detail = "{\"expected\":\"gradient\"}"});
  }
  std::vector<WrittenStop> out;
  for (const api::GradientStop& s : get<VK::gradient>(value).stops) {
    const api::Color& c = s.color;
    if (!std::isfinite(s.offset) || !std::isfinite(c.r) || !std::isfinite(c.g) || !std::isfinite(c.b) || !std::isfinite(c.a)) {
      fail(ErrorCode::invalid_argument, "'" + b.path + "': stops must be finite", {.path = b.path});
    }
    out.push_back({std::max(0.0, std::min(1.0, s.offset)), channels_to_color(c.r, c.g, c.b, c.a)});
  }
  return out;
}

bool holds(const Node& n, const Json& w) {
  if (!w.is_object()) return true;
  if (w.at("component").is_string() && n.comp(w.at("component").str()) == nullptr) return false;
  if (w.at("fx").is_string() && n.fx().at(w.at("fx").str()).is_undefined()) return false;
  if (w.at("threeD").is_bool() && w.at("threeD").b() && !is_3d_enabled(n)) return false;
  auto contains = [](const Json& list, const std::string& v) {
    for (const Json& x : list.arr()) {
      if (x.is_string() && x.str() == v) return true;
    }
    return false;
  };
  if (w.at("kinds").is_array() || w.at("notKinds").is_array()) {
    const std::string kind = n.kind();
    if (w.at("kinds").is_array() && !contains(w.at("kinds"), kind)) return false;
    if (w.at("notKinds").is_array() && contains(w.at("notKinds"), kind)) return false;
  }
  if (w.at("fillType").is_string()) {
    const Json& f = n.fx().at("fill");
    if (!f.is_object() || !(f.at("type").is_string() && f.at("type").str() == w.at("fillType").str())) return false;
  }
  return true;
}

/// modelMorph.ts `nodeMorphTargetCount`.
std::size_t morph_target_count(const Node& n) {
  std::size_t count = 0;
  if (const Component* t = n.comp("Transform")) {
    while (count < 256 && t->props.at("morph" + std::to_string(count)).is_number()) ++count;
  }
  for (const Component& c : n.components) {
    if (c.type != "Model") continue;
    const Json& names = c.props.at("morphNames");
    if (!names.is_array()) continue;
    count = std::max(count, names.arr().size());
    break;
  }
  return count;
}

}  // namespace

// ── the stroke stack ─────────────────────────────────────────────────────

Json normalize_shape_stroke(const Json& v) {
  Json o = Json::object();
  if (!is_stroke(v)) {
    o.set("enabled", Json::boolean(true));
    o.set("color", Json::string("#ffffff"));
    o.set("width", Json::number(4));
    o.set("opacity", Json::number(1));
    o.set("align", Json::string("center"));
    o.set("dash", Json::array());
    o.set("cap", Json::string("butt"));
    o.set("join", Json::string("miter"));
    return o;
  }
  const Json& paint = v.at("paint");
  const bool validPaint = paint.is_object() && paint.at("type").is_string() &&
                          (paint.at("type").str() == "linear" || paint.at("type").str() == "radial" ||
                           paint.at("type").str() == "solid");
  o.set("enabled", Json::boolean(!(v.at("enabled").is_bool() && !v.at("enabled").b())));
  o.set("color", v.at("color").is_string() ? v.at("color") : Json::string("#ffffff"));
  o.set("width", Json::number(std::max(0.0, v.at("width").is_finite_number() ? v.at("width").num() : 4.0)));
  o.set("opacity", Json::number(clamp01(v.at("opacity").is_finite_number() ? v.at("opacity").num() : 1.0)));
  const std::string align = v.at("align").is_string() ? v.at("align").str() : "";
  o.set("align", Json::string(align == "inside" || align == "outside" ? align : "center"));
  Json dash = Json::array();
  if (v.at("dash").is_array()) {
    for (const Json& d : v.at("dash").arr()) {
      if (d.is_finite_number() && d.num() >= 0) dash.arr_mut().push_back(d);
    }
  }
  o.set("dash", std::move(dash));
  if (v.at("dashOffset").is_finite_number()) o.set("dashOffset", v.at("dashOffset"));
  const std::string cap = v.at("cap").is_string() ? v.at("cap").str() : "";
  o.set("cap", Json::string(cap == "round" || cap == "square" ? cap : "butt"));
  const std::string join = v.at("join").is_string() ? v.at("join").str() : "";
  o.set("join", Json::string(join == "round" || join == "bevel" ? join : "miter"));
  if (v.at("miterLimit").is_finite_number()) o.set("miterLimit", Json::number(std::max(1.0, v.at("miterLimit").num())));
  if (validPaint) o.set("paint", paint);
  if (Json t = norm_taper(v.at("taper")); !t.is_undefined()) o.set("taper", std::move(t));
  if (Json w = norm_wave(v.at("wave")); !w.is_undefined()) o.set("wave", std::move(w));
  if (v.at("composite").is_string() && v.at("composite").str() == "above") o.set("composite", Json::string("above"));
  if (v.at("blendMode").is_string() && is_paint_blend_mode(v.at("blendMode").str()) && v.at("blendMode").str() != "normal") {
    o.set("blendMode", v.at("blendMode"));
  }
  if (validPaint && paint.at("type").str() != "solid") {
    if (Json g = norm_gradient(v.at("gradient")); !g.is_undefined()) o.set("gradient", std::move(g));
  }
  return o;
}

std::vector<Json> node_strokes(const Node& n) {
  const Json& arr = n.fx().at("strokes");
  if (arr.is_array()) {
    std::vector<Json> valid;
    for (const Json& s : arr.arr()) {
      if (is_stroke(s)) valid.push_back(normalize_shape_stroke(s));
    }
    if (!valid.empty()) return valid;
  }
  const Json& s = n.fx().at("stroke");
  if (is_stroke(s)) return {normalize_shape_stroke(s)};
  return {};
}

void store_node_strokes(Document& d, std::string_view layer, const std::vector<Json>& strokes) {
  std::vector<Json> normalized;
  for (const Json& s : strokes) normalized.push_back(normalize_shape_stroke(s));
  sg_set_fx(d, layer, "strokes", normalized.size() > 1 ? Json::array(normalized) : Json());
  sg_set_fx(d, layer, "stroke", normalized.empty() ? Json() : normalized[0]);
}

std::optional<StrokeTrackHit> stroke_track_hit(const Node& n, std::string_view prop) {
  auto st = parse_stroke_track_path(prop);
  if (!st) return std::nullopt;
  if (st->index == 0 && n.comp("Text") != nullptr) return std::nullopt;
  std::vector<Json> stack = node_strokes(n);
  if (st->index >= stack.size()) return std::nullopt;
  return StrokeTrackHit{st->index, st->param, st->channel, std::move(stack[st->index])};
}

std::optional<double> read_stroke_track(const Node& n, const StrokeTrackHit& h) {
  const Json& s = h.stroke;
  const std::string_view param = h.param;
  if (param == "color") return std::nullopt;
  if (param == "opacity" || param == "width") return s.at(param).num();
  if (param == "miterLimit") return s.at("miterLimit").is_number() ? s.at("miterLimit").num() : 4.0;
  if (param == "dashOffset") return s.at("dashOffset").is_number() ? s.at("dashOffset").num() : 0.0;
  if (auto k = dash_slot(param)) {
    const Json& dash = s.at("dash");
    return dash.is_array() && *k < dash.arr().size() ? std::optional<double>(dash.arr()[*k].num()) : std::nullopt;
  }
  if (auto f = field_of(kTaper, param)) {
    const Json& v = s.at("taper").at(*f);
    return v.is_number() ? v.num() : identity_taper().at(*f).num();
  }
  if (auto f = field_of(kWave, param)) {
    const Json& v = s.at("wave").at(*f);
    return v.is_number() ? v.num() : 0.0;
  }
  if (auto f = field_of(kGradient, param)) {
    if (!gradient_paint(s)) return std::nullopt;
    const Json g = gradient_of(n, s);  // held: gradient_of returns by value
    const Json& v = g.at(*f);
    return v.is_number() ? v.num() : 0.0;
  }
  return std::nullopt;
}

bool write_stroke_track(Document& d, std::string_view layer, const StrokeTrackHit& h, double value) {
  if (!h.channel.empty()) return false;
  const Node& n = *d.node(layer);
  auto next = with_stroke_param(n, h.stroke, h.param, value);
  if (!next) return false;
  std::vector<Json> stack = node_strokes(n);
  stack[h.index] = std::move(*next);
  store_node_strokes(d, layer, stack);
  return true;
}

std::optional<std::size_t> stroke_color_index(const Node& n, const std::string& base) {
  const auto st = parse_stroke_track_path(base + "_r");
  if (!st || st->param != "color") return std::nullopt;
  if (st->index == 0 && n.comp("Text") != nullptr) return std::nullopt;
  return st->index < node_strokes(n).size() ? std::optional<std::size_t>(st->index) : std::nullopt;
}

std::string stroke_color_at(const Node& n, std::size_t index) {
  // Held: node_strokes returns by value; a reference into the temporary dangled
  // (every stroke colour read as the #ffffff fallback — d1EvalParity).
  const std::vector<Json> stack = node_strokes(n);
  const Json& c = stack[index].at("color");
  return c.is_string() ? c.str() : std::string("#ffffff");
}

void set_stroke_color_at(Document& d, std::string_view layer, std::size_t index, const std::string& hex) {
  std::vector<Json> stack = node_strokes(*d.node(layer));
  stack[index].set("color", Json::string(hex));
  store_node_strokes(d, layer, stack);
}

bool has_stroke_host(const Node& n, bool paintHost) {
  return paintHost || !n.fx().at("stroke").is_undefined() || !n.fx().at("strokes").is_undefined();
}

api::Value read_stroke_stack(const Node& n) { return v_json(stringify(Json::array(node_strokes(n)))); }

void write_stroke_stack(Document& d, std::string_view layer, const std::string& path, const api::Value& value) {
  if (value.kind() != VK::json) {
    fail(ErrorCode::type_mismatch, "'" + path + "' takes json, got " + std::string(kind_name(value.kind())),
         {.path = path, .detail = "{\"expected\":\"json\"}"});
  }
  auto v = js::parse(get<VK::json>(value));
  if (!v) fail(ErrorCode::invalid_argument, "invalid json", {.path = path});
  Json list = v->is_null() ? Json::array() : std::move(*v);
  bool ok = list.is_array();
  if (ok) {
    for (const Json& s : list.arr()) ok = ok && is_stroke(s);
  }
  if (!ok) fail(ErrorCode::invalid_argument, "'" + path + "' takes null or an array of strokes {width: number, …}", {.path = path});
  const std::vector<Json> before = node_strokes(*d.node(layer));
  std::vector<Json> after;
  for (const Json& s : list.arr()) after.push_back(normalize_shape_stroke(s));
  std::set<std::string> drop;
  for (std::size_t i = after.size(); i < before.size(); ++i) {
    for (auto& p : stroke_track_paths_for(i)) drop.insert(std::move(p));
  }
  for (std::size_t i = 0; i < std::min(before.size(), after.size()); ++i) {
    const std::size_t lost = before[i].at("dash").arr().size();
    for (std::size_t k = after[i].at("dash").arr().size(); k < lost; ++k) {
      if (k < kDash.size()) drop.insert(stroke_track_path(i, kDash[k]));
    }
  }
  drop_track_props(d, layer, drop);
  store_node_strokes(d, layer, after);
}

std::function<void()> plan_remove_stroke(Document& d, std::string_view layer, double index) {
  const std::vector<Json> stack = node_strokes(*d.node(layer));
  const std::string L(layer);
  if (!(index >= 0 && index < static_cast<double>(stack.size()) && std::floor(index) == index)) {
    fail(ErrorCode::out_of_range, "layer '" + L + "' has no stroke " + js::number_to_string(index),
         {.layer = L, .detail = "{\"strokes\":" + std::to_string(stack.size()) + "}"});
  }
  const auto at = static_cast<std::size_t>(index);
  return [&d, L, at, stack]() {
    if (const NodeAnim* a = d.anim(L)) {
      NodeAnim next = *a;
      bool changed = false;
      auto rekey = [&](auto& section) {
        for (const auto& p : stroke_track_paths_for(at)) changed = section.erase(p) || changed;
        for (std::size_t j = at + 1; j < stack.size(); ++j) {
          const auto from = stroke_track_paths_for(j);
          const auto to = stroke_track_paths_for(j - 1);
          for (std::size_t k = 0; k < from.size(); ++k) {
            auto* v = section.find(from[k]);
            if (v == nullptr) continue;
            auto moved = std::move(*v);
            (void)section.erase(from[k]);
            section.set(to[k], std::move(moved));
            changed = true;
          }
        }
      };
      rekey(next.tracks);
      rekey(next.exprs);
      if (changed) d.set_anim(L, next.empty() ? std::nullopt : std::optional<NodeAnim>(std::move(next)));
    }
    std::vector<Json> kept;
    for (std::size_t i = 0; i < stack.size(); ++i) {
      if (i != at) kept.push_back(stack[i]);
    }
    store_node_strokes(d, L, kept);
  };
}

// ── Gradient Fill ▸ Colors ───────────────────────────────────────────────

bool has_gradient_fill(const Node& n) { return gradient_kind(n).has_value(); }

std::optional<PropBinding> fill_stops_binding(const Document& d, const Node& n, std::string_view layer) {
  const NodeAnim* a = d.anim(layer);
  if (!gradient_kind(n) && !(a != nullptr && a->data.contains("fill.stops"))) return std::nullopt;
  PropBinding b;
  b.path = "layer/fillStops";
  b.name = "Colors";
  b.matchName = "ADBE Vector Grad Colors";
  b.valueType = api::ValueType::gradient;
  b.dataTrack = "fill.stops";
  b.special = Special::fillStops;
  return b;
}

api::Value read_fill_stops_static(const Node& n) {
  std::vector<std::pair<double, Json>> stops;
  for (const Json& s : stored_stops(n)) stops.emplace_back(s.at("offset").is_number() ? s.at("offset").num() : 0.0, s.at("color"));
  return gradient_value(gradient_kind(n).value_or("linear"), stops);
}

void write_fill_stops_static(Document& d, std::string_view layer, const PropBinding& b, const api::Value& value) {
  const std::vector<WrittenStop> next = written_stops(b, value);
  const Node& n = *d.node(layer);
  const std::string L(layer);
  if (!gradient_kind(n)) fail(ErrorCode::invalid_argument, "layer '" + L + "' has no gradient fill", {.layer = L, .path = b.path});
  const std::vector<Json> old = stored_stops(n);
  std::set<std::string> ids;
  for (const Json& s : old) {
    if (s.at("id").is_string()) ids.insert(s.at("id").str());
  }
  Json stops = Json::array();
  for (std::size_t i = 0; i < next.size(); ++i) {
    std::string id;
    if (i < old.size() && old[i].at("id").is_string()) {
      id = old[i].at("id").str();
    } else {
      std::size_t k = i;
      while (ids.contains("gs" + std::to_string(k))) ++k;
      id = "gs" + std::to_string(k);
      ids.insert(id);
    }
    Json s = Json::object();
    s.set("id", Json::string(id));
    s.set("offset", Json::number(next[i].offset));
    s.set("color", Json::string(next[i].color));
    stops.arr_mut().push_back(std::move(s));
  }
  Json paint = primary_fill(n);
  paint.set("stops", std::move(stops));
  set_primary_fill_paint(d, layer, paint);
}

api::Value fill_stops_key_to_api(const Node& n, const Json& v) {
  std::vector<std::pair<double, Json>> stops;
  if (v.is_array()) {
    for (const Json& s : v.arr()) stops.emplace_back(s.at("pos").is_number() ? s.at("pos").num() : 0.0, s.at("color"));
  }
  return gradient_value(gradient_kind(n).value_or("linear"), stops);
}

Json api_to_fill_stops_key(const PropBinding& b, const api::Value& value) {
  std::vector<WrittenStop> w = written_stops(b, value);
  std::stable_sort(w.begin(), w.end(), [](const WrittenStop& x, const WrittenStop& y) { return x.offset < y.offset; });
  Json out = Json::array();
  for (const WrittenStop& s : w) {
    Json o = Json::object();
    o.set("pos", Json::number(s.offset));
    o.set("color", Json::string(s.color));
    out.arr_mut().push_back(std::move(o));
  }
  return out;
}

// ── Orient Towards Point of Interest ─────────────────────────────────────

namespace {
constexpr std::array<std::string_view, 3> kPoi = {"poiX", "poiY", "poiZ"};

bool has_poi(const Node& n) {
  for (const Component& c : n.components) {
    for (auto k : kPoi) {
      if (c.props.at(k).is_number()) return true;
    }
  }
  return false;
}
}  // namespace

api::Value read_point_of_interest(const Node& n) { return v_bool(has_poi(n)); }

void write_point_of_interest(Document& d, std::string_view layer, const api::Value& value) {
  const std::string path(kPoiPath);
  if (value.kind() != VK::bool_) {
    fail(ErrorCode::type_mismatch, "'" + path + "' takes a bool, got " + std::string(kind_name(value.kind())),
         {.path = path, .detail = "{\"expected\":\"bool\"}"});
  }
  const Node& n = *d.node(layer);
  const std::string L(layer);
  if (!get<VK::bool_>(value)) {
    std::vector<std::pair<std::string, std::string>> clear;
    for (const Component& c : n.components) {
      for (auto k : kPoi) {
        if (!c.props.at(k).is_undefined()) clear.emplace_back(c.id, std::string(k));
      }
    }
    for (const auto& [cid, k] : clear) (void)sg_write_prop(d, layer, cid, k, Json());
    drop_track_props(d, layer, {"poiX", "poiY", "poiZ"});
    return;
  }
  if (has_poi(n)) return;
  const Component* t = n.comp("Transform");
  if (t == nullptr) fail(ErrorCode::not_found, "layer '" + L + "' has no Transform", {.layer = L, .path = path});
  const std::string tid = t->id;
  double w = 1920;
  double h = 1080;
  if (const auto comp = comp_of_layer(d, layer)) {
    if (const Json* rec = d.comp(*comp)) {
      if (rec->at("width").is_number()) w = rec->at("width").num();
      if (rec->at("height").is_number()) h = rec->at("height").num();
    }
  }
  (void)sg_write_prop(d, layer, tid, "poiX", Json::number(w / 2));
  (void)sg_write_prop(d, layer, tid, "poiY", Json::number(h / 2));
  (void)sg_write_prop(d, layer, tid, "poiZ", Json::number(0));
}

// ── latent numeric bindings ──────────────────────────────────────────────

std::vector<LatentMember> latent_members(const Node& n) {
  std::vector<LatentMember> out;
  for (const Json& spec : registry().latent.arr()) {
    if (!holds(n, spec.at("when"))) continue;
    std::vector<std::string> home;
    for (const Json& h : spec.at("home").arr()) home.push_back(h.str());
    const std::string& member = spec.at("member").str();
    const Json& expand = spec.at("expand");
    if (expand.is_string() && expand.str() == "strokes") {
      const std::vector<Json> stack = node_strokes(n);
      for (std::size_t i = 0; i < stack.size(); ++i) {
        if (stack[i].at("enabled").is_bool() && stack[i].at("enabled").b()) out.push_back({stroke_track_path(i, member), home});
      }
    } else if (expand.is_string() && expand.str() == "morph") {
      const std::size_t count = morph_target_count(n);
      for (std::size_t i = 0; i < count; ++i) out.push_back({member + std::to_string(i), home});
    } else {
      out.push_back({member, std::move(home)});
    }
  }
  return out;
}

}  // namespace premation::doc
