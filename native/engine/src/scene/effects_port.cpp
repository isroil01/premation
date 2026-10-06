#include "effects_port.hpp"
#include "stamp_field.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>
#include <optional>
#include <set>
#include <string>

#include "catalog_data.hpp"
#include "effects_spatial.hpp"
#include "frame_build.hpp"
#include "scene_native_fx.hpp"
#include "fxstate.hpp"
#include "jsmath.hpp"
#include "lut_port.hpp"
#include "scene_math.hpp"

namespace premation::scene {
namespace {

std::string type_of(const Json& e) { return e.at("type").is_string() ? e.at("type").str() : std::string(); }

/// Effects whose pixels are drawn by the TS Canvas2D painters (canvas2dEffects.ts CANVAS2D_ONLY):
/// they only exist inside a CPU bake.
bool is_canvas2d_only(std::string_view t) {
  static constexpr std::array<std::string_view, 9> k = {"vegas", "path-stroke", "scribble", "numbers", "timecode",
                                                        "audio-spectrum", "lightning", "plexus", "audio-waveform"};
  return std::ranges::find(k, t) != k.end();
}

/// colorLut.ts LUT_BUILDERS.
bool is_lut_effect(std::string_view t) {
  static constexpr std::array<std::string_view, 10> k = {"levels", "curves", "posterize", "exposure", "lumetri",
                                                         "color-balance", "gamma-pedestal-gain", "color-offset",
                                                         "threshold-rgb", "cineon-converter"};
  return std::ranges::find(k, t) != k.end();
}

/// effectBake.ts GPU_BLENDED_OPACITY.
bool gpu_blends_effect_opacity(std::string_view t) {
  static const std::set<std::string, std::less<>> k = {
      "blur", "glow", "drop-shadow", "inner-shadow", "inner-glow", "satin", "bevel", "deep-glow",
      "directional-blur", "gaussian-blur", "fast-box-blur", "radial-blur", "bilateral-blur", "smart-blur",
      "camera-lens-blur", "radial-fast-blur", "cross-blur", "vector-blur", "unsharp-mask", "sharpen",
      "mosaic", "find-edges", "roughen-edges", "bulge", "twirl", "spherize", "mirror", "offset", "emboss",
      "scatter", "ripple", "magnify", "warp", "smear", "rolling-shutter", "radial-shadow", "cartoon",
      "brush-strokes", "strobe-light", "color-emboss", "halftone", "kaleidoscope", "vignette", "glass",
      "texturize", "threads", "chromatic-aberration", "hex-tile", "flo-motion", "lens", "griddler",
      "ball-action", "drizzle", "card-dance", "plastic", "ripple-pulse", "3d-glasses", "fractal",
      "polar-coordinates", "wave-warp", "turbulent-displace", "curl-noise", "minimax",
      "vibrance", "colorama", "shadow-highlight", "photo-filter", "black-and-white", "tritone", "threshold",
      "equalize", "auto-levels", "auto-contrast", "auto-color", "change-color", "change-to-color",
      "leave-color", "toner", "broadcast-colors", "simple-choker", "linear-color-key", "shift-channels",
      "keylight", "luma-key", "color-key", "color-range", "extract", "spill-suppressor", "matte-choker",
      "alpha-levels", "solid-composite", "channel-combiner", "remove-color-matting", "unmult", "cc-composite",
      "color-difference-key", "wire-removal",
      "turbulent-noise", "add-grain", "median", "dust-scratches", "noise-alpha", "noise", "cell-pattern",
      "gradient-ramp", "fractal-noise", "checkerboard", "grid", "fill", "four-color-gradient", "stroke",
      "beam", "beam-path", "lens-flare", "circle", "ellipse", "radio-waves", "light-rays", "light-sweep",
      "star-burst", "snowfall", "rainfall", "write-on", "light-burst", "particle-systems", "cc-bubbles"};
  return k.contains(t) || is_native_effect(t);  // G1: the chain blends a native effect's opacity back
}

/// The chain entries this port writes (extract_spatial_effects below).
bool is_ported_spatial(std::string_view t) {
  static constexpr std::array<std::string_view, 8> k = {"blur", "glow", "drop-shadow", "gradient-ramp",
                                                        "fill", "stroke", "sharpen", "noise"};
  return std::ranges::find(k, t) != k.end();
}

/// effectColorMatrix.ts COLOR_MATRIX_BUILDERS keys.
bool is_color_effect(std::string_view t) {
  static constexpr std::array<std::string_view, 11> k = {"brightness", "contrast", "saturate", "grayscale", "sepia",
                                                         "hue-rotate", "hue-saturation", "invert", "tint",
                                                         "channel-mixer", "opacity"};
  // `opacity` is a CSS-only effect with no matrix; listed so it is not reported.
  return std::ranges::find(k, t) != k.end();
}

/// Effects whose GPU form is the identity (canvas2dEffects.ts: CC RepeTile's
/// CPU pass expands the buffer and crops it back, so there is nothing to draw
/// — the TS GPU path has no shader for it and draws the layer unchanged).
bool is_gpu_identity(std::string_view t) { return t == "cc-repetile"; }

bool is_temporal(std::string_view t) { return t == "echo" || t == "posterize-time" || t == "wide-time" || t == "force-motion-blur"; }

/// `withAlpha(hex, alpha)` then `Color.fromHex`.
Rgba color_with_alpha(const Json& v, double alpha) {
  const std::string hex = v.is_string() ? v.str() : v.is_undefined() || v.is_null() ? "0" : js::stringify(v);
  const double a = std::max(0.0, std::min(1.0, alpha));
  std::string_view t = hex;
  while (!t.empty() && (t.front() == ' ' || t.front() == '\t' || t.front() == '\n' || t.front() == '\r')) t.remove_prefix(1);
  while (!t.empty() && (t.back() == ' ' || t.back() == '\t' || t.back() == '\n' || t.back() == '\r')) t.remove_suffix(1);
  bool six = t.size() == 7 && t[0] == '#';
  for (std::size_t i = 1; six && i < t.size(); ++i) {
    const char c = t[i];
    six = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
  }
  if (!six) return color_from_hex(hex);
  Rgba c = color_from_hex(t);  // #rrggbb → the same channels rgba() would give
  c.a = a;
  return c;
}

const Json& param_of(const Json& params, std::string_view k) {
  static const Json kUndef;
  const Json* v = params.find(k);
  return v != nullptr ? *v : kUndef;
}

}  // namespace

bool effect_enabled(const Json& e) { return !(e.at("enabled").is_bool() && !e.at("enabled").b()); }

double effect_number(const Json& e, std::string_view key) {
  const Json p = doc::params_of(e);
  const Json& v = param_of(p, key);
  return v.is_number() ? v.num() : 0;
}

std::vector<Json> resolve_effect_params(const std::vector<Json>& effects, const Values& a, std::optional<double> layerTimeSec) {
  std::vector<Json> out;
  out.reserve(effects.size());
  for (const Json& e0 : effects) {
    Json e = e0;
    const std::string id = e.at("id").is_string() ? e.at("id").str() : "";
    if (const auto op = a.get("effect." + id + ".fx.opacity")) e.set("opacity", Json::number(std::max(0.0, std::min(100.0, *op))));
    const doc::EffectDef* def = doc::registry().effect(type_of(e));
    if (def == nullptr) {
      out.push_back(std::move(e));
      continue;
    }
    Json params = doc::params_of(e);
    bool touched = false;
    const std::string t = type_of(e);
    const char* timeParam = t == "timecode" || t == "strobe-light" || t == "particle-systems" ? "time" : nullptr;
    if (timeParam != nullptr && layerTimeSec) {
      const Json& follow = param_of(params, "followCompTime");
      if (!(follow.is_bool() && !follow.b())) {
        params.set(timeParam, Json::number(*layerTimeSec));
        touched = true;
      }
    }
    for (const auto& p : def->params) {
      if (p.type == "number") {
        if (const auto v = a.get("effect." + id + "." + p.key)) {
          params.set(p.key, Json::number(*v));
          touched = true;
        }
        continue;
      }
      if (p.type == "color") {
        const std::string base = "effect." + id + "." + p.key;
        const auto r = a.get(base + "_r");
        const auto g = a.get(base + "_g");
        const auto b = a.get(base + "_b");
        const auto al = a.get(base + "_a");
        if (r || g || b || al) {
          const Json& stored = param_of(params, p.key);
          const std::string hex = stored.is_string() ? stored.str()
                                  : p.def.is_string()  ? p.def.str()
                                                       : std::string("#ffffff");
          const auto ch = doc::parse_color_channels(hex);
          params.set(p.key, Json::string(doc::channels_to_color(r.value_or(ch[0]), g.value_or(ch[1]), b.value_or(ch[2]),
                                                                 al.value_or(ch[3]))));
          touched = true;
        }
      }
    }
    if (const doc::EffectParamDef* primary = def->primary(); primary != nullptr && !touched) {
      if (const auto legacy = a.get("effect." + id)) {
        params.set(primary->key, Json::number(*legacy));
        touched = true;
      }
    }
    if (touched) e.set("params", std::move(params));
    out.push_back(std::move(e));
  }
  return out;
}

bool is_gpu_only_effect(std::string_view type) {
  const doc::EffectDef* def = doc::registry().effect(type);
  return def != nullptr && def->gpuOnly;
}

bool effects_need_cpu_bake(const std::vector<Json>& effects) {
  return std::ranges::any_of(effects, [](const Json& e) {
    if (!effect_enabled(e)) return false;
    const std::string t = type_of(e);
    if (is_canvas2d_only(t)) return true;
    // AE parity 3.2: the refine-matte effects run in the CPU bake only (a guided filter over the whole layer).
    if (t == "refine-soft-matte" || t == "refine-hard-matte") return true;
    if (e.at("maskId").is_string() && !e.at("maskId").str().empty()) return true;
    const bool hasOpacity = e.at("opacity").is_number() && std::isfinite(e.at("opacity").num());
    if (hasOpacity && !gpu_blends_effect_opacity(t)) return true;
    // effectFollowsPath: Write-on's brush form (writeOnUsesBrush, read through paramsOf).
    if (t == "write-on") {
      const Json& mode = doc::params_of(e).at("writeOnMode");
      if (mode.is_number() && motion::js::round(mode.num()) == 0) return true;
    }
    if (t != "beam-path") {
      const Json& pm = e.at("params").at("pathMaskId");
      if (pm.is_string() && !pm.str().empty()) return true;
    }
    return false;
  });
}

bool layer_is_baked(const RLayer& l) {
  if (l.gpuEffects) return false;  // E4: the stack runs on the GPU chain (gpu_effect_route)
  if (l.kind == LayerKind::image || l.kind == LayerKind::video) return effects_need_cpu_bake(l.effects);
  return effects_need_cpu_bake(l.effects) || (l.fillOpacity && *l.fillOpacity < 1);
}

bool has_lut_effect(const RLayer& l) {
  return std::ranges::any_of(l.effects, [](const Json& e) { return effect_enabled(e) && is_lut_effect(type_of(e)); });
}

const char* effect_unported_reason(const Json& e) {
  if (!effect_enabled(e)) return nullptr;
  const std::string t = type_of(e);
  if (is_temporal(t)) return nullptr;  // handled by the snapshot's time plumbing (or reported there)
  if (is_color_effect(t)) return nullptr;
  if (is_native_effect(t)) return nullptr;  // G1: native SDK plugins render in the chain (scene_native_fx.cpp)
  // An effect type the engine does not know: a native plugin that is not
  // installed (or failed to load), or an old JS / WGSL plugin (G2). The effect
  // stays in the document untouched and passes its input through.
  if (doc::registry().effect(t) == nullptr) return "missing plugin — the effect passes through until it is installed";
  // A baked layer's chain runs in the raster (bake_chain.cpp): what it cannot
  // draw is reported there, per effect, with the raster.
  if (is_canvas2d_only(t)) return nullptr;
  if (e.at("maskId").is_string() && !e.at("maskId").str().empty()) return nullptr;
  const Json& pm = e.at("params").at("pathMaskId");
  if (t != "beam-path" && pm.is_string() && !pm.str().empty()) return nullptr;
  if (e.at("opacity").is_number() && !gpu_blends_effect_opacity(t)) return nullptr;
  if (is_lut_effect(t) || t == "apply-color-lut") return nullptr;  // lut:<id> strip / apply-color-lut entry (lut_port.cpp)
  if (is_gpu_identity(t)) return nullptr;
  if (!is_ported_spatial(t) && !is_more_spatial(t)) return "GPU effect not in the C++ port";
  return nullptr;
}

// ── colour matrix ─────────────────────────────────────────────────────────

namespace {
using M3 = std::array<double, 9>;
constexpr M3 kI3 = {1, 0, 0, 0, 1, 0, 0, 0, 1};
constexpr double kLR = 0.2126;
constexpr double kLG = 0.7152;
constexpr double kLB = 0.0722;

M3 mul(const M3& a, const M3& b) {
  M3 r{};
  for (std::size_t row = 0; row < 3; ++row) {
    for (std::size_t col = 0; col < 3; ++col) {
      r[row * 3 + col] = a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
    }
  }
  return r;
}
M3 saturate_m(double s) {
  return {kLR + (1 - kLR) * s, kLG - kLG * s, kLB - kLB * s, kLR - kLR * s, kLG + (1 - kLG) * s, kLB - kLB * s,
          kLR - kLR * s,       kLG - kLG * s, kLB + (1 - kLB) * s};
}
M3 sepia_m(double p) {
  constexpr M3 s = {0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131};
  M3 r{};
  for (std::size_t i = 0; i < 9; ++i) r[i] = kI3[i] * (1 - p) + s[i] * p;
  return r;
}
M3 hue_rotate_m(double deg) {
  const double a = (deg * std::numbers::pi) / 180;
  const double c = motion::js::cos(a);
  const double s = motion::js::sin(a);
  return {kLR + c * (1 - kLR) + s * -kLR, kLG + c * -kLG + s * -kLG, kLB + c * -kLB + s * (1 - kLB),
          kLR + c * -kLR + s * 0.143,     kLG + c * (1 - kLG) + s * 0.14, kLB + c * -kLB + s * -0.283,
          kLR + c * -kLR + s * -(1 - kLR), kLG + c * -kLG + s * kLG,   kLB + c * (1 - kLB) + s * kLB};
}
M3 scale_m(double b) { return {b, 0, 0, 0, b, 0, 0, 0, b}; }

std::array<double, 3> hex01(const Json& v) {
  if (!v.is_string()) return {0, 0, 0};
  std::string_view s = v.str();
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) s.remove_prefix(1);
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t')) s.remove_suffix(1);
  if (s.starts_with('#')) s.remove_prefix(1);
  if (s.size() != 6) return {0, 0, 0};
  for (const char c : s) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return {0, 0, 0};
  }
  const Rgba c = color_from_hex(std::string("#") + std::string(s));
  return {c.r, c.g, c.b};
}

