// extractSpatialEffects (src/core/rendering/snapshotToFrameScene.ts), part A:
// every branch from 'deep-glow' through 'twister' (the eight effects_port.cpp
// writes itself excepted, and the JS 'plugin' branch, which is not ported —
// decision G2). Each branch writes its chain entry in `effectToWire` form:
// fields in the TypeScript object's declaration order, conditional spreads
// only when their condition holds. The helpers below are the TypeScript
// functions the branches call (each cites its twin).
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <numbers>
#include <string>
#include <string_view>

#include "effects_port.hpp"
#include "effects_spatial.hpp"
#include "jsmath.hpp"
#include "readers.hpp"
#include "scene_math.hpp"

namespace premation::scene {
namespace {

namespace mjs = motion::js;

constexpr double kPi = std::numbers::pi;
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
using Vec3 = std::array<double, 3>;

// ── JavaScript Math semantics ─────────────────────────────────────────────

/// `Math.max(a, b)`: NaN wins, +0 beats -0.
double jmax(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return kNaN;
  if (a == b) return std::signbit(a) ? b : a;
  return a > b ? a : b;
}
/// `Math.min(a, b)`: NaN wins, -0 beats +0.
double jmin(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return kNaN;
  if (a == b) return std::signbit(a) ? a : b;
  return a < b ? a : b;
}
/// `Math.max(lo, Math.min(hi, v))`.
double jclamp(double v, double lo, double hi) { return jmax(lo, jmin(hi, v)); }
/// `(v < 0 ? 0 : v > 1 ? 1 : v)` (NaN passes through).
double clamp01n(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
/// `x || d` for a number.
double js_or(double x, double d) { return (x == 0 || std::isnan(x)) ? d : x; }
double deg2rad(double deg) { return (deg * kPi) / 180; }

bool is_hex_digit(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return c - 'A' + 10;
}
bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; }
std::string_view trim(std::string_view t) {
  while (!t.empty() && is_ws(t.front())) t.remove_prefix(1);
  while (!t.empty() && is_ws(t.back())) t.remove_suffix(1);
  return t;
}

/// `String(v)` for a param value (effectParam never yields undefined: `?? 0`).
std::string js_string(const Json& v) {
  if (v.is_string()) return v.str();
  if (v.is_number()) return js::number_to_string(v.num());
  if (v.is_bool()) return v.b() ? "true" : "false";
  if (v.is_undefined() || v.is_null()) return "0";
  if (v.is_object()) return "[object Object]";
  return js::stringify(v);
}

/// `parseInt(s, 16)` (NaN when no digit parses).
double parse_int16(std::string_view s) {
  s = trim(s);
  double sign = 1;
  if (!s.empty() && (s.front() == '-' || s.front() == '+')) {
    if (s.front() == '-') sign = -1;
    s.remove_prefix(1);
  }
  if (s.size() >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) s.remove_prefix(2);
  double v = 0;
  bool any = false;
  for (const char c : s) {
    if (!is_hex_digit(c)) break;
    v = v * 16 + hex_val(c);
    any = true;
  }
  return any ? sign * v : kNaN;
}

/// canvas2dEffects.ts `parseHex(String(v))`: `#rrggbb` / `#rgb` → bytes, else mid-grey.
Vec3 parse_hex(const Json& v) {
  if (!v.is_string()) return {128, 128, 128};  // String(non-string) never starts with '#'
  const std::string_view s = trim(v.str());
  if (s.size() != 7 && s.size() != 4) return {128, 128, 128};
  if (s[0] != '#') return {128, 128, 128};
  for (std::size_t i = 1; i < s.size(); ++i) {
    if (!is_hex_digit(s[i])) return {128, 128, 128};
  }
  if (s.size() == 7) {
    const auto byte = [&](std::size_t i) { return static_cast<double>(hex_val(s[i]) * 16 + hex_val(s[i + 1])); };
    return {byte(1), byte(3), byte(5)};
  }
  const auto dbl = [&](std::size_t i) { return static_cast<double>(hex_val(s[i]) * 17); };
  return {dbl(1), dbl(2), dbl(3)};
}

/// deepGlow.ts `hexBytes(hex)`.
Vec3 hex_bytes(const std::string& hex) {
  std::string h(trim(hex));
  if (!h.empty() && h.front() == '#') h.erase(0, 1);
  if (h.size() == 3) h = std::string{h[0], h[0], h[1], h[1], h[2], h[2]};
  const double v = parse_int16(std::string_view(h).substr(0, std::min<std::size_t>(6, h.size())));
  if (!std::isfinite(v)) return {255, 255, 255};
  // JS `(i >> 16) & 255` on an int32: masking to 8 bits makes the arithmetic
  // and logical shifts agree, so the uint32 view yields the same bytes.
  const auto u = static_cast<std::uint32_t>(mjs::to_int32(v));
  return {static_cast<double>((u >> 16U) & 255U), static_cast<double>((u >> 8U) & 255U), static_cast<double>(u & 255U)};
}

/// colorSpace.ts `rgbToHsl` (bytes → [h, s, l] 0..1).
Vec3 rgb_to_hsl(double r, double g, double b) {
  const double rn = r / 255;
  const double gn = g / 255;
  const double bn = b / 255;
  const double mx = std::max({rn, gn, bn});
  const double mn = std::min({rn, gn, bn});
  const double l = (mx + mn) / 2;
  const double d = mx - mn;
  if (d == 0) return {0, 0, l};
  const double s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  double h = 0;
  if (mx == rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (mx == gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return {h, s, l};
}

/// keyingEffects.ts `hueOf` (bytes → 0..1).
double hue_of(double r, double g, double b) {
  const double mx = std::max({r, g, b});
  const double mn = std::min({r, g, b});
  const double d = mx - mn;
  if (d == 0) return 0;
  double hue = 0;
  if (mx == r) hue = std::fmod((g - b) / d, 6.0);
  else if (mx == g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue /= 6;
  return hue < 0 ? hue + 1 : hue;
}

/// colorSpace.ts `luma` (Rec.709).
double luma709(double r, double g, double b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

/// deepGlow.ts `srgbToLinear01`.
double srgb_to_linear01(double c) { return c <= 0.04045 ? c / 12.92 : mjs::pow((c + 0.055) / 1.055, 2.4); }

/// effects.ts `withAlpha(hex, alpha)` then `Color.fromHex` (as effects_port.cpp).
Rgba color_with_alpha(const Json& v, double alpha) {
  const std::string hex = v.is_string() ? v.str() : v.is_undefined() || v.is_null() ? "0" : js::stringify(v);
  const double a = std::max(0.0, std::min(1.0, alpha));
  const std::string_view t = trim(hex);
  bool six = t.size() == 7 && t[0] == '#';
  for (std::size_t i = 1; six && i < t.size(); ++i) six = is_hex_digit(t[i]);
  if (!six) return color_from_hex(hex);
  Rgba c = color_from_hex(t);
  c.a = a;
  return c;
}

/// distort.ts `squareToQuad` (row-major, local form) then `invert3`.
std::vector<double> corner_pin_inverse(const std::array<double, 8>& q) {
  const double x0 = q[0], y0 = q[1], x1 = q[2], y1 = q[3], x2 = q[4], y2 = q[5], x3 = q[6], y3 = q[7];
  const double dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const double dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const double den = dx1 * dy2 - dx2 * dy1;
  if (std::abs(den) < 1e-9) return {};
  const double gg = (dx3 * dy2 - dx2 * dy3) / den;
  const double hh = (dx1 * dy3 - dx3 * dy1) / den;
  const double a = x1 - x0 + gg * x1, b = x3 - x0 + hh * x3, c = x0;
  const double d = y1 - y0 + gg * y1, e = y3 - y0 + hh * y3, f = y0;
  const double g = gg, h = hh, i = 1;
  const double A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const double det = a * A + b * B + c * C;
  if (std::abs(det) < 1e-12) return {};
  const double s = 1 / det;
  return {A * s, (c * h - b * i) * s, (b * f - c * e) * s,
          B * s, (a * i - c * g) * s, (c * d - a * f) * s,
          C * s, (b * g - a * h) * s, (a * e - b * d) * s};
}

// ── param access (effectNumber / effectParam over paramsOf(e)) ────────────

struct Params {
  const Json& p;
  [[nodiscard]] const Json& raw(std::string_view k) const {
    static const Json kUndef;
    const Json* v = p.find(k);
    return v != nullptr ? *v : kUndef;
  }
  /// `effectNumber(e, k)`.
  [[nodiscard]] double n(std::string_view k) const {
    const Json& v = raw(k);
    return v.is_number() ? v.num() : 0.0;
  }
  /// `effectParam(e, k) === true`.
  [[nodiscard]] bool is_true(std::string_view k) const {
    const Json& v = raw(k);
    return v.is_bool() && v.b();
  }
  /// `effectParam(e, k) !== false`.
  [[nodiscard]] bool not_false(std::string_view k) const {
    const Json& v = raw(k);
    return !(v.is_bool() && !v.b());
  }
  /// `parseHex(String(effectParam(e, k) ?? d))` (the default is dead: effectParam is `?? 0`).
  [[nodiscard]] Vec3 hex(std::string_view k) const { return parse_hex(raw(k)); }
  /// The same, as 0..1 fractions.
  [[nodiscard]] std::vector<double> unit3(std::string_view k) const {
    const Vec3 c = hex(k);
    return {c[0] / 255, c[1] / 255, c[2] / 255};
  }
  /// `c(k, alpha)`.
  [[nodiscard]] Rgba c(std::string_view k, double alpha = 1) const { return color_with_alpha(raw(k), alpha); }
};

using Out = std::vector<api::RenderEffect>;

// ── generators, lights and the round-six colour passes ────────────────────

bool lights_and_colour(std::string_view t, const Params& P, const RLayer& layer, Out& out) {
  if (t == "deep-glow") {
    // deepGlow.ts deepGlowSettings.
    const double radius = jmax(0, P.n("radius"));
    const double exposure = P.n("exposure");
    const double threshold = jclamp(P.n("threshold") / 100, 0, 1);
    const double aspect = jclamp(P.n("aspect"), -100, 100) / 100;
    const double chroma = jclamp(P.n("chromatic") / 100, 0, 1);
    const Vec3 tb = hex_bytes(js_string(P.raw("tint")));
    const double q = mjs::round(P.n("quality"));
    const bool glowOnly = P.is_true("glowOnly");
    constexpr double kChromaSpread = 0.35;
    constexpr std::array<double, 3> kOctaves = {4, 6, 8};
    if (radius > 0 || glowOnly) {
      FxWriter w("deep-glow");
      w.num("radiusPx", radius);
      w.num("gain", mjs::pow(2, exposure));
      w.num("threshold", threshold);
      w.nums("aspect", {aspect < 0 ? jmax(0.02, 1 + aspect) : 1, aspect > 0 ? jmax(0.02, 1 - aspect) : 1});
      w.nums("chroma", {1 + chroma * kChromaSpread, 1, jmax(0.05, 1 - chroma * kChromaSpread)});
      w.nums("tint", {srgb_to_linear01(tb[0] / 255), srgb_to_linear01(tb[1] / 255), srgb_to_linear01(tb[2] / 255)});
      w.num("tintAmount", jclamp(P.n("tintAmount") / 100, 0, 1));
      w.flag("glowOnly", glowOnly);
      w.flag("dither", P.not_false("dither"));
      const double qi = jclamp(q, 0, 2);
      if (!std::isnan(qi)) w.num("octaves", kOctaves.at(static_cast<std::size_t>(qi)));
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "beam") {
    FxWriter w("beam");
    w.num("startX", P.n("startX") / 100).num("startY", P.n("startY") / 100);
    w.num("endX", P.n("endX") / 100).num("endY", P.n("endY") / 100);
    w.num("length", clamp01n(P.n("length") / 100));
    w.num("thickness", jmax(0.5, P.n("thickness")));
    w.num("softness", clamp01n(P.n("softness") / 100));
    w.color("color", P.c("color"));
    out.push_back(w.done());
    return true;
  }
  if (t == "light-sweep") {
    FxWriter w("light-sweep");
    w.num("position", P.n("position") / 100);
    w.num("sweepWidth", jmax(0, P.n("sweepWidth")));
    w.num("angle", P.n("angle"));
    w.num("softness", clamp01n(P.n("softness") / 100));
    w.num("intensity", clamp01n(P.n("intensity") / 100));
    w.num("composite", mjs::round(P.n("composite")));
    w.color("color", P.c("color"));
    out.push_back(w.done());
    return true;
  }
  if (t == "lens-flare") {
    FxWriter w("lens-flare");
    w.num("centerX", P.n("centerX"));
    w.num("centerY", P.n("centerY"));
    w.num("brightness", clamp01n(P.n("brightness") / 100));
    w.num("scale", jmax(0.05, P.n("scale")));
    w.color("color", P.c("color"));
    out.push_back(w.done());
    return true;
  }
  if (t == "light-rays") {
    FxWriter w("light-rays");
    w.num("centerX", P.n("centerX"));
    w.num("centerY", P.n("centerY"));
    w.num("rayCount", jmax(1, jmin(256, mjs::round(P.n("rayCount")))));
    w.num("rayLength", jmax(0, P.n("rayLength")));
    w.num("spread", clamp01n(P.n("spread") / 100));
    w.num("rotation", deg2rad(P.n("rotation")));
    w.num("opacity", clamp01n(P.n("opacity") / 100));
    w.num("falloff", clamp01n(P.n("falloff") / 100));
    w.num("seed", mjs::round(P.n("seed")));
    w.num("composite", mjs::round(P.n("composite")));
    w.color("color", P.c("color"));
    out.push_back(w.done());
    return true;
  }
  if (t == "vignette") {
    const double w0 = jmax(1, js_or(layer.width, 1));
    const double h0 = jmax(1, js_or(layer.height, 1));
    FxWriter w("vignette");
    w.num("amount", jclamp(P.n("amount") / 100, -1, 1));
    w.num("inner", jclamp(P.n("size") / 100, 0, 1));
    w.num("feather", jclamp(P.n("feather") / 100, 1e-3, 1));
    w.num("roundness", jclamp(P.n("roundness") / 100, 0, 1));
    w.num("cx", 0.5 + P.n("centerX") / w0);
    w.num("cy", 0.5 + P.n("centerY") / h0);
    w.num("aspect", w0 / h0);
    out.push_back(w.done());
    return true;
  }
  if (t == "black-and-white") {
    const bool tintOn = P.is_true("tint");
    const Vec3 tc = P.hex("tintColor");
    const Vec3 hsl = rgb_to_hsl(tc[0], tc[1], tc[2]);
    FxWriter w("black-and-white");
    w.num("reds", P.n("reds") / 100).num("yellows", P.n("yellows") / 100).num("greens", P.n("greens") / 100);
    w.num("cyans", P.n("cyans") / 100).num("blues", P.n("blues") / 100).num("magentas", P.n("magentas") / 100);
    w.num("tintOn", tintOn ? 1 : 0).num("tintH", hsl[0]).num("tintS", hsl[1]);
    out.push_back(w.done());
    return true;
  }
  if (t == "tritone") {
    const Vec3 s = P.hex("shadows");
    const Vec3 m = P.hex("midtones");
    const Vec3 h = P.hex("highlights");
    FxWriter w("tritone");
    w.num("sr", s[0] / 255).num("sg", s[1] / 255).num("sb", s[2] / 255);
    w.num("mr", m[0] / 255).num("mg", m[1] / 255).num("mb", m[2] / 255);
    w.num("hr", h[0] / 255).num("hg", h[1] / 255).num("hb", h[2] / 255);
    w.num("blend", jclamp(P.n("blend") / 100, 0, 1));
    out.push_back(w.done());
    return true;
  }
  if (t == "photo-filter") {
    const Vec3 c = P.hex("color");
    FxWriter w("photo-filter");
    w.num("r", c[0] / 255).num("g", c[1] / 255).num("b", c[2] / 255);
    w.num("density", jclamp(P.n("density") / 100, 0, 1));
    w.flag("preserveLuminosity", P.not_false("preserveLuminosity"));
    out.push_back(w.done());
    return true;
  }
  if (t == "threshold") {
    out.push_back(FxWriter("threshold").num("level", jclamp(P.n("level") / 255, 0, 1)).done());
    return true;
  }
  if (t == "vibrance") {
    out.push_back(FxWriter("vibrance").num("vibrance", P.n("vibrance") / 100).num("saturation", P.n("saturation") / 100).done());
    return true;
  }
  return false;
}

// ── round six waves 2–3 + round seven: warps, neighbourhood passes ────────

bool warps(std::string_view t, const Params& P, double lw, double lh, Out& out) {
  const auto cx = [&]() { return lw / 2 + P.n("centerX"); };
  const auto cy = [&]() { return lh / 2 + P.n("centerY"); };
  if (t == "mirror") {
    const double mrad = deg2rad(P.n("angle"));
    FxWriter w("mirror");
    w.num("cx", cx()).num("cy", cy()).num("nx", mjs::cos(mrad)).num("ny", mjs::sin(mrad)).num("lw", lw).num("lh", lh);
    out.push_back(w.done());
    return true;
  }
  if (t == "offset") {
    FxWriter w("offset");
    w.num("tx", P.n("shiftX") - lw / 2).num("ty", P.n("shiftY") - lh / 2);
    w.num("keep", jclamp(P.n("blend") / 100, 0, 1)).num("lw", lw).num("lh", lh);
    out.push_back(w.done());
    return true;
  }
  if (t == "bulge") {
    FxWriter w("bulge");
    w.num("cx", cx()).num("cy", cy()).num("radius", P.n("radius")).num("amount", P.n("height") / 100).num("lw", lw).num("lh", lh);
    out.push_back(w.done());
    return true;
  }
  if (t == "twirl") {
    FxWriter w("twirl");
    w.num("cx", cx()).num("cy", cy()).num("radius", P.n("radius")).num("maxAngle", deg2rad(P.n("angle")));
    w.num("lw", lw).num("lh", lh);
    out.push_back(w.done());
    return true;
  }
  if (t == "spherize") {
    FxWriter w("spherize");
    w.num("cx", cx()).num("cy", cy()).num("radius", P.n("radius")).num("amount", P.n("amount") / 100).num("lw", lw).num("lh", lh);
    out.push_back(w.done());
    return true;
  }
  if (t == "kaleidoscope") {
    const double segN = jmax(1, jmin(64, mjs::round(P.n("segments"))));
    FxWriter w("kaleidoscope");
    w.num("cx", cx()).num("cy", cy());
    w.num("rot", deg2rad(P.n("rotation"))).num("srcA", deg2rad(P.n("sourceAngle")));
    w.num("seg", segN <= 1 ? 0 : (kPi * 2) / segN);
    w.num("scale", jmax(0.01, P.n("zoom") / 100)).num("lw", lw).num("lh", lh);
    out.push_back(w.done());
    return true;
  }
  if (t == "ripple") {
    FxWriter w("ripple");
    w.num("cx", cx()).num("cy", cy());
    w.num("radius", P.n("radius") > 0 ? P.n("radius") : hypot2(lw, lh));
    w.num("amplitude", P.n("amplitude")).num("frequency", P.n("frequency"));
    w.num("phase", deg2rad(P.n("phase"))).num("decay", jmax(0, P.n("decay"))).num("lw", lw).num("lh", lh);
    out.push_back(w.done());
    return true;
  }
  if (t == "chromatic-aberration") {
    const double caRad = deg2rad(P.n("angle"));
    const double cax = cx();
    const double cay = cy();
    FxWriter w("chromatic-aberration");
    w.num("amount", P.n("amount"));
    w.flag("linear", mjs::round(P.n("aberrationMode")) == 1);
    w.num("lvx", mjs::cos(caRad) * P.n("amount")).num("lvy", mjs::sin(caRad) * P.n("amount"));
    w.num("falloffExp", 1 + (P.n("falloff") / 100) * 3);
    w.num("cx", cax).num("cy", cay);
    w.num("maxR", jmax(1, hypot2(jmax(cax, lw - cax), jmax(cay, lh - cay))));
    w.num("lw", lw).num("lh", lh);
    out.push_back(w.done());
    return true;
  }
  if (t == "magnify") {
    const double mradius = P.n("radius");
    FxWriter w("magnify");
    w.num("cx", cx()).num("cy", cy());
    w.num("radius", mradius).num("scale", jmax(0.01, P.n("magnification") / 100));
    w.flag("square", mjs::round(P.n("shape")) == 1);
    w.num("feather", jmax(0, jmin(P.n("feather"), mradius))).num("lw", lw).num("lh", lh);
    out.push_back(w.done());
    return true;
  }
  if (t == "mosaic") {
    FxWriter w("mosaic");
    w.num("cols", jmax(1, jmin(lw, mjs::round(P.n("horizontalBlocks")))));
    w.num("rows", jmax(1, jmin(lh, mjs::round(P.n("verticalBlocks")))));
    w.flag("sharp", P.is_true("sharpColors")).num("lw", lw).num("lh", lh);
    out.push_back(w.done());
    return true;
  }
  if (t == "gaussian-blur" || t == "fast-box-blur") {
    const double r = jmax(0, P.n(t == "gaussian-blur" ? "blurriness" : "blurRadius"));
    if (r > 0) {
      const double dimsRaw = mjs::round(P.n("dimensions"));
      out.push_back(FxWriter(std::string(t)).num("radiusPx", r / std::numbers::sqrt3).num("dims", dimsRaw == 1 ? 1 : dimsRaw == 2 ? 2 : 0).done());
    }
    return true;
  }
  if (t == "radial-blur") {
    const double amount = P.n("amount");
    if (amount != 0) {
      FxWriter w("radial-blur");
      w.num("cx", cx()).num("cy", cy());
      w.num("amount", amount).flag("zoom", mjs::round(P.n("blurType")) == 1);
      w.num("steps", jmax(2, jmin(64, mjs::round(js_or(P.n("quality"), 16))))).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "corner-pin") {
    const std::array<double, 8> offs = {P.n("topLeftX"),     P.n("topLeftY"),     P.n("topRightX"),   P.n("topRightY"),
                                        P.n("bottomRightX"), P.n("bottomRightY"), P.n("bottomLeftX"), P.n("bottomLeftY")};
    if (std::ranges::any_of(offs, [](double v) { return v != 0; })) {
      std::vector<double> inv =
          corner_pin_inverse({offs[0], offs[1], lw + offs[2], offs[3], lw + offs[4], lh + offs[5], offs[6], lh + offs[7]});
      if (inv.empty()) inv.assign(9, 0.0);
      out.push_back(FxWriter("corner-pin").nums("m", std::move(inv)).num("lw", lw).num("lh", lh).done());
    }
    return true;
  }
  if (t == "transform") {
    const double scale = jmax(0, P.n("scale")) / 100;
    const double rot = deg2rad(P.n("rotation"));
    const double px = P.n("positionX");
    const double py = P.n("positionY");
    const double opacity = jclamp(P.n("opacity") / 100, 0, 1);
    if (!(scale == 1 && rot == 0 && px == 0 && py == 0 && opacity == 1)) {
      FxWriter w("transform");
      w.num("px", px).num("py", py).num("scale", scale).num("rot", rot).num("opacity", opacity).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  return false;
}

// ── round eight: keying ─────────────────────────────────────────────────

bool keying(std::string_view t, const Params& P, double lw, double lh, Out& out) {
  if (t == "keylight") {
    const Vec3 key = P.hex("screenColor");
    const double kr = key[0], kg = key[1], kb = key[2];
    std::size_t p = 0, a = 1, b = 2;
    if (kg >= kr && kg >= kb) {
      p = 1;
      a = 0;
      b = 2;
    } else if (kb >= kr && kb >= kg) {
      p = 2;
      a = 0;
      b = 1;
    }
    const double balance = jclamp(P.n("balance") / 100, 0, 1);
    const Vec3 kv = {kr / 255, kg / 255, kb / 255};
    const double sec = balance * jmax(kv.at(a), kv.at(b)) + (1 - balance) * jmin(kv.at(a), kv.at(b));
    const double ref = kv.at(p) - sec;
    FxWriter w("keylight");
    w.num("kr", kv[0]).num("kg", kv[1]).num("kb", kv[2]).num("balance", balance);
    w.num("gain", jmax(0, P.n("gain") / 100));
    w.num("clipBlack", jclamp(P.n("clipBlack") / 100, 0, 1));
    w.num("clipWhite", jclamp(P.n("clipWhite") / 100, 0, 1));
    w.num("despill", jclamp(P.n("despill") / 100, 0, 1));
    w.num("p", static_cast<double>(p)).num("a", static_cast<double>(a)).num("b", static_cast<double>(b));
    w.num("denom", std::abs(ref) < 1e-4 ? 1 : ref);
    w.num("chokePx", mjs::sign(P.n("choke")) * jmin(10, mjs::round(std::abs(P.n("choke")))));
    w.num("softPx", jmin(25, mjs::round(jmax(0, P.n("matteSoftness")))));
    w.num("lw", lw).num("lh", lh);
    out.push_back(w.done());
    return true;
  }
  if (t == "linear-color-key") {
    const Vec3 key = P.hex("keyColor");
    const double m = mjs::round(P.n("matchOn"));
    FxWriter w("linear-color-key");
    w.num("kr", key[0] / 255).num("kg", key[1] / 255).num("kb", key[2] / 255);
    w.num("mode", m == 1 ? 1 : m == 2 ? 2 : 0);
    w.num("tol", jclamp(P.n("tolerance") / 100, 0, 1));
    w.num("soft", jclamp(P.n("softness") / 100, 0, 1));
    w.flag("keep", P.is_true("keepMatched"));
    w.num("keyHue", hue_of(key[0], key[1], key[2]));
    w.num("keyLum", (0.299 * key[0] + 0.587 * key[1] + 0.114 * key[2]) / 255);
    out.push_back(w.done());
    return true;
  }
  if (t == "luma-key") {
    FxWriter w("luma-key");
    w.num("keyType", jclamp(mjs::round(P.n("keyType")), 0, 3));
    w.num("cut", jclamp(P.n("threshold") / 255, 0, 1));
    w.num("tol", jmax(0, P.n("tolerance") / 255));
    w.num("soft", jmax(0, P.n("softness") / 255));
    out.push_back(w.done());
    return true;
  }
  if (t == "color-key") {
    const Vec3 key = P.hex("keyColor");
    FxWriter w("color-key");
    w.num("kr", key[0] / 255).num("kg", key[1] / 255).num("kb", key[2] / 255);
    w.num("tol", jclamp(P.n("tolerance") / 100, 0, 1));
    w.num("soft", jclamp(P.n("edgeSoftness") / 100, 0, 1));
    out.push_back(w.done());
    return true;
  }
  if (t == "color-range") {
    const Vec3 key = P.hex("keyColor");
    const double mode = mjs::round(P.n("colorSpace"));
    const double y = luma709(key[0], key[1], key[2]);
    const Vec3 proj = mode == 2   ? Vec3{key[0], key[1], key[2]}
                      : mode == 1 ? Vec3{y, (key[2] - y) * 0.565, (key[0] - y) * 0.713}  // NOLINT(modernize-use-std-numbers): 0.565 is the YUV Cb scale from colorRange.ts, not inv_sqrtpi (0.5642)
                                  : Vec3{y, (key[0] - key[1]) * 0.5, (key[1] - key[2]) * 0.5};
    const double lo = jclamp(P.n("minTolerance") / 100, 0, 1) * 255;
    FxWriter w("color-range");
    w.num("ky", proj[0]).num("ku", proj[1]).num("kv", proj[2]).num("mode", mode == 1 ? 1 : mode == 2 ? 2 : 0);
    w.num("lo", lo).num("hi", jmax(lo + 1e-6, jclamp(P.n("maxTolerance") / 100, 0, 1) * 255));
    w.num("wl", jclamp(P.n("lumaWeight") / 100, 0, 1));
    out.push_back(w.done());
    return true;
  }
  if (t == "extract") {
    FxWriter w("extract");
    w.num("channel", mjs::round(P.n("extractChannel")));
    w.num("black", P.n("blackPoint")).num("white", P.n("whitePoint"));
    w.num("blackSoft", P.n("blackSoftness")).num("whiteSoft", P.n("whiteSoftness"));
    w.flag("invert", P.is_true("invertExtract"));
    out.push_back(w.done());
    return true;
  }
  if (t == "spill-suppressor") {
    const double strength = jclamp(P.n("amount") / 100, 0, 1);
    if (strength > 0) {
      const Vec3 key = P.hex("keyColor");
      FxWriter w("spill-suppressor");
      w.num("keyHue", rgb_to_hsl(key[0], key[1], key[2])[0]).num("strength", strength);
      w.flag("preserveLuma", P.not_false("preserveLuma"));
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "simple-choker") {
    const double choke = P.n("chokeAmount");
    const double radius = mjs::round(std::abs(choke));
    if (radius > 0) {
      out.push_back(FxWriter("simple-choker").num("radius", radius).flag("erode", choke > 0).num("lw", lw).num("lh", lh).done());
    }
    return true;
  }
  if (t == "matte-choker") {
    const double spread = jmax(0, P.n("spread"));
    const double choke = jmax(0, P.n("choke"));
    const double softness = jmax(0, P.n("softness"));
    if (spread > 0 || choke > 0 || softness > 0) {
      FxWriter w("matte-choker");
      w.num("spread", spread).num("choke", choke).num("softness", softness);
      w.num("iterations", jmax(1, jmin(5, mjs::round(js_or(P.n("iterations"), 1))))).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "wave-warp") {
    const double height = P.n("waveHeight");
    const double width = jmax(2, P.n("waveWidth"));
    if (height != 0) {
      const double dir = deg2rad(P.n("direction"));
      FxWriter w("wave-warp");
      w.num("dx", mjs::cos(dir)).num("dy", mjs::sin(dir));
      w.num("k", (kPi * 2) / width).num("phase", deg2rad(P.n("phase")));
      w.num("height", height).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  return false;
}

// ── round nine: colour, channel and transition passes ─────────────────────

bool round_nine(std::string_view t, const Params& P, double lw, double lh, Out& out) {
  if (t == "directional-blur") {
    const double length = jmax(0, P.n("length"));
    if (length >= 1) {
      const double r = deg2rad(P.n("direction"));
      FxWriter w("directional-blur");
      w.num("dx", mjs::cos(r)).num("dy", mjs::sin(r)).num("length", length);
      w.num("steps", jmax(1, jmin(64, mjs::round(length)))).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "linear-wipe") {
    const double completion = jclamp(P.n("completion"), 0, 100) / 100;
    if (completion > 0) {
      const double r = deg2rad(P.n("wipeAngle"));
      const double span = std::abs(lw * mjs::cos(r)) + std::abs(lh * mjs::sin(r));
      FxWriter w("linear-wipe");
      w.num("gx", mjs::cos(r)).num("gy", mjs::sin(r));
      w.num("pos", -span / 2 + completion * span).num("soft", jmax(jmax(0, P.n("feather")), 0.01));
      w.flag("full", completion >= 1).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "shift-channels") {
    const auto src = [&](std::string_view k) { return jclamp(mjs::round(P.n(k)), 0, 6); };
    FxWriter w("shift-channels");
    w.num("a", src("takeAlphaFrom")).num("r", src("takeRedFrom")).num("g", src("takeGreenFrom")).num("b", src("takeBlueFrom"));
    out.push_back(w.done());
    return true;
  }
  if (t == "alpha-levels") {
    FxWriter w("alpha-levels");
    w.num("inBlack", P.n("inBlack")).num("span", jmax(1e-6, P.n("inWhite") - P.n("inBlack")));
    w.num("invGamma", 1 / jmax(1e-3, js_or(P.n("gamma"), 1)));
    w.num("outBlack", P.n("outBlack")).num("outWhite", P.n("outWhite"));
    out.push_back(w.done());
    return true;
  }
  if (t == "solid-composite") {
    const Vec3 col = P.hex("solidColor");
    FxWriter w("solid-composite");
    w.num("cr", col[0] / 255).num("cg", col[1] / 255).num("cb", col[2] / 255);
    w.num("so", jclamp(P.n("sourceOpacity") / 100, 0, 1)).num("co", jclamp(P.n("solidOpacity") / 100, 0, 1));
    w.num("mode", mjs::round(P.n("compositeMode")));
    out.push_back(w.done());
    return true;
  }
  if (t == "channel-combiner") {
    out.push_back(FxWriter("channel-combiner").num("mode", mjs::round(P.n("combinerMode"))).done());
    return true;
  }
  if (t == "remove-color-matting") {
    const double strength = jclamp(P.n("amount") / 100, 0, 1);
    if (strength > 0) {
      const Vec3 bgc = P.hex("backgroundColor");
      FxWriter w("remove-color-matting");
      w.num("br", bgc[0] / 255).num("bg", bgc[1] / 255).num("bb", bgc[2] / 255);
      w.num("floor", jclamp(P.n("threshold") / 100, 0, 1)).num("strength", strength);
      out.push_back(w.done());
    }
    return true;
  }
  const auto tolerances = [&](FxWriter& w) {
    w.num("hT", jclamp(P.n("hueTolerance") / 100, 0, 1) * 0.5);
    w.num("sT", jclamp(P.n("satTolerance") / 100, 0, 1)).num("lT", jclamp(P.n("lightTolerance") / 100, 0, 1));
    w.num("soft", jclamp(P.n("softness") / 100, 0, 1));
  };
  if (t == "change-color") {
    const Vec3 tgt = P.hex("targetColor");
    const Vec3 hsl = rgb_to_hsl(tgt[0], tgt[1], tgt[2]);
    FxWriter w("change-color");
    w.num("th", hsl[0]).num("ts", hsl[1]).num("tl", hsl[2]);
    tolerances(w);
    w.num("hueShift", P.n("hueShift") / 360).num("satScale", P.n("satScale") / 100).num("lightScale", P.n("lightScale") / 100);
    w.flag("invert", P.is_true("invertSelection"));
    out.push_back(w.done());
    return true;
  }
  if (t == "change-to-color") {
    const Vec3 from = P.hex("fromColor");
    const Vec3 to = P.hex("toColor");
    const Vec3 f = rgb_to_hsl(from[0], from[1], from[2]);
    const Vec3 d = rgb_to_hsl(to[0], to[1], to[2]);
    FxWriter w("change-to-color");
    w.num("fh", f[0]).num("fs", f[1]).num("fl", f[2]);
    tolerances(w);
    w.flag("preserve", P.not_false("preserveLightness")).num("dh", d[0]).num("ds", d[1]).num("dl", d[2]);
    out.push_back(w.done());
    return true;
  }
  if (t == "leave-color") {
    const double strength = jclamp(P.n("amount") / 100, 0, 1);
    if (strength > 0) {
      const Vec3 tgt = P.hex("targetColor");
      FxWriter w("leave-color");
      w.num("th", rgb_to_hsl(tgt[0], tgt[1], tgt[2])[0]);
      w.num("tol", jclamp(P.n("tolerance") / 100, 0, 1) * 0.5).num("soft", jclamp(P.n("softness") / 100, 0, 1));
      w.num("strength", strength);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "toner") {
    const double k = jclamp(1 - P.n("blend") / 100, 0, 1);
    if (k > 0) {
      std::vector<double> stops;
      stops.reserve(15);
      for (const std::string_view key : {"blackTone", "shadowTone", "midTone", "highlightTone", "whiteTone"}) {
        const Vec3 c3 = P.hex(key);
        stops.push_back(c3[0] / 255);
        stops.push_back(c3[1] / 255);
        stops.push_back(c3[2] / 255);
      }
      out.push_back(FxWriter("toner").nums("stops", std::move(stops)).num("k", k).done());
    }
    return true;
  }
  if (t == "venetian-blinds") {
    const double tt = jclamp(P.n("completion") / 100, 0, 1);
    if (tt > 0) {
      const double r = deg2rad(P.n("direction"));
      const double pitch = jmax(1, P.n("width"));
      FxWriter w("venetian-blinds");
      w.num("cos", mjs::cos(r)).num("sin", mjs::sin(r)).num("pitch", pitch).num("half", (pitch * tt) / 2);
      w.num("soft", jmax(0, P.n("feather"))).flag("full", tt >= 1).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "radial-wipe") {
    const double tt = jclamp(P.n("completion") / 100, 0, 1);
    if (tt > 0) {
      constexpr double kTau = kPi * 2;
      const double dirRaw = P.n("wipe");
      const double dir = dirRaw >= 2 ? 2 : dirRaw >= 1 ? 1 : 0;
      FxWriter w("radial-wipe");
      w.num("cx", lw / 2 + P.n("centerX")).num("cy", lh / 2 + P.n("centerY"));
      w.num("start", std::fmod(deg2rad(P.n("startAngle")), kTau)).num("swept", (dir == 2 ? tt / 2 : tt) * kTau);
      w.num("dir", dir).num("soft", jmax(0, deg2rad(P.n("feather")))).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "iris-wipe") {
    const bool invert = P.is_true("invertIris");
    const double completion = P.n("completion");
    if (completion > 0 || invert) {
      const double tt = jclamp(completion / 100, 0, 1);
      const double cx = lw / 2 + P.n("centerX");
      const double cy = lh / 2 + P.n("centerY");
      const double maxR = js_or(hypot2(jmax(cx, lw - cx), jmax(cy, lh - cy)), 1);
      const double outer = tt * maxR;
      const bool useInner = P.is_true("useInnerRadius");
      FxWriter w("iris-wipe");
      w.num("cx", cx).num("cy", cy).num("outer", outer).num("inner", useInner ? jmin(outer, P.n("innerRadius")) : 0);
      w.num("points", mjs::round(P.n("irisPoints"))).num("rot", deg2rad(P.n("rotation")));
      w.num("feath", jmax(1e-3, P.n("feather"))).flag("useInner", useInner).flag("invert", invert).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "line-sweep") {
    const bool invert = P.is_true("invertSweep");
    const double completion = P.n("completion");
    if (completion > 0 || invert) {
      const double a = deg2rad(P.n("angle"));
      FxWriter w("line-sweep");
      w.num("nx", mjs::cos(a)).num("ny", mjs::sin(a));
      w.num("n", jclamp(mjs::round(P.n("lineCount")), 1, 512)).num("stag", jclamp(P.n("stagger") / 100, 0, 1));
      w.num("feath", jmax(1e-3, P.n("feather") / 100)).num("t", jclamp(completion / 100, 0, 1));
      w.flag("invert", invert).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  return false;
}

// ── round ten: separable neighbourhood passes and drawn generators ────────

bool round_ten(std::string_view t, const Params& P, double lw, double lh, Out& out) {
  if (t == "channel-blur") {
    const double rr = jmax(0, mjs::round(P.n("redBlurriness")));
    const double rg = jmax(0, mjs::round(P.n("greenBlurriness")));
    const double rb = jmax(0, mjs::round(P.n("blueBlurriness")));
    const double ra = jmax(0, mjs::round(P.n("alphaBlurriness")));
    if (rr > 0 || rg > 0 || rb > 0 || ra > 0) {
      const double dimsRaw = mjs::round(P.n("dimensions"));
      FxWriter w("channel-blur");
      w.num("r", rr).num("g", rg).num("b", rb).num("a", ra).num("dims", dimsRaw == 1 ? 1 : dimsRaw == 2 ? 2 : 0);
      w.flag("repeatEdge", P.is_true("repeatEdge")).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "minimax") {
    const double radius = jmax(0, mjs::round(P.n("radius")));
    if (radius > 0) {
      const double ch = mjs::round(P.n("channel"));
      const double dirRaw = P.n("direction");
      FxWriter w("minimax");
      w.num("op", jclamp(mjs::round(P.n("operation")), 0, 3)).num("radius", radius);
      w.num("mask", ch == 1 ? 7 : ch == 2 ? 1 : ch == 3 ? 2 : ch == 4 ? 4 : 8);
      w.num("dir", dirRaw >= 2 ? 2 : dirRaw >= 1 ? 1 : 0).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "unsharp-mask") {
    const double amount = P.n("amount");
    const double radius = P.n("radius");
    if (amount > 0 && radius > 0) {
      FxWriter w("unsharp-mask");
      w.num("amount", amount / 100).num("threshold", jmax(0, P.n("threshold")) / 255).num("sigmaPx", radius / std::numbers::sqrt3);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "shadow-highlight") {
    const double sa = P.n("shadowAmount") / 100;
    const double ha = P.n("highlightAmount") / 100;
    if (sa != 0 || ha != 0) {
      const double r = jmax(0, P.n("radius"));
      FxWriter w("shadow-highlight");
      w.num("shadow", sa).num("highlight", ha).num("invWidth", 1 / jmax(0.01, P.n("tonalWidth") / 100));
      w.num("sigmaPx", std::sqrt((r * (r + 1)) / 3));
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "checkerboard") {
    const double opacity = jmin(1, P.n("opacity") / 100);
    if (opacity > 0) {
      const double sizeW = jmax(1, P.n("width"));
      const double sizeH = jmax(1, P.n("height"));
      const double ax = P.n("anchorX");
      const double ay = P.n("anchorY");
      FxWriter w("checkerboard");
      w.num("sizeW", sizeW).num("sizeH", sizeH);
      w.num("startX", -sizeW + std::fmod(std::fmod(ax, sizeW) + sizeW, sizeW));
      w.num("startY", -sizeH + std::fmod(std::fmod(ay, sizeH) + sizeH, sizeH));
      w.nums("colA", P.unit3("colorA")).nums("colB", P.unit3("colorB"));
      w.num("opacity", opacity).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "grid") {
    const double thickness = jmax(0, P.n("thickness"));
    const double opacity = jmin(1, P.n("opacity") / 100);
    if (thickness > 0 && opacity > 0) {
      const double pitchX = jmax(1, P.n("width"));
      const double pitchY = jmax(1, P.n("height"));
      FxWriter w("grid");
      w.num("pitchX", pitchX).num("pitchY", pitchY);
      w.num("offX", std::fmod(std::fmod(P.n("anchorX"), pitchX) + pitchX, pitchX));
      w.num("offY", std::fmod(std::fmod(P.n("anchorY"), pitchY) + pitchY, pitchY));
      w.num("thickness", thickness).num("snap", std::fmod(mjs::round(thickness), 2.0) == 1 ? 0.5 : 0).num("opacity", opacity);
      w.nums("color", P.unit3("color")).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "four-color-gradient") {
    const double blend = jclamp(P.n("blend") / 100, 0, 1);
    if (blend > 0) {
      FxWriter w("four-color-gradient");
      w.nums("tl", P.unit3("colorTL")).nums("tr", P.unit3("colorTR")).nums("bl", P.unit3("colorBL")).nums("br", P.unit3("colorBR"));
      w.num("blend", blend).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "circle") {
    const double radius = jmax(0, P.n("radius"));
    const double opacity = jclamp(P.n("opacity") / 100, 0, 1);
    if (radius > 0 && opacity > 0) {
      FxWriter w("circle");
      w.num("cx", lw / 2 + P.n("centerX")).num("cy", lh / 2 + P.n("centerY")).num("radius", radius);
      w.num("feather", jmax(0, jmin(radius, P.n("feather")))).num("thickness", jmax(0, P.n("thickness"))).num("opacity", opacity);
      w.flag("invert", P.is_true("invertCircle")).num("composite", mjs::round(P.n("composite")));
      w.nums("color", P.unit3("color")).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "ellipse") {
    const double rx = jmax(0, P.n("ellipseWidth") / 2);
    const double ry = jmax(0, P.n("ellipseHeight") / 2);
    const double opacity = jclamp(P.n("opacity") / 100, 0, 1);
    if (rx > 0 && ry > 0 && opacity > 0) {
      FxWriter w("ellipse");
      w.num("cx", lw / 2 + P.n("centerX")).num("cy", lh / 2 + P.n("centerY")).num("rx", rx).num("ry", ry);
      w.num("rot", deg2rad(P.n("rotation"))).num("thickness", jmax(0.5, P.n("thickness"))).num("softness", jmax(0, P.n("softness")));
      w.num("opacity", opacity).num("composite", mjs::round(P.n("composite")));
      w.nums("color", P.unit3("color")).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  return false;
}

// ── round eleven: advanced distort / transition / stylize ─────────────────

/// `boxSigma(r)`.
double box_sigma(double r) { return r > 0 ? std::sqrt((r * (r + 1)) / 3) : 0; }
double clamp01(double v) { return jclamp(v, 0, 1); }

bool round_eleven_a(std::string_view t, const Params& P, double lw, double lh, Out& out) {
  if (t == "polar-coordinates") {
    const double interp = P.n("interpolation");
    if (interp > 0) {
      FxWriter w("polar-coordinates");
      w.num("t", clamp01(interp / 100)).num("conv", P.n("conversion") >= 1 ? 1 : 0).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "optics-compensation") {
    const double fov = jclamp(P.n("fieldOfView"), 0, 180);
    if (fov > 0) {
      FxWriter w("optics-compensation");
      w.num("k", mjs::tan((fov * kPi) / 360) * 0.5).flag("reverse", P.is_true("reverse"));
      w.num("cx", lw / 2 + P.n("centerX")).num("cy", lh / 2 + P.n("centerY"));
      w.num("norm", js_or(hypot2(lw / 2, lh / 2), 1)).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "warp") {
    const double bend = P.n("bend") / 100;
    const double h = P.n("horizontalDistortion");
    const double v = P.n("verticalDistortion");
    if (bend != 0 || h != 0 || v != 0) {
      FxWriter w("warp");
      w.num("style", mjs::round(P.n("style"))).num("bend", bend).num("h", h).num("v", v);
      w.flag("vert", mjs::round(P.n("warpAxis")) == 1).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "page-turn") {
    const double amount = P.n("amount");
    if (amount > 0) {
      const double tt = clamp01(amount / 100);
      const double a = deg2rad(P.n("angle"));
      const double nx = mjs::cos(a);
      const double ny = mjs::sin(a);
      const double diag = std::abs(lw * nx) + std::abs(lh * ny);
      FxWriter w("page-turn");
      w.num("nx", nx).num("ny", ny).num("foldAt", (1 - tt) * diag - (lw * nx + lh * ny) / 2);
      w.num("rad", jmax(1, P.n("curlRadius")));
      w.num("backA", clamp01(P.n("backOpacity") / 100)).num("shade", clamp01(P.n("shading") / 100)).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "split") {
    const double offset = P.n("splitOffset");
    if (offset != 0) {
      const double a = deg2rad(P.n("angle"));
      FxWriter w("split");
      w.num("nx", mjs::cos(a)).num("ny", mjs::sin(a)).num("cx", lw / 2 + P.n("centerX")).num("cy", lh / 2 + P.n("centerY"));
      w.num("half", offset / 2).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "slant") {
    const double slant = P.n("slant");
    if (slant != 0) {
      FxWriter w("slant");
      w.num("slant", slant).flag("vert", mjs::round(P.n("slantAxis")) == 1).num("anchor", clamp01(P.n("floor")));
      w.num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "smear") {
    const double vx = P.n("toX") - P.n("fromX");
    const double vy = P.n("toY") - P.n("fromY");
    const double radius = P.n("radius");
    if ((vx != 0 || vy != 0) && radius > 0) {
      FxWriter w("smear");
      w.num("fx", lw / 2 + P.n("fromX")).num("fy", lh / 2 + P.n("fromY")).num("vx", vx).num("vy", vy).num("radius", radius);
      w.num("el", jmax(0.1, P.n("elasticity") / 100)).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "rolling-shutter") {
    const double sweep = P.n("sweep");
    const double wobble = P.n("wobble");
    if (sweep != 0 || wobble != 0) {
      FxWriter w("rolling-shutter");
      w.num("sweep", sweep).num("wobble", wobble).flag("flip", mjs::round(P.n("scanDirection")) == 1);
      w.flag("vertical", P.is_true("verticalScan")).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  return false;
}

// The branches between 'rolling-shutter' and 'card-dance' (part B's first).
bool round_eleven_b(std::string_view t, const Params& P, double lw, double lh, Out& out) {
  if (t == "radial-shadow") {
    const double op = P.n("shadowOpacity");
    if (op > 0) {
      const double softness = P.n("softness");
      FxWriter w("radial-shadow");
      w.num("lx", lw / 2 + P.n("lightX")).num("ly", lh / 2 + P.n("lightY")).num("proj", 1 + jmax(0, P.n("projection")) / 100);
      w.nums("color", P.unit3("shadowColor")).num("op", clamp01(op / 100));
      w.num("sigmaPx", softness > 0 ? box_sigma(jmax(1, mjs::round(softness))) : 0);
      w.flag("shadowOnly", mjs::round(P.n("renderMode")) == 1).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "flo-motion") {
    const double k1a = P.n("knot1Amount") / 100;
    const double k2a = P.n("knot2Amount") / 100;
    if (k1a != 0 || k2a != 0) {
      const double sigma = jmax(4, (P.n("falloff") / 100) * jmin(lw, lh));
      FxWriter w("flo-motion");
      w.num("k1x", lw / 2 + P.n("knot1X")).num("k1y", lh / 2 + P.n("knot1Y")).num("k1a", k1a);
      w.num("k2x", lw / 2 + P.n("knot2X")).num("k2y", lh / 2 + P.n("knot2Y")).num("k2a", k2a);
      w.num("twoSigma2", 2 * sigma * sigma).num("reachOverSigma", 1.2).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "lens") {
    const double ballR = jmax(4, (P.n("size") / 100) * (jmin(lw, lh) / 2));
    const double halfDiag = hypot2(lw, lh) / 2;
    FxWriter w("lens");
    w.num("cx", lw / 2 + P.n("centerX")).num("cy", lh / 2 + P.n("centerY")).num("ballR", ballR);
    w.num("pull", ballR + (halfDiag - ballR) * clamp01(P.n("convergence") / 100)).num("lw", lw).num("lh", lh);
    out.push_back(w.done());
    return true;
  }
  if (t == "griddler") {
    const double r = deg2rad(P.n("rotation"));
    FxWriter w("griddler");
    w.num("tile", jmax(4, P.n("tileSize"))).num("sx", jmax(0.01, P.n("horizontalScale") / 100));
    w.num("sy", jmax(0.01, P.n("verticalScale") / 100)).num("cosR", mjs::cos(r)).num("sinR", mjs::sin(r));
    w.num("lw", lw).num("lh", lh);
    out.push_back(w.done());
    return true;
  }
  if (t == "ball-action") {
    const double g = jmax(4, P.n("grid"));
    FxWriter w("ball-action");
    w.num("g", g).num("R", jmax(0.01, (g / 2) * clamp01(P.n("ballSize") / 100)));
    w.num("jit", (P.n("scatter") / 100) * g * 0.5).num("seed", std::floor(P.n("seed"))).num("lw", lw).num("lh", lh);
    out.push_back(w.done());
    return true;
  }
  if (t == "drizzle") {
    const double count = mjs::round(clamp01(P.n("dripRate") / 100) * 30);
    const double amp = P.n("rippleHeight");
    if (P.n("dripRate") > 0 && count > 0 && amp > 0) {
      const double spread = jmax(8, P.n("spreading"));
      const double bandW = jmax(3, spread * 0.08);
      FxWriter w("drizzle");
      w.num("n", count).num("spread", spread).num("bandW", bandW).num("freq", kPi / (bandW * 0.6));
      w.num("evolution", P.n("evolution")).num("seed", std::floor(P.n("seed"))).num("amp", amp).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "jaws") {
    const double tt = clamp01(P.n("completion") / 100);
    if (tt > 0) {
      const double a = deg2rad(P.n("direction"));
      const double ux = mjs::cos(a);
      const double uy = mjs::sin(a);
      const double extent = std::abs(-uy * lw) / 2 + std::abs(ux * lh) / 2;
      const double th = P.n("teethHeight");
      FxWriter w("jaws");
      w.num("ux", ux).num("uy", uy).num("sep", tt >= 1 ? 1e6 : tt * (extent + th));
      w.num("tw", jmax(2, P.n("teethWidth"))).num("th", jmax(1, th)).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "pixel-polly") {
    const double tt = clamp01(P.n("completion") / 100);
    if (tt > 0) {
      const double cell = jmax(4, P.n("cellSize"));
      FxWriter w("pixel-polly");
      w.num("t", tt).num("cell", cell).num("fx", lw / 2 + P.n("centerX")).num("fy", lh / 2 + P.n("centerY"));
      w.num("maxFly", hypot2(lw, lh) * 0.7);
      w.num("grav", (P.n("gravity") / 100) * lh * 0.8).num("spin", deg2rad(P.n("spin"))).num("seed", std::floor(P.n("seed")));
      w.num("fade", tt < 0.6 ? 1 : jmax(0, 1 - (tt - 0.6) / 0.4));
      w.num("cols", std::ceil(lw / cell)).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  if (t == "twister") {
    const double tt = clamp01(P.n("completion") / 100);
    if (tt > 0) {
      FxWriter w("twister");
      w.num("t", tt).num("axisY", lh / 2 + P.n("centerY")).num("twist", deg2rad(P.n("twist"))).num("lw", lw).num("lh", lh);
      out.push_back(w.done());
    }
    return true;
  }
  return false;
}

constexpr std::array<std::string_view, 78> kHandled = {
    "deep-glow", "beam", "light-sweep", "lens-flare", "light-rays", "vignette", "black-and-white", "tritone",
    "photo-filter", "threshold", "vibrance", "mirror", "offset", "bulge", "twirl", "spherize", "kaleidoscope",
    "ripple", "chromatic-aberration", "magnify", "mosaic", "gaussian-blur", "fast-box-blur", "radial-blur",
    "corner-pin", "transform", "keylight", "linear-color-key", "luma-key", "color-key", "color-range", "extract",
    "spill-suppressor", "simple-choker", "matte-choker", "wave-warp", "directional-blur", "linear-wipe",
    "shift-channels", "alpha-levels", "solid-composite", "channel-combiner", "remove-color-matting",
    "change-color", "change-to-color", "leave-color", "toner", "venetian-blinds", "radial-wipe", "iris-wipe",
    "line-sweep", "channel-blur", "minimax", "unsharp-mask", "shadow-highlight", "checkerboard", "grid",
    "four-color-gradient", "circle", "ellipse", "polar-coordinates", "optics-compensation", "warp", "page-turn",
    "split", "slant", "smear", "rolling-shutter", "radial-shadow", "flo-motion", "lens", "griddler",
    "ball-action", "drizzle", "jaws", "pixel-polly", "twister"};

}  // namespace

bool spatial_a_handles(std::string_view type) { return std::ranges::find(kHandled, type) != kHandled.end(); }

bool spatial_a(const Json& e, const Json& params, const RLayer& layer, std::vector<api::RenderEffect>& out) {
  const Json& ty = e.at("type");
  if (!ty.is_string()) return false;
  const std::string_view t = ty.str();
  if (!spatial_a_handles(t)) return false;
  const Params P{params};
  if (lights_and_colour(t, P, layer, out)) return true;
  // `lw` / `lh`: the layer box, `Math.max(1, layer.width || 1)`.
  const double lw = jmax(1, js_or(layer.width, 1));
  const double lh = jmax(1, js_or(layer.height, 1));
  return warps(t, P, lw, lh, out) || keying(t, P, lw, lh, out) || round_nine(t, P, lw, lh, out) ||
         round_ten(t, P, lw, lh, out) || round_eleven_a(t, P, lw, lh, out) || round_eleven_b(t, P, lw, lh, out);
}

}  // namespace premation::scene
