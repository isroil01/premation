#include "effects_port.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>
#include <set>

#include "catalog_data.hpp"
#include "effects_spatial.hpp"
#include "fxstate.hpp"
#include "jsmath.hpp"
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
  return k.contains(t);
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
    if (e.at("maskId").is_string() && !e.at("maskId").str().empty()) return true;
    const bool hasOpacity = e.at("opacity").is_number() && std::isfinite(e.at("opacity").num());
    if (hasOpacity && !gpu_blends_effect_opacity(t)) return true;
    // effectFollowsPath (write-on's brush form is detected by the caller as unported).
    if (t != "beam-path") {
      const Json& pm = e.at("params").at("pathMaskId");
      if (pm.is_string() && !pm.str().empty()) return true;
    }
    return false;
  });
}

bool layer_is_baked(const RLayer& l) {
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
  if (doc::registry().effect(t) == nullptr) return "plugin effects";
  if (is_canvas2d_only(t)) return "CPU-baked effect (E4)";
  if (e.at("maskId").is_string() && !e.at("maskId").str().empty()) return "effect scoped to a mask (CPU bake, E4)";
  const Json& pm = e.at("params").at("pathMaskId");
  if (t != "beam-path" && pm.is_string() && !pm.str().empty()) return "path-following effect (CPU bake, E4)";
  if (e.at("opacity").is_number() && !gpu_blends_effect_opacity(t)) return "effect opacity (CPU bake, E4)";
  if (is_lut_effect(t)) return "per-channel LUT effect";
  if (t == "apply-color-lut") return "3D LUT effect";
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
    const std::string t = type_of(e);
    if (onlyGpuOnly && !is_gpu_only_effect(t)) continue;
    owner = &e;
    ownerAt = spatial.size();
    const Json params = doc::params_of(e);
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
  stampOpacity();
  return spatial;
}

}  // namespace premation::scene