bool build_matrix(const Json& e, double amt, M3& m, std::array<double, 3>& o) {
  const std::string t = type_of(e);
  o = {0, 0, 0};
  if (t == "brightness") m = scale_m(amt / 100);
  else if (t == "contrast") {
    const double c = amt / 100;
    const double off = 0.5 * (1 - c);
    m = {c, 0, 0, 0, c, 0, 0, 0, c};
    o = {off, off, off};
  } else if (t == "saturate") m = saturate_m(amt / 100);
  else if (t == "grayscale") m = saturate_m(1 - amt / 100);
  else if (t == "sepia") m = sepia_m(amt / 100);
  else if (t == "hue-rotate") m = hue_rotate_m(amt);
  else if (t == "hue-saturation") {
    const M3 hue = hue_rotate_m(effect_number(e, "hue"));
    const M3 sat = saturate_m((100 + effect_number(e, "saturation")) / 100);
    const M3 light = scale_m((100 + effect_number(e, "lightness")) / 100);
    m = mul(light, mul(sat, hue));
  } else if (t == "invert") {
    const double i = amt / 100;
    const double k = 1 - 2 * i;
    m = {k, 0, 0, 0, k, 0, 0, 0, k};
    o = {i, i, i};
  } else if (t == "tint") {
    const Json p = doc::params_of(e);
    const Json& mb = param_of(p, "mapBlack");
    const Json& mw = param_of(p, "mapWhite");
    const auto b = hex01(mb.is_undefined() || mb.is_null() ? Json::string("#000000") : mb);
    const auto w = hex01(mw.is_undefined() || mw.is_null() ? Json::string("#ffffff") : mw);
    const double a = amt / 100;
    M3 tint{};
    for (std::size_t i = 0; i < 3; ++i) {
      const double dd = w[i] - b[i];
      tint[i * 3] = dd * kLR;
      tint[i * 3 + 1] = dd * kLG;
      tint[i * 3 + 2] = dd * kLB;
    }
    for (std::size_t i = 0; i < 9; ++i) m[i] = kI3[i] * (1 - a) + tint[i] * a;
    o = {b[0] * a, b[1] * a, b[2] * a};
  } else if (t == "channel-mixer") {
    const auto pp = [&](const char* k) { return effect_number(e, k) / 100; };
    const double rr = pp("redRed"), rg = pp("redGreen"), rb = pp("redBlue");
    const double gr = pp("greenRed"), gg = pp("greenGreen"), gb = pp("greenBlue");
    const double br = pp("blueRed"), bg = pp("blueGreen"), bb = pp("blueBlue");
    const Json p = doc::params_of(e);
    const bool mono = param_of(p, "monochrome").is_bool() && param_of(p, "monochrome").b();
    m = mono ? M3{rr, rg, rb, rr, rg, rb, rr, rg, rb} : M3{rr, rg, rb, gr, gg, gb, br, bg, bb};
    o = {pp("redConst"), pp("greenConst"), pp("blueConst")};
  } else {
    return false;
  }
  return true;
}
}  // namespace

