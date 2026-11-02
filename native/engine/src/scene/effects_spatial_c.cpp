// extractSpatialEffects, part C: the sixty effects of docs/PROGRAM_PERFORMANCE.md
// E (2026-10-10) — After Effects' built-ins Premation lacked (Brightness &
// Contrast, Color Balance (HLS), Calculations, Set Channels, Blend, Difference
// Matte, Shatter, Caustics, Wave World, Basic 3D, ...) and the looks motion
// designers reach for in AE most (VHS, CRT, Pixel Sort, Long Shadow, Halation,
// Starglow, ...). Every one is a single GPU pass (shaders/wgsl/fx60-*.wgsl):
// the branch packs its controls into `p` (rows of four, the layer box last)
// and the chain draws it from p_table / field_table (+ a Gaussian copy of the
// layer at binding 3, `sigmaPx`) / map_table (+ another layer at binding 3,
// `mapLayerId`). `reachPx` tells the bounds code how far an effect draws past
// its input: 0 = per pixel, > 0 = that many layer px, absent = not measured.
// Lengths are layer px; colours are display (sRGB) 0..1 unless named `lin`.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <numbers>
#include <string>
#include <string_view>
#include <vector>

#include "effects_port.hpp"
#include "effects_spatial.hpp"

namespace premation::scene {
namespace {

using Out = std::vector<api::RenderEffect>;
using V3 = std::array<double, 3>;

constexpr double kPi = std::numbers::pi;

double jmax(double a, double b) { return a > b ? a : b; }
double clampd(double v, double lo, double hi) { return std::max(lo, std::min(hi, std::isfinite(v) ? v : lo)); }
double s2l(double c) { return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }

int hexv(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/// The effect's controls by key (`paramsOf(e)`: declared defaults under the stored values).
struct Params {
  const Json& p;
  [[nodiscard]] const Json& raw(std::string_view k) const {
    static const Json kUndef;
    const Json* v = p.find(k);
    return v != nullptr ? *v : kUndef;
  }
  [[nodiscard]] double n(std::string_view k) const {
    const Json& v = raw(k);
    return v.is_number() && std::isfinite(v.num()) ? v.num() : 0.0;
  }
  /// A percentage as a fraction.
  [[nodiscard]] double pct(std::string_view k) const { return n(k) / 100; }
  /// Degrees as radians.
  [[nodiscard]] double rad(std::string_view k) const { return n(k) * kPi / 180; }
  [[nodiscard]] bool on(std::string_view k) const {
    const Json& v = raw(k);
    return v.is_bool() && v.b();
  }
  /// An enum / count param, rounded.
  [[nodiscard]] double e(std::string_view k) const { return std::round(n(k)); }
  /// `#rrggbb` / `#rgb` as display 0..1 (mid-grey when unreadable).
  [[nodiscard]] V3 u3(std::string_view k) const {
    const Json& v = raw(k);
    if (!v.is_string()) return {0.5, 0.5, 0.5};
    std::string_view s = v.str();
    while (!s.empty() && s.front() == ' ') s.remove_prefix(1);
    if (s.empty() || s.front() != '#') return {0.5, 0.5, 0.5};
    s.remove_prefix(1);
    V3 out{0.5, 0.5, 0.5};
    if (s.size() >= 6) {
      for (std::size_t i = 0; i < 3; ++i) {
        const int a = hexv(s[i * 2]);
        const int b = hexv(s[(i * 2) + 1]);
        if (a < 0 || b < 0) return {0.5, 0.5, 0.5};
        out.at(i) = (a * 16 + b) / 255.0;
      }
    } else if (s.size() >= 3) {
      for (std::size_t i = 0; i < 3; ++i) {
        const int a = hexv(s[i]);
        if (a < 0) return {0.5, 0.5, 0.5};
        out.at(i) = (a * 17) / 255.0;
      }
    }
    return out;
  }
  /// The same, decoded to linear light.
  [[nodiscard]] V3 l3(std::string_view k) const {
    const V3 c = u3(k);
    return {s2l(c[0]), s2l(c[1]), s2l(c[2])};
  }
  /// A layer reference ('' = none).
  [[nodiscard]] std::string layer(std::string_view k) const {
    const Json& v = raw(k);
    return v.is_string() ? v.str() : std::string();
  }
};

void push3(std::vector<double>& p, const V3& v) { p.insert(p.end(), v.begin(), v.end()); }

/// A hash of (i, seed) to [0, 1) — the CPU twin of the shaders' `hcell` idea
/// (not bit-equal: the values only drive whole-layer motion here).
double hash1(double i, double seed) {
  std::uint64_t x = static_cast<std::uint64_t>(static_cast<std::int64_t>(std::floor(i))) * 0x9E3779B97F4A7C15ULL;
  x ^= static_cast<std::uint64_t>(static_cast<std::int64_t>(std::floor(seed))) * 0xC2B2AE3D27D4EB4FULL;
  x ^= x >> 31U;
  x *= 0xBF58476D1CE4E5B9ULL;
  x ^= x >> 27U;
  x *= 0x94D049BB133111EBULL;
  x ^= x >> 31U;
  return static_cast<double>(x >> 11U) / 9007199254740992.0;
}

/// Smooth 1-D value noise in [-1, 1].
double noise1(double x, double seed) {
  const double i = std::floor(x);
  const double f = x - i;
  const double u = f * f * (3 - 2 * f);
  return (hash1(i, seed) * (1 - u) + hash1(i + 1, seed) * u) * 2 - 1;
}

/// Octave sum of noise1, [-1, 1]; `rough` 0..1 weights the upper octaves.
double fbm1(double x, double seed, int octaves, double rough) {
  double sum = 0;
  double amp = 1;
  double norm = 0;
  for (int o = 0; o < octaves; ++o) {
    sum += amp * noise1(x * std::pow(2.0, o), seed + o * 31.0);
    norm += amp;
    amp *= rough;
  }
  return norm > 0 ? sum / norm : 0;
}

/// Camera Shake at layer time `t`: offset x, y (px), rotation (rad), scale.
std::array<double, 4> shake_at(const Params& P, double t) {
  const double f = jmax(0.01, P.n("frequency"));
  const double seed = P.e("seed");
  const int oct = static_cast<int>(clampd(P.e("octaves"), 1, 4));
  const double rough = clampd(P.pct("roughness"), 0, 1);
  const double amp = jmax(0, P.n("amount"));
  const double x = fbm1(t * f, seed, oct, rough) * amp;
  const double y = fbm1(t * f, seed + 101, oct, rough) * amp;
  const double r = fbm1(t * f, seed + 211, oct, rough) * P.rad("rotation");
  const double z = 1 + fbm1(t * f, seed + 307, oct, rough) * clampd(P.pct("zoom"), 0, 0.5);
  return {x, y, r, z};
}

constexpr auto kHandled = std::to_array<std::string_view>({
    // fx60:b4:begin
    "brightness-contrast",
    "color-balance-hls",
    "calculations",
    "set-channels",
    "blend",
    "difference-matte",
    "color-neutralizer",
    "blobbylize",
    "cc-split-2",
    "eyedropper-fill",
    "noise-hls-auto",
    "caustics",
    "shatter",
    "wave-world",
    "warpomatic",
    "overbrights",
    "hdr-compander",
    "hdr-highlight-compression",
    "reduce-interlace-flicker",
    "basic-3d",
    "digital-glitch",
    "vr-rotate-sphere",
    "color-gradients",
    "vhs",
    "crt",
    "pixel-sort",
    "long-shadow",
    "halation",
    "light-leaks",
    "tilt-shift",
    "gradient-map",
    "duotone",
    "soft-glow",
    "neon",
    "hologram",
    "dither",
    "ascii",
    "led-screen",
    "pencil-sketch",
    "oil-paint",
    "camera-shake",
    "flicker",
    "prism",
    "frosted-glass",
    "bleach-bypass",
    "cross-process",
    "split-toning",
    "old-film",
    "anamorphic-streaks",
    "starglow",
    "sparkle",
    "white-balance",
    "clarity",
    "lens-distortion",
    "heat-haze",
    "color-halftone",
    "crystallize",
    "fog",
    "chrome",
    "night-vision",
    // fx60:b4:end
    // Camera program D1: depth for compositing (scene depth at binding 3).
    "depth-matte",
    "depth-fog",
    "depth-extract",
});

bool pack(std::string_view t, const Params& P, double lw, double lh, Out& out) {
  // Camera program D1: the scene-depth effects. Depths are comp px along the
  // active camera's view; the chain binds the composition's scene depth
  // (render_graph/scene_depth.cpp) at binding 3 — `readsDepth`.
  if (t == "depth-matte") {
    FxWriter w("depth-matte");
    const double nearZ = jmax(0, P.n("near"));
    std::vector<double> p{nearZ, jmax(nearZ, P.n("far")), jmax(0, P.n("feather")), P.on("invert") ? 1.0 : 0.0, lw, lh, 0, 0};
    w.nums("p", std::move(p));
    w.flag("readsDepth", true);
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "depth-fog") {
    FxWriter w("depth-fog");
    const V3 c = P.u3("color");
    const V3 c2 = P.u3("farColor");
    const double start = jmax(0, P.n("start"));
    std::vector<double> p{c[0], c[1], c[2], clampd(P.pct("density"), 0, 1),
                          start, jmax(start + 1, P.n("end")), P.on("gradient") ? 1.0 : 0.0, P.on("fogBackground") ? 1.0 : 0.0,
                          c2[0], c2[1], c2[2], 0,
                          lw, lh, 0, 0};
    w.nums("p", std::move(p));
    w.flag("readsDepth", true);
    out.push_back(w.done());
    return true;
  }
  if (t == "depth-extract") {
    FxWriter w("depth-extract");
    const double nearZ = jmax(0, P.n("near"));
    std::vector<double> p{nearZ, jmax(nearZ + 1, P.n("far")), P.on("invert") ? 1.0 : 0.0, 0, lw, lh, 0, 0};
    w.nums("p", std::move(p));
    w.flag("readsDepth", true);
    out.push_back(w.done());
    return true;
  }
  // fx60:b5:begin
  if (t == "brightness-contrast") {
    FxWriter w("brightness-contrast");
    std::vector<double> p;
    p.push_back(P.n("brightness") / 150);  // b
    p.push_back(P.n("contrast") / 100);  // c
    p.push_back(P.on("useLegacy") ? 1.0 : 0.0);  // legacy
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "color-balance-hls") {
    FxWriter w("color-balance-hls");
    std::vector<double> p;
    p.push_back(P.n("hue") / 360);  // h
    p.push_back(P.pct("lightness"));  // l
    p.push_back(P.pct("saturation"));  // s
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "calculations") {
    FxWriter w("calculations");
    std::vector<double> p;
    p.push_back(P.e("inputChannel"));  // inCh
    p.push_back(P.on("invertInput") ? 1.0 : 0.0);  // invIn
    p.push_back(P.e("secondChannel"));  // secCh
    p.push_back(clampd(P.pct("secondOpacity"), 0, 1));  // secOp
    p.push_back(P.on("invertSecond") ? 1.0 : 0.0);  // invSec
    p.push_back(P.e("blendingMode"));  // mode
    p.push_back(P.on("preserveTransparency") ? 1.0 : 0.0);  // keepA
    p.push_back(P.layer("secondLayer").empty() ? 0.0 : 1.0);  // hasMap
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    if (const std::string id = P.layer("secondLayer"); !id.empty()) w.text("mapLayerId", id);
    out.push_back(w.done());
    return true;
  }
  if (t == "set-channels") {
    FxWriter w("set-channels");
    std::vector<double> p;
    p.push_back(P.e("setRed"));  // r
    p.push_back(P.e("setGreen"));  // g
    p.push_back(P.e("setBlue"));  // b
    p.push_back(P.e("setAlpha"));  // a
    p.push_back(P.layer("sourceLayer").empty() ? 0.0 : 1.0);  // hasMap
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    if (const std::string id = P.layer("sourceLayer"); !id.empty()) w.text("mapLayerId", id);
    out.push_back(w.done());
    return true;
  }
  if (t == "blend") {
    FxWriter w("blend");
    std::vector<double> p;
    p.push_back(P.e("mode"));  // mode
    p.push_back(clampd(P.pct("blendWithOriginal"), 0, 1));  // keep
    p.push_back(P.layer("blendLayer").empty() ? 0.0 : 1.0);  // hasMap
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    if (const std::string id = P.layer("blendLayer"); !id.empty()) w.text("mapLayerId", id);
    out.push_back(w.done());
    return true;
  }
  if (t == "difference-matte") {
    FxWriter w("difference-matte");
    std::vector<double> p;
    p.push_back(P.e("view"));  // view
    p.push_back(clampd(P.pct("tolerance"), 0, 1));  // tol
    p.push_back(clampd(P.pct("softness"), 0, 1));  // soft
    p.push_back(P.layer("differenceLayer").empty() ? 0.0 : 1.0);  // hasMap
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    if (const std::string id = P.layer("differenceLayer"); !id.empty()) w.text("mapLayerId", id);
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "color-neutralizer") {
    FxWriter w("color-neutralizer");
    std::vector<double> p;
    push3(p, P.u3("shadowsUnbalance"));  // s
    push3(p, P.u3("midtonesUnbalance"));  // m
    push3(p, P.u3("highlightsUnbalance"));  // h
    p.push_back(clampd(P.pct("blend"), 0, 1));  // blend
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "blobbylize") {
    FxWriter w("blobbylize");
    std::vector<double> p;
    p.push_back(clampd(P.pct("cutAway"), 0, 0.98));  // cut
    p.push_back(P.pct("lightIntensity"));  // inten
    push3(p, P.l3("lightColor"));  // light
    p.push_back(std::sin(P.rad("lightDirection")));  // ldx
    p.push_back(-std::cos(P.rad("lightDirection")));  // ldy
    p.push_back(clampd(P.pct("ambient"), 0, 1));  // amb
    p.push_back(P.pct("specular"));  // spec
    p.push_back(jmax(0, P.n("softness")));  // soft
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("sigmaPx", jmax(0, P.n("softness") * 0.5));
    w.num("reachPx", P.n("softness") * 1.5);
    if (const std::string blob = P.layer("blobLayerId"); !blob.empty()) w.text("blobLayerId", blob);  // stream D L6
    out.push_back(w.done());
    return true;
  }
  if (t == "cc-split-2") {
    FxWriter w("cc-split-2");
    std::vector<double> p;
    p.push_back(lw / 2 + P.n("pointAX"));  // ax
    p.push_back(lh / 2 + P.n("pointAY"));  // ay
    p.push_back(lw / 2 + P.n("pointBX"));  // bx
    p.push_back(lh / 2 + P.n("pointBY"));  // by
    p.push_back(jmax(0, P.n("split1")));  // s1
    p.push_back(jmax(0, P.n("split2")));  // s2
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    out.push_back(w.done());
    return true;
  }
  if (t == "eyedropper-fill") {
    FxWriter w("eyedropper-fill");
    std::vector<double> p;
    p.push_back(lw / 2 + P.n("sampleX"));  // sx
    p.push_back(lh / 2 + P.n("sampleY"));  // sy
    p.push_back(jmax(0, P.n("sampleRadius")));  // r
    p.push_back(P.e("average"));  // avg
    p.push_back(P.on("maintainAlpha") ? 1.0 : 0.0);  // keepA
    p.push_back(clampd(P.pct("blend"), 0, 1));  // blend
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    out.push_back(w.done());
    return true;
  }
  if (t == "noise-hls-auto") {
    FxWriter w("noise-hls-auto");
    std::vector<double> p;
    p.push_back(P.e("noise"));  // kind
    p.push_back(P.pct("hue"));  // h
    p.push_back(P.pct("lightness"));  // l
    p.push_back(P.pct("saturation"));  // s
    p.push_back(jmax(1, P.n("grainSize")));  // size
    p.push_back(std::floor(P.n("time") * jmax(0, P.n("speed"))));  // k
    p.push_back(P.e("seed"));  // seed
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "caustics") {
    FxWriter w("caustics");
    std::vector<double> p;
    p.push_back(jmax(1, P.n("scale")));  // scale
    p.push_back(P.pct("distortion"));  // dist
    p.push_back(P.pct("intensity"));  // inten
    push3(p, P.l3("lightColor"));  // light
    p.push_back(P.pct("strength"));  // strength
    p.push_back(P.pct("ambient"));  // amb
    p.push_back(P.n("time") * P.n("speed"));  // t
    p.push_back(P.e("seed"));  // seed
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    // Stream D L6: row 3 = (bottom set, water set, water gain, 0); the chain
    // fills the first two once it knows which layers arrived.
    p.push_back(0);  // useBottom
    p.push_back(0);  // useWater
    p.push_back(jmax(0, P.pct("waterGain")));  // water gain
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    if (const std::string bottom = P.layer("bottomLayerId"); !bottom.empty()) w.text("bottomLayerId", bottom);
    if (const std::string water = P.layer("waterLayerId"); !water.empty()) w.text("waterLayerId", water);
    out.push_back(w.done());
    return true;
  }
  if (t == "shatter") {
    FxWriter w("shatter");
    std::vector<double> p;
    p.push_back(P.e("pattern"));  // shape
    p.push_back(jmax(4, P.n("pieceSize")));  // size
    p.push_back(lw / 2 + P.n("forceX"));  // fx
    p.push_back(lh / 2 + P.n("forceY"));  // fy
    p.push_back(jmax(1, P.n("forceRadius")));  // frad
    p.push_back(jmax(0, P.n("forceStrength")));  // fstr
    p.push_back(jmax(0, P.n("gravity")) * 120 * std::sin(P.rad("gravityDirection")));  // gx
    p.push_back(-jmax(0, P.n("gravity")) * 120 * std::cos(P.rad("gravityDirection")));  // gy
    p.push_back(jmax(0, P.n("rotationSpeed")));  // rot
    p.push_back(clampd(P.pct("randomness"), 0, 1));  // rnd
    p.push_back(jmax(0, P.n("time") - P.n("startTime")));  // el
    p.push_back(P.e("seed"));  // seed
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    out.push_back(w.done());
    return true;
  }
  if (t == "wave-world") {
    FxWriter w("wave-world");
    std::vector<double> p;
    p.push_back(P.e("view"));  // view
    p.push_back(lw / 2 + P.n("producer1X"));  // p1x
    p.push_back(lh / 2 + P.n("producer1Y"));  // p1y
    p.push_back(P.on("producer2") ? 1.0 : 0.0);  // p2on
    p.push_back(lw / 2 + P.n("producer2X"));  // p2x
    p.push_back(lh / 2 + P.n("producer2Y"));  // p2y
    p.push_back(jmax(0, P.n("speed")));  // speed
    p.push_back(jmax(4, P.n("wavelength")));  // wl
    p.push_back(clampd(P.pct("amplitude"), 0, 1));  // amp
    p.push_back(clampd(P.pct("damping"), 0, 1));  // damp
    p.push_back(jmax(0, P.n("time")));  // t
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    out.push_back(w.done());
    return true;
  }
  if (t == "warpomatic") {
    FxWriter w("warpomatic");
    std::vector<double> p;
    p.push_back(clampd(P.pct("completion"), 0, 1));  // comp
    p.push_back(P.n("warpAmount"));  // amt
    p.push_back(P.e("warpDirection"));  // dir
    p.push_back(clampd(P.pct("blendSpan"), 0, 1));  // span
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("sigmaPx", jmax(0, P.n("smoothness") * 0.5));
    out.push_back(w.done());
    return true;
  }
  if (t == "overbrights") {
    FxWriter w("overbrights");
    std::vector<double> p;
    p.push_back(P.e("channel"));  // ch
    p.push_back(P.e("show"));  // show
    push3(p, P.l3("clipColor"));  // col
    p.push_back(clampd(P.pct("dim"), 0, 1));  // dim
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "hdr-compander") {
    FxWriter w("hdr-compander");
    std::vector<double> p;
    p.push_back(P.e("mode"));  // mode
    p.push_back(jmax(0.0001, P.n("gain")));  // gain
    p.push_back(jmax(0.01, P.n("gamma")));  // gamma
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "hdr-highlight-compression") {
    FxWriter w("hdr-highlight-compression");
    std::vector<double> p;
    p.push_back(clampd(P.pct("amount"), 0, 1));  // amt
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "reduce-interlace-flicker") {
    FxWriter w("reduce-interlace-flicker");
    std::vector<double> p;
    p.push_back(jmax(0, P.n("softness")));  // soft
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", P.n("softness") * 2);
    out.push_back(w.done());
    return true;
  }
  if (t == "basic-3d") {
    FxWriter w("basic-3d");
    std::vector<double> p;
    p.push_back(P.rad("swivel"));  // sw
    p.push_back(P.rad("tilt"));  // tl
    p.push_back(P.n("distance"));  // dist
    p.push_back(P.on("specular") ? 1.0 : 0.0);  // spec
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    out.push_back(w.done());
    return true;
  }
  if (t == "digital-glitch") {
    FxWriter w("digital-glitch");
    std::vector<double> p;
    p.push_back(clampd(P.pct("amount"), 0, 1));  // amt
    p.push_back(jmax(2, P.n("blockSize")));  // block
    p.push_back(jmax(0, P.n("rgbSplit")));  // split
    p.push_back(clampd(P.pct("scanlines"), 0, 1));  // scan
    p.push_back(clampd(P.pct("noise"), 0, 1));  // noise
    p.push_back(clampd(P.pct("corruption"), 0, 1));  // corr
    p.push_back(std::floor(P.n("time") * jmax(0, P.n("speed"))));  // k
    p.push_back(P.e("seed"));  // seed
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    out.push_back(w.done());
    return true;
  }
  if (t == "vr-rotate-sphere") {
    FxWriter w("vr-rotate-sphere");
    std::vector<double> p;
    p.push_back(P.rad("tilt"));  // tx
    p.push_back(P.rad("pan"));  // ty
    p.push_back(P.rad("roll"));  // tz
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    out.push_back(w.done());
    return true;
  }
  if (t == "color-gradients") {
    FxWriter w("color-gradients");
    std::vector<double> p;
    p.push_back(clampd(P.e("points"), 2, 5));  // n
    p.push_back(jmax(0.1, P.n("falloff")));  // pw
    p.push_back(clampd(P.pct("blend"), 0, 1));  // blend
    p.push_back(lw / 2 + P.n("point1X"));  // x1
    p.push_back(lh / 2 + P.n("point1Y"));  // y1
    push3(p, P.u3("color1"));  // c1
    p.push_back(lw / 2 + P.n("point2X"));  // x2
    p.push_back(lh / 2 + P.n("point2Y"));  // y2
    push3(p, P.u3("color2"));  // c2
    p.push_back(lw / 2 + P.n("point3X"));  // x3
    p.push_back(lh / 2 + P.n("point3Y"));  // y3
    push3(p, P.u3("color3"));  // c3
    p.push_back(lw / 2 + P.n("point4X"));  // x4
    p.push_back(lh / 2 + P.n("point4Y"));  // y4
    push3(p, P.u3("color4"));  // c4
    p.push_back(lw / 2 + P.n("point5X"));  // x5
    p.push_back(lh / 2 + P.n("point5Y"));  // y5
    push3(p, P.u3("color5"));  // c5
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "vhs") {
    FxWriter w("vhs");
    std::vector<double> p;
    p.push_back(clampd(P.pct("amount"), 0, 1));  // amt
    p.push_back(jmax(0, P.n("chromaBleed")));  // bleed
    p.push_back(clampd(P.pct("tracking"), 0, 1));  // track
    p.push_back(jmax(0, P.n("jitter")));  // jit
    p.push_back(clampd(P.pct("noise"), 0, 1));  // noise
    p.push_back(clampd(P.pct("scanlines"), 0, 1));  // scan
    p.push_back(jmax(0, P.pct("saturation")));  // sat
    p.push_back(jmax(0.01, P.n("softness")));  // soft
    p.push_back(P.n("time"));  // t
    p.push_back(P.e("seed"));  // seed
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    out.push_back(w.done());
    return true;
  }
  if (t == "crt") {
    FxWriter w("crt");
    std::vector<double> p;
    p.push_back(clampd(P.pct("curvature"), 0, 1));  // curv
    p.push_back(clampd(P.pct("scanlines"), 0, 1));  // scan
    p.push_back(jmax(1, P.n("lineSize")));  // size
    p.push_back(P.e("mask"));  // mask
    p.push_back(clampd(P.pct("maskStrength"), 0, 1));  // maskS
    p.push_back(jmax(0, P.pct("glow")));  // glow
    p.push_back(clampd(P.pct("vignette"), 0, 1));  // vig
    p.push_back(jmax(0, P.pct("brightness")));  // bright
    p.push_back(P.n("convergence"));  // conv
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    out.push_back(w.done());
    return true;
  }
  if (t == "pixel-sort") {
    FxWriter w("pixel-sort");
    std::vector<double> p;
    p.push_back(std::cos(P.rad("direction")));  // dx
    p.push_back(std::sin(P.rad("direction")));  // dy
    p.push_back(clampd(P.pct("thresholdLow"), 0, 1));  // lo
    p.push_back(clampd(P.pct("thresholdHigh"), 0, 1));  // hi
    p.push_back(jmax(4, P.n("maxLength")));  // len
    p.push_back(P.e("order"));  // order
    p.push_back(P.e("sortBy"));  // by
    p.push_back(P.on("invertRange") ? 1.0 : 0.0);  // inv
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "long-shadow") {
    FxWriter w("long-shadow");
    std::vector<double> p;
    p.push_back(std::cos(P.rad("angle")));  // dx
    p.push_back(std::sin(P.rad("angle")));  // dy
    p.push_back(jmax(0, P.n("length")));  // len
    push3(p, P.l3("color"));  // col
    p.push_back(clampd(P.pct("shadowOpacity"), 0, 1));  // op
    p.push_back(clampd(P.pct("fade"), 0, 1));  // fade
    p.push_back(P.on("shadowOnly") ? 1.0 : 0.0);  // only
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", P.n("length"));
    out.push_back(w.done());
    return true;
  }
  if (t == "halation") {
    FxWriter w("halation");
    std::vector<double> p;
    p.push_back(s2l(clampd(P.pct("threshold"), 0, 0.99)));  // thr
    p.push_back(jmax(0, P.pct("amount")));  // amt
    push3(p, P.l3("tint"));  // tint
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("sigmaPx", jmax(0, P.n("radius") * 0.5));
    w.num("reachPx", P.n("radius") * 1.3);
    out.push_back(w.done());
    return true;
  }
  if (t == "light-leaks") {
    FxWriter w("light-leaks");
    std::vector<double> p;
    p.push_back(jmax(0, P.pct("intensity")));  // inten
    push3(p, P.u3("color1"));  // c1
    push3(p, P.u3("color2"));  // c2
    push3(p, P.u3("color3"));  // c3
    p.push_back(jmax(0.1, P.pct("scale")));  // scale
    p.push_back(P.e("mode"));  // mode
    p.push_back(P.n("time") * P.n("speed") * 0.15 + P.n("evolution") / 360);  // t
    p.push_back(P.e("seed"));  // seed
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", (P.e("mode") == 3 ? -1.0 : 0.0));
    out.push_back(w.done());
    return true;
  }
  if (t == "tilt-shift") {
    FxWriter w("tilt-shift");
    std::vector<double> p;
    p.push_back(lh / 2 + P.n("focusPosition"));  // cy
    p.push_back(-std::sin(P.rad("focusAngle")));  // nx
    p.push_back(std::cos(P.rad("focusAngle")));  // ny
    p.push_back(jmax(0, P.n("focusWidth")));  // w
    p.push_back(jmax(1, P.n("transition")));  // tr
    p.push_back(jmax(0, P.n("blurRadius")));  // r
    p.push_back(jmax(0, P.pct("saturation")));  // sat
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", P.n("blurRadius"));
    out.push_back(w.done());
    return true;
  }
  if (t == "gradient-map") {
    FxWriter w("gradient-map");
    std::vector<double> p;
    push3(p, P.u3("color1"));  // c1
    push3(p, P.u3("color2"));  // c2
    push3(p, P.u3("color3"));  // c3
    push3(p, P.u3("color4"));  // c4
    p.push_back(clampd(P.pct("position2"), 0, 1));  // p2
    p.push_back(clampd(P.pct("position3"), 0, 1));  // p3
    p.push_back(P.on("reverse") ? 1.0 : 0.0);  // rev
    p.push_back(clampd(P.pct("blend"), 0, 1));  // blend
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "duotone") {
    FxWriter w("duotone");
    std::vector<double> p;
    push3(p, P.u3("shadows"));  // s
    push3(p, P.u3("highlights"));  // h
    p.push_back(jmax(0, P.pct("contrast")));  // con
    p.push_back(clampd(P.pct("blend"), 0, 1));  // blend
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "soft-glow") {
    FxWriter w("soft-glow");
    std::vector<double> p;
    p.push_back(clampd(P.pct("amount"), 0, 2));  // amt
    p.push_back(P.pct("brightness"));  // bright
    p.push_back(jmax(0, P.pct("saturation")));  // sat
    p.push_back(P.e("mode"));  // mode
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("sigmaPx", jmax(0, P.n("radius") * 0.5));
    w.num("reachPx", P.n("radius") * 1.3);
    out.push_back(w.done());
    return true;
  }
  if (t == "neon") {
    FxWriter w("neon");
    std::vector<double> p;
    push3(p, P.l3("color"));  // col
    push3(p, P.l3("coreColor"));  // core
    p.push_back(jmax(0.5, P.n("tubeWidth")));  // w
    p.push_back(jmax(0, P.pct("intensity")));  // inten
    p.push_back(clampd(P.pct("fill"), 0, 1));  // fill
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("sigmaPx", jmax(0, P.n("glowRadius") * 0.5));
    w.num("reachPx", P.n("glowRadius") * 1.3 + P.n("tubeWidth"));
    out.push_back(w.done());
    return true;
  }
  if (t == "hologram") {
    FxWriter w("hologram");
    std::vector<double> p;
    push3(p, P.u3("color"));  // col
    p.push_back(clampd(P.pct("lines"), 0, 1));  // lines
    p.push_back(jmax(1, P.n("lineSize")));  // size
    p.push_back(clampd(P.pct("flicker"), 0, 1));  // flick
    p.push_back(clampd(P.pct("glitch"), 0, 1));  // glitch
    p.push_back(P.n("chromatic"));  // chroma
    p.push_back(clampd(P.pct("hologramOpacity"), 0, 1));  // op
    p.push_back(jmax(0, P.pct("edge")));  // edge
    p.push_back(P.n("time") * P.n("speed"));  // t
    p.push_back(P.e("seed"));  // seed
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    out.push_back(w.done());
    return true;
  }
  if (t == "dither") {
    FxWriter w("dither");
    std::vector<double> p;
    p.push_back(P.e("method"));  // method
    p.push_back(clampd(P.e("levels"), 2, 32));  // levels
    p.push_back(jmax(1, P.n("pixelSize")));  // size
    p.push_back(P.e("palette"));  // pal
    push3(p, P.u3("color1"));  // c1
    push3(p, P.u3("color2"));  // c2
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "ascii") {
    FxWriter w("ascii");
    std::vector<double> p;
    p.push_back(jmax(4, P.n("cellSize")));  // cell
    p.push_back(P.e("colorMode"));  // mode
    push3(p, P.u3("textColor"));  // text
    push3(p, P.u3("background"));  // bg
    p.push_back(clampd(P.pct("backgroundOpacity"), 0, 1));  // bgop
    p.push_back(jmax(0.1, P.pct("brightness")));  // bright
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    out.push_back(w.done());
    return true;
  }
  if (t == "led-screen") {
    FxWriter w("led-screen");
    std::vector<double> p;
    p.push_back(jmax(2, P.n("pitch")));  // pitch
    p.push_back(P.e("shape"));  // shape
    p.push_back(clampd(P.pct("gap"), 0, 0.9));  // gap
    p.push_back(jmax(0, P.pct("glow")));  // glow
    p.push_back(jmax(0, P.pct("brightness")));  // bright
    push3(p, P.u3("background"));  // bg
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    out.push_back(w.done());
    return true;
  }
  if (t == "pencil-sketch") {
    FxWriter w("pencil-sketch");
    std::vector<double> p;
    p.push_back(jmax(0, P.pct("edges")));  // edge
    p.push_back(clampd(P.pct("hatching"), 0, 1));  // hatch
    p.push_back(jmax(2, P.n("hatchSpacing")));  // sp
    push3(p, P.u3("paper"));  // paper
    push3(p, P.u3("pencil"));  // pencil
    p.push_back(clampd(P.pct("colorize"), 0, 1));  // colorize
    p.push_back(clampd(P.pct("blend"), 0, 1));  // blend
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "oil-paint") {
    FxWriter w("oil-paint");
    std::vector<double> p;
    p.push_back(jmax(1, P.n("brushSize")));  // r
    p.push_back(jmax(0, P.pct("saturation")));  // sat
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "camera-shake") {
    const double tt = P.n("time");
    const auto s1 = shake_at(P, tt);
    const auto s0 = shake_at(P, tt - clampd(P.pct("motionBlur"), 0, 1) / 30.0);
    double fill = 1;
    if (P.e("edges") == 3) {
      const double m = std::min(lw, lh);
      fill = 1 + (2.2 * jmax(0, P.n("amount"))) / m + std::abs(std::sin(P.rad("rotation"))) * std::max(lw, lh) / m;
    }
    FxWriter w("camera-shake");
    std::vector<double> p;
    p.push_back(s1[0]);  // ox
    p.push_back(s1[1]);  // oy
    p.push_back(s1[2]);  // r
    p.push_back(s1[3] * fill);  // z
    p.push_back(s0[0]);  // pox
    p.push_back(s0[1]);  // poy
    p.push_back(s0[2]);  // pr
    p.push_back(s0[3] * fill);  // pz
    p.push_back(P.pct("motionBlur") > 0 ? 1.0 : 0.0);  // blur
    p.push_back(P.e("edges"));  // edges
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", P.n("amount"));
    out.push_back(w.done());
    return true;
  }
  if (t == "flicker") {
    const double ft = P.n("time") * jmax(0.01, P.n("speed"));
    const double sm = clampd(P.pct("smoothness"), 0, 1);
    const double stepped = hash1(std::floor(ft), P.e("seed")) * 2 - 1;
    const double smooth = noise1(ft, P.e("seed") + 5);
    const double fl = clampd(1 - clampd(P.pct("amount"), 0, 1) * (0.5 + 0.5 * ((1 - sm) * stepped + sm * smooth)), 0, 1);
    FxWriter w("flicker");
    std::vector<double> p;
    p.push_back(P.e("mode"));  // mode
    p.push_back(fl);  // fl
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "prism") {
    FxWriter w("prism");
    std::vector<double> p;
    p.push_back(P.n("amount"));  // amt
    p.push_back(std::cos(P.rad("angle")));  // dx
    p.push_back(std::sin(P.rad("angle")));  // dy
    p.push_back(clampd(P.e("copies"), 2, 12));  // n
    p.push_back(P.e("mode"));  // radial
    p.push_back(lw / 2 + P.n("centerX"));  // cx
    p.push_back(lh / 2 + P.n("centerY"));  // cy
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", P.n("amount"));
    out.push_back(w.done());
    return true;
  }
  if (t == "frosted-glass") {
    FxWriter w("frosted-glass");
    std::vector<double> p;
    p.push_back(jmax(0, P.n("amount")));  // amt
    p.push_back(clampd(P.pct("smoothness"), 0, 1));  // sm
    p.push_back(P.e("seed"));  // seed
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    const bool fromBackdrop = P.e("source") == 1;  // stream D: frost the scene under the layer
    p.push_back(fromBackdrop ? 1 : 0);  // source
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", P.n("amount"));
    if (fromBackdrop) w.flag("readsBackdrop", true);
    out.push_back(w.done());
    return true;
  }
  if (t == "bleach-bypass") {
    FxWriter w("bleach-bypass");
    std::vector<double> p;
    p.push_back(clampd(P.pct("amount"), 0, 1));  // amt
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "cross-process") {
    FxWriter w("cross-process");
    std::vector<double> p;
    p.push_back(clampd(P.pct("amount"), 0, 1));  // amt
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "split-toning") {
    FxWriter w("split-toning");
    std::vector<double> p;
    p.push_back(P.n("highlightHue") / 360);  // hh
    p.push_back(clampd(P.pct("highlightSaturation"), 0, 1));  // hs
    p.push_back(P.n("shadowHue") / 360);  // sh
    p.push_back(clampd(P.pct("shadowSaturation"), 0, 1));  // ss
    p.push_back(P.pct("balance"));  // bal
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "old-film") {
    FxWriter w("old-film");
    std::vector<double> p;
    p.push_back(clampd(P.pct("sepia"), 0, 1));  // sepia
    p.push_back(clampd(P.pct("grain"), 0, 1));  // grain
    p.push_back(clampd(P.pct("scratches"), 0, 1));  // scr
    p.push_back(clampd(P.pct("dust"), 0, 1));  // dust
    p.push_back(clampd(P.pct("flicker"), 0, 1));  // flick
    p.push_back(jmax(0, P.n("weave")));  // weave
    p.push_back(clampd(P.pct("vignette"), 0, 1));  // vig
    p.push_back(std::floor(P.n("time") * jmax(1, P.n("fps"))));  // k
    p.push_back(P.e("seed"));  // seed
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    out.push_back(w.done());
    return true;
  }
  if (t == "anamorphic-streaks") {
    FxWriter w("anamorphic-streaks");
    std::vector<double> p;
    p.push_back(s2l(clampd(P.pct("threshold"), 0, 0.99)));  // thr
    p.push_back(jmax(0, P.n("length")));  // len
    p.push_back(jmax(0, P.pct("intensity")));  // inten
    push3(p, P.l3("tint"));  // tint
    p.push_back(std::cos(P.rad("angle")));  // dx
    p.push_back(std::sin(P.rad("angle")));  // dy
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", P.n("length"));
    out.push_back(w.done());
    return true;
  }
  if (t == "starglow") {
    FxWriter w("starglow");
    std::vector<double> p;
    p.push_back(s2l(clampd(P.pct("threshold"), 0, 0.99)));  // thr
    p.push_back(jmax(0, P.n("length")));  // len
    p.push_back(4 + 2 * clampd(P.e("points"), 0, 2));  // pts
    p.push_back(P.rad("angle"));  // ang
    p.push_back(jmax(0, P.pct("intensity")));  // inten
    p.push_back(P.e("colorMode"));  // mode
    push3(p, P.l3("tint"));  // tint
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", P.n("length"));
    out.push_back(w.done());
    return true;
  }
  if (t == "sparkle") {
    FxWriter w("sparkle");
    std::vector<double> p;
    p.push_back(clampd(P.pct("density"), 0, 1));  // dens
    p.push_back(jmax(1, P.n("size")));  // size
    p.push_back(clampd(P.pct("threshold"), 0, 1));  // thr
    p.push_back(jmax(0, P.pct("intensity")));  // inten
    push3(p, P.l3("color"));  // col
    p.push_back(P.on("sourceColor") ? 1.0 : 0.0);  // useSrc
    p.push_back(P.n("time") * P.n("speed"));  // t
    p.push_back(P.e("seed"));  // seed
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", P.n("size"));
    out.push_back(w.done());
    return true;
  }
  if (t == "white-balance") {
    FxWriter w("white-balance");
    std::vector<double> p;
    p.push_back(P.pct("temperature"));  // temp
    p.push_back(P.pct("tint"));  // tint
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "clarity") {
    FxWriter w("clarity");
    std::vector<double> p;
    p.push_back(P.pct("amount"));  // amt
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("sigmaPx", jmax(0, P.n("radius") * 0.5));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "lens-distortion") {
    FxWriter w("lens-distortion");
    std::vector<double> p;
    p.push_back(P.pct("curvature") * 0.6);  // k
    p.push_back(clampd(P.pct("chromatic"), 0, 1) * 0.06);  // ca
    p.push_back(clampd(P.pct("vignette"), 0, 1));  // vig
    p.push_back(P.on("fill") ? 1.0 : 0.0);  // fill
    p.push_back(lw / 2 + P.n("centerX"));  // cx
    p.push_back(lh / 2 + P.n("centerY"));  // cy
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    out.push_back(w.done());
    return true;
  }
  if (t == "heat-haze") {
    FxWriter w("heat-haze");
    std::vector<double> p;
    p.push_back(jmax(0, P.n("amount")));  // amt
    p.push_back(jmax(1, P.n("scale")));  // scale
    p.push_back(std::cos(P.rad("direction")) * P.n("time") * P.n("speed") * jmax(1, P.n("scale")) * 0.6);  // ox
    p.push_back(std::sin(P.rad("direction")) * P.n("time") * P.n("speed") * jmax(1, P.n("scale")) * 0.6);  // oy
    p.push_back(P.n("time") * P.n("speed"));  // t
    p.push_back(P.e("seed"));  // seed
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", P.n("amount"));
    out.push_back(w.done());
    return true;
  }
  if (t == "color-halftone") {
    FxWriter w("color-halftone");
    std::vector<double> p;
    p.push_back(jmax(2, P.n("radius") * 2));  // cell
    p.push_back(P.rad("angleC"));  // ac
    p.push_back(P.rad("angleM"));  // am
    p.push_back(P.rad("angleY"));  // ay
    p.push_back(P.rad("angleK"));  // ak
    push3(p, P.u3("paper"));  // paper
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "crystallize") {
    FxWriter w("crystallize");
    std::vector<double> p;
    p.push_back(jmax(2, P.n("cellSize")));  // size
    p.push_back(clampd(P.pct("borders"), 0, 1));  // border
    push3(p, P.u3("borderColor"));  // bcol
    p.push_back(P.e("seed"));  // seed
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "fog") {
    FxWriter w("fog");
    std::vector<double> p;
    p.push_back(clampd(P.pct("density"), 0, 1));  // dens
    push3(p, P.u3("color"));  // col
    p.push_back(jmax(1, P.n("scale")));  // scale
    p.push_back(std::cos(P.rad("direction")) * P.n("time") * P.n("speed") * jmax(1, P.n("scale")) * 0.15);  // ox
    p.push_back(std::sin(P.rad("direction")) * P.n("time") * P.n("speed") * jmax(1, P.n("scale")) * 0.15);  // oy
    p.push_back(P.n("time") * P.n("speed") * 0.2);  // t
    p.push_back(clampd(P.pct("falloff"), 0, 1));  // fall
    p.push_back(P.e("seed"));  // seed
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "chrome") {
    FxWriter w("chrome");
    std::vector<double> p;
    p.push_back(jmax(1, P.n("bands")));  // bands
    p.push_back(jmax(0, P.pct("depth")));  // depth
    push3(p, P.u3("tint"));  // tint
    p.push_back(jmax(0, P.pct("contrast")));  // con
    p.push_back(clampd(P.pct("blend"), 0, 1));  // blend
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    w.num("reachPx", 0);
    out.push_back(w.done());
    return true;
  }
  if (t == "night-vision") {
    FxWriter w("night-vision");
    std::vector<double> p;
    p.push_back(jmax(0, P.pct("gain")));  // gain
    p.push_back(clampd(P.pct("noise"), 0, 1));  // noise
    p.push_back(clampd(P.pct("scanlines"), 0, 1));  // scan
    p.push_back(clampd(P.pct("vignette"), 0, 1));  // vig
    push3(p, P.u3("color"));  // col
    p.push_back(P.e("mask"));  // mask
    p.push_back(std::floor(P.n("time") * 30));  // k
    p.push_back(P.e("seed"));  // seed
    p.push_back(lw);  // lw
    p.push_back(lh);  // lh
    while (p.size() % 4 != 0) p.push_back(0);
    w.nums("p", std::move(p));
    out.push_back(w.done());
    return true;
  }
  // fx60:b5:end
  return false;
}

}  // namespace

bool spatial_c_handles(std::string_view type) { return std::ranges::find(kHandled, type) != kHandled.end(); }

bool spatial_c(const Json& e, const Json& params, const RLayer& layer, Out& out) {
  const Json& ty = e.at("type");
  if (!ty.is_string()) return false;
  const std::string_view t = ty.str();
  if (!spatial_c_handles(t)) return false;
  const Params P{params};
  const double lw = jmax(1, layer.width > 0 ? layer.width : 1);
  const double lh = jmax(1, layer.height > 0 ? layer.height : 1);
  return pack(t, P, lw, lh, out);
}

}  // namespace premation::scene
