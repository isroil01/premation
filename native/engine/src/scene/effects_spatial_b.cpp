// extractSpatialEffects (src/core/rendering/snapshotToFrameScene.ts), part B:
// every branch from 'card-dance' to the end of the function, except the eight
// kinds effects_port.cpp writes itself (fill, stroke, sharpen, noise, …), the
// JS plugin branch (decision G2) and 'apply-color-lut' (a parsed .cube LUT
// texture the scene builder does not produce). See effects_spatial.hpp.
//
// Each branch writes its chain entry in `effectToWire` form (FxWriter): fields
// in the TypeScript object's declaration order, `p` vec4 rows flattened.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <numbers>
#include <optional>
#include <set>
#include <string>

#include "effects_port.hpp"
#include "effects_spatial.hpp"
#include "jsmath.hpp"
#include "readers.hpp"
#include "scene_math.hpp"

namespace premation::scene {
namespace {

namespace mjs = motion::js;
constexpr double kPi = std::numbers::pi;

// ── JavaScript Math with its NaN / -0 semantics ─────────────────────────────

template <typename... T>
double jmax(T... v) {
  const std::array<double, sizeof...(T)> a{static_cast<double>(v)...};
  return mjs::max_of(a);
}
template <typename... T>
double jmin(T... v) {
  const std::array<double, sizeof...(T)> a{static_cast<double>(v)...};
  return mjs::min_of(a);
}
template <typename... T>
double jhypot(T... v) {
  const std::array<double, sizeof...(T)> a{static_cast<double>(v)...};
  return mjs::hypot(a);
}
/// `x || d` for a number.
double or_num(double x, double d) { return (x == 0 || std::isnan(x)) ? d : x; }

double clamp01(double v) { return jmax(0.0, jmin(1.0, v)); }
double rad(double deg) { return (deg * kPi) / 180; }
double box_sigma(double r) { return r > 0 ? std::sqrt((r * (r + 1)) / 3) : 0; }
double lin01(double c) { return c <= 0.04045 ? c / 12.92 : mjs::pow((c + 0.055) / 1.055, 2.4); }
double jround(double x) { return mjs::round(x); }

bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'; }
std::string_view trim(std::string_view t) {
  while (!t.empty() && is_ws(t.front())) t.remove_prefix(1);
  while (!t.empty() && is_ws(t.back())) t.remove_suffix(1);
  return t;
}
bool is_hex_digit(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return c - 'A' + 10;
}

/// `String(v)` of a param value (`effectParam` never yields undefined/null: `?? 0`).
std::string js_string(const Json& v) {
  if (v.is_string()) return v.str();
  if (v.is_undefined() || v.is_null()) return "0";
  return js::stringify(v);
}

/// canvas2dEffects.ts `parseHex`: #rrggbb / #rgb → bytes, else mid grey.
std::array<double, 3> parse_hex(std::string_view hex) {
  const std::string_view s = trim(hex);
  if (s.size() == 7 && s[0] == '#' && std::all_of(s.begin() + 1, s.end(), is_hex_digit)) {
    std::array<double, 3> o{};
    for (std::size_t i = 0; i < 3; ++i) o.at(i) = hex_val(s.at(1 + i * 2)) * 16 + hex_val(s.at(2 + i * 2));
    return o;
  }
  if (s.size() == 4 && s[0] == '#' && std::all_of(s.begin() + 1, s.end(), is_hex_digit)) {
    std::array<double, 3> o{};
    for (std::size_t i = 0; i < 3; ++i) o.at(i) = hex_val(s.at(1 + i)) * 17;
    return o;
  }
  return {128, 128, 128};
}

/// `withAlpha(hex, alpha)` then `Color.fromHex` (effects_port.cpp's reading).
Rgba color_with_alpha(const std::string& hex, double alpha) {
  const double a = jmax(0.0, jmin(1.0, alpha));
  const std::string_view t = trim(hex);
  if (!(t.size() == 7 && t[0] == '#' && std::all_of(t.begin() + 1, t.end(), is_hex_digit))) return color_from_hex(hex);
  Rgba c = color_from_hex(t);
  c.a = a;
  return c;
}

// ── beamPath.ts ─────────────────────────────────────────────────────────────

constexpr double kBeamPenUp = 1e9;
constexpr std::size_t kBeamMaxPoints = 64;

double mix(double a, double b, double t) { return a * (1 - t) + b * t; }

/// noiseHash.ts `hash01u` — uint32 wrapping arithmetic, as Math.imul + `>>> 0`.
double hash01u(double x, double y, double seed) {
  std::uint32_t n = mjs::to_uint32(x) * 374761393U + mjs::to_uint32(y) * 668265263U + mjs::to_uint32(seed) * 2147483647U;
  n = (n ^ (n >> 13U)) * 1274126177U;
  n = n ^ (n >> 16U);
  return static_cast<double>(n) / 4294967296.0;
}

double beam_flicker(double phase, double rate, double seed, double depth) {
  if (depth <= 0) return 1;
  const double x = phase * jmax(0.0, rate);
  const double i = std::floor(x);
  const double f = x - i;
  const double u = f * f * (3 - 2 * f);
  const double nn = mix(hash01u(i, 7, seed), hash01u(i + 1, 7, seed), u);
  return 1 - jmax(0.0, jmin(1.0, depth)) * nn;
}

double arc_length(const std::vector<double>& p) {
  double l = 0;
  for (std::size_t i = 2; i + 1 < p.size(); i += 2) l += hypot2(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return l;
}

std::vector<std::vector<double>> subpaths_of(const std::vector<double>& flat) {
  std::vector<std::vector<double>> out;
  std::vector<double> cur;
  for (std::size_t i = 0; i + 1 < flat.size(); i += 2) {
    const double x = flat[i];
    const double y = flat[i + 1];
    if (!std::isfinite(x) || !std::isfinite(y) || x >= kBeamPenUp) {
      if (cur.size() >= 4) out.push_back(cur);
      cur.clear();
      continue;
    }
    cur.push_back(x);
    cur.push_back(y);
  }
  if (cur.size() >= 4) out.push_back(cur);
  return out;
}

std::vector<double> resample(const std::vector<double>& p, double n) {
  // p is a flat [x, y, …] list (even length), so this is exact, as in the TS.
  const auto count = static_cast<double>(p.size()) / 2;
  if (n >= count) return p;
  const double total = arc_length(p);
  std::vector<double> out{p[0], p[1]};
  if (total <= 0) return out;
  std::size_t seg = 0;
  double segStart = 0;
  double segLen = hypot2(p[2] - p[0], p[3] - p[1]);
  for (double k = 1; k < n - 1; ++k) {
    const double target = (k / (n - 1)) * total;
    while (static_cast<double>(seg) < count - 2 && segStart + segLen < target) {
      segStart += segLen;
      ++seg;
      segLen = hypot2(p[seg * 2 + 2] - p[seg * 2], p[seg * 2 + 3] - p[seg * 2 + 1]);
    }
    const double t = segLen > 0 ? jmin(1.0, jmax(0.0, (target - segStart) / segLen)) : 0;
    out.push_back(mix(p[seg * 2], p[seg * 2 + 2], t));
    out.push_back(mix(p[seg * 2 + 1], p[seg * 2 + 3], t));
  }
  out.push_back(p[p.size() - 2]);
  out.push_back(p[p.size() - 1]);
  return out;
}

struct Spine {
  std::vector<double> points;
  double totalLen = 0;
};

Spine beam_spine(const std::vector<double>& flat) {
  const auto subs = subpaths_of(flat);
  Spine s;
  if (subs.empty()) return s;
  std::vector<double> lens;
  lens.reserve(subs.size());
  double total = 0;
  for (const auto& sp : subs) {
    lens.push_back(arc_length(sp));
    total += lens.back();
  }
  const auto nsubs = static_cast<double>(subs.size());
  const double budget = static_cast<double>(kBeamMaxPoints) - (nsubs - 1);
  double remaining = budget;
  for (std::size_t i = 0; i < subs.size(); ++i) {
    const double share = total > 0 ? jround((lens[i] / total) * budget) : std::floor(budget / nsubs);
    const double n = jmax(2.0, jmin(remaining - 2 * (nsubs - 1 - static_cast<double>(i)), share,
                                    static_cast<double>(subs[i].size()) / 2));
    remaining -= n;
    if (i > 0) {
      s.points.push_back(kBeamPenUp);
      s.points.push_back(0);
    }
    const auto r = resample(subs[i], n);
    s.points.insert(s.points.end(), r.begin(), r.end());
  }
  s.totalLen = total;
  return s;
}

double srgb_to_linear01(double c) { return c <= 0.04045 ? c / 12.92 : mjs::pow((c + 0.055) / 1.055, 2.4); }

/// beamPath.ts `hexLinear` (Number.parseInt(h.slice(0, 6), 16) semantics).
std::array<double, 3> hex_linear(const std::string& hex) {
  std::string h(trim(hex));
  if (!h.empty() && h.front() == '#') h.erase(0, 1);
  if (h.size() == 3) h = std::string{h[0], h[0], h[1], h[1], h[2], h[2]};
  std::string_view s = std::string_view(h).substr(0, 6);
  s = trim(s);
  double sign = 1;
  if (!s.empty() && (s.front() == '+' || s.front() == '-')) {
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
  std::array<double, 3> b{255, 255, 255};
  if (any) {
    // JS `(iv >> 16) & 255` on an int32: the 8-bit mask makes arithmetic and
    // logical shifts agree, so the uint32 view yields the same bytes.
    const auto iv = static_cast<std::uint32_t>(mjs::to_int32(sign * v));
    b = {static_cast<double>((iv >> 16U) & 255U), static_cast<double>((iv >> 8U) & 255U), static_cast<double>(iv & 255U)};
  }
  return {srgb_to_linear01(b[0] / 255), srgb_to_linear01(b[1] / 255), srgb_to_linear01(b[2] / 255)};
}

// ── colorEffects.ts COLORAMA_PALETTES ───────────────────────────────────────

struct Stop {
  double at;
  std::array<double, 3> rgb;
};
const std::vector<std::vector<Stop>>& colorama_palettes() {
  static const std::vector<std::vector<Stop>> k = {
      {{0, {0, 0, 0}}, {0.35, {200, 30, 0}}, {0.7, {255, 190, 0}}, {1, {255, 255, 230}}},
      {{0, {255, 0, 0}},
       {0.17, {255, 255, 0}},
       {0.33, {0, 255, 0}},
       {0.5, {0, 255, 255}},
       {0.67, {0, 0, 255}},
       {0.83, {255, 0, 255}},
       {1, {255, 0, 0}}},
      {{0, {0, 0, 0}}, {1, {255, 255, 255}}},
      {{0, {0, 4, 40}}, {0.5, {0, 140, 210}}, {1, {230, 250, 255}}},
      {{0, {0, 0, 0}}, {0.5, {255, 240, 180}}, {1, {0, 0, 0}}},
  };
  return k;
}

// ── the port ────────────────────────────────────────────────────────────────

const std::set<std::string, std::less<>>& handled() {
  static const std::set<std::string, std::less<>> k = {
      "card-dance", "unmult", "cc-composite", "cc-scatterize", "radial-fast-blur", "cross-blur", "scale-wipe",
      "plastic", "glass", "texturize", "threads", "hex-tile", "cc-tiler", "ripple-pulse", "radial-scale-wipe",
      "glass-wipe", "image-wipe", "color-difference-key", "wire-removal", "broadcast-colors", "noise-hls",
      "block-load", "kernel", "3d-glasses", "fractal", "particle-systems", "cc-bubbles", "vector-blur",
      "turbulent-displace", "curl-noise", "roughen-edges", "scatter", "colorama", "selective-color",
      "turbulent-noise", "add-grain", "median", "dust-scratches", "block-dissolve", "gradient-wipe", "card-wipe",
      "strobe-light", "burn-film", "light-wipe", "grid-wipe", "noise-alpha", "brush-strokes", "bilateral-blur",
      "smart-blur", "camera-lens-blur", "mesh-warp", "liquify", "bezier-warp", "cell-pattern", "radio-waves",
      "beam-path", "light-burst", "write-on", "star-burst", "snowfall", "rainfall", "cartoon", "inner-shadow",
      "inner-glow", "satin", "bevel", "equalize", "auto-levels", "auto-contrast", "auto-color", "find-edges",
      "emboss", "color-emboss", "halftone", "fractal-noise", "displacement-map", "compound-blur", "set-matte",
      "motion-tile", "bevel-alpha", "bevel-edges", "arithmetic", "sphere", "cylinder", "spotlight", "bend"};
  return k;
}

/// The per-effect readers the TypeScript closes over.
class Fx {
 public:
  Fx(const Json& e, const Json& params, const RLayer& layer)
      : lw_(jmax(1.0, or_num(layer.width, 1))), lh_(jmax(1.0, or_num(layer.height, 1))), e_(&e), params_(&params) {}

  [[nodiscard]] double lw() const noexcept { return lw_; }
  [[nodiscard]] double lh() const noexcept { return lh_; }

  /// `effectParam(e, k)` — the resolved param, `?? 0`.
  [[nodiscard]] Json raw(std::string_view k) const {
    const Json* v = params_->find(k);
    if (v == nullptr || v->is_undefined() || v->is_null()) return Json::number(0);
    return *v;
  }
  /// `effectNumber(e, k)`.
  [[nodiscard]] double n(std::string_view k) const {
    const Json* v = params_->find(k);
    return v != nullptr && v->is_number() ? v->num() : 0.0;
  }
  [[nodiscard]] bool is_true(std::string_view k) const {
    const Json v = raw(k);
    return v.is_bool() && v.b();
  }
  [[nodiscard]] bool is_false(std::string_view k) const {
    const Json v = raw(k);
    return v.is_bool() && !v.b();
  }
  /// `flag(k, d)` — effectParam is never undefined, so the default never applies.
  [[nodiscard]] double flag(std::string_view k) const { return is_true(k) ? 1 : 0; }
  /// `e.params?.[k] === true` (the stored params, not paramsOf).
  [[nodiscard]] bool stored_true(std::string_view k) const {
    const Json& v = e_->at("params").at(k);
    return v.is_bool() && v.b();
  }
  [[nodiscard]] bool stored_false(std::string_view k) const {
    const Json& v = e_->at("params").at(k);
    return v.is_bool() && !v.b();
  }
  /// `c(k, alpha)`.
  [[nodiscard]] Rgba c(std::string_view k, double alpha = 1) const { return color_with_alpha(js_string(raw(k)), alpha); }
  /// `unit3(k, d)` — parseHex of String(effectParam) / 255.
  [[nodiscard]] std::array<double, 3> unit3(std::string_view k) const {
    const auto c3 = parse_hex(js_string(raw(k)));
    return {c3[0] / 255, c3[1] / 255, c3[2] / 255};
  }
  [[nodiscard]] std::array<double, 3> lin3(std::string_view k) const {
    const auto u = unit3(k);
    return {lin01(u[0]), lin01(u[1]), lin01(u[2])};
  }
  /// A non-empty string param (a layer id), else nullopt.
  [[nodiscard]] std::optional<std::string> layer_id(std::string_view k) const {
    const Json v = raw(k);
    if (v.is_string() && !v.str().empty()) return v.str();
    return std::nullopt;
  }
  [[nodiscard]] double cx() const { return lw_ / 2 + n("centerX"); }
  [[nodiscard]] double cy() const { return lh_ / 2 + n("centerY"); }

 private:
  double lw_;
  double lh_;
  const Json* e_;
  const Json* params_;
};

using Rows = std::vector<double>;

api::RenderEffect pfx(std::string type, Rows p) { return FxWriter(std::move(type)).nums("p", std::move(p)).done(); }

void beam_path(const Fx& f, const Json& params, std::vector<api::RenderEffect>& out) {
  const double lw = f.lw();
  const double lh = f.lh();
  const double source = jround(f.n("source"));
  const Json& flat = params.at("pathPoints");
  std::vector<double> spineIn;
  if (source != 1 && flat.is_array() && flat.arr().size() >= 4) {
    for (const Json& v : flat.arr()) spineIn.push_back(v.is_number() ? v.num() : kBeamPenUp);
  } else {
    spineIn = {f.n("startX"), f.n("startY"), f.n("endX"), f.n("endY")};
  }
  Spine sp = beam_spine(spineIn);
  for (std::size_t i = 0; i + 1 < sp.points.size(); i += 2) {
    if (sp.points[i] >= kBeamPenUp) continue;
    sp.points[i] = sp.points[i] + lw / 2;
    sp.points[i + 1] = sp.points[i + 1] + lh / 2;
  }
  if (!(sp.points.size() >= 4 && sp.totalLen > 0)) return;
  const double start0 = clamp01(f.n("start") / 100);
  const double end0 = clamp01(f.n("end") / 100);
  const double coreWidth = jmax(0.0, f.n("coreWidth"));
  const double coreSoftness = clamp01(f.n("coreSoftness") / 100);
  const auto coreColor = hex_linear(js_string(f.raw("coreColor")));
  const auto glowColor = hex_linear(js_string(f.raw("glowColor")));
  const double glowSpread = jmax(0.5, f.n("glowSpread"));
  const double glowIntensity = jmax(0.0, f.n("glowIntensity") / 100);
  const double glowExponent = 1 + 3 * clamp01(f.n("glowBias") / 100);
  const double start = jmin(start0, end0);
  const double end = jmax(start0, end0);
  const double startSize = jmax(0.0, f.n("startSize") / 100);
  const double endSize = jmax(0.0, f.n("endSize") / 100);
  const double distortion = jmax(0.0, f.n("distortion"));
  const double distortionScale = jmax(4.0, f.n("distortionScale"));
  const double evolution = f.n("evolution");
  const double composite = jround(f.n("composite"));
  const double flicker =
      beam_flicker(f.n("flickerPhase"), f.n("flickerRate"), jround(f.n("seed")), clamp01(f.n("flicker") / 100));
  const std::size_t count = sp.points.size() / 2;
  Rows p = {lw,
            lh,
            static_cast<double>(count),
            sp.totalLen,
            coreWidth / 2,
            coreSoftness,
            glowSpread,
            glowIntensity * flicker,
            glowExponent,
            start,
            end,
            startSize,
            endSize,
            distortion,
            1 / distortionScale,
            evolution * 0.01,
            composite,
            0.75,
            flicker,
            0,
            coreColor[0],
            coreColor[1],
            coreColor[2],
            0,
            glowColor[0],
            glowColor[1],
            glowColor[2],
            0};
  for (std::size_t i = 0; i < kBeamMaxPoints; i += 2) {
    if (i < count) {
      p.push_back(sp.points[i * 2]);
      p.push_back(sp.points[i * 2 + 1]);
    } else {
      p.push_back(kBeamPenUp);
      p.push_back(0);
    }
    if (i + 1 < count) {
      p.push_back(sp.points[i * 2 + 2]);
      p.push_back(sp.points[i * 2 + 3]);
    } else {
      p.push_back(kBeamPenUp);
      p.push_back(0);
    }
  }
  const double spreadPx = coreWidth * jmax(startSize, endSize) + glowSpread * 10 + distortion;
  out.push_back(FxWriter("beam-path").nums("p", std::move(p)).num("spreadPx", spreadPx).done());
}

// The branches, split in three for readability (TS order is preserved inside each).

void round_eleven(const std::string& t, const Fx& f, std::vector<api::RenderEffect>& out) {
  const double lw = f.lw();
  const double lh = f.lh();
  const auto n = [&](std::string_view k) { return f.n(k); };
  if (t == "card-dance") {
    const double amt = clamp01(n("amount") / 100);
    if (amt > 0) {
      out.push_back(FxWriter("card-dance")
                        .num("rows", jmax(1.0, jround(n("rows"))))
                        .num("cols", jmax(1.0, jround(n("columns"))))
                        .num("amt", amt)
                        .num("rot", rad(n("cardRotation")))
                        .num("phase", n("phase"))
                        .num("maxOff", jmin(lw, lh) * 0.4)
                        .num("lw", lw)
                        .num("lh", lh)
                        .done());
    }
  }
  if (t == "unmult") {
    out.push_back(FxWriter("unmult")
                      .num("thresh", jmax(0.0, jmin(0.99, n("threshold") / 100)))
                      .num("boost", jmax(0.1, n("boost") / 100))
                      .done());
  }
  if (t == "cc-composite") {
    const double op = n("opacity");
    if (op > 0) {
      out.push_back(FxWriter("cc-composite")
                        .num("mix", clamp01(op / 100))
                        .num("mode", jmax(0.0, jmin(10.0, jround(n("blendMode")))))
                        .flag("rgbOnly", f.is_true("rgbOnly"))
                        .done());
    }
  }
  if (t == "cc-scatterize") {
    const double amount = n("amount");
    if (amount > 0.001) {
      out.push_back(FxWriter("cc-scatterize")
                        .num("amt", amount * 0.5)
                        .num("twist", rad(n("twist")))
                        .num("windX", n("windX"))
                        .num("windY", n("windY"))
                        .num("seed", std::floor(n("seed")))
                        .num("lw", lw)
                        .num("lh", lh)
                        .done());
    }
  }
  if (t == "radial-fast-blur") {
    const double amount = n("amount");
    if (amount > 0.01) {
      out.push_back(FxWriter("radial-fast-blur")
                        .num("cx", f.cx())
                        .num("cy", f.cy())
                        .num("amt", (amount / 100) * 0.8)
                        .num("mode", jmax(0.0, jmin(2.0, jround(n("zoomMode")))))
                        .num("lw", lw)
                        .num("lh", lh)
                        .done());
    }
  }
  if (t == "cross-blur") {
    const double rx = jmax(0.0, jround(n("radiusX")));
    const double ry = jmax(0.0, jround(n("radiusY")));
    if (rx > 0 || ry > 0) {
      out.push_back(FxWriter("cross-blur")
                        .num("rx", rx)
                        .num("ry", ry)
                        .flag("repeatEdge", f.is_true("repeatEdges"))
                        .num("lw", lw)
                        .num("lh", lh)
                        .done());
    }
  }
  if (t == "scale-wipe") {
    const double comp = clamp01(n("completion") / 100);
    if (comp > 0.001) {
      const double a = rad(n("direction"));
      const double maxDist = hypot2(lw, lh);
      out.push_back(FxWriter("scale-wipe")
                        .num("cx", f.cx())
                        .num("cy", f.cy())
                        .num("ux", mjs::cos(a))
                        .num("uy", mjs::sin(a))
                        .num("wipeEdge", comp * maxDist)
                        .num("stretch", n("stretch"))
                        .num("maxDist", maxDist)
                        .num("lw", lw)
                        .num("lh", lh)
                        .done());
    }
  }
  if (t == "plastic") {
    const double la = rad(n("lightAngle"));
    const double lx = mjs::cos(la);
    const double ly = -mjs::sin(la);
    const double lz = 0.8;
    const double len = or_num(jhypot(lx, ly, lz), 1);
    out.push_back(FxWriter("plastic")
                      .num("bump", (n("surfaceBump") / 100) * 8)
                      .num("gain", n("lightIntensity") / 100)
                      .nums("l", {lx / len, ly / len, lz / len})
                      .num("specGain", (n("specular") / 100) * 1.5)
                      .num("sigmaPx", box_sigma(jmax(0.0, jround(n("softness")))))
                      .num("lw", lw)
                      .num("lh", lh)
                      .done());
  }
  if (t == "glass") {
    const double la = rad(n("lightAngle"));
    const double hgt = n("height") / 100;
    out.push_back(FxWriter("glass")
                      .num("dispK", hgt * n("displacement"))
                      .num("hgt", hgt)
                      .num("lx", mjs::cos(la))
                      .num("ly", -mjs::sin(la))
                      .num("gain", n("lightIntensity") / 100)
                      .num("shine", clamp01(n("shininess") / 100))
                      .num("sigmaPx", box_sigma(jmax(0.0, jround(n("bumpSoftness")))))
                      .num("lw", lw)
                      .num("lh", lh)
                      .done());
  }
  if (t == "texturize") {
    const double gain = n("contrast") / 100;
    if (gain > 0) {
      const double la = rad(n("lightAngle"));
      out.push_back(FxWriter("texturize")
                        .num("pattern", jround(n("pattern")))
                        .num("gain", gain)
                        .num("lx", mjs::cos(la))
                        .num("ly", -mjs::sin(la))
                        .num("s", 100 / jmax(10.0, n("scale")))
                        .num("lw", lw)
                        .num("lh", lh)
                        .done());
    }
  }
  if (t == "threads") {
    const double th = jmax(2.0, jround(n("thickness")));
    out.push_back(FxWriter("threads")
                      .num("th", th)
                      .num("period", th + jmax(0.0, jround(n("spacing"))))
                      .num("dk", clamp01(n("depth") / 100))
                      .num("lw", lw)
                      .num("lh", lh)
                      .done());
  }
  if (t == "hex-tile") {
    out.push_back(FxWriter("hex-tile")
                      .num("R", jmax(2.0, n("radius")))
                      .num("bd", clamp01(n("border") / 100))
                      .num("lw", lw)
                      .num("lh", lh)
                      .done());
  }
  // Round seven: `p` vec4 rows (fxRoundFifteen.ts).
  if (t == "cc-tiler") {
    const double scale = n("scale");
    if (scale < 100 || n("centerX") != 0 || n("centerY") != 0) {
      out.push_back(pfx("cc-tiler", {lw, lh, jmax(0.01, scale / 100), clamp01(n("blendWithOriginal") / 100),  //
                                     f.cx(), f.cy(), 0, 0}));
    }
  }
  if (t == "ripple-pulse") {
    const double amplitude = n("amplitude");
    if (amplitude != 0) {
      out.push_back(pfx("ripple-pulse", {lw, lh, f.cx(), f.cy(),  //
                                         n("pulseRadius"), amplitude, jmax(1.0, n("width")), f.is_false("renderBump") ? 0.0 : 1.0}));
    }
  }
  if (t == "radial-scale-wipe") {
    const double tt = clamp01(n("completion") / 100);
    if (tt > 0) {
      const bool reverse = f.is_true("reverse");
      const double k = tt >= 1 ? 0 : (reverse ? 1 - tt : 1 / (1 - tt));
      out.push_back(pfx("radial-scale-wipe", {lw, lh, f.cx(), f.cy(), k, 1 - tt, 0, 0}));
    }
  }
  if (t == "glass-wipe") {
    const double tt = clamp01(n("completion") / 100);
    if (tt > 0) {
      out.push_back(pfx("glass-wipe", {lw, lh, tt, jmax(0.02, clamp01(n("softness") / 100)), n("displacement"), 0, 0, 0}));
    }
  }
  if (t == "image-wipe") {
    const double tt = clamp01(n("completion") / 100);
    if (tt > 0) {
      const double band = jmax(0.001, clamp01(n("borderSoftness") / 100));
      out.push_back(pfx("image-wipe", {lw, lh, tt * (1 + 2 * band) - band, band,  //
                                       jmax(0.0, jmin(4.0, jround(n("gradientChannel")))),
                                       f.is_true("invertGradient") ? 1.0 : 0.0, 0, 0}));
    }
  }
  if (t == "color-difference-key") {
    const Rgba key = f.c("keyColor");
    const double len = or_num(jhypot(key.r, key.g, key.b), 1);
    const double keyIdx = key.r >= key.g && key.r >= key.b ? 0 : key.g >= key.b ? 1 : 2;
    const double black = clamp01(n("matteInBlack") / 255);
    const double white = clamp01(n("matteInWhite") / 255);
    out.push_back(pfx("color-difference-key", {key.r / len, key.g / len, key.b / len, keyIdx,  //
                                               black, 1 / jmax(0.0001, white - black), 1 / jmax(0.01, n("matteGamma")),
                                               jround(n("viewMode"))}));
  }
  if (t == "wire-removal") {
    const double ax = lw / 2 + n("pointAX");
    const double ay = lh / 2 + n("pointAY");
    const double dx = (lw / 2 + n("pointBX")) - ax;
    const double dy = (lh / 2 + n("pointBY")) - ay;
    const double len = hypot2(dx, dy);
    const double thickness = n("thickness");
    if (len >= 0.0001 && thickness > 0) {
      const double half = thickness / 2;
      out.push_back(pfx("wire-removal", {lw, lh, ax, ay,                      //
                                         dx / len, dy / len, len, half,       //
                                         half + clamp01(n("slope") / 100) * thickness + 1, thickness, 0, 0}));
    }
  }
  if (t == "broadcast-colors") {
    const double pedestal = jround(n("standard")) == 0 ? 7.5 : 0;
    out.push_back(pfx("broadcast-colors", {pedestal, 100 - pedestal, jmax(90.0, jmin(120.0, n("maxSignalAmplitude"))),
                                           jround(n("howToMakeColorSafe"))}));
  }
  if (t == "noise-hls") {
    const double hue = clamp01(n("hue") / 100);
    const double lightness = clamp01(n("lightness") / 100);
    const double saturation = clamp01(n("saturation") / 100);
    if (hue > 0 || lightness > 0 || saturation > 0) {
      out.push_back(pfx("noise-hls", {lw, lh, jmax(0.5, n("grainSize")), std::floor(n("noisePhase")),  //
                                      hue, lightness, saturation, jround(n("noiseType"))}));
    }
  }
  if (t == "block-load") {
    const double completion = n("completion");
    if (completion < 100) {
      out.push_back(pfx("block-load", {lw, lh, clamp01(completion / 100), jmax(1.0, jmin(8.0, jround(n("scans")))),  //
                                       jmax(1.0, jround(n("blockSize"))), 0, 0, 0}));
    }
  }
  if (t == "kernel") {
    const std::array<double, 9> k = {n("k00"), n("k01"), n("k02"), n("k10"), n("k11"),
                                     n("k12"), n("k20"), n("k21"), n("k22")};
    const double divisor = n("divisor");
    const double offset = n("offset");
    bool isIdentity = divisor == 1 && offset == 0;
    for (std::size_t i = 0; isIdentity && i < 9; ++i) isIdentity = k.at(i) == (i == 4 ? 1.0 : 0.0);
    if (!isIdentity) {
      out.push_back(pfx("kernel", {k[0], k[1], k[2], k[3],  //
                                   k[4], k[5], k[6], k[7],  //
                                   k[8], std::abs(divisor) < 0.0001 ? 1 : divisor, offset / 255, 0,  //
                                   lw, lh, 0, 0}));
    }
  }
  if (t == "3d-glasses") {
    const double shift = f.is_true("swapLeftRight") ? -n("convergenceOffset") : n("convergenceOffset");
    out.push_back(pfx("3d-glasses", {lw, lh, shift, jround(n("view")), clamp01(n("balance") / 100), 0, 0, 0}));
  }
  if (t == "fractal") {
    const Rgba inside = f.c("insideColor");
    const double scale = 4 / (jmin(lw, lh) * jmax(0.1, n("magnification")));
    out.push_back(pfx("fractal", {lw, lh, jround(n("setType")), jmax(1.0, jmin(256.0, jround(n("iterations")))),  //
                                  n("centerX"), n("centerY"), scale, 0,                                          //
                                  n("juliaX"), n("juliaY"), n("colorPhase") / 360, jmax(0.1, n("colorCycles")),  //
                                  inside.r, inside.g, inside.b, 0}));
  }
  if (t == "particle-systems") {
    const double birthRate = n("birthRate");
    const double time = n("time");
    if (birthRate > 0 && time >= 0) {
      const double longevity = jmax(0.0001, n("longevity"));
      const double rate = jmax(0.0001, birthRate);
      const double first = jmax(0.0, std::floor((time - longevity) * rate) - 1);
      const double last = jmin(std::floor(time * rate) + 1, first + 511);
      const double animation = jround(n("animation"));
      const double direction = animation == 2 && n("direction") == 0 ? 270 : n("direction");
      const Rgba birth = f.c("birthColor");
      const Rgba death = f.c("deathColor");
      out.push_back(pfx("particle-systems",
                        {lw, lh, time, rate,                                                                         //
                         longevity, n("producerX"), n("producerY"), n("producerRadiusX"),                            //
                         n("producerRadiusY"), animation == 0 ? 0.0 : 1.0, rad(direction), rad(n("spread")),         //
                         n("velocity"), clamp01(n("velocityVariation") / 100), n("gravity"), n("resistance"),        //
                         n("birthSize"), n("deathSize"), clamp01(n("sizeVariation") / 100), clamp01(n("opacity") / 100),  //
                         birth.r, birth.g, birth.b, jround(n("blend")),                                              //
                         death.r, death.g, death.b, std::floor(n("seed")),                                           //
                         first, last, 0, 0}));
    }
  }
  if (t == "cc-bubbles") {
    const double count = jmax(0.0, jround(n("bubbleAmount")));
    const double opacity = n("opacity");
    if (count > 0 && opacity > 0) {
      const double size = n("bubbleSize");
      const double cell = jmax(4.0, std::sqrt((lw * lh) / jmax(1.0, count)));
      const Rgba col = f.c("color");
      out.push_back(pfx("cc-bubbles",
                        {lw, lh, cell, jmax(1.0, std::ceil(lw / cell)),                                              //
                         jmax(1.0, std::ceil(lh / cell)), count, n("bubbleSpeed"), n("wobbleAmplitude"),             //
                         n("wobbleFrequency"), size, clamp01(n("sizeVariation") / 100), jround(n("shading")),        //
                         col.r, col.g, col.b, clamp01(opacity / 100),                                                //
                         n("evolution"), std::floor(n("seed")), lh + size * 2, 0}));
    }
  }
  if (t == "vector-blur") {
    const double amount = n("amount");
    if (amount > 0) {
      const double K = jmax(2.0, jmin(24.0, jround(amount)));
      const double r = rad(n("angleOffset"));
      out.push_back(FxWriter("vector-blur")
                        .num("amount", amount)
                        .num("K", K)
                        .num("cosR", mjs::cos(r))
                        .num("sinR", mjs::sin(r))
                        .num("step", amount / K)
                        .num("sigmaPx", box_sigma(jmax(0.0, jround(n("smoothness")))))
                        .num("lw", lw)
                        .num("lh", lh)
                        .done());
    }
  }
}

double stride(double r) { return jmax(1.0, std::ceil(r / 6)); }

void round_twelve(const std::string& t, const Fx& f, const Json& params, std::vector<api::RenderEffect>& out) {
  const double lw = f.lw();
  const double lh = f.lh();
  const auto n = [&](std::string_view k) { return f.n(k); };
  if (t == "turbulent-displace" || t == "curl-noise") {
    const double amount = n("amount");
    if (amount != 0) {
      const double size = jmax(4.0, n("size"));
      const double oct = jmax(1.0, jmin(6.0, std::floor(n("complexity"))));
      const double k = t == "curl-noise" ? amount * size * 0.5 : amount;
      out.push_back(pfx(t, {lw, lh, k, 1 / size, n("evolution") * 0.01, oct, 0, 0}));
    }
  }
  if (t == "roughen-edges") {
    const double border = jmax(0.0, n("border"));
    if (border > 0) {
      out.push_back(pfx("roughen-edges", {lw, lh, border, 1 / jmax(1.0, (n("scale") / 100) * 20),  //
                                          n("evolution") / 60, n("seed"), jmax(1.0, jmin(6.0, jround(n("complexity")))),
                                          jmax(0.0, n("edgeSharpness"))}));
    }
  }
  if (t == "scatter") {
    const double amount = n("amount");
    if (amount > 0) out.push_back(pfx("scatter", {lw, lh, amount, n("grain"), n("seed"), n("evolution"), 0, 0}));
  }
  if (t == "colorama") {
    const auto& pals = colorama_palettes();
    double idx = jmax(0.0, jmin(static_cast<double>(pals.size() - 1), jround(n("palette"))));
    if (std::isnan(idx)) idx = 0;  // TS would throw; the first palette keeps the frame alive
    const auto& pal = pals.at(static_cast<std::size_t>(idx));
    Rows p;
    for (std::size_t i = 0; i < 7; ++i) {
      const Stop& st = pal.at(std::min(i, pal.size() - 1));
      p.insert(p.end(), {st.rgb[0] / 255, st.rgb[1] / 255, st.rgb[2] / 255, st.at});
    }
    p.insert(p.end(), {n("phaseShift") / 360, jmax(0.01, n("cycleRepetitions")),
                       jmax(0.0, jmin(100.0, n("blendWithOriginal"))) / 100, static_cast<double>(pal.size())});
    out.push_back(pfx("colorama", std::move(p)));
  }
  if (t == "selective-color") {
    const double cyan = n("cyan");
    const double magenta = n("magenta");
    const double yellow = n("yellow");
    const double black = n("black");
    if (cyan != 0 || magenta != 0 || yellow != 0 || black != 0) {
      out.push_back(pfx("selective-color", {jmax(0.0, jmin(8.0, jround(n("range")))), cyan / 100, magenta / 100, yellow / 100,
                                            black / 100, f.is_true("absolute") ? 0.0 : 1.0, 0, 0}));
    }
  }
  if (t == "turbulent-noise") {
    out.push_back(pfx("turbulent-noise", {lw, lh, jmax(1.0, n("scale")), jmax(1.0, jmin(8.0, jround(n("complexity")))),  //
                                          n("evolution"), n("contrast") / 100, n("brightness") / 100, f.flag("invert")}));
  }
  if (t == "add-grain") {
    const double intensity = n("intensity");
    if (intensity != 0) {
      out.push_back(pfx("add-grain", {lw, lh, intensity / 100, jmax(0.1, n("size")),  //
                                      clamp01(n("saturation") / 100), n("seed"), 0, 0}));
    }
  }
  if (t == "median") {
    const double r = jmax(0.0, jmin(8.0, jround(n("radius"))));
    if (r > 0) out.push_back(pfx("median", {lw, lh, r, 0, 0, 0, 0, 0}));
  }
  if (t == "dust-scratches") {
    out.push_back(pfx("dust-scratches", {lw, lh, jmax(1.0, jmin(8.0, jround(n("radius")))), 1,  //
                                         jmax(0.0, n("threshold")) / 255, 0, 0, 0}));
  }
  if (t == "block-dissolve") {
    const double completion = n("completion");
    if (completion > 0) {
      const double tt = clamp01(completion / 100);
      out.push_back(pfx("block-dissolve", {lw, lh, tt, jmax(1.0, jround(n("blockWidth"))),  //
                                           jmax(1.0, jround(n("blockHeight"))), tt >= 1 ? 0 : jmax(0.0, n("feather")),
                                           n("seed"), 0}));
    }
  }
  if (t == "gradient-wipe") {
    const double completion = n("completion");
    if (completion > 0) {
      out.push_back(pfx("gradient-wipe", {clamp01(completion / 100), jmax(0.0001, n("softness") / 100),
                                          f.flag("invertGradient"), 0}));
    }
  }
  if (t == "card-wipe") {
    const double completion = n("completion");
    if (completion > 0) {
      out.push_back(pfx("card-wipe", {lw, lh, clamp01(completion / 100), jmax(1.0, jround(n("rows"))),  //
                                      jmax(1.0, jround(n("columns"))), jmax(0.0, jmin(4.0, jround(n("flipOrder")))), 0, 0}));
    }
  }
  if (t == "strobe-light") {
    const double period = jmax(0.001, n("strobePeriod"));
    const double time = n("time");
    const double phase = std::fmod(std::fmod(time, period) + period, period) / period;
    const double k = clamp01(n("intensity") / 100);
    if (phase < clamp01(n("strobeDuty") / 100) && k > 0) {
      const auto col = f.unit3("strobeColor");
      out.push_back(pfx("strobe-light", {k, jround(n("strobeOperation")), 0, 0, col[0], col[1], col[2], 0}));
    }
  }
  if (t == "burn-film") {
    const double burn = n("burn");
    if (burn > 0) {
      const double tt = clamp01(burn / 100);
      const double cx = f.cx();
      const double cy = f.cy();
      const double maxR = or_num(hypot2(jmax(cx, lw - cx), jmax(cy, lh - cy)), 1);
      const auto bc = f.unit3("burnColor");
      const auto ch = f.unit3("charColor");
      out.push_back(pfx("burn-film", {lw, lh, tt, cx,                                                          //
                                      cy, maxR, tt * maxR * 1.15, clamp01(n("randomness") / 100),              //
                                      bc[0], bc[1], bc[2], jround(n("seed")),                                  //
                                      ch[0], ch[1], ch[2], 0}));
    }
  }
  if (t == "light-wipe") {
    const double completion = n("completion");
    if (completion > 0) {
      const double tt = clamp01(completion / 100);
      const bool radial = jround(n("wipeShape")) == 1;
      const double cx = f.cx();
      const double cy = f.cy();
      const double a = rad(n("angle"));
      const double nx = mjs::cos(a);
      const double ny = mjs::sin(a);
      const double span = radial ? or_num(hypot2(jmax(cx, lw - cx), jmax(cy, lh - cy)), 1)
                                 : std::abs(lw * nx) + std::abs(lh * ny);
      const double width = n("lightWidth");
      const auto col = f.unit3("lightColor");
      out.push_back(pfx("light-wipe", {lw, lh, radial ? 1.0 : 0.0, cx,  //
                                       cy, nx, ny, span,                //
                                       tt * (span + width), jmax(0.001, width), clamp01(n("intensity") / 100),
                                       jmax(0.001, n("feather")),  //
                                       col[0], col[1], col[2], 0}));
    }
  }
  if (t == "grid-wipe") {
    const double completion = n("completion");
    const double invert = f.flag("invertGrid");
    if (completion > 0 || invert > 0) {
      out.push_back(pfx("grid-wipe", {lw, lh, clamp01(completion / 100), jmax(1.0, jmin(256.0, jround(n("columns")))),  //
                                      jmax(1.0, jmin(256.0, jround(n("rows")))), jround(n("tileShape")),
                                      clamp01(n("randomSeed") / 100), jmax(0.001, n("feather") / 100),  //
                                      invert, 0, 0, 0}));
    }
  }
  if (t == "noise-alpha") {
    const double amount = n("amount");
    if (amount > 0) {
      out.push_back(pfx("noise-alpha", {lw, lh, clamp01(amount / 100), f.flag("uniformNoise"),  //
                                        jround(n("seed")), jround(n("noisePhase")), f.flag("clipResult"), 0}));
    }
  }
  if (t == "brush-strokes") {
    const double density = n("density");
    if (density > 0) {
      out.push_back(pfx("brush-strokes", {lw, lh, jmax(1.0, jmin(32.0, jround(n("strokeLength")))),
                                          jmax(1.0, jround(n("cellSize"))),  //
                                          clamp01(n("randomness") / 100) * kPi, clamp01(density / 100),
                                          rad(n("strokeAngle")), 0}));
    }
  }
  if (t == "bilateral-blur" || t == "smart-blur" || t == "camera-lens-blur") {
    const double r = jmax(0.0, jmin(24.0, jround(n("radius"))));
    if (n("radius") > 0 && r > 0) {
      if (t == "bilateral-blur") {
        const double ss = jmax(0.5, r / 2);
        const double sr = jmax(1.0, n("colorSigma"));
        out.push_back(pfx("bilateral-blur", {lw, lh, r, 1 / (2 * ss * ss),  //
                                             1 / (2 * sr * sr), f.flag("preserveAlpha"), stride(r), 0}));
      } else if (t == "smart-blur") {
        out.push_back(pfx("smart-blur", {lw, lh, r, jmax(0.0, n("threshold")), jround(n("mode")), stride(r), 0, 0}));
      } else {
        out.push_back(pfx("camera-lens-blur", {lw, lh, r, jround(n("blades")),  //
                                               rad(n("irisRotation")), jmax(1.0, n("gain")),
                                               clamp01(n("highlightThreshold") / 100), stride(r)}));
      }
    }
  }
  if (t == "mesh-warp") {
    Rows offs;
    offs.reserve(32);
    for (int i = 0; i < 16; ++i) {
      offs.push_back(n("v" + std::to_string(i) + "X"));
      offs.push_back(n("v" + std::to_string(i) + "Y"));
    }
    if (std::ranges::any_of(offs, [](double v) { return v != 0; })) {
      Rows p = {lw, lh, 0, 0};
      p.insert(p.end(), offs.begin(), offs.end());
      out.push_back(pfx("mesh-warp", std::move(p)));
    }
  }
  if (t == "liquify") {
    const double radius = n("brushSize");
    const double pushX = n("pushX");
    const double pushY = n("pushY");
    const double twirl = rad(n("twirl"));
    const double pinch = n("pinch") / 100;
    if (radius > 0 && (pushX != 0 || pushY != 0 || twirl != 0 || pinch != 0)) {
      out.push_back(pfx("liquify", {lw, lh, f.cx(), f.cy(), radius, pushX, pushY, twirl, pinch, 0, 0, 0}));
    }
  }
  if (t == "bezier-warp") {
    const std::array<std::array<double, 2>, 12> rest = {{{0, 0},
                                                         {lw / 3, 0},
                                                         {(2 * lw) / 3, 0},
                                                         {lw, 0},
                                                         {lw, lh / 3},
                                                         {lw, (2 * lh) / 3},
                                                         {lw, lh},
                                                         {(2 * lw) / 3, lh},
                                                         {lw / 3, lh},
                                                         {0, lh},
                                                         {0, (2 * lh) / 3},
                                                         {0, lh / 3}}};
    static constexpr std::array<std::string_view, 12> keys = {"topLeft",     "top1",    "top2",    "topRight",
                                                              "right1",      "right2",  "bottomRight", "bottom1",
                                                              "bottom2",     "bottomLeft", "left1", "left2"};
    Rows pts;
    bool isRest = true;
    for (std::size_t i = 0; i < 12; ++i) {
      const std::string k(keys.at(i));
      const double x = rest.at(i)[0] + n(k + "X");
      const double y = rest.at(i)[1] + n(k + "Y");
      if (!(x == rest.at(i)[0] && y == rest.at(i)[1])) isRest = false;
      pts.push_back(x);
      pts.push_back(y);
    }
    if (!isRest) {
      Rows p = {lw, lh, 0, 0};
      p.insert(p.end(), pts.begin(), pts.end());
      out.push_back(pfx("bezier-warp", std::move(p)));
    }
  }
  if (t == "cell-pattern") {
    out.push_back(pfx("cell-pattern", {lw, lh, jmax(2.0, n("size")), jmax(0.01, n("contrast") / 100),  //
                                       n("evolution"), f.flag("invert"), f.flag("membrane"), 0}));
  }
  if (t == "radio-waves") {
    const double a = clamp01(n("opacity") / 100);
    if (a > 0) {
      const double maxRadius = n("maxRadius");
      const auto col = f.lin3("color");
      out.push_back(pfx("radio-waves", {lw, lh, f.cx(), f.cy(),  //
                                        jmax(1.0, jmin(64.0, jround(n("waveCount")))),
                                        maxRadius > 0 ? maxRadius : hypot2(lw, lh) / 2, n("phase") / 360,
                                        jmax(0.5, n("thickness")),  //
                                        col[0], col[1], col[2], a,  //
                                        clamp01(n("fadeOut") / 100), jround(n("composite")), 0, 0}));
    }
  }
  if (t == "beam-path") beam_path(f, params, out);
  if (t == "light-burst") {
    const double gain = jmax(0.0, n("intensity") / 100);
    const double reach = clamp01(n("rayLength") / 100);
    if (n("intensity") > 0 && gain > 0 && reach > 0) {
      out.push_back(pfx("light-burst", {lw, lh, f.cx(), f.cy(), gain, reach, 0, 0}));
    }
  }
  if (t == "write-on") {
    const double t1 = clamp01(n("completion") / 100);
    const double sx = lw / 2 + n("startX");
    const double sy = lh / 2 + n("startY");
    const double dx = n("endX") - n("startX");
    const double dy = n("endY") - n("startY");
    const double len = hypot2(dx, dy);
    if (t1 > 0 && len >= 0.001) {
      const double radius = jmax(0.5, n("brushSize") / 2);
      const double taper = n("taper");
      const auto col = f.lin3("brushColor");
      out.push_back(pfx("write-on", {lw, lh, sx, sy,  //
                                     dx, dy, t1, (n("wobble") / 100) * len * 0.12,  //
                                     radius, jmax(0.000001, (taper / 100) * t1), taper > 0 ? 1.0 : 0.0,
                                     jmax(2.0, jmin(256.0, std::ceil((len * t1) / jmax(1.0, radius * 0.5)))),  //
                                     col[0], col[1], col[2], -dy / len,  //
                                     dx / len, 0, 0, 0}));
    }
  }
  if (t == "star-burst") {
    const auto col = f.unit3("starColor");
    out.push_back(pfx("star-burst", {lw, lh, jround(clamp01(n("amount") / 100) * 400), n("phase"),  //
                                     n("size"), clamp01(n("blend") / 100), std::floor(n("seed")), hypot2(lw / 2, lh / 2),
                                     col[0], col[1], col[2], 0}));
  }
  if (t == "snowfall") {
    const double amount = n("amount");
    if (amount > 0) {
      const double amt = jmax(0.01, clamp01(amount / 100));
      const double cell = jmax(12.0, std::sqrt(1200 / amt), lh / 64);
      const auto col = f.lin3("flakeColor");
      out.push_back(pfx("snowfall", {lw, lh, cell, n("size"),  //
                                     n("evolution"), n("wind"), clamp01(n("opacity") / 100), std::floor(n("seed")),
                                     col[0], col[1], col[2], std::ceil(lw / cell)}));
    }
  }
  if (t == "rainfall") {
    const double amount = n("amount");
    if (amount > 0) {
      const double amt = jmax(0.01, clamp01(amount / 100));
      const double len = jmax(2.0, n("length"));
      const double cell = jmax(16.0, std::sqrt(2500 / amt), lh / 64, lw / 64, len / 5);
      const double a = rad(n("angle"));
      const auto col = f.lin3("rainColor");
      out.push_back(pfx("rainfall", {lw, lh, cell, len,  //
                                     n("evolution"), clamp01(n("opacity") / 100), std::floor(n("seed")), mjs::sin(a),
                                     col[0], col[1], col[2], mjs::cos(a),  //
                                     std::ceil(lw / cell), std::ceil(lh / cell), 0, 0}));
    }
  }
}

void round_thirteen(const std::string& t, const Fx& f, std::vector<api::RenderEffect>& out) {
  const double lw = f.lw();
  const double lh = f.lh();
  const auto n = [&](std::string_view k) { return f.n(k); };
  if (t == "cartoon") {
    const double blurR = jmax(0.0, jmin(12.0, jround(n("smoothness"))));
    const double levels = jmax(2.0, jmin(64.0, jround(n("levels"))));
    out.push_back(FxWriter("cartoon")
                      .nums("p", {lw, lh, 255 / (levels - 1), jmax(0.0, n("edgeThreshold")),  //
                                  jmax(1.0, jround(n("edgeWidth"))), clamp01(n("edgeOpacity") / 100),
                                  blurR > 0 ? 1.0 : 0.0, 0})
                      .num("sigmaPx", box_sigma(blurR))
                      .done());
  }
  if (t == "inner-shadow" || t == "inner-glow") {
    const double opacity = clamp01(n("opacity") / 100);
    if (opacity > 0) {
      const bool glow = t == "inner-glow";
      const double size = jmax(0.0, glow ? n("size") : n("softness"));
      const double dist = glow ? 0 : jmax(0.0, n("distance"));
      const double a = rad(glow ? 0 : n("angle"));
      const auto col = f.unit3("color");
      out.push_back(FxWriter(t)
                        .nums("p", {mjs::cos(a) * dist, mjs::sin(a) * dist, opacity, glow ? 1.0 : 0.0,  //
                                    col[0], col[1], col[2], 0,                                          //
                                    lw, lh, 0, 0})
                        .num("sigmaPx", size)
                        .done());
    }
  }
  if (t == "satin") {
    const double opacity = clamp01(n("opacity") / 100);
    const double size = jmax(0.0, n("size"));
    const double dist = jmax(0.0, n("distance"));
    if (opacity > 0 && (size > 0 || dist > 0)) {
      const double a = rad(n("angle"));
      const auto col = f.unit3("color");
      out.push_back(FxWriter("satin")
                        .nums("p", {mjs::cos(a) * dist, mjs::sin(a) * dist, opacity, f.flag("invert"),  //
                                    col[0], col[1], col[2], 0,                                          //
                                    lw, lh, 0, 0})
                        .num("sigmaPx", size)
                        .done());
    }
  }
  if (t == "bevel") {
    const double size = jmax(1.0, n("size"));
    const double depth = jmax(0.0, n("depth")) / 100;
    const double hiOp = clamp01(n("highlightOpacity") / 100);
    const double loOp = clamp01(n("shadowOpacity") / 100);
    if (depth > 0 && (hiOp > 0 || loOp > 0)) {
      const Json dir = f.raw("direction");
      const bool down = dir.is_string() && dir.str() == "down";
      const double a = rad(n("angle") + (down ? 180 : 0));
      const double alt = rad(jmax(0.0, jmin(90.0, n("altitude"))));
      const auto hi = f.unit3("highlightColor");
      const auto lo = f.unit3("shadowColor");
      out.push_back(FxWriter("bevel")
                        .nums("p", {mjs::cos(a) * mjs::cos(alt), mjs::sin(a) * mjs::cos(alt), mjs::sin(alt), depth * 8,  //
                                    hi[0], hi[1], hi[2], hiOp,                                                         //
                                    lo[0], lo[1], lo[2], loOp,                                                         //
                                    lw, lh, 0, 0})
                        .num("sigmaPx", jmax(0.5, size))
                        .done());
    }
  }
  if (t == "equalize" || t == "auto-levels" || t == "auto-contrast" || t == "auto-color") {
    const double keep = clamp01(1 - n("blend") / 100);
    if (keep > 0 && (t != "equalize" || n("amount") > 0)) {
      const double lo = clamp01(n("blackClip") / 100);
      const double hi = 1 - clamp01(n("whiteClip") / 100);
      Rows p;
      if (t == "equalize") p = {jround(n("equalizeMode")) == 1 ? 1.0 : 0.0, clamp01(n("amount") / 100), 0, 0, keep, 0, 0, 0};
      else if (t == "auto-levels") p = {2, lo, hi, 0, keep, 0, 0, 0};
      else if (t == "auto-contrast") p = {3, lo, hi, 0, keep, 0, 0, 0};
      else p = {4, lo, hi, clamp01(n("snapNeutral") / 100), keep, 0, 0, 0};
      out.push_back(FxWriter(t).nums("p", std::move(p)).num("lw", lw).num("lh", lh).done());
    }
  }
  if (t == "find-edges") {
    out.push_back(FxWriter("find-edges")
                      .flag("invert", !f.is_false("invert"))
                      .num("blend", jmax(0.0, jmin(1.0, n("blendWithOriginal") / 100)))
                      .num("lw", lw)
                      .num("lh", lh)
                      .done());
  }
  if (t == "emboss") {
    const double erad = (n("angle") * kPi) / 180;
    out.push_back(FxWriter("emboss")
                      .num("dx", mjs::cos(erad) * n("relief"))
                      .num("dy", mjs::sin(erad) * n("relief"))
                      .num("k", n("contrast") / 100)
                      .num("keep", jmax(0.0, jmin(1.0, n("blend") / 100)))
                      .num("lw", lw)
                      .num("lh", lh)
                      .done());
  }
  if (t == "color-emboss") {
    const double cerad = (n("direction") * kPi) / 180;
    out.push_back(FxWriter("color-emboss")
                      .num("ox", jround(mjs::cos(cerad) * jmax(1.0, n("relief"))))
                      .num("oy", jround(mjs::sin(cerad) * jmax(1.0, n("relief"))))
                      .num("k", jmax(0.0, n("contrast")) / 100)
                      .num("blend", jmax(0.0, jmin(1.0, 1 - n("blendWithOriginal") / 100)))
                      .num("lw", lw)
                      .num("lh", lh)
                      .done());
  }
  if (t == "halftone") {
    const double hrad = (n("screenAngle") * kPi) / 180;
    const auto ink = parse_hex(js_string(f.raw("inkColor")));
    const auto paper = parse_hex(js_string(f.raw("paperColor")));
    out.push_back(FxWriter("halftone")
                      .num("cell", jmax(2.0, jround(n("cellSize"))))
                      .num("ca", mjs::cos(hrad))
                      .num("sa", mjs::sin(hrad))
                      .num("k", jmax(0.01, n("contrast") / 100))
                      .num("inkR", ink[0] / 255)
                      .num("inkG", ink[1] / 255)
                      .num("inkB", ink[2] / 255)
                      .flag("colorize", f.is_true("colorize"))
                      .num("paperR", paper[0] / 255)
                      .num("paperG", paper[1] / 255)
                      .num("paperB", paper[2] / 255)
                      .num("blend", jmax(0.0, jmin(1.0, 1 - n("blendWithOriginal") / 100)))
                      .num("lw", lw)
                      .num("lh", lh)
                      .done());
  }
}

/// The branches outside the `{ lw, lh }` block (after it, before fill/stroke).
void outer(const std::string& t, const Fx& f, const RLayer& layer, std::vector<api::RenderEffect>& out) {
  const auto n = [&](std::string_view k) { return f.n(k); };
  const double w = jmax(1.0, or_num(layer.width, 1));
  const double h = jmax(1.0, or_num(layer.height, 1));
  if (t == "fractal-noise") out.push_back(FxWriter("fractal-noise").num("scale", n("scale")).done());
  if (t == "displacement-map") {
    FxWriter wr("displacement-map");
    wr.num("amount", n("amount"));
    if (const auto id = f.layer_id("mapLayerId")) wr.text("mapLayerId", *id);
    out.push_back(wr.done());
  }
  if (t == "compound-blur") {
    FxWriter wr("compound-blur");
    wr.num("maxRadiusPx", n("maxBlur"));
    wr.flag("invert", f.stored_true("invert"));
    if (const auto id = f.layer_id("blurLayerId")) wr.text("mapLayerId", *id);
    out.push_back(wr.done());
  }
  if (t == "set-matte") {
    FxWriter wr("set-matte");
    wr.flag("useLuminance", f.stored_true("useLuminance"));
    wr.flag("invert", f.stored_true("invert"));
    if (const auto id = f.layer_id("matteLayerId")) wr.text("matteLayerId", *id);
    out.push_back(wr.done());
  }
  if (t == "motion-tile") out.push_back(FxWriter("motion-tile").num("scale", n("scale")).done());
  if (t == "bevel-alpha" || t == "bevel-edges") {
    out.push_back(FxWriter(t)
                      .num("thickness", n("thickness") / jmin(w, h))
                      .num("lightRad", (n("lightAngle") * kPi) / 180)
                      .num("intensity", n("intensity") / 100)
                      .color("color", f.c("lightColor", 1))
                      .done());
  }
  if (t == "arithmetic") {
    out.push_back(FxWriter("arithmetic")
                      .num("operator", jround(n("operator")))
                      .num("r", n("red") / 255)
                      .num("g", n("green") / 255)
                      .num("b", n("blue") / 255)
                      .flag("clip", !f.stored_false("clip"))
                      .done());
  }
  if (t == "sphere") {
    out.push_back(FxWriter("sphere")
                      .num("radius", n("radius") / 100)
                      .num("rotXRad", (n("rotateX") * kPi) / 180)
                      .num("rotYRad", (n("rotateY") * kPi) / 180)
                      .num("rotZRad", (n("rotateZ") * kPi) / 180)
                      .num("shading", n("shading") / 100)
                      .num("aspect", w / h)
                      .color("color", f.c("lightColor", 1))
                      .done());
  }
  if (t == "cylinder") {
    out.push_back(FxWriter("cylinder")
                      .num("radius", n("radius") / 100)
                      .num("rotRad", (n("rotation") * kPi) / 180)
                      .num("shading", n("shading") / 100)
                      .color("color", f.c("lightColor", 1))
                      .done());
  }
  if (t == "spotlight") {
    const double aspect = w / h;
    const double fromX = ((w / 2 + n("fromX")) / w) * aspect;
    const double fromY = (0 + n("fromY")) / h;
    const double toX = ((w / 2 + n("toX")) / w) * aspect;
    const double toY = (h / 2 + n("toY")) / h;
    double ambientPct = n("ambient");
    if (ambientPct == 15 || ambientPct == 55) ambientPct = 100;
    double intensityPct = n("intensity");
    if (intensityPct == 150 && (n("ambient") == 15 || n("ambient") == 55)) intensityPct = 100;
    out.push_back(FxWriter("spotlight")
                      .num("fromX", fromX)
                      .num("fromY", fromY)
                      .num("toX", toX)
                      .num("toY", toY)
                      .num("coneHalfRad", (n("coneAngle") * kPi) / 360)
                      .num("softness", n("edgeSoftness") / 100)
                      .num("intensity", intensityPct / 100)
                      .num("ambient", ambientPct / 100)
                      .num("aspect", aspect)
                      .flag("lightOnly", jround(n("render")) == 1)
                      .num("reach", jmax(0.01, n("reach") / 100))
                      .color("color", f.c("lightColor", 1))
                      .done());
  }
  if (t == "bend") {
    const double aspect = w / h;
    const double topPxX = w / 2 + n("topX");
    const double topPxY = 0 + n("topY");
    const double basePxX = w / 2 + n("baseX");
    const double basePxY = h + n("baseY");
    out.push_back(FxWriter("bend")
                      .num("angleRad", (n("amount") * kPi) / 180)
                      .num("style", jround(n("style")))
                      .num("aspect", aspect)
                      .flag("holdOutside", jround(n("outside")) == 1)
                      .num("topX", (topPxX / w) * aspect)
                      .num("topY", topPxY / h)
                      .num("baseX", (basePxX / w) * aspect)
                      .num("baseY", basePxY / h)
                      .done());
  }
}

}  // namespace

bool spatial_b_handles(std::string_view type) { return handled().contains(type); }

bool spatial_b(const Json& e, const Json& params, const RLayer& layer, std::vector<api::RenderEffect>& out) {
  const std::string t = e.at("type").is_string() ? e.at("type").str() : std::string();
  if (!handled().contains(t)) return false;
  const Fx f(e, params, layer);
  round_eleven(t, f, out);
  round_twelve(t, f, params, out);
  round_thirteen(t, f, out);
  outer(t, f, layer, out);
  return true;
}

}  // namespace premation::scene