ColorMatrix effect_color_matrix(const std::vector<Json>& effects) {
  ColorMatrix cm;
  M3 m = kI3;
  std::array<double, 3> offset{0, 0, 0};
  for (const Json& e : effects) {
    if (!effect_enabled(e)) continue;
    const doc::EffectDef* def = doc::registry().effect(type_of(e));
    const doc::EffectParamDef* primary = def != nullptr ? def->primary() : nullptr;
    const double amt = effect_number(e, primary != nullptr ? primary->key : std::string("amount"));
    M3 em{};
    std::array<double, 3> eo{};
    if (!build_matrix(e, amt, em, eo)) continue;
    m = mul(em, m);
    offset = {em[0] * offset[0] + em[1] * offset[1] + em[2] * offset[2] + eo[0],
              em[3] * offset[0] + em[4] * offset[1] + em[5] * offset[2] + eo[1],
              em[6] * offset[0] + em[7] * offset[1] + em[8] * offset[2] + eo[2]};
    cm.identity = false;
  }
  if (!cm.identity) {
    cm.m = m;
    cm.offset = offset;
  }
  return cm;
}

std::array<double, 3> apply_color_matrix(const ColorMatrix& cm, const std::array<double, 3>& v) {
  const auto& a = cm.m;
  const double r = a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
  const double g = a[3] * v[0] + a[4] * v[1] + a[5] * v[2];
  const double b = a[6] * v[0] + a[7] * v[1] + a[8] * v[2];
  const auto clamp = [](double n) { return n < 0 ? 0.0 : n > 1 ? 1.0 : n; };
  return {clamp(r + cm.offset[0]), clamp(g + cm.offset[1]), clamp(b + cm.offset[2])};
}

