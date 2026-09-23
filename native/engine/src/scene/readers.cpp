#include "readers.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <numbers>

#include "fxstate.hpp"
#include "scene.hpp"
#include "jsmath.hpp"
#include "scene_math.hpp"

namespace premation::scene {
namespace {

const Json& empty_object() {
  static const Json kEmpty = Json::object();
  return kEmpty;
}

double clamp01(double v) { return std::max(0.0, std::min(1.0, v)); }

bool finite_num(const Json& v) { return v.is_number() && std::isfinite(v.num()); }

/// `Number.parseInt(h, 16)` over an 8-digit string known to be hex → the 32 bits.
std::uint32_t hex32(std::string_view h) {
  std::uint32_t n = 0;
  for (const char ch : h) {
    std::uint32_t d = 0;
    if (ch >= '0' && ch <= '9') d = static_cast<std::uint32_t>(ch - '0');
    else if (ch >= 'a' && ch <= 'f') d = static_cast<std::uint32_t>(ch - 'a' + 10);
    else if (ch >= 'A' && ch <= 'F') d = static_cast<std::uint32_t>(ch - 'A' + 10);
    else break;
    n = (n << 4U) | d;
  }
  return n;
}

std::string_view trim(std::string_view s) {
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t' || s.front() == '\n' || s.front() == '\r')) s.remove_prefix(1);
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\n' || s.back() == '\r')) s.remove_suffix(1);
  return s;
}

/// `Number(s)` for the rgb() parts (decimal only; NaN otherwise).
double js_number(std::string_view s) {
  if (s.empty()) return std::nan("");
  std::string tmp(s);
  char* end = nullptr;
  const double v = std::strtod(tmp.c_str(), &end);
  if (end == nullptr || *end != '\0') return std::nan("");
  return v;
}

}  // namespace

std::optional<double> jnum(const Json& v) noexcept {
  if (v.is_number()) return v.num();
  return std::nullopt;
}

std::optional<std::string> jstr(const Json& v) {
  if (v.is_string()) return v.str();
  return std::nullopt;
}

const Json& comp_props(const Node& n, std::string_view type) noexcept {
  const doc::Component* c = n.comp(type);
  return c != nullptr ? c->props : empty_object();
}

const Json& fx_props(const Node& n) noexcept { return n.fx(); }

std::optional<double> read_num_prop(const Node& n, std::string_view prop) noexcept {
  for (const auto& c : n.components) {
    const Json* v = c.props.find(prop);
    if (v != nullptr && v->is_number()) return v->num();
  }
  return std::nullopt;
}

// ── colours ───────────────────────────────────────────────────────────────

Rgba color_from_hex(std::string_view hex) {
  const std::string_view raw = trim(hex);
  // /^rgba?\(([^)]+)\)$/i
  const auto lower_starts = [&](std::string_view p) {
    if (raw.size() < p.size()) return false;
    for (std::size_t i = 0; i < p.size(); ++i) {
      const char c = raw[i];
      const char l = c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c;
      if (l != p[i]) return false;
    }
    return true;
  };
  if ((lower_starts("rgba(") || lower_starts("rgb(")) && raw.back() == ')') {
    const std::size_t open = raw.find('(');
    const std::string_view inner = raw.substr(open + 1, raw.size() - open - 2);
    if (!inner.empty() && inner.find(')') == std::string_view::npos) {
      std::vector<double> parts;
      std::size_t i = 0;
      while (i < inner.size()) {
        while (i < inner.size() && (inner[i] == ',' || inner[i] == ' ' || inner[i] == '\t' || inner[i] == '/')) ++i;
        const std::size_t s = i;
        while (i < inner.size() && !(inner[i] == ',' || inner[i] == ' ' || inner[i] == '\t' || inner[i] == '/')) ++i;
        if (i > s) parts.push_back(js_number(inner.substr(s, i - s)));
      }
      if (parts.size() >= 3 && std::isfinite(parts[0]) && std::isfinite(parts[1]) && std::isfinite(parts[2])) {
        const double a = parts.size() > 3 && std::isfinite(parts[3]) ? parts[3] : 1;
        return {std::max(0.0, std::min(1.0, parts[0] / 255)), std::max(0.0, std::min(1.0, parts[1] / 255)),
                std::max(0.0, std::min(1.0, parts[2] / 255)), std::max(0.0, std::min(1.0, a))};
      }
      return {0, 0, 0, 1};
    }
  }
  std::string h(raw.starts_with('#') ? raw.substr(1) : raw);
  if (h.size() == 3) h = std::string{h[0], h[0], h[1], h[1], h[2], h[2]};
  if (h.size() == 6) h += "ff";
  if (h.size() != 8) return {0, 0, 0, 1};
  const std::uint32_t n = hex32(h);
  return {static_cast<double>((n >> 24U) & 0xFFU) / 255, static_cast<double>((n >> 16U) & 0xFFU) / 255,
          static_cast<double>((n >> 8U) & 0xFFU) / 255, static_cast<double>(n & 0xFFU) / 255};
}

std::string color_to_hex(const Rgba& c) {
  const auto ch = [](double v) {
    return static_cast<unsigned>(motion::js::round(std::max(0.0, std::min(1.0, v)) * 255));
  };
  std::array<char, 10> buf{};
  std::snprintf(buf.data(), buf.size(), "#%02x%02x%02x%02x", ch(c.r), ch(c.g), ch(c.b), ch(c.a));  // NOLINT(cppcoreguidelines-pro-type-vararg)
  return {buf.data(), 9};
}

// ── fx flags ──────────────────────────────────────────────────────────────

std::string read_node_blend(const Node& n) {
  const Json& m = fx_props(n).at("blendMode");
  if (!m.is_string()) return "normal";
  const auto& modes = doc::registry().blendModes;
  return std::ranges::find(modes, m.str()) != modes.end() ? m.str() : "normal";
}

bool read_node_preserve_transparency(const Node& n) {
  const Json& v = fx_props(n).at("preserveTransparency");
  return v.is_bool() && v.b();
}

bool read_node_adjustment(const Node& n) {
  const Json& v = fx_props(n).at("isAdjustment");
  return v.is_bool() && v.b();
}

bool read_node_motion_blur(const Node& n) {
  const Json& v = fx_props(n).at("motionBlur");
  return v.is_bool() && v.b();
}

bool read_is_guide_layer(const Node& n) {
  const Json& v = fx_props(n).at("guide");
  return v.is_bool() && v.b();
}

std::string read_node_quality_s(const Node& n) {
  const Json& q = fx_props(n).at("quality");
  if (q.is_string() && (q.str() == "draft" || q.str() == "wireframe")) return q.str();
  return "best";
}

std::optional<Matte> read_matte(const Json& v) {
  const auto legacy = [](std::string_view s) -> std::optional<Matte> {
    if (s == "alpha") return Matte{false, false, std::nullopt};
    if (s == "alpha-inv") return Matte{false, true, std::nullopt};
    if (s == "luma") return Matte{true, false, std::nullopt};
    if (s == "luma-inv") return Matte{true, true, std::nullopt};
    return std::nullopt;
  };
  if (v.is_undefined() || v.is_null()) return std::nullopt;
  if (v.is_string()) {
    if (v.str().empty() || v.str() == "none") return std::nullopt;
    return legacy(v.str());
  }
  if (v.is_bool() || v.is_number()) return std::nullopt;
  if (v.is_object()) {
    const Json& mode = v.at("mode");
    std::optional<std::string> sourceId;
    if (v.at("sourceId").is_string() && !v.at("sourceId").str().empty()) sourceId = v.at("sourceId").str();
    if (mode.is_string() && (mode.str() == "alpha" || mode.str() == "luma")) {
      return Matte{mode.str() == "luma", v.at("inverted").is_bool() && v.at("inverted").b(), sourceId};
    }
    if (mode.is_string()) {
      if (auto m = legacy(mode.str())) {
        m->sourceId = std::move(sourceId);
        return m;
      }
    }
  }
  return std::nullopt;
}

std::optional<Matte> read_matte_of(const Node& n) { return read_matte(fx_props(n).at("matte")); }

bool is_precomp_node(const Node& n) {
  const Json& v = fx_props(n).at("precomp");
  return v.is_bool() && v.b();
}

bool composites_as_unit(const Node& n) {
  return is_precomp_node(n) && !doc::read_comp_collapse(n);
}

std::pair<double, double> read_node_anchor(const Node& n) {
  const doc::Component* t = n.comp("Transform");
  if (t == nullptr) return {0, 0};
  return {jnum(t->props.at("anchorX")).value_or(0), jnum(t->props.at("anchorY")).value_or(0)};
}

// ── paint ─────────────────────────────────────────────────────────────────

bool is_fill_paint(const Json& v) {
  if (!v.is_object()) return false;
  const Json& t = v.at("type");
  return t.is_string() && (t.str() == "solid" || t.str() == "linear" || t.str() == "radial");
}

Json read_node_fill(const Node& n) {
  const Json& paint = fx_props(n).at("fill");
  if (is_fill_paint(paint)) return paint;
  for (const auto& c : n.components) {
    const Json& f = c.props.at("fill");
    if (f.is_string()) {
      Json s = Json::object();
      s.set("type", Json::string("solid"));
      s.set("color", f);
      return s;
    }
  }
  return {};
}

std::vector<Json> read_node_fills(const Node& n) {
  const Json& arr = fx_props(n).at("fills");
  if (arr.is_array()) {
    std::vector<Json> valid;
    for (const Json& f : arr.arr()) {
      if (is_fill_paint(f)) valid.push_back(f);
    }
    if (!valid.empty()) return valid;
  }
  Json single = read_node_fill(n);
  if (single.is_undefined()) return {};
  return {std::move(single)};
}

namespace {

bool is_stroke(const Json& v) { return v.is_object() && v.at("width").is_number(); }

Json norm_taper(const Json& v) {
  if (!v.is_object()) return {};
  const auto fin = [](const Json& x, double d) { return finite_num(x) ? x.num() : d; };
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
  const auto num = [](const Json& x, double d) { return finite_num(x) ? x.num() : d; };
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
    if (!finite_num(v.at(k))) return {};
  }
  Json o = Json::object();
  for (const char* k : {"startX", "startY", "endX", "endY"}) o.set(k, v.at(k));
  const Json& hl = v.at("highlightLength");
  if (finite_num(hl) && hl.num() != 0) o.set("highlightLength", Json::number(std::max(-1.0, std::min(1.0, hl.num()))));
  const Json& ha = v.at("highlightAngle");
  if (finite_num(ha) && ha.num() != 0) o.set("highlightAngle", ha);
  return o;
}

bool is_paint_blend_mode(std::string_view m) {
  // paintBlend.ts PAINT_BLEND_MODES.
  static constexpr std::array<std::string_view, 17> kModes = {
      "normal", "darken", "multiply", "color-burn", "add", "lighten", "screen", "color-dodge", "overlay",
      "soft-light", "hard-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"};
  return std::ranges::find(kModes, m) != kModes.end();
}

}  // namespace