// ── spatial chain entries ───────────────────────────────────────────────────

FxWriter& FxWriter::num(std::string name, double v) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = api::RenderParamKind::number;
  p.number = v;
  e_.params.push_back(std::move(p));
  return *this;
}
FxWriter& FxWriter::flag(std::string name, bool v) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = api::RenderParamKind::flag;
  p.number = v ? 1 : 0;
  e_.params.push_back(std::move(p));
  return *this;
}
FxWriter& FxWriter::color(std::string name, const Rgba& c) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = api::RenderParamKind::color;
  p.numbers = {c.r, c.g, c.b, c.a};
  e_.params.push_back(std::move(p));
  return *this;
}
FxWriter& FxWriter::nums(std::string name, std::vector<double> v) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = api::RenderParamKind::numbers;
  p.numbers = std::move(v);
  e_.params.push_back(std::move(p));
  return *this;
}
FxWriter& FxWriter::text(std::string name, std::string v) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = api::RenderParamKind::text;
  p.text = std::move(v);
  e_.params.push_back(std::move(p));
  return *this;
}

namespace {

/// The chain entries of ONE enabled effect — the loop body of
/// extractSpatialEffects, shared by the TS-parity extraction below and the E4
/// GPU route (extract_gpu_route_effects), so both write identical entries.
void effect_entries(const Json& e, const RLayer& l, std::vector<api::RenderEffect>& spatial) {
  const std::string t = type_of(e);
  const Json params = doc::params_of(e);
  if (auto native = native_effect_entry(e, params, l)) {  // G1: a native SDK plugin effect
    spatial.push_back(std::move(*native));
    return;
  }
  const auto n = [&](std::string_view k) {
    const Json& v = param_of(params, k);
    return v.is_number() ? v.num() : 0.0;
  };
  const auto c = [&](std::string_view k, double alpha) { return color_with_alpha(param_of(params, k), alpha); };
  if (t == "blur") {
    const double blades = n("blades");
    const double roundness = n("roundness");
    const double highlightGain = n("highlightGain");
    const double irisRotation = n("irisRotation");
    const double irisAspect = n("irisAspect");
    const double highlightThreshold = n("highlightThreshold");
    const double highlightSaturation = n("highlightSaturation");
    const double fringe = n("diffractionFringe");
    const bool hasCoc = params.find("coc0") != nullptr;
    const double amount = hasCoc ? std::max({n("amount"), n("coc0"), n("coc1"), n("coc2"), n("coc3")}) : n("amount");
    FxWriter w("blur");
    w.num("radiusPx", amount);
    if (blades >= 3) w.num("blades", blades);
    if (blades >= 3 && std::isfinite(roundness)) w.num("roundness", roundness);
    if (highlightGain > 0) w.num("highlightGain", highlightGain);
    if (blades >= 3 && std::isfinite(irisRotation) && irisRotation != 0) w.num("irisRotationDeg", irisRotation);
    if (blades >= 3 && std::isfinite(irisAspect) && irisAspect > 0 && irisAspect != 1) w.num("irisAspect", irisAspect);
    if (highlightThreshold > 0) w.num("highlightThreshold", highlightThreshold);
    if (highlightSaturation > 0) w.num("highlightSaturation", highlightSaturation);
    if (blades >= 3 && fringe > 0) w.num("fringe", fringe);
    if (hasCoc) w.nums("cocCorners", {n("coc0"), n("coc1"), n("coc2"), n("coc3")});
    if (e.at("id").is_string() && e.at("id").str() == "dof") w.flag("dofSource", true);
    spatial.push_back(w.done());
  }
  if (t == "glow") {
    const double size = n("radius");
    const double spread01 = std::max(0.0, std::min(1.0, n("spread") / 100));
    FxWriter w("glow");
    w.num("radiusPx", size * (1 - spread01));
    if (spread01 > 0) w.num("spreadPx", size * spread01);
    w.color("color", c("color", n("intensity") / 100));
    spatial.push_back(w.done());
  }
  if (t == "drop-shadow") {
    const double rad = (n("angle") * std::numbers::pi) / 180;
    const double size = n("softness");
    const double spread01 = std::max(0.0, std::min(1.0, n("spread") / 100));
    FxWriter w("drop-shadow");
    w.num("radiusPx", size * (1 - spread01));
    if (spread01 > 0) w.num("spreadPx", size * spread01);
    w.num("offsetX", motion::js::cos(rad) * n("distance"));
    w.num("offsetY", motion::js::sin(rad) * n("distance"));
    w.color("color", c("color", n("opacity") / 100));
    spatial.push_back(w.done());
  }
  if (t == "gradient-ramp") {
    FxWriter w("gradient-ramp");
    w.num("blend", n("blend") / 100);
    w.color("colorA", c("colorA", 1));
    w.color("colorB", c("colorB", 1));
    w.num("angle", n("angle"));
    spatial.push_back(w.done());
  }
  if (t == "fill") {
    spatial.push_back(FxWriter("fill").color("color", c("color", n("opacity") / 100)).done());
  }
  if (t == "stroke") {
    const Json& posRaw = param_of(params, "position");
    int position = 0;
    if ((posRaw.is_string() && posRaw.str() == "inside") || (posRaw.is_number() && posRaw.num() == 1)) position = 1;
    else if ((posRaw.is_string() && posRaw.str() == "center") || (posRaw.is_number() && posRaw.num() == 2)) position = 2;
    else if (posRaw.is_number() && posRaw.num() >= 1 && posRaw.num() <= 2) position = static_cast<int>(motion::js::round(posRaw.num()));
    FxWriter w("stroke");
    w.num("widthPx", n("width"));
    w.color("color", c("color", n("opacity") / 100));
    if (position != 0) w.num("position", position);
    spatial.push_back(w.done());
  }
  if (t == "apply-color-lut") {
    if (auto lut = apply_color_lut_entry(e, params, l)) spatial.push_back(std::move(*lut));
  }
  if (!is_ported_spatial(t)) (void)extract_more_spatial(e, params, l, spatial);
  if (t == "sharpen") spatial.push_back(FxWriter("sharpen").num("amount", n("amount") / 100).done());
  if (t == "noise") {
    const Json& mono = e.at("params").at("monochrome");
    spatial.push_back(FxWriter("noise")
                          .num("amount", n("amount") / 100)
                          .num("evolution", n("evolution"))
                          .flag("monochrome", !(mono.is_bool() && !mono.b()))
                          .done());
  }
}

}  // namespace

std::vector<api::RenderEffect> extract_spatial_effects(const RLayer& l, bool onlyGpuOnly) {
  std::vector<api::RenderEffect> spatial;
  if (l.effects.empty()) return spatial;
  const Json* owner = nullptr;
  std::size_t ownerAt = 0;
  const auto stampOpacity = [&]() {
    const Json* e = owner;
    owner = nullptr;
    if (e == nullptr || onlyGpuOnly || !(e->at("opacity").is_number() && std::isfinite(e->at("opacity").num()))) return;
    if (spatial.size() - ownerAt != 1) return;
    const double a = std::max(0.0, std::min(1.0, e->at("opacity").num() / 100));
    if (a <= 0) spatial.resize(ownerAt);
    else if (a < 1) {
      api::RenderEffectParam p;
      p.name = "effectOpacity";
      p.kind = api::RenderParamKind::number;
      p.number = a;
      spatial[ownerAt].params.push_back(std::move(p));
    }
  };
  for (const Json& e : l.effects) {
    stampOpacity();
    if (!effect_enabled(e)) continue;
    if (onlyGpuOnly && !is_gpu_only_effect(type_of(e))) continue;
    owner = &e;
    ownerAt = spatial.size();
    effect_entries(e, l, spatial);
  }
  stampOpacity();
  return spatial;
}

// ── E4: the GPU route for a layer the TypeScript bakes ─────────────────────