Json normalize_stroke(const Json& v) {
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
  o.set("width", Json::number(std::max(0.0, finite_num(v.at("width")) ? v.at("width").num() : 4.0)));
  o.set("opacity", Json::number(clamp01(finite_num(v.at("opacity")) ? v.at("opacity").num() : 1.0)));
  const std::string align = v.at("align").is_string() ? v.at("align").str() : "";
  o.set("align", Json::string(align == "inside" || align == "outside" ? align : "center"));
  Json dash = Json::array();
  if (v.at("dash").is_array()) {
    for (const Json& d : v.at("dash").arr()) {
      if (finite_num(d) && d.num() >= 0) dash.arr_mut().push_back(d);
    }
  }
  o.set("dash", std::move(dash));
  if (finite_num(v.at("dashOffset"))) o.set("dashOffset", v.at("dashOffset"));
  const std::string cap = v.at("cap").is_string() ? v.at("cap").str() : "";
  o.set("cap", Json::string(cap == "round" || cap == "square" ? cap : "butt"));
  const std::string join = v.at("join").is_string() ? v.at("join").str() : "";
  o.set("join", Json::string(join == "round" || join == "bevel" ? join : "miter"));
  if (finite_num(v.at("miterLimit"))) o.set("miterLimit", Json::number(std::max(1.0, v.at("miterLimit").num())));
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

std::vector<Json> read_node_strokes(const Node& n) {
  const Json& arr = fx_props(n).at("strokes");
  if (arr.is_array()) {
    std::vector<Json> valid;
    for (const Json& s : arr.arr()) {
      if (is_stroke(s)) valid.push_back(normalize_stroke(s));
    }
    if (!valid.empty()) return valid;
  }
  const Json& s = fx_props(n).at("stroke");
  if (is_stroke(s)) return {normalize_stroke(s)};
  return {};
}

namespace {

const char* primary_track(std::string_view param) {
  // strokeTracks.ts PRIMARY_TRACKS.
  static constexpr std::array<std::pair<std::string_view, const char*>, 26> kMap = {{
      {"color", "stroke"}, {"opacity", "strokeOpacity"}, {"width", "strokeWidth"}, {"miterLimit", "strokeMiterLimit"},
      {"dash1", "strokeDash1"}, {"gap1", "strokeGap1"}, {"dash2", "strokeDash2"}, {"gap2", "strokeGap2"},
      {"dash3", "strokeDash3"}, {"gap3", "strokeGap3"}, {"dashOffset", "strokeDashOffset"},
      {"taperStartLength", "strokeTaperStartLength"}, {"taperEndLength", "strokeTaperEndLength"},
      {"taperStartWidth", "strokeTaperStartWidth"}, {"taperEndWidth", "strokeTaperEndWidth"},
      {"taperStartEase", "strokeTaperStartEase"}, {"taperEndEase", "strokeTaperEndEase"},
      {"waveAmount", "strokeWaveAmount"}, {"waveWavelength", "strokeWaveWavelength"}, {"wavePhase", "strokeWavePhase"},
      {"gradientStartX", "strokeGradientStartX"}, {"gradientStartY", "strokeGradientStartY"},
      {"gradientEndX", "strokeGradientEndX"}, {"gradientEndY", "strokeGradientEndY"},
      {"highlightLength", "strokeHighlightLength"}, {"highlightAngle", "strokeHighlightAngle"},
  }};
  for (const auto& [k, v] : kMap) {
    if (k == param) return v;
  }
  return "";
}

std::string stroke_track_path(std::size_t index, std::string_view param) {
  if (index == 0) return primary_track(param);
  return "stroke." + std::to_string(index) + "." + std::string(param);
}

Json gradient_geometry_for(const Json& paint, double w, double h) {
  const auto rel = [](double px, double extent) { return extent > 0 ? 0.5 + px / extent : 0.5; };
  Json g = Json::object();
  const std::string type = paint.is_object() && paint.at("type").is_string() ? paint.at("type").str() : "solid";
  if (type == "linear") {
    const double a = (paint.at("angle").num() * std::numbers::pi) / 180;
    const double dx = motion::js::cos(a);
    const double dy = motion::js::sin(a);
    const double half = (std::abs(dx) * w + std::abs(dy) * h) / 2;
    g.set("startX", Json::number(rel(-dx * half, w)));
    g.set("startY", Json::number(rel(-dy * half, h)));
    g.set("endX", Json::number(rel(dx * half, w)));
    g.set("endY", Json::number(rel(dy * half, h)));
    return g;
  }
  if (type == "radial") {
    const double r = (std::max(0.01, paint.at("radius").num()) * hypot2(w, h)) / 2;
    g.set("startX", paint.at("cx"));
    g.set("startY", paint.at("cy"));
    g.set("endX", Json::number(paint.at("cx").num() + (w > 0 ? r / w : 0)));
    g.set("endY", paint.at("cy"));
    return g;
  }
  g.set("startX", Json::number(0.5));
  g.set("startY", Json::number(0));
  g.set("endX", Json::number(0.5));
  g.set("endY", Json::number(1));
  return g;
}

Json resolve_stroke_tracks(const Json& stroke, std::size_t index, const Values& a, double w, double h) {
  if (a.empty()) return stroke;
  const auto path = [&](std::string_view p) { return stroke_track_path(index, p); };
  const auto has = [&](std::string_view p) { return a.has(path(p)); };
  const auto num = [&](std::string_view p, double fb) {
    const auto v = a.get(path(p));
    return v && std::isfinite(*v) ? *v : fb;
  };
  Json s = stroke;
  if (has("dashOffset")) s.set("dashOffset", Json::number(a.get(path("dashOffset")).value_or(0)));
  if (has("width")) {
    const auto v = a.get(path("width"));
    if (v && std::isfinite(*v)) s.set("width", Json::number(std::max(0.0, *v)));
  }
  if (has("taperStartWidth") || has("taperEndWidth") || has("taperStartLength") || has("taperEndLength") ||
      has("taperStartEase") || has("taperEndEase")) {
    const Json& t = s.at("taper");
    const auto tv = [&](const char* k, double d) { return t.is_object() && t.at(k).is_number() ? t.at(k).num() : d; };
    Json o = Json::object();
    o.set("startWidth", Json::number(num("taperStartWidth", tv("startWidth", 1))));
    o.set("endWidth", Json::number(num("taperEndWidth", tv("endWidth", 1))));
    o.set("startLength", Json::number(num("taperStartLength", tv("startLength", 0))));
    o.set("endLength", Json::number(num("taperEndLength", tv("endLength", 0))));
    o.set("startEase", Json::number(num("taperStartEase", tv("startEase", 0))));
    o.set("endEase", Json::number(num("taperEndEase", tv("endEase", 0))));
    if (t.is_object() && t.at("lengthUnits").is_string() && t.at("lengthUnits").str() == "pixels") {
      o.set("lengthUnits", Json::string("pixels"));
    }
    s.set("taper", std::move(o));
  }
  if (has("waveAmount") || has("waveWavelength") || has("wavePhase")) {
    const Json& wv = s.at("wave");
    const auto vv = [&](const char* k, double d) { return wv.is_object() && wv.at(k).is_number() ? wv.at(k).num() : d; };
    Json o = Json::object();
    o.set("amount", Json::number(num("waveAmount", vv("amount", 0))));
    o.set("wavelength", Json::number(num("waveWavelength", vv("wavelength", 0))));
    o.set("phase", Json::number(num("wavePhase", vv("phase", 0))));
    if (wv.is_object() && wv.at("units").is_string() && wv.at("units").str() == "cycles") o.set("units", Json::string("cycles"));
    s.set("wave", std::move(o));
  }
  const std::string cp = stroke_track_path(index, "color");
  if (a.has(cp + "_r")) {
    s.set("color", Json::string(color_to_hex({a.get(cp + "_r").value_or(0), a.get(cp + "_g").value_or(0),
                                              a.get(cp + "_b").value_or(0), a.get(cp + "_a").value_or(1)})));
  }
  if (has("opacity")) s.set("opacity", Json::number(std::max(0.0, std::min(1.0, num("opacity", s.at("opacity").num())))));
  if (has("miterLimit")) {
    const double base = s.at("miterLimit").is_number() ? s.at("miterLimit").num() : 4;
    s.set("miterLimit", Json::number(std::max(1.0, num("miterLimit", base))));
  }
  static constexpr std::array<std::string_view, 6> kDash = {"dash1", "gap1", "dash2", "gap2", "dash3", "gap3"};
  const Json& dash = s.at("dash");
  if (dash.is_array() && !dash.arr().empty()) {
    bool any = false;
    for (std::size_t k = 0; k < dash.arr().size() && k < kDash.size(); ++k) any = any || has(kDash.at(k));
    if (any) {
      Json nd = Json::array();
      for (std::size_t k = 0; k < dash.arr().size(); ++k) {
        const double v = dash.arr()[k].num();
        nd.arr_mut().push_back(Json::number(k < kDash.size() ? std::max(0.0, num(kDash.at(k), v)) : v));
      }
      s.set("dash", std::move(nd));
    }
  }
  const Json& paint = s.at("paint");
  if (paint.is_object() && paint.at("type").is_string() && paint.at("type").str() != "solid" &&
      (has("gradientStartX") || has("gradientStartY") || has("gradientEndX") || has("gradientEndY") ||
       has("highlightLength") || has("highlightAngle"))) {
    const Json g = s.at("gradient").is_object() ? s.at("gradient") : gradient_geometry_for(paint, w, h);
    Json o = Json::object();
    o.set("startX", Json::number(num("gradientStartX", g.at("startX").num())));
    o.set("startY", Json::number(num("gradientStartY", g.at("startY").num())));
    o.set("endX", Json::number(num("gradientEndX", g.at("endX").num())));
    o.set("endY", Json::number(num("gradientEndY", g.at("endY").num())));
    std::optional<double> hl = has("highlightLength") ? std::optional<double>(num("highlightLength", 0)) : jnum(g.at("highlightLength"));
    std::optional<double> ha = has("highlightAngle") ? std::optional<double>(num("highlightAngle", 0)) : jnum(g.at("highlightAngle"));
    if (hl) o.set("highlightLength", Json::number(*hl));
    if (ha) o.set("highlightAngle", Json::number(*ha));
    s.set("gradient", std::move(o));
  }
  return s;
}

}  // namespace

StrokeStack resolve_stroke_stack(const std::vector<Json>& stack, const Values& a, double w, double h) {
  const auto renderable = [](const Json& s) { return s.at("enabled").b() && s.at("width").num() > 0; };
  std::vector<std::optional<Json>> resolved;
  resolved.reserve(stack.size());
  for (std::size_t i = 0; i < stack.size(); ++i) {
    if (renderable(stack[i])) resolved.emplace_back(resolve_stroke_tracks(stack[i], i, a, w, h));
    else resolved.emplace_back(std::nullopt);
  }
  StrokeStack out;
  bool hasPrimary = false;
  if (!resolved.empty()) {
    if (const auto& primary = resolved.front(); primary.has_value()) {
      hasPrimary = true;
      out.stroke = *primary;
    }
  }
  Json list = Json::array();
  for (const auto& r : resolved) {
    if (r) list.arr_mut().push_back(*r);
  }
  const std::size_t n = list.arr().size();
  if (n > 1 || (n == 1 && !hasPrimary)) out.strokes = std::move(list);
  return out;
}

// ── corners ───────────────────────────────────────────────────────────────

Radii resolve_corner_radii(std::optional<double> r, std::optional<double> tl, std::optional<double> tr,
                           std::optional<double> br, std::optional<double> bl) {
  const double base = std::max(0.0, r.value_or(0));
  const auto n = [base](std::optional<double> v) { return v && std::isfinite(*v) ? std::max(0.0, *v) : base; };
  return {n(tl), n(tr), n(br), n(bl)};
}

Radii clamp_corner_radii(double width, double height, Radii r) {
  const double w = std::max(0.0, width);
  const double h = std::max(0.0, height);
  for (double& v : r) v = std::max(0.0, v);
  const auto scale = [](double a, double b, double limit) {
    const double sum = a + b;
    if (sum <= limit || sum <= 1e-6) return 1.0;
    return limit / sum;
  };
  const double s = std::min({scale(r[0], r[1], w), scale(r[1], r[2], h), scale(r[2], r[3], w), scale(r[3], r[0], h), 1.0});
  return {r[0] * s, r[1] * s, r[2] * s, r[3] * s};
}

bool has_independent_corner_radii(const Radii& r) {
  const bool uniform = r[0] == r[1] && r[1] == r[2] && r[2] == r[3];
  return !uniform && std::ranges::any_of(r, [](double v) { return v > 0.5; });
}

// ── masks ─────────────────────────────────────────────────────────────────

Json read_node_mask_at(const Node& n, double t) {
  const std::vector<Json> anim = doc::read_node_mask_anim(n);
  if (!anim.empty()) {
    const auto m = doc::interpolate_mask(anim, t);
    if (m && m->at("paths").is_array() && !m->at("paths").arr().empty()) return *m;
    return {};
  }
  if (auto m = doc::read_node_mask(n)) return *m;
  return {};
}

Json apply_mask_property_tracks(const Json& mask, const Values& av) {
  if (mask.is_undefined() || av.empty()) return mask;
  bool changed = false;
  Json paths = Json::array();
  for (const Json& p : mask.at("paths").arr()) {
    const std::string id = p.at("id").is_string() ? p.at("id").str() : "";
    const auto f = av.get("mask." + id + ".feather");
    const auto o = av.get("mask." + id + ".opacity");
    const auto e = av.get("mask." + id + ".expansion");
    if (!f && !o && !e) {
      paths.arr_mut().push_back(p);
      continue;
    }
    changed = true;
    Json q = p;
    if (f) q.set("feather", Json::number(std::max(0.0, *f)));
    if (o) q.set("opacity", Json::number(std::max(0.0, std::min(1.0, *o / 100))));
    if (e) q.set("expansion", Json::number(*e));
    paths.arr_mut().push_back(std::move(q));
  }
  if (!changed) return mask;
  Json out = mask;
  out.set("paths", std::move(paths));
  return out;
}

Json rounded_rect_mask(double w, double h, const Radii& radii, std::string_view id) {
  const double hw = w / 2;
  const double hh = h / 2;
  const auto scale = [](double a, double b, double limit) {
    const double sum = a + b;
    if (sum <= limit || sum <= 1e-6) return 1.0;
    return limit / sum;
  };
  double tl = std::max(0.0, radii[0]);
  double tr = std::max(0.0, radii[1]);
  double br = std::max(0.0, radii[2]);
  double bl = std::max(0.0, radii[3]);
  const double s = std::min({scale(tl, tr, w), scale(tr, br, h), scale(br, bl, w), scale(bl, tl, h), 1.0});
  tl *= s;
  tr *= s;
  br *= s;
  bl *= s;
  Json path = Json::object();
  path.set("id", Json::string(std::string(id)));
  path.set("mode", Json::string("add"));
  path.set("closed", Json::boolean(true));
  path.set("feather", Json::number(0));
  path.set("opacity", Json::number(1));
  path.set("expansion", Json::number(0));
  path.set("inverted", Json::boolean(false));
  Json pts = Json::array();
  const auto pt = [&pts](double x, double y, double inX, double inY, double outX, double outY) {
    Json p = Json::object();
    p.set("x", Json::number(x));
    p.set("y", Json::number(y));
    p.set("inX", Json::number(inX));
    p.set("inY", Json::number(inY));
    p.set("outX", Json::number(outX));
    p.set("outY", Json::number(outY));
    pts.arr_mut().push_back(std::move(p));
  };
  if (tl < 0.5 && tr < 0.5 && br < 0.5 && bl < 0.5) {
    // rectangleMask(w, h): the four corners, handles on the vertices.
    pt(-hw, -hh, -hw, -hh, -hw, -hh);
    pt(hw, -hh, hw, -hh, hw, -hh);
    pt(hw, hh, hw, hh, hw, hh);
    pt(-hw, hh, -hw, hh, -hw, hh);
  } else {
    const double k = 0.5522847498307936;
    pt(-hw + tl, -hh, -hw + tl - tl * k, -hh, -hw + tl, -hh);
    pt(hw - tr, -hh, hw - tr, -hh, hw - tr + tr * k, -hh);
    pt(hw, -hh + tr, hw, -hh + tr - tr * k, hw, -hh + tr);
    pt(hw, hh - br, hw, hh - br, hw, hh - br + br * k);
    pt(hw - br, hh, hw - br + br * k, hh, hw - br, hh);
    pt(-hw + bl, hh, -hw + bl, hh, -hw + bl - bl * k, hh);
    pt(-hw, hh - bl, -hw, hh - bl + bl * k, -hw, hh - bl);
    pt(-hw, -hh + tl, -hw, -hh + tl, -hw, -hh + tl - tl * k);
  }
  path.set("points", std::move(pts));
  return path;
}

}  // namespace premation::scene