bool scribble_has_paths(const RLayer& l) {
  if (!l.mask.is_object() || !l.mask.at("paths").is_array()) return false;
  for (const Json& p : l.mask.at("paths").arr()) {
    if (p.at("points").is_array() && p.at("points").arr().size() >= 2) return true;
  }
  return false;
}

bool gpu_draws_canvas_effect(const RLayer& l, const Json& e) {
  const std::string t = type_of(e);
  // Plexus is a point cloud (stamp_field.cpp), not a read of the bake.
  if (t == "plexus") return true;
  // Scribble with no mask path draws nothing (scribble.ts). The fill-opacity
  // chain is the whole effect; a mask still needs the CPU region scan.
  if (t == "scribble") return !scribble_has_paths(l);
  // Vegas over the layer's own alpha (the contour mode, not mask / path
  // strokes): its contours come from the content raster (TexKind::contours),
  // so its input must BE that raster — a shape with a raster of its own, no
  // layer mask, and Vegas first in the stack. Fill opacity is a later chain
  // entry, so the contour is of the unfaded content (contour_request_spec).
  if (t != "vegas") return false;
  if (l.kind != LayerKind::shape || !needs_shape_raster(l)) return false;
  if (l.mask.is_object() && l.mask.at("paths").is_array() && !l.mask.at("paths").arr().empty()) return false;
  const Json p = doc::params_of(e);
  if (p.at("allMasks").is_bool() && p.at("allMasks").b()) return false;
  if (p.at("pathPoints").is_array() && p.at("pathPoints").arr().size() >= 6) return false;
  for (const Json& o : l.effects) {
    if (!effect_enabled(o) || is_temporal(type_of(o))) continue;
    return &o == &e;
  }
  return false;
}

std::string contour_key(std::string_view layerId) { return "vegas:" + std::string(layerId); }

namespace {
/// Path Stroke's / Scribble's paint-style param (strokePaint.ts PAINT_STYLE:
/// 0 on original, 1 on transparent, 2 reveal original).
const char* paint_style_param(std::string_view t) {
  return t == "path-stroke" ? "paintStyle" : t == "scribble" ? "composite" : nullptr;
}
}  // namespace

bool gpu_overlay_effect(const RLayer& l, const Json& e) {
  const std::string t = type_of(e);
  const bool drawOnly = t == "numbers" || t == "timecode" || t == "audio-spectrum";
  const bool composited = t == "audio-waveform" || t == "lightning";
  // Path Stroke / Scribble paint a buffer from the mask paths alone and only then
  // composite it with the layer (compositePaint): the buffer on transparent IS
  // the overlay, landed over (on original), in place of (on transparent) or as
  // a destination-in mask (reveal original).
  const bool paintBuffer = paint_style_param(t) != nullptr;
  if (!drawOnly && !composited && !paintBuffer) return false;
  if (t == "scribble" && !scribble_has_paths(l)) return false;  // draws nothing (gpu_draws_canvas_effect)
  if (composited) {
    // compositeFor: 0 over · 1 add (lighter) · 2 screen · 3 multiply · 4 inside
    // (source-atop). Painting the primitives alone and landing the result once
    // equals painting them on the layer one by one for over, lighter and screen
    // (each is associative, and the first primitive lands on transparent as
    // itself) and for source-atop (Σ atop B = (P1 over … over Pn) atop B, so
    // the overlay is painted source-over and landed atop). Multiply is
    // associative too (in 1 − premultiplied colour it is a + b − ab): the overlay
    // is painted multiply on transparent and the chain lands it with
    // blend-combine's multiply, Cs·(1 − Ab) + Cb·(1 − As) + Cs·Cb (no
    // fixed-function blend state expresses it).
    const double mode = motion::js::round(effect_number(e, "composite"));
    if (mode != 0 && mode != 1 && mode != 2 && mode != 3 && mode != 4) return false;
  }
  // The overlay is painted at the size of the layer's OWN raster (a shape with
  // a path raster, or text), which a layer mask would not shape the same way.
  const bool ownRaster = (l.kind == LayerKind::shape && needs_shape_raster(l)) || l.kind == LayerKind::text;
  if (!ownRaster) return false;
  // maskIsActive (mask.ts): only paths with a mode shape the layer; the
  // mode-None paths Path Stroke / Scribble follow do not.
  if (l.mask.is_object() && l.mask.at("paths").is_array()) {
    for (const Json& p : l.mask.at("paths").arr()) {
      if (!(p.at("mode").is_string() && p.at("mode").str() == "none")) return false;
    }
  }
  return true;
}

namespace {
std::string overlay_key(std::string_view layerId, std::size_t ordinal) {
  return "fxdraw:" + std::string(layerId) + ":" + std::to_string(ordinal);
}
}  // namespace

std::vector<std::pair<std::string, Json>> gpu_overlay_requests(const RLayer& l) {
  std::vector<std::pair<std::string, Json>> out;
  if (!l.gpuEffects) return out;
  std::size_t ordinal = 0;
  for (const Json& e : l.effects) {
    if (!effect_enabled(e) || !gpu_overlay_effect(l, e)) continue;
    out.emplace_back(overlay_key(l.id, ordinal++), e);
  }
  return out;
}

std::optional<api::RenderEffect> gpu_canvas_effect_entry(const RLayer& l, const Json& e) {
  if (!gpu_draws_canvas_effect(l, e)) return std::nullopt;
  if (type_of(e) == "plexus") {
    const auto stamp = stamp_for_effect(l, e);
    if (!stamp) return std::nullopt;
    return FxWriter("stamp-field")
        .text("stampKey", stamp->key)
        .num("instances", static_cast<double>(stamp->instances))
        .num("over", stamp->over)
        .done();
  }
  if (type_of(e) == "scribble") return std::nullopt;  // nothing to draw
  const Json params = doc::params_of(e);
  const auto n = [&](std::string_view k) {
    const Json& v = param_of(params, k);
    return v.is_number() ? v.num() : 0.0;
  };
  // apply_vegas' early returns (nothing drawn, nothing cleared).
  if (n("opacity") <= 0 || n("length") <= 0) return std::nullopt;
  const Json& rp = params.at("randomPhase");
  FxWriter w("vegas");
  w.text("contourKey", contour_key(l.id));
  w.num("opacity", n("opacity") / 100);
  w.num("length", n("length"));
  w.num("width", std::max(0.1, n("width")));
  w.num("segments", std::max(1.0, motion::js::round(n("segments"))));
  w.num("rotation", n("rotation"));
  w.num("hardness", std::max(0.0, std::min(100.0, n("hardness"))));
  w.flag("bunched", motion::js::round(n("segmentDistribution")) == 0);
  w.flag("randomPhase", rp.is_bool() && rp.b());
  w.num("seed", std::floor(n("randomSeed")));
  w.num("blendMode", motion::js::round(n("blendMode")));
  w.num("startOpacity", n("startOpacity"));
  w.num("midOpacity", n("midOpacity"));
  w.num("endOpacity", n("endOpacity"));
  w.num("midPosition", n("midPosition"));
  w.color("color", color_with_alpha(param_of(params, "color"), 1));
  return w.done();
}

std::optional<Json> contour_request_spec(const RLayer& l) {
  for (const Json& e : l.effects) {
    if (!effect_enabled(e) || !gpu_draws_canvas_effect(l, e)) continue;
    const double threshold = std::max(1.0, std::min(254.0, effect_number(e, "threshold")));
    // The content raster is unfaded: the GPU route applies fill opacity after
    // the contour. Folding it into the threshold rebuilt the contour on every
    // fill-opacity frame (the E4 bench, ~1 s at 1080p).
    Json spec = Json::object();
    spec.set("source", Json::string("path:" + l.id));
    spec.set("threshold", Json::number(threshold));
    spec.set("width", Json::number(l.width));
    spec.set("height", Json::number(l.height));
    spec.set("padding", Json::number(raster_padding(l)));
    return spec;
  }
  return std::nullopt;
}

namespace {

/// The layer-mask path an effect's `maskId` names (effectBake.ts compositeBlend's
/// scope), or null: no id, or an id the layer's mask does not hold — then the
/// CPU chain applies the effect unscoped, and so does the GPU route.
const Json* scope_path_of(const RLayer& l, const Json& e) {
  const Json& id = e.at("maskId");
  if (!id.is_string() || id.str().empty()) return nullptr;
  if (!l.mask.is_object() || !l.mask.at("paths").is_array()) return nullptr;
  for (const Json& p : l.mask.at("paths").arr()) {
    if (p.at("id").is_string() && p.at("id").str() == id.str()) return &p;
  }
  return nullptr;
}

/// effectOpacityOf: a finite `opacity` → clamp(pct / 100); absent → nullopt.
std::optional<double> effect_opacity_of(const Json& e) {
  const Json& op = e.at("opacity");
  if (!op.is_number() || !std::isfinite(op.num())) return std::nullopt;
  return std::max(0.0, std::min(1.0, op.num() / 100));
}

void add_param(api::RenderEffect& fx, std::string name, double v) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = api::RenderParamKind::number;
  p.number = v;
  fx.params.push_back(std::move(p));
}

void add_text(api::RenderEffect& fx, std::string name, std::string v) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = api::RenderParamKind::text;
  p.text = std::move(v);
  fx.params.push_back(std::move(p));
}

}  // namespace

std::string scope_mask_key(std::string_view layerId, std::string_view maskId) {
  std::string k = "fxmask:";
  k += layerId;
  k += ':';
  k += maskId;
  return k;
}

const char* gpu_effect_route_blocker(const RLayer& l) {
  if (l.precompLayers) return "a precomp container (its chain is the container's)";
  for (const Json& e : l.effects) {
    if (!effect_enabled(e)) continue;
    const std::string t = type_of(e);
    if (is_canvas2d_only(t) && !gpu_draws_canvas_effect(l, e) && !gpu_overlay_effect(l, e)) return "a Canvas2D-only effect";
    if (is_temporal(t)) continue;  // the snapshot's time plumbing, baked or not
    if (!is_native_effect(t) && doc::registry().effect(t) == nullptr) return "a missing plugin's effect";
    if (t != "beam-path" && !gpu_overlay_effect(l, e) && !(is_canvas2d_only(t) && gpu_draws_canvas_effect(l, e))) {
      const Json& pm = e.at("params").at("pathMaskId");
      if (pm.is_string() && !pm.str().empty()) return "a path-following effect";
    }
    // Colour grades and per-channel LUTs are chain entries (color-matrix /
    // channel-lut), so they stay in stack order after fill opacity.
    const bool grade = (is_color_effect(t) && t != "opacity") || is_lut_effect(t);
    const bool chained = is_ported_spatial(t) || is_more_spatial(t) || is_native_effect(t) || t == "apply-color-lut" ||
                         (is_canvas2d_only(t) && (gpu_draws_canvas_effect(l, e) || gpu_overlay_effect(l, e))) || grade ||
                         is_gpu_identity(t);
    if (!chained) return "an effect with no GPU chain entry";
    // Effect Opacity and a mask scope blend the effect's entries back over its
    // input — any chain entry, one in place, several as a `blendSpan`
    // (effect_chain.cpp keeps the input): applyEffectChain's blend of the whole
    // effect. (The TS GPU chain blends only `gpu_blends_effect_opacity` kinds,
    // which is why it bakes the others; the route is exactly for those.)
  }
  return nullptr;
}

bool gpu_effect_route(const RLayer& l) {
  if (l.gpuEffects) return true;
  if (!layer_is_baked(l)) return false;  // nothing to route: the stack is on the GPU already
  return gpu_effect_route_blocker(l) == nullptr;
}

std::vector<api::RenderEffect> extract_gpu_route_effects(const RLayer& l) {
  std::vector<api::RenderEffect> out;
  // Fill opacity (shape / text only, as layerIsBaked): the chain snapshots the
  // silhouette, fades the contents and shapes every style by the snapshot.
  const bool vector = l.kind != LayerKind::image && l.kind != LayerKind::video;
  if (vector && l.fillOpacity && *l.fillOpacity < 1) {
    out.push_back(FxWriter("fill-opacity").num("amount", std::max(0.0, std::min(1.0, *l.fillOpacity))).done());
  }
  std::size_t lutOrdinal = 0;
  std::size_t overlayOrdinal = 0;  // gpu_overlay_requests' order
  for (const Json& e : l.effects) {
    if (!effect_enabled(e)) continue;
    const std::size_t at = out.size();
    const std::string t = type_of(e);
    if (t == "write-on") {
      if (const auto stamp = stamp_for_effect(l, e)) {
        out.push_back(FxWriter("stamp-field")
                          .text("stampKey", stamp->key)
                          .num("instances", static_cast<double>(stamp->instances))
                          .num("over", stamp->over)
                          .done());
      } else {
        effect_entries(e, l, out);  // classic line / path
      }
    } else if (is_color_effect(t) && t != "opacity") {
      M3 em{};
      std::array<double, 3> eo{};
      const doc::EffectDef* def = doc::registry().effect(t);
      const doc::EffectParamDef* primary = def != nullptr ? def->primary() : nullptr;
      const double amt = effect_number(e, primary != nullptr ? primary->key : std::string("amount"));
      if (build_matrix(e, amt, em, eo)) {
        out.push_back(FxWriter("color-matrix")
                          .nums("m", {em[0], em[1], em[2], em[3], em[4], em[5], em[6], em[7], em[8]})
                          .nums("offset", {eo[0], eo[1], eo[2]})
                          .done());
      }
    } else if (is_lut_effect(t)) {
      out.push_back(FxWriter("channel-lut").text("lutKey", channel_lut_key(l.id, lutOrdinal)).done());
      ++lutOrdinal;
    } else if (is_canvas2d_only(t) && gpu_overlay_effect(l, e)) {
      // E4 round 2: the effect's drawing alone, landed with its composite
      // (compositeFor's code; 10 + PAINT_STYLE for a paint buffer).
      double mode = (t == "audio-waveform" || t == "lightning") ? motion::js::round(effect_number(e, "composite")) : 0;
      if (const char* style = paint_style_param(t)) mode = 10 + std::max(0.0, std::min(2.0, motion::js::round(effect_number(e, style))));
      out.push_back(FxWriter("fx-overlay").text("overlayKey", overlay_key(l.id, overlayOrdinal)).num("mode", mode).done());
      ++overlayOrdinal;
    } else if (is_canvas2d_only(t)) {
      if (auto drawn = gpu_canvas_effect_entry(l, e)) out.push_back(std::move(*drawn));
    } else if (is_gpu_identity(t)) {
      // nothing to draw (the CPU pass is expand + crop back)
    } else {
      effect_entries(e, l, out);
    }
    const std::size_t written = out.size() - at;
    if (written == 0) continue;
    const std::optional<double> a = effect_opacity_of(e);
    const Json* scope = scope_path_of(l, e);
    if (a && *a <= 0 && scope == nullptr) {  // applyEffectChain: a fully faded, unscoped effect is skipped
      out.resize(at);
      continue;
    }
    const bool blends = (a && *a < 1) || scope != nullptr;
    if (a && *a < 1) add_param(out[at], "effectOpacity", *a);
    if (scope != nullptr) {
      add_text(out[at], "scopeMaskKey", scope_mask_key(l.id, scope->at("id").str()));
      if (!a) add_param(out[at], "effectOpacity", 1);  // the scoped blend-back runs even at full opacity
    }
    // Several entries: the blend covers them all (the chain keeps the input
    // until the last one) — applyEffectChain blends the whole effect back.
    if (blends && written > 1) add_param(out[at], "blendSpan", static_cast<double>(written));
  }
  return out;
}

std::vector<std::pair<std::string, Json>> gpu_route_scope_masks(const RLayer& l) {
  std::vector<std::pair<std::string, Json>> out;
  for (const Json& e : l.effects) {
    if (!effect_enabled(e)) continue;
    const Json* scope = scope_path_of(l, e);
    if (scope == nullptr) continue;
    std::string key = scope_mask_key(l.id, scope->at("id").str());
    if (std::ranges::any_of(out, [&](const auto& m) { return m.first == key; })) continue;
    // compositeBlend paints `{...path, mode: 'add'}` alone.
    Json path = *scope;
    path.set("mode", Json::string("add"));
    Json paths = Json::array();
    paths.arr_mut().push_back(std::move(path));
    Json mask = Json::object();
    mask.set("paths", std::move(paths));
    out.emplace_back(std::move(key), std::move(mask));
  }
  return out;
}

}  // namespace premation::scene
