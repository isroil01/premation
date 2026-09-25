// The canvas2d-route PIXEL effects of the bake chain: each is a port of its
// TS `apply*` wrapper (src/core/effects/canvas2dEffects.ts and the modules it
// delegates to — pathStroke.ts, scribble.ts, writeOnBrush.ts, deepGlow.ts,
// beamPath.ts, cubeLut.ts): the same early returns at neutral settings (which
// decide whether the frame is touched at all), the same param → kernel
// argument mapping (renames, /100 scalings, w/2 + offset centres, Math.round
// and clamps, colour parsing) and the same post-passes, handing the kernel of
// engine_effects (kernel_dispatch.cpp) its arguments by the TS kernel's names.

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <string>
#include <utility>
#include <vector>

#include "effect_chain.hpp"
#include "jsmath.hpp"
#include "kernel_dispatch.hpp"
#include "kernels.hpp"
#include "noise_hash.hpp"
#include "numconv.hpp"

namespace premation::effects {
namespace {

using raster::json::Value;
namespace js = motion::js;

// ── the TS param helpers ─────────────────────────────────────────────────────

/// effectNumber(e, k): the param when it is a number, else 0.
double n(const Value& p, std::string_view k) {
  const Value& v = p[k];
  return v.is_number() ? v.num() : 0;
}
/// canvas2dEffects.ts str(e, k, fallback).
std::string str(const Value& p, std::string_view k, std::string_view fb) {
  const Value& v = p[k];
  return v.is_string() ? v.str() : std::string(fb);
}
/// canvas2dEffects.ts bool(e, k, fallback).
bool flag(const Value& p, std::string_view k, bool fb) {
  const Value& v = p[k];
  return v.is_bool() ? v.truthy() : fb;
}
/// `paramsOf(e)[k] === true`.
bool is_true(const Value& p, std::string_view k) {
  const Value& v = p[k];
  return v.is_bool() && v.truthy();
}

std::string trim(std::string_view s) {
  std::size_t b = 0;
  std::size_t e = s.size();
  while (b < e && std::isspace(static_cast<unsigned char>(s[b])) != 0) ++b;
  while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1])) != 0) --e;
  return std::string(s.substr(b, e - b));
}
int hexv(char ch) {
  if (ch >= '0' && ch <= '9') return ch - '0';
  if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
  if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
  return -1;
}
bool all_hex(std::string_view s) {
  return std::ranges::all_of(s, [](char ch) { return hexv(ch) >= 0; });
}
int hex_int(std::string_view s) {
  int v = 0;
  for (const char ch : s) v = v * 16 + hexv(ch);
  return v;
}
using Rgb3 = std::array<double, 3>;
Rgb3 bytes_of(int v) { return {static_cast<double>((v >> 16) & 255), static_cast<double>((v >> 8) & 255), static_cast<double>(v & 255)}; }

/// canvas2dEffects.ts parseHex: `#rrggbb` / `#rgb` → bytes, else mid grey.
Rgb3 parse_hex(std::string_view hex) {
  const std::string s = trim(hex);
  if (s.size() == 7 && s[0] == '#' && all_hex(std::string_view(s).substr(1))) return bytes_of(hex_int(std::string_view(s).substr(1)));
  if (s.size() == 4 && s[0] == '#' && all_hex(std::string_view(s).substr(1))) {
    std::string full;
    for (std::size_t i = 1; i < 4; ++i) full += std::string(2, s[i]);
    return bytes_of(hex_int(full));
  }
  return {128, 128, 128};
}
/// pathStroke.ts / scribble.ts / writeOnBrush.ts hexRgb: /^#?([0-9a-f]{6})/i on the trimmed string, else white.
Rgb3 hex_rgb_prefix(std::string_view hex) {
  const std::string s = trim(hex);
  const std::size_t o = !s.empty() && s[0] == '#' ? 1 : 0;
  if (s.size() < o + 6 || !all_hex(std::string_view(s).substr(o, 6))) return {255, 255, 255};
  return bytes_of(hex_int(std::string_view(s).substr(o, 6)));
}
/// `Number.parseInt(s, 16)` on the longest hex-digit prefix (no sign, no 0x); NaN → nullopt.
std::optional<double> parse_int_hex(std::string_view s) {
  std::size_t i = 0;
  while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i])) != 0) ++i;
  double v = 0;
  bool any = false;
  for (; i < s.size() && hexv(s[i]) >= 0; ++i) {
    v = v * 16 + hexv(s[i]);
    any = true;
  }
  if (!any) return std::nullopt;
  return v;
}
/// deepGlow.ts hexBytes / beamPath.ts hexLinear's byte step.
Rgb3 hex_bytes(std::string_view hex) {
  std::string h = trim(hex);
  if (!h.empty() && h[0] == '#') h.erase(0, 1);
  if (h.size() == 3) h = std::string(2, h[0]) + std::string(2, h[1]) + std::string(2, h[2]);
  const auto v = parse_int_hex(std::string_view(h).substr(0, std::min<std::size_t>(6, h.size())));
  if (!v) return {255, 255, 255};
  const auto iv = static_cast<std::int64_t>(*v);
  return {static_cast<double>((iv >> 16) & 255), static_cast<double>((iv >> 8) & 255), static_cast<double>(iv & 255)};
}
/// deepGlow.ts srgbToLinear01.
double srgb_to_linear01(double c) { return c <= 0.04045 ? c / 12.92 : js::pow((c + 0.055) / 1.055, 2.4); }
std::string param_string(const Value& arr, std::size_t i);
/// `String(effectParam(e, k) ?? fallback)` — a colour param read as a string.
/// effectParam is `paramsOf(e)[k] ?? 0`, so an absent param reads "0", never
/// the fallback.
std::string param_string(const Value& p, std::string_view k) {
  const Value& v = p[k];
  if (v.is_string()) return v.str();
  if (v.is_bool()) return v.truthy() ? "true" : "false";
  if (v.is_number()) return js::number_to_string(v.num());
  if (v.is_array()) {  // Array.prototype.toString
    std::string out;
    for (std::size_t i = 0; i < v.size(); ++i) {
      if (i > 0) out += ',';
      out += param_string(v, i);
    }
    return out;
  }
  if (v.is_object()) return "[object Object]";
  return "0";
}
/// An array element's String() (null → "", as Array.prototype.join writes it).
std::string param_string(const Value& arr, std::size_t i) {
  const Value& v = arr[i];
  if (v.is_null()) return "";
  if (v.is_string()) return v.str();
  if (v.is_bool()) return v.truthy() ? "true" : "false";
  if (v.is_number()) return js::number_to_string(v.num());
  if (v.is_object()) return "[object Object]";
  std::string out;
  for (std::size_t j = 0; j < v.size(); ++j) {
    if (j > 0) out += ',';
    out += param_string(v, j);
  }
  return out;
}
double clamp01(double v) { return std::max(0.0, std::min(1.0, v)); }

// ── kernel arguments ─────────────────────────────────────────────────────────

class Args {
 public:
  Args& operator()(std::string k, double v) {
    v_.emplace_back(std::move(k), v);
    return *this;
  }
  Args& rgb(const std::string& name, const Rgb3& c) {
    (*this)(name + "R", c[0])(name + "G", c[1])(name + "B", c[2]);
    return *this;
  }
  Args& list(std::string k, std::vector<double> v) {
    l_.emplace_back(std::move(k), std::move(v));
    return *this;
  }
  [[nodiscard]] double get(std::string_view k, double fb) const {
    for (const auto& [key, v] : v_) {
      if (key == k) return v;
    }
    return fb;
  }
  [[nodiscard]] std::vector<double> lists(std::string_view k) const {
    for (const auto& [key, v] : l_) {
      if (key == k) return v;
    }
    return {};
  }

 private:
  std::vector<std::pair<std::string, double>> v_;
  std::vector<std::pair<std::string, std::vector<double>>> l_;
};

/// Run the kernel of `kernel` on the pass's frame.
void run(PixelPass& pass, std::string_view kernel, const Args& a) {
  const RgbaView img = pass.frame();
  (void)run_kernel(
      kernel, [&](std::string_view k, double fb) { return a.get(k, fb); }, [&](std::string_view k) { return a.lists(k); }, img,
      pass.pool());
}

/// A numeric array param (a resolved list), non-numbers dropped (writeOnBrush.ts trailOf).
std::vector<double> numbers_of(const Value& v) {
  std::vector<double> out;
  for (const auto& x : v.items()) {
    if (x.is_number()) out.push_back(x.num());
  }
  return out;
}

using Adapter = void (*)(const Value& p, PixelPass& pass);

// ── canvas2dEffects.ts, in its order ────────────────────────────────────────

void venetian_blinds(const Value& p, PixelPass& pass) {
  const double completion = n(p, "completion");
  if (completion <= 0) return;
  run(pass, "venetian-blinds", Args()("completion", completion / 100)("direction", n(p, "direction"))("width", n(p, "width"))("feather", n(p, "feather")));
}
void gradient_wipe(const Value& p, PixelPass& pass) {
  const double completion = n(p, "completion");
  if (completion <= 0) return;
  run(pass, "gradient-wipe", Args()("completion", completion / 100)("softness", n(p, "softness") / 100)("invert", flag(p, "invertGradient", false) ? 1 : 0));
}
void card_wipe(const Value& p, PixelPass& pass) {
  const double completion = n(p, "completion");
  if (completion <= 0) return;
  run(pass, "card-wipe", Args()("completion", completion / 100)("rows", n(p, "rows"))("columns", n(p, "columns"))("flipOrder", n(p, "flipOrder")));
}
void simple_choker_fx(const Value& p, PixelPass& pass) {
  const double choke = n(p, "chokeAmount");
  if (choke == 0) return;
  run(pass, "simple-choker", Args()("chokePx", choke));
}
void linear_color_key_fx(const Value& p, PixelPass& pass) {
  run(pass, "linear-color-key",
      Args().rgb("key", parse_hex(str(p, "keyColor", "#00ff00")))("matchOn", n(p, "matchOn"))("tolerance", n(p, "tolerance"))(
          "softness", n(p, "softness"))("keepMatched", flag(p, "keepMatched", false) ? 1 : 0));
}
void shift_channels_fx(const Value& p, PixelPass& pass) {
  run(pass, "shift-channels",
      Args()("alphaFrom", n(p, "takeAlphaFrom"))("redFrom", n(p, "takeRedFrom"))("greenFrom", n(p, "takeGreenFrom"))(
          "blueFrom", n(p, "takeBlueFrom")));
}
void vibrance_fx(const Value& p, PixelPass& pass) {
  const double vib = n(p, "vibrance");
  const double sat = n(p, "saturation");
  if (vib == 0 && sat == 0) return;
  run(pass, "vibrance", Args()("vibrance", vib)("saturation", sat));
}
/// Distort-family centre: an OFFSET from the layer's middle.
double cx_of(const PixelPass& pass, const Value& p, std::string_view k) { return pass.w() / 2.0 + n(p, k); }
double cy_of(const PixelPass& pass, const Value& p, std::string_view k) { return pass.h() / 2.0 + n(p, k); }
void bulge_fx(const Value& p, PixelPass& pass) {
  const double height = n(p, "height");
  const double radius = n(p, "radius");
  if (height == 0 || radius <= 0) return;
  run(pass, "bulge", Args()("centerX", cx_of(pass, p, "centerX"))("centerY", cy_of(pass, p, "centerY"))("radius", radius)("height", height));
}
void twirl_fx(const Value& p, PixelPass& pass) {
  const double angle = n(p, "angle");
  const double radius = n(p, "radius");
  if (angle == 0 || radius <= 0) return;
  run(pass, "twirl", Args()("centerX", cx_of(pass, p, "centerX"))("centerY", cy_of(pass, p, "centerY"))("radius", radius)("angle", angle));
}
void spherize_fx(const Value& p, PixelPass& pass) {
  const double amount = n(p, "amount");
  const double radius = n(p, "radius");
  if (amount == 0 || radius <= 0) return;
  run(pass, "spherize", Args()("centerX", cx_of(pass, p, "centerX"))("centerY", cy_of(pass, p, "centerY"))("radius", radius)("amount", amount));
}
void corner_pin_fx(const Value& p, PixelPass& pass) {
  static constexpr std::array<std::string_view, 8> kKeys{"topLeftX", "topLeftY", "topRightX", "topRightY",
                                                         "bottomRightX", "bottomRightY", "bottomLeftX", "bottomLeftY"};
  static constexpr std::array<std::string_view, 8> kArgs{"tlx", "tly", "trx", "try", "brx", "bry", "blx", "bly"};
  std::array<double, 8> off{};
  bool all_zero = true;
  for (std::size_t i = 0; i < 8; ++i) {
    off[i] = n(p, kKeys[i]);
    all_zero = all_zero && off[i] == 0;
  }
  if (all_zero) return;
  const double w = pass.w();
  const double h = pass.h();
  const std::array<double, 8> base{0, 0, w, 0, w, h, 0, h};  // distort.ts defaultCorners
  Args a;
  for (std::size_t i = 0; i < 8; ++i) a(std::string(kArgs[i]), base[i] + off[i]);
  run(pass, "corner-pin", a);
}
void bezier_warp_fx(const Value& p, PixelPass& pass) {
  static constexpr std::array<std::string_view, 12> kNames{"topLeft", "top1",    "top2",    "topRight",   "right1", "right2",
                                                           "bottomRight", "bottom1", "bottom2", "bottomLeft", "left1",  "left2"};
  const std::array<Pt2, 12> rest = bezier_warp_rest(pass.w(), pass.h());
  bool at_rest = true;
  Args a;
  for (std::size_t i = 0; i < 12; ++i) {
    const std::string k(kNames[i]);
    const double dx = n(p, k + "X");
    const double dy = n(p, k + "Y");
    // isRestWarp compares the offset points with the rest points exactly.
    at_rest = at_rest && rest[i].x + dx == rest[i].x && rest[i].y + dy == rest[i].y;
    a(k + "X", dx)(k + "Y", dy);
  }
  if (at_rest) return;
  run(pass, "bezier-warp", a);
}
void cell_pattern_fx(const Value& p, PixelPass& pass) {
  run(pass, "cell-pattern",
      Args()("size", n(p, "size"))("evolution", n(p, "evolution"))("contrast", n(p, "contrast"))("invert", is_true(p, "invert") ? 1 : 0)(
          "membrane", is_true(p, "membrane") ? 1 : 0));
}
void turbulent_noise_fx(const Value& p, PixelPass& pass) {
  run(pass, "turbulent-noise",
      Args()("scale", n(p, "scale"))("complexity", n(p, "complexity"))("evolution", n(p, "evolution"))("contrast", n(p, "contrast"))(
          "brightness", n(p, "brightness"))("invert", is_true(p, "invert") ? 1 : 0));
}
void add_grain_fx(const Value& p, PixelPass& pass) {
  if (n(p, "intensity") == 0) return;
  run(pass, "add-grain",
      Args()("intensity", n(p, "intensity"))("size", n(p, "size"))("saturation", n(p, "saturation"))("seed", n(p, "seed")));
}
void median_fx(const Value& p, PixelPass& pass) {
  const double radius = js::round(n(p, "radius"));
  if (radius <= 0) return;
  run(pass, "median", Args()("radius", radius));
}
void selective_color_fx(const Value& p, PixelPass& pass) {
  const double cyan = n(p, "cyan");
  const double magenta = n(p, "magenta");
  const double yellow = n(p, "yellow");
  const double black = n(p, "black");
  if (cyan == 0 && magenta == 0 && yellow == 0 && black == 0) return;
  run(pass, "selective-color",
      Args()("range", n(p, "range"))("cyan", cyan)("magenta", magenta)("yellow", yellow)("black", black)(
          "relative", is_true(p, "absolute") ? 0 : 1));
}
/// cubeLut.ts fromStoredLut's validation, as a kernel argument set (nullopt = render unchanged).
std::optional<Args> stored_lut(const Value& raw, double intensity) {
  if (!raw.is_object()) return std::nullopt;
  const double size = raw["size"].is_number() ? raw["size"].num() : 0;
  const double size1d = raw["size1d"].is_number() ? raw["size1d"].num() : 0;
  if (!raw["data"].is_array()) return std::nullopt;
  if (size == 0 && size1d == 0) return std::nullopt;
  if (size > 0 && size1d > 0) return std::nullopt;
  const double expected = size > 0 ? size * size * size * 3 : size1d * 3;
  if (static_cast<double>(raw["data"].size()) != expected) return std::nullopt;
  std::vector<double> data;
  for (const auto& v : raw["data"].items()) {
    if (!v.is_number() || !std::isfinite(v.num())) return std::nullopt;
    data.push_back(v.num());
  }
  const auto domain = [&](std::string_view k, double def) -> std::optional<std::vector<double>> {
    const Value& d = raw[k];
    if (d.is_null()) return std::vector<double>{def, def, def};
    std::vector<double> out;
    for (std::size_t i = 0; i < 3; ++i) {
      const Value& x = d[i];
      if (!x.is_number()) return std::nullopt;  // `undefined > x` / `x > undefined` is false: the check below fails
      out.push_back(x.num());
    }
    return out;
  };
  const auto dmin = domain("domainMin", 0);
  const auto dmax = domain("domainMax", 1);
  if (!dmin || !dmax) return std::nullopt;
  for (std::size_t i = 0; i < 3; ++i) {
    if (!((*dmax)[i] > (*dmin)[i])) return std::nullopt;
  }
  Args a;
  a("size", size)("size1d", size1d)("intensity", intensity).list("lut", std::move(data)).list("domainMin", *dmin).list("domainMax", *dmax);
  return a;
}
void apply_color_lut_fx(const Value& p, PixelPass& pass) {
  const double intensity = n(p, "intensity") / 100;
  if (!(intensity > 0)) return;
  const auto a = stored_lut(p["lut"], intensity);
  if (!a) return;
  run(pass, "apply-color-lut", *a);
}
void shadow_highlight_fx(const Value& p, PixelPass& pass) {
  const double s = n(p, "shadowAmount");
  const double hi = n(p, "highlightAmount");
  if (s == 0 && hi == 0) return;
  run(pass, "shadow-highlight", Args()("shadowAmount", s)("highlightAmount", hi)("radius", n(p, "radius"))("tonalWidth", n(p, "tonalWidth")));
}
void colorama_fx(const Value& p, PixelPass& pass) {
  run(pass, "colorama",
      Args()("palette", n(p, "palette"))("phaseShift", n(p, "phaseShift"))("cycleRepetitions", n(p, "cycleRepetitions"))(
          "blendWithOriginal", std::max(0.0, std::min(100.0, n(p, "blendWithOriginal"))) / 100));
}
void mosaic_fx(const Value& p, PixelPass& pass) {
  run(pass, "mosaic",
      Args()("hBlocks", n(p, "horizontalBlocks"))("vBlocks", n(p, "verticalBlocks"))("sharpColors", flag(p, "sharpColors", false) ? 1 : 0));
}
void find_edges_fx(const Value& p, PixelPass& pass) {
  const RgbaView img = pass.frame();
  const std::vector<std::uint8_t> src(img.data.begin(), img.data.end());
  find_edges(img, flag(p, "invert", true), pass.pool());
  // Blend With Original, in the wrapper: edges·(1 − blend) + src·blend into a Uint8ClampedArray.
  const double blend = std::max(0.0, std::min(100.0, n(p, "blendWithOriginal"))) / 100;
  if (blend > 0) {
    std::uint8_t* d = img.data.data();
    for (std::size_t i = 0; i < src.size(); i += 4) {
      for (std::size_t c = 0; c < 3; ++c) d[i + c] = u8c(d[i + c] * (1 - blend) + src[i + c] * blend);
    }
  }
}
void roughen_edges_fx(const Value& p, PixelPass& pass) {
  const double border = std::max(0.0, n(p, "border"));
  if (border <= 0) return;
  run(pass, "roughen-edges",
      Args()("border", border)("scale", n(p, "scale"))("complexity", n(p, "complexity"))("evolution", n(p, "evolution"))(
          "seed", n(p, "seed"))("edgeSharpness", n(p, "edgeSharpness")));
}
void gaussian_blur_fx(const Value& p, PixelPass& pass) {
  const double radius = std::max(0.0, n(p, "blurriness"));
  if (radius <= 0) return;
  run(pass, "gaussian-blur", Args()("radius", radius)("dimensions", n(p, "dimensions"))("repeatEdge", flag(p, "repeatEdge", true) ? 1 : 0));
}
void fast_box_blur_fx(const Value& p, PixelPass& pass) {
  const double radius = std::max(0.0, n(p, "blurRadius"));
  if (radius <= 0) return;
  run(pass, "fast-box-blur",
      Args()("radius", radius)("dimensions", n(p, "dimensions"))("iterations", n(p, "iterations"))(
          "repeatEdge", flag(p, "repeatEdge", true) ? 1 : 0));
}
void radial_blur_fx(const Value& p, PixelPass& pass) {
  const double amount = n(p, "amount");
  if (amount == 0) return;
  run(pass, "radial-blur",
      Args()("amount", amount)("centerX", cx_of(pass, p, "centerX"))("centerY", cy_of(pass, p, "centerY"))(
          "zoom", n(p, "blurType") == 1 ? 1 : 0)("quality", n(p, "quality")));
}
void wave_warp_fx(const Value& p, PixelPass& pass) {
  const double height = n(p, "waveHeight");
  if (height == 0) return;
  run(pass, "wave-warp",
      Args()("waveHeight", height)("waveWidth", std::max(2.0, n(p, "waveWidth")))("direction", n(p, "direction"))("phase", n(p, "phase")));
}
void turbulent_displace_fx(const Value& p, PixelPass& pass) {
  const double amount = n(p, "amount");
  if (amount == 0) return;
  run(pass, "turbulent-displace",
      Args()("amount", amount)("size", std::max(4.0, n(p, "size")))("complexity", n(p, "complexity"))("evolution", n(p, "evolution")));
}
void curl_noise_fx(const Value& p, PixelPass& pass) {
  const double amount = n(p, "amount");
  if (amount == 0) return;
  run(pass, "curl-noise",
      Args()("amount", amount)("size", std::max(4.0, n(p, "size")))("complexity", n(p, "complexity"))("evolution", n(p, "evolution")));
}
void sharpen_fx(const Value& p, PixelPass& pass) {
  const double amount = n(p, "amount") / 100;
  if (amount <= 0) return;
  run(pass, "sharpen", Args()("amount", amount));
}
void noise_fx(const Value& p, PixelPass& pass) {
  const double amount = n(p, "amount") / 100;
  if (amount <= 0) return;
  run(pass, "noise", Args()("amount", amount)("evolution", js::round(n(p, "evolution")))("mono", flag(p, "monochrome", true) ? 1 : 0));
}
void keylight_fx(const Value& p, PixelPass& pass) {
  run(pass, "keylight",
      Args().rgb("key", parse_hex(str(p, "screenColor", "#00ff00")))("balance", n(p, "balance") / 100)("gain", n(p, "gain") / 100)(
          "clipBlack", n(p, "clipBlack") / 100)("clipWhite", n(p, "clipWhite") / 100)("despill", n(p, "despill") / 100)(
          "choke", n(p, "choke"))("matteSoftness", n(p, "matteSoftness")));
}

// ── Round three ──
void photo_filter_fx(const Value& p, PixelPass& pass) {
  const double density = n(p, "density");
  if (density <= 0) return;
  run(pass, "photo-filter",
      Args().rgb("filter", parse_hex(str(p, "color", "#ec8a00")))("density", density)(
          "preserveLuminosity", flag(p, "preserveLuminosity", true) ? 1 : 0));
}
void black_and_white_fx(const Value& p, PixelPass& pass) {
  Args a;
  a("reds", n(p, "reds") / 100)("yellows", n(p, "yellows") / 100)("greens", n(p, "greens") / 100)("cyans", n(p, "cyans") / 100)(
      "blues", n(p, "blues") / 100)("magentas", n(p, "magentas") / 100);
  if (flag(p, "tint", false)) a("useTint", 1).rgb("tint", parse_hex(str(p, "tintColor", "#d8b48a")));
  else a("useTint", 0);
  run(pass, "black-and-white", a);
}
void tritone_fx(const Value& p, PixelPass& pass) {
  const double blend = n(p, "blend");
  if (blend >= 100) return;
  run(pass, "tritone",
      Args().rgb("shadows", parse_hex(str(p, "shadows", "#000000"))).rgb("midtones", parse_hex(str(p, "midtones", "#808080"))).rgb(
          "highlights", parse_hex(str(p, "highlights", "#ffffff")))("blend", blend));
}
void threshold_fx(const Value& p, PixelPass& pass) { run(pass, "threshold", Args()("level", n(p, "level"))); }
void polar_fx(const Value& p, PixelPass& pass) {
  const double interpolation = n(p, "interpolation");
  if (interpolation <= 0) return;
  run(pass, "polar-coordinates", Args()("interpolation", interpolation)("conversion", n(p, "conversion")));
}
void liquify_fx(const Value& p, PixelPass& pass) {
  run(pass, "liquify",
      Args()("centerX", cx_of(pass, p, "centerX"))("centerY", cy_of(pass, p, "centerY"))("radius", n(p, "brushSize"))("pushX", n(p, "pushX"))(
          "pushY", n(p, "pushY"))("twirl", n(p, "twirl"))("pinch", n(p, "pinch")));
}
void mesh_warp_fx(const Value& p, PixelPass& pass) {
  Args a;
  bool all_zero = true;
  for (int i = 0; i < 16; ++i) {  // MESH_WARP_N = 4
    const double x = n(p, "v" + std::to_string(i) + "X");
    const double y = n(p, "v" + std::to_string(i) + "Y");
    all_zero = all_zero && x == 0 && y == 0;
    a("mx" + std::to_string(i), x)("my" + std::to_string(i), y);
  }
  if (all_zero) return;
  run(pass, "mesh-warp", a);
}
void optics_fx(const Value& p, PixelPass& pass) {
  const double fov = n(p, "fieldOfView");
  if (fov <= 0) return;
  run(pass, "optics-compensation",
      Args()("fov", fov)("reverse", is_true(p, "reverse") ? 1 : 0)("centerX", n(p, "centerX"))("centerY", n(p, "centerY")));
}
void mirror_fx(const Value& p, PixelPass& pass) {
  run(pass, "mirror", Args()("centerX", cx_of(pass, p, "centerX"))("centerY", cy_of(pass, p, "centerY"))("angle", n(p, "angle")));
}
void offset_fx(const Value& p, PixelPass& pass) {
  const double blend = n(p, "blend");
  if (blend >= 100) return;
  run(pass, "offset", Args()("shiftX", cx_of(pass, p, "shiftX"))("shiftY", cy_of(pass, p, "shiftY"))("blend", blend));
}
void emboss_fx(const Value& p, PixelPass& pass) {
  const double blend = n(p, "blend");
  if (blend >= 100) return;
  run(pass, "emboss", Args()("angleDeg", n(p, "angle"))("relief", n(p, "relief"))("contrast", n(p, "contrast"))("blend", blend));
}
void scatter_fx(const Value& p, PixelPass& pass) {
  const double amount = n(p, "amount");
  if (amount <= 0) return;
  const double grain = n(p, "grain");
  run(pass, "scatter",
      Args()("amount", amount)("grain", grain >= 2 ? 2 : grain >= 1 ? 1 : 0)("seed", n(p, "seed"))("evolution", n(p, "evolution")));
}
void radial_wipe_fx(const Value& p, PixelPass& pass) {
  const double completion = n(p, "completion");
  if (completion <= 0) return;
  run(pass, "radial-wipe",
      Args()("completion", completion / 100)("startAngle", n(p, "startAngle"))("direction", n(p, "wipe"))(
          "centerX", cx_of(pass, p, "centerX"))("centerY", cy_of(pass, p, "centerY"))("feather", n(p, "feather")));
}
void block_dissolve_fx(const Value& p, PixelPass& pass) {
  const double completion = n(p, "completion");
  if (completion <= 0) return;
  run(pass, "block-dissolve",
      Args()("completion", completion / 100)("blockWidth", n(p, "blockWidth"))("blockHeight", n(p, "blockHeight"))(
          "feather", n(p, "feather"))("seed", n(p, "seed")));
}
void luma_key_fx(const Value& p, PixelPass& pass) {
  run(pass, "luma-key",
      Args()("keyType", n(p, "keyType"))("threshold", n(p, "threshold"))("tolerance", n(p, "tolerance"))("softness", n(p, "softness")));
}
void minimax_fx(const Value& p, PixelPass& pass) {
  const double radius = n(p, "radius");
  if (radius <= 0) return;
  const double direction = n(p, "direction");
  run(pass, "minimax",
      Args()("op", n(p, "operation"))("radius", radius)("channel", n(p, "channel"))(
          "direction", direction >= 2 ? 2 : direction >= 1 ? 1 : 0));
}
void channel_blur_fx(const Value& p, PixelPass& pass) {
  const double r = n(p, "redBlurriness");
  const double g = n(p, "greenBlurriness");
  const double b = n(p, "blueBlurriness");
  const double a = n(p, "alphaBlurriness");
  if (r <= 0 && g <= 0 && b <= 0 && a <= 0) return;
  run(pass, "channel-blur",
      Args()("red", r)("green", g)("blue", b)("alpha", a)("dimensions", n(p, "dimensions"))("repeatEdge", flag(p, "repeatEdge", false) ? 1 : 0));
}
void unsharp_mask_fx(const Value& p, PixelPass& pass) {
  const double amount = n(p, "amount");
  const double radius = n(p, "radius");
  if (amount <= 0 || radius <= 0) return;
  run(pass, "unsharp-mask", Args()("amount", amount)("radius", radius)("threshold", n(p, "threshold")));
}

// ── Round four ──
void bilateral_fx(const Value& p, PixelPass& pass) {
  const double radius = n(p, "radius");
  if (radius <= 0) return;
  run(pass, "bilateral-blur",
      Args()("radius", radius)("colorSigma", n(p, "colorSigma"))("preserveAlpha", flag(p, "preserveAlpha", true) ? 1 : 0));
}
void smart_blur_fx(const Value& p, PixelPass& pass) {
  const double radius = n(p, "radius");
  if (radius <= 0) return;
  run(pass, "smart-blur", Args()("radius", radius)("threshold", n(p, "threshold"))("mode", n(p, "mode")));
}
void camera_lens_fx(const Value& p, PixelPass& pass) {
  const double radius = n(p, "radius");
  if (radius <= 0) return;
  run(pass, "camera-lens-blur",
      Args()("radius", radius)("blades", n(p, "blades"))("rotation", n(p, "irisRotation"))("gain", n(p, "gain"))(
          "threshold", n(p, "highlightThreshold")));
}
void ripple_fx(const Value& p, PixelPass& pass) {
  if (n(p, "amplitude") == 0) return;
  run(pass, "ripple",
      Args()("centerX", n(p, "centerX"))("centerY", n(p, "centerY"))("radius", n(p, "radius"))("amplitude", n(p, "amplitude"))(
          "frequency", n(p, "frequency"))("phase", n(p, "phase"))("decay", n(p, "decay")));
}
void magnify_fx(const Value& p, PixelPass& pass) {
  run(pass, "magnify",
      Args()("centerX", n(p, "centerX"))("centerY", n(p, "centerY"))("magnification", n(p, "magnification"))("radius", n(p, "radius"))(
          "shape", n(p, "shape"))("feather", n(p, "feather")));
}
void warp_fx(const Value& p, PixelPass& pass) {
  run(pass, "warp",
      Args()("style", n(p, "style"))("bend", n(p, "bend"))("horizontal", n(p, "horizontalDistortion"))(
          "vertical", n(p, "verticalDistortion"))("axis", n(p, "warpAxis")));
}
void page_turn_fx(const Value& p, PixelPass& pass) {
  const double amount = n(p, "amount");
  if (amount <= 0) return;
  run(pass, "page-turn",
      Args()("amount", amount)("angle", n(p, "angle"))("radius", n(p, "curlRadius"))("backOpacity", n(p, "backOpacity"))(
          "shading", n(p, "shading")));
}
void split_fx(const Value& p, PixelPass& pass) {
  if (n(p, "splitOffset") == 0) return;
  run(pass, "split", Args()("offset", n(p, "splitOffset"))("angle", n(p, "angle"))("centerX", n(p, "centerX"))("centerY", n(p, "centerY")));
}
void slant_fx(const Value& p, PixelPass& pass) {
  if (n(p, "slant") == 0) return;
  run(pass, "slant", Args()("slant", n(p, "slant"))("axis", n(p, "slantAxis"))("floor", n(p, "floor")));
}
void smear_fx(const Value& p, PixelPass& pass) {
  run(pass, "smear",
      Args()("fromX", n(p, "fromX"))("fromY", n(p, "fromY"))("toX", n(p, "toX"))("toY", n(p, "toY"))("radius", n(p, "radius"))(
          "elasticity", n(p, "elasticity")));
}
void rolling_shutter_fx(const Value& p, PixelPass& pass) {
  if (n(p, "sweep") == 0 && n(p, "wobble") == 0) return;
  run(pass, "rolling-shutter",
      Args()("sweep", n(p, "sweep"))("wobble", n(p, "wobble"))("direction", n(p, "scanDirection"))(
          "vertical", flag(p, "verticalScan", false) ? 1 : 0));
}
void radial_shadow_fx(const Value& p, PixelPass& pass) {
  if (n(p, "shadowOpacity") <= 0) return;
  run(pass, "radial-shadow",
      Args()("lightX", n(p, "lightX"))("lightY", n(p, "lightY"))("projection", n(p, "projection")).rgb(
          "color", parse_hex(str(p, "shadowColor", "#000000")))("opacity", n(p, "shadowOpacity"))("softness", n(p, "softness"))(
          "renderMode", n(p, "renderMode")));
}
void cartoon_fx(const Value& p, PixelPass& pass) {
  run(pass, "cartoon",
      Args()("smoothness", n(p, "smoothness"))("levels", n(p, "levels"))("edgeThreshold", n(p, "edgeThreshold"))(
          "edgeWidth", n(p, "edgeWidth"))("edgeOpacity", n(p, "edgeOpacity")));
}
void brush_strokes_fx(const Value& p, PixelPass& pass) {
  if (n(p, "density") <= 0) return;
  run(pass, "brush-strokes",
      Args()("direction", n(p, "strokeAngle"))("length", n(p, "strokeLength"))("randomness", n(p, "randomness"))(
          "cellSize", n(p, "cellSize"))("density", n(p, "density")));
}
void strobe_fx(const Value& p, PixelPass& pass) {
  run(pass, "strobe-light",
      Args()("time", n(p, "time"))("period", n(p, "strobePeriod"))("duty", n(p, "strobeDuty"))("operation", n(p, "strobeOperation")).rgb(
          "color", parse_hex(str(p, "strobeColor", "#ffffff")))("intensity", n(p, "intensity")));
}
void color_emboss_fx(const Value& p, PixelPass& pass) {
  run(pass, "color-emboss",
      Args()("direction", n(p, "direction"))("relief", n(p, "relief"))("contrast", n(p, "contrast"))(
          "blendWithOriginal", n(p, "blendWithOriginal")));
}
void halftone_fx(const Value& p, PixelPass& pass) {
  run(pass, "halftone",
      Args()("cellSize", n(p, "cellSize"))("angle", n(p, "screenAngle"))("contrast", n(p, "contrast")).rgb(
          "ink", parse_hex(str(p, "inkColor", "#000000"))).rgb("paper", parse_hex(str(p, "paperColor", "#ffffff")))(
          "colorize", flag(p, "colorize", false) ? 1 : 0)("blendWithOriginal", n(p, "blendWithOriginal")));
}
void kaleidoscope_fx(const Value& p, PixelPass& pass) {
  run(pass, "kaleidoscope",
      Args()("segments", n(p, "segments"))("centerX", n(p, "centerX"))("centerY", n(p, "centerY"))("rotation", n(p, "rotation"))(
          "sourceAngle", n(p, "sourceAngle"))("zoom", n(p, "zoom")));
}
void vignette_fx(const Value& p, PixelPass& pass) {
  if (n(p, "amount") == 0) return;
  run(pass, "vignette",
      Args()("amount", n(p, "amount"))("size", n(p, "size"))("feather", n(p, "feather"))("roundness", n(p, "roundness"))(
          "centerX", n(p, "centerX"))("centerY", n(p, "centerY")));
}
void burn_film_fx(const Value& p, PixelPass& pass) {
  if (n(p, "burn") <= 0) return;
  run(pass, "burn-film",
      Args()("burn", n(p, "burn"))("centerX", n(p, "centerX"))("centerY", n(p, "centerY")).rgb(
          "burnColor", parse_hex(str(p, "burnColor", "#fff6e0"))).rgb("charColor", parse_hex(str(p, "charColor", "#3d1f0a")))(
          "randomness", n(p, "randomness"))("seed", n(p, "seed")));
}

// ── Round five ──
void star_burst_fx(const Value& p, PixelPass& pass) {
  run(pass, "star-burst",
      Args()("phase", n(p, "phase"))("amount", n(p, "amount"))("size", n(p, "size")).rgb("color", parse_hex(str(p, "starColor", "#ffffff")))(
          "blend", n(p, "blend"))("seed", n(p, "seed")));
}
void snowfall_fx(const Value& p, PixelPass& pass) {
  if (n(p, "amount") <= 0) return;
  run(pass, "snowfall",
      Args()("amount", n(p, "amount"))("size", n(p, "size"))("evolution", n(p, "evolution"))("wind", n(p, "wind"))(
          "opacity", n(p, "opacity")).rgb("color", parse_hex(str(p, "flakeColor", "#ffffff")))("seed", n(p, "seed")));
}
void rainfall_fx(const Value& p, PixelPass& pass) {
  if (n(p, "amount") <= 0) return;
  run(pass, "rainfall",
      Args()("amount", n(p, "amount"))("length", n(p, "length"))("angle", n(p, "angle"))("evolution", n(p, "evolution"))(
          "opacity", n(p, "opacity")).rgb("color", parse_hex(str(p, "rainColor", "#cfe6ff")))("seed", n(p, "seed")));
}
void write_on_fx(const Value& p, PixelPass& pass) {
  // writeOnUsesBrush: Mode ▸ Brush Position (0) is the recorded brush.
  const Value& mode = p["writeOnMode"];
  if (mode.is_number() && js::round(mode.num()) == 0) {
    const Value& color = p["brushColor"];
    run(pass, "write-on",
        Args()("mode", 0)("brushX", n(p, "brushPositionX"))("brushY", n(p, "brushPositionY"))
            .rgb("color", color.is_string() ? hex_rgb_prefix(color.str()) : Rgb3{255, 255, 255})("size", n(p, "brushSize"))(
                "hardness", n(p, "brushHardness"))("opacity", n(p, "brushOpacity"))("paintTimeProps", n(p, "paintTimeProps"))(
                "brushTimeProps", n(p, "brushTimeProps"))("paintStyle", n(p, "paintStyle"))(
                "filled", p["brushTrailFilled"].is_number() && p["brushTrailFilled"].num() == 1 ? 1 : 0)
            .list("brushTrailXY", numbers_of(p["brushTrailXY"]))
            .list("brushTrailSize", numbers_of(p["brushTrailSize"]))
            .list("brushTrailAttr", numbers_of(p["brushTrailAttr"])));
    return;
  }
  Args a;
  a("mode", 1)("completion", n(p, "completion"))("brushSize", n(p, "brushSize")).rgb("color", parse_hex(str(p, "brushColor", "#ffffff")))(
      "taper", n(p, "taper"));
  const Value& flat = p["pathPoints"];
  if (flat.is_array() && flat.size() >= 4) {
    // `flat as number[]`: a resolved polyline is numbers (a non-number would be NaN in the kernel's arithmetic).
    std::vector<double> pts;
    for (const auto& v : flat.items()) pts.push_back(v.is_number() ? v.num() : std::nan(""));
    a.list("pathPoints", std::move(pts));
  } else {
    a("startX", n(p, "startX"))("startY", n(p, "startY"))("endX", n(p, "endX"))("endY", n(p, "endY"))("wobble", n(p, "wobble"));
  }
  run(pass, "write-on", a);
}
void light_burst_fx(const Value& p, PixelPass& pass) {
  if (n(p, "intensity") <= 0) return;
  run(pass, "light-burst",
      Args()("centerX", n(p, "centerX"))("centerY", n(p, "centerY"))("intensity", n(p, "intensity"))("rayLength", n(p, "rayLength")));
}
void deep_glow_fx(const Value& p, PixelPass& pass) {
  // deepGlow.ts deepGlowSettings.
  static constexpr double kChromaSpread = 0.35;
  static constexpr std::array<double, 3> kOctaves{4, 6, 8};
  const double radius = std::max(0.0, n(p, "radius"));
  const double exposure = n(p, "exposure");
  const double threshold = std::max(0.0, std::min(1.0, n(p, "threshold") / 100));
  const double aspect = std::max(-100.0, std::min(100.0, n(p, "aspect"))) / 100;
  const double chroma = std::max(0.0, std::min(1.0, n(p, "chromatic") / 100));
  const Rgb3 t = hex_bytes(param_string(p, "tint"));
  const double q = js::round(n(p, "quality"));
  run(pass, "deep-glow",
      Args()("radius", radius)("gain", js::pow(2, exposure))("threshold", threshold)(
          "aspectX", aspect < 0 ? std::max(0.02, 1 + aspect) : 1)("aspectY", aspect > 0 ? std::max(0.02, 1 - aspect) : 1)(
          "chromaR", 1 + chroma * kChromaSpread)("chromaG", 1)("chromaB", std::max(0.05, 1 - chroma * kChromaSpread))(
          "tintR", srgb_to_linear01(t[0] / 255))("tintG", srgb_to_linear01(t[1] / 255))("tintB", srgb_to_linear01(t[2] / 255))(
          "tintAmount", std::max(0.0, std::min(1.0, n(p, "tintAmount") / 100)))("glowOnly", is_true(p, "glowOnly") ? 1 : 0)(
          "dither", p["dither"].is_bool() && !p["dither"].truthy() ? 0 : 1)(
          "octaves", kOctaves[static_cast<std::size_t>(std::max(0.0, std::min(2.0, q)))]));
}
/// beamPath.ts beamFlicker.
double beam_flicker(double phase, double rate, double seed, double depth) {
  if (depth <= 0) return 1;
  const double x = phase * std::max(0.0, rate);
  const double i = std::floor(x);
  const double f = x - i;
  const double u = f * f * (3 - 2 * f);
  const double nn = mixd(hash01u(ju32(i), 7, ju32(seed)), hash01u(ju32(i + 1), 7, ju32(seed)), u);
  return 1 - std::max(0.0, std::min(1.0, depth)) * nn;
}
void beam_path_fx(const Value& p, PixelPass& pass) {
  // beamPath.ts beamPathSettings (the spine resampled and centred by the kernel).
  static constexpr double kPenUp = 1e9;
  const double source = js::round(n(p, "source"));
  const Value& flat = p["pathPoints"];
  Args a;
  if (source != 1 && flat.is_array() && flat.size() >= 4) {
    std::vector<double> spine;
    for (const auto& v : flat.items()) spine.push_back(v.is_number() ? v.num() : kPenUp);
    a.list("pathPoints", std::move(spine));
  } else {
    a("startX", n(p, "startX"))("startY", n(p, "startY"))("endX", n(p, "endX"))("endY", n(p, "endY"));
  }
  const auto lin = [&](std::string_view k) {
    const Rgb3 b = hex_bytes(param_string(p, k));
    return Rgb3{srgb_to_linear01(b[0] / 255), srgb_to_linear01(b[1] / 255), srgb_to_linear01(b[2] / 255)};
  };
  const double start = clamp01(n(p, "start") / 100);
  const double end = clamp01(n(p, "end") / 100);
  a("coreWidth", std::max(0.0, n(p, "coreWidth")))("coreSoftness", clamp01(n(p, "coreSoftness") / 100))
      .rgb("coreColor", lin("coreColor"))
      .rgb("glowColor", lin("glowColor"))("glowSpread", std::max(0.5, n(p, "glowSpread")))(
          "glowIntensity", std::max(0.0, n(p, "glowIntensity") / 100))("glowExponent", 1 + 3 * clamp01(n(p, "glowBias") / 100))(
          "start", std::min(start, end))("end", std::max(start, end))("startSize", std::max(0.0, n(p, "startSize") / 100))(
          "endSize", std::max(0.0, n(p, "endSize") / 100))("distortion", std::max(0.0, n(p, "distortion")))(
          "distortionScale", std::max(4.0, n(p, "distortionScale")))("evolution", n(p, "evolution"))(
          "composite", js::round(n(p, "composite")))(
          "flicker", beam_flicker(n(p, "flickerPhase"), n(p, "flickerRate"), js::round(n(p, "seed")), clamp01(n(p, "flicker") / 100)));
  run(pass, "beam-path", a);
}
/// strokePaint.ts pickMaskPaths' index: '' / absent id → the first mask.
double pick_index(const Value& p) {
  const Value& id = p["pathMaskId"];
  const std::string s = id.is_string() ? id.str() : "";
  if (s.empty()) return 0;
  return p["pathMaskIndex"].is_number() ? p["pathMaskIndex"].num() : -1;
}
Args mask_lists(const Value& p) {
  Args a;
  a.list("maskPathsMeta", numbers_of(p["maskPathsMeta"])).list("maskPathsXY", numbers_of(p["maskPathsXY"]));
  a("pathMaskIndex", pick_index(p));
  return a;
}
void path_stroke_fx(const Value& p, PixelPass& pass) {
  Args a = mask_lists(p);
  a("allMasks", is_true(p, "allMasks") ? 1 : 0).rgb("color", hex_rgb_prefix(str(p, "color", "#ffffff")))("brushSize", n(p, "brushSize"))(
      "hardness", n(p, "brushHardness"))("opacity", n(p, "opacity"))("start", n(p, "start"))("end", n(p, "end"))("spacing", n(p, "spacing"))(
      "paintStyle", n(p, "paintStyle"))("sequential", is_true(p, "strokeSequentially") ? 1 : 0);
  run(pass, "path-stroke", a);
}
void scribble_fx(const Value& p, PixelPass& pass) {
  Args a = mask_lists(p);
  a("mode", n(p, "scribbleMode"))("fillType", n(p, "fillType"))("edgeWidth", n(p, "edgeWidth"))("endCap", n(p, "endCap"))(
      "join", n(p, "join"))("miterLimit", n(p, "miterLimit")).rgb("color", hex_rgb_prefix(str(p, "color", "#ffffff")))(
      "opacity", n(p, "opacity"))("angle", n(p, "angle"))("strokeWidth", n(p, "strokeWidth"))("curviness", n(p, "curviness"))(
      "curvinessVariation", n(p, "curvinessVariation"))("spacing", n(p, "spacing"))("spacingVariation", n(p, "spacingVariation"))(
      "pathOverlap", n(p, "pathOverlap"))("pathOverlapVariation", n(p, "pathOverlapVariation"))("start", n(p, "start"))(
      "end", n(p, "end"))("sequential", p["fillPathsSequentially"].is_bool() && !p["fillPathsSequentially"].truthy() ? 0 : 1)(
      "seed", n(p, "randomSeed"))("wiggleState", n(p, "wiggleState"))("smoothWiggle", js::round(n(p, "wiggleType")) == 2 ? 1 : 0)(
      "composite", n(p, "composite"));
  run(pass, "scribble", a);
}
void glass_fx(const Value& p, PixelPass& pass) {
  run(pass, "glass",
      Args()("bumpSoftness", n(p, "bumpSoftness"))("height", n(p, "height"))("displacement", n(p, "displacement"))(
          "lightAngle", n(p, "lightAngle"))("lightIntensity", n(p, "lightIntensity"))("shininess", n(p, "shininess")));
}
void texturize_fx(const Value& p, PixelPass& pass) {
  if (n(p, "contrast") <= 0) return;
  run(pass, "texturize",
      Args()("pattern", n(p, "pattern"))("contrast", n(p, "contrast"))("scale", n(p, "scale"))("lightAngle", n(p, "lightAngle")));
}
void threads_fx(const Value& p, PixelPass& pass) {
  run(pass, "threads", Args()("thickness", n(p, "thickness"))("spacing", n(p, "spacing"))("depth", n(p, "depth")));
}
void chromatic_fx(const Value& p, PixelPass& pass) {
  if (n(p, "amount") <= 0) return;
  run(pass, "chromatic-aberration",
      Args()("amount", n(p, "amount"))("aberrationMode", n(p, "aberrationMode"))("angle", n(p, "angle"))("falloff", n(p, "falloff"))(
          "centerX", n(p, "centerX"))("centerY", n(p, "centerY")));
}
void hex_tile_fx(const Value& p, PixelPass& pass) { run(pass, "hex-tile", Args()("radius", n(p, "radius"))("border", n(p, "border"))); }
void vector_blur_fx(const Value& p, PixelPass& pass) {
  if (n(p, "amount") <= 0) return;
  run(pass, "vector-blur", Args()("amount", n(p, "amount"))("angleOffset", n(p, "angleOffset"))("smoothness", n(p, "smoothness")));
}
void flo_motion_fx(const Value& p, PixelPass& pass) {
  run(pass, "flo-motion",
      Args()("knot1X", n(p, "knot1X"))("knot1Y", n(p, "knot1Y"))("knot1Amount", n(p, "knot1Amount"))("knot2X", n(p, "knot2X"))(
          "knot2Y", n(p, "knot2Y"))("knot2Amount", n(p, "knot2Amount"))("falloff", n(p, "falloff")));
}
void lens_fx(const Value& p, PixelPass& pass) {
  run(pass, "lens", Args()("centerX", n(p, "centerX"))("centerY", n(p, "centerY"))("size", n(p, "size"))("convergence", n(p, "convergence")));
}
void griddler_fx(const Value& p, PixelPass& pass) {
  run(pass, "griddler",
      Args()("tileSize", n(p, "tileSize"))("horizontalScale", n(p, "horizontalScale"))("verticalScale", n(p, "verticalScale"))(
          "rotation", n(p, "rotation")));
}
void ball_action_fx(const Value& p, PixelPass& pass) {
  run(pass, "ball-action", Args()("grid", n(p, "grid"))("ballSize", n(p, "ballSize"))("scatter", n(p, "scatter"))("seed", n(p, "seed")));
}
void drizzle_fx(const Value& p, PixelPass& pass) {
  if (n(p, "dripRate") <= 0) return;
  run(pass, "drizzle",
      Args()("dripRate", n(p, "dripRate"))("rippleHeight", n(p, "rippleHeight"))("spreading", n(p, "spreading"))(
          "evolution", n(p, "evolution"))("seed", n(p, "seed")));
}
void jaws_fx(const Value& p, PixelPass& pass) {
  if (n(p, "completion") <= 0) return;
  run(pass, "jaws",
      Args()("completion", n(p, "completion"))("direction", n(p, "direction"))("teethHeight", n(p, "teethHeight"))(
          "teethWidth", n(p, "teethWidth")));
}
void pixel_polly_fx(const Value& p, PixelPass& pass) {
  if (n(p, "completion") <= 0) return;
  run(pass, "pixel-polly",
      Args()("completion", n(p, "completion"))("cellSize", n(p, "cellSize"))("gravity", n(p, "gravity"))("spin", n(p, "spin"))(
          "centerX", n(p, "centerX"))("centerY", n(p, "centerY"))("seed", n(p, "seed")));
}
void twister_fx(const Value& p, PixelPass& pass) {
  if (n(p, "completion") <= 0) return;
  run(pass, "twister", Args()("completion", n(p, "completion"))("centerY", n(p, "centerY"))("twist", n(p, "twist")));
}
void card_dance_fx(const Value& p, PixelPass& pass) {
  if (n(p, "amount") <= 0) return;
  run(pass, "card-dance",
      Args()("rows", n(p, "rows"))("columns", n(p, "columns"))("amount", n(p, "amount"))("cardRotation", n(p, "cardRotation"))(
          "phase", n(p, "phase")));
}

// ── Colour ──
void equalize_fx(const Value& p, PixelPass& pass) {
  if (n(p, "amount") <= 0) return;
  run(pass, "equalize", Args()("mode", n(p, "equalizeMode"))("amount", n(p, "amount"))("blend", n(p, "blend")));
}
void auto_levels_fx(const Value& p, PixelPass& pass) {
  run(pass, "auto-levels", Args()("blackClip", n(p, "blackClip"))("whiteClip", n(p, "whiteClip"))("blend", n(p, "blend")));
}
void auto_contrast_fx(const Value& p, PixelPass& pass) {
  run(pass, "auto-contrast", Args()("blackClip", n(p, "blackClip"))("whiteClip", n(p, "whiteClip"))("blend", n(p, "blend")));
}
void auto_color_fx(const Value& p, PixelPass& pass) {
  run(pass, "auto-color",
      Args()("blackClip", n(p, "blackClip"))("whiteClip", n(p, "whiteClip"))("snapNeutral", n(p, "snapNeutral"))("blend", n(p, "blend")));
}
void change_color_fx(const Value& p, PixelPass& pass) {
  run(pass, "change-color",
      Args().rgb("target", parse_hex(str(p, "targetColor", "#ff0000")))("hueTol", n(p, "hueTolerance"))("satTol", n(p, "satTolerance"))(
          "lightTol", n(p, "lightTolerance"))("softness", n(p, "softness"))("hueShift", n(p, "hueShift"))("satScale", n(p, "satScale"))(
          "lightScale", n(p, "lightScale"))("invert", flag(p, "invertSelection", false) ? 1 : 0));
}
void change_to_color_fx(const Value& p, PixelPass& pass) {
  run(pass, "change-to-color",
      Args().rgb("from", parse_hex(str(p, "fromColor", "#ff0000"))).rgb("to", parse_hex(str(p, "toColor", "#0055ff")))(
          "hueTol", n(p, "hueTolerance"))("satTol", n(p, "satTolerance"))("lightTol", n(p, "lightTolerance"))("softness", n(p, "softness"))(
          "preserveLightness", flag(p, "preserveLightness", true) ? 1 : 0));
}
void leave_color_fx(const Value& p, PixelPass& pass) {
  if (n(p, "amount") <= 0) return;
  run(pass, "leave-color",
      Args().rgb("target", parse_hex(str(p, "targetColor", "#ff0000")))("tolerance", n(p, "tolerance"))("softness", n(p, "softness"))(
          "amount", n(p, "amount")));
}
void toner_fx(const Value& p, PixelPass& pass) {
  run(pass, "toner",
      Args().rgb("black", parse_hex(str(p, "blackTone", "#000000"))).rgb("shadows", parse_hex(str(p, "shadowTone", "#2a2a45"))).rgb(
          "midtones", parse_hex(str(p, "midTone", "#8a7a63"))).rgb("highlights", parse_hex(str(p, "highlightTone", "#e8d9b8"))).rgb(
          "white", parse_hex(str(p, "whiteTone", "#ffffff")))("blend", n(p, "blend")));
}

// ── Keying & Channel ──
void color_key_fx(const Value& p, PixelPass& pass) {
  run(pass, "color-key",
      Args().rgb("key", parse_hex(str(p, "keyColor", "#00ff00")))("tolerance", n(p, "tolerance"))("edgeSoftness", n(p, "edgeSoftness")));
}
void color_range_fx(const Value& p, PixelPass& pass) {
  run(pass, "color-range",
      Args().rgb("key", parse_hex(str(p, "keyColor", "#00ff00")))("space", n(p, "colorSpace"))("minTol", n(p, "minTolerance"))(
          "maxTol", n(p, "maxTolerance"))("lumaWeight", n(p, "lumaWeight")));
}
void extract_fx(const Value& p, PixelPass& pass) {
  run(pass, "extract",
      Args()("channel", n(p, "extractChannel"))("black", n(p, "blackPoint"))("white", n(p, "whitePoint"))("blackSoft", n(p, "blackSoftness"))(
          "whiteSoft", n(p, "whiteSoftness"))("invert", flag(p, "invertExtract", false) ? 1 : 0));
}
void spill_fx(const Value& p, PixelPass& pass) {
  if (n(p, "amount") <= 0) return;
  run(pass, "spill-suppressor",
      Args().rgb("key", parse_hex(str(p, "keyColor", "#00ff00")))("amount", n(p, "amount"))(
          "preserveLuma", flag(p, "preserveLuma", true) ? 1 : 0));
}
void matte_choker_fx(const Value& p, PixelPass& pass) {
  run(pass, "matte-choker",
      Args()("spread", n(p, "spread"))("choke", n(p, "choke"))("softness", n(p, "softness"))("iterations", n(p, "iterations")));
}
void alpha_levels_fx(const Value& p, PixelPass& pass) {
  run(pass, "alpha-levels",
      Args()("inBlack", n(p, "inBlack"))("inWhite", n(p, "inWhite"))("gamma", n(p, "gamma"))("outBlack", n(p, "outBlack"))(
          "outWhite", n(p, "outWhite")));
}
void solid_composite_fx(const Value& p, PixelPass& pass) {
  run(pass, "solid-composite",
      Args().rgb("color", parse_hex(str(p, "solidColor", "#000000")))("sourceOpacity", n(p, "sourceOpacity"))(
          "solidOpacity", n(p, "solidOpacity"))("mode", n(p, "compositeMode")));
}
void channel_combiner_fx(const Value& p, PixelPass& pass) { run(pass, "channel-combiner", Args()("mode", n(p, "combinerMode"))); }
void remove_matting_fx(const Value& p, PixelPass& pass) {
  if (n(p, "amount") <= 0) return;
  run(pass, "remove-color-matting",
      Args().rgb("bg", parse_hex(str(p, "backgroundColor", "#000000")))("threshold", n(p, "threshold"))("amount", n(p, "amount")));
}

// ── Transition & Noise ──
void iris_wipe_fx(const Value& p, PixelPass& pass) {
  const double completion = n(p, "completion");
  const bool inv = flag(p, "invertIris", false);
  if (completion <= 0 && !inv) return;
  run(pass, "iris-wipe",
      Args()("completion", completion)("centerX", n(p, "centerX"))("centerY", n(p, "centerY"))("points", n(p, "irisPoints"))(
          "rotation", n(p, "rotation"))("innerRadius", n(p, "innerRadius"))("useInnerRadius", flag(p, "useInnerRadius", false) ? 1 : 0)(
          "feather", n(p, "feather"))("invert", inv ? 1 : 0));
}
void light_wipe_fx(const Value& p, PixelPass& pass) {
  const double completion = n(p, "completion");
  if (completion <= 0) return;
  run(pass, "light-wipe",
      Args()("completion", completion)("shape", n(p, "wipeShape"))("angle", n(p, "angle"))("centerX", n(p, "centerX"))(
          "centerY", n(p, "centerY"))("width", n(p, "lightWidth")).rgb("color", parse_hex(str(p, "lightColor", "#ffffff")))(
          "intensity", n(p, "intensity"))("feather", n(p, "feather")));
}
void line_sweep_fx(const Value& p, PixelPass& pass) {
  const double completion = n(p, "completion");
  const bool inv = flag(p, "invertSweep", false);
  if (completion <= 0 && !inv) return;
  run(pass, "line-sweep",
      Args()("completion", completion)("lineCount", n(p, "lineCount"))("angle", n(p, "angle"))("stagger", n(p, "stagger"))(
          "feather", n(p, "feather"))("invert", inv ? 1 : 0));
}
void grid_wipe_fx(const Value& p, PixelPass& pass) {
  const double completion = n(p, "completion");
  const bool inv = flag(p, "invertGrid", false);
  if (completion <= 0 && !inv) return;
  run(pass, "grid-wipe",
      Args()("completion", completion)("columns", n(p, "columns"))("rows", n(p, "rows"))("shape", n(p, "tileShape"))(
          "random", n(p, "randomSeed"))("feather", n(p, "feather"))("invert", inv ? 1 : 0));
}
void dust_fx(const Value& p, PixelPass& pass) { run(pass, "dust-scratches", Args()("radius", n(p, "radius"))("threshold", n(p, "threshold"))); }
void noise_alpha_fx(const Value& p, PixelPass& pass) {
  if (n(p, "amount") <= 0) return;
  run(pass, "noise-alpha",
      Args()("amount", n(p, "amount"))("uniform", flag(p, "uniformNoise", true) ? 1 : 0)("seed", n(p, "seed"))("phase", n(p, "noisePhase"))(
          "clipResult", flag(p, "clipResult", true) ? 1 : 0));
}

// ── Round six ──
void unmult_fx(const Value& p, PixelPass& pass) { run(pass, "unmult", Args()("threshold", n(p, "threshold"))("boost", n(p, "boost"))); }
void cc_composite_fx(const Value& p, PixelPass& pass) {
  const double opacity = n(p, "opacity");
  if (opacity <= 0) return;
  run(pass, "cc-composite", Args()("opacity", opacity)("blendMode", n(p, "blendMode"))("rgbOnly", flag(p, "rgbOnly", false) ? 1 : 0));
}
void cc_scatterize_fx(const Value& p, PixelPass& pass) {
  const double amount = n(p, "amount");
  if (amount <= 0) return;
  run(pass, "cc-scatterize",
      Args()("amount", amount)("windX", n(p, "windX"))("windY", n(p, "windY"))("twist", n(p, "twist"))("seed", n(p, "seed")));
}
void radial_fast_blur_fx(const Value& p, PixelPass& pass) {
  const double amount = n(p, "amount");
  if (amount <= 0) return;
  run(pass, "radial-fast-blur", Args()("amount", amount)("centerX", n(p, "centerX"))("centerY", n(p, "centerY"))("mode", n(p, "zoomMode")));
}
void cross_blur_fx(const Value& p, PixelPass& pass) {
  const double rx = n(p, "radiusX");
  const double ry = n(p, "radiusY");
  if (rx <= 0 && ry <= 0) return;
  run(pass, "cross-blur", Args()("radiusX", rx)("radiusY", ry)("repeatEdges", flag(p, "repeatEdges", true) ? 1 : 0));
}
void scale_wipe_fx(const Value& p, PixelPass& pass) {
  const double comp = n(p, "completion");
  if (comp <= 0) return;
  run(pass, "scale-wipe",
      Args()("completion", comp)("stretch", n(p, "stretch"))("direction", n(p, "direction"))("centerX", n(p, "centerX"))(
          "centerY", n(p, "centerY")));
}
void plastic_fx(const Value& p, PixelPass& pass) {
  run(pass, "plastic",
      Args()("surfaceBump", n(p, "surfaceBump"))("softness", n(p, "softness"))("lightAngle", n(p, "lightAngle"))(
          "lightIntensity", n(p, "lightIntensity"))("specular", n(p, "specular")));
}

// ── Round seven ──
void cc_tiler_fx(const Value& p, PixelPass& pass) {
  const double scale = n(p, "scale");
  if (scale >= 100 && n(p, "centerX") == 0 && n(p, "centerY") == 0) return;
  run(pass, "cc-tiler",
      Args()("scale", scale)("centerX", n(p, "centerX"))("centerY", n(p, "centerY"))("blendWithOriginal", n(p, "blendWithOriginal")));
}
void ripple_pulse_fx(const Value& p, PixelPass& pass) {
  if (n(p, "amplitude") == 0) return;
  run(pass, "ripple-pulse",
      Args()("centerX", n(p, "centerX"))("centerY", n(p, "centerY"))("pulseRadius", n(p, "pulseRadius"))("amplitude", n(p, "amplitude"))(
          "width", n(p, "width"))("renderBump", flag(p, "renderBump", true) ? 1 : 0));
}
void radial_scale_wipe_fx(const Value& p, PixelPass& pass) {
  if (n(p, "completion") <= 0) return;
  run(pass, "radial-scale-wipe",
      Args()("completion", n(p, "completion"))("centerX", n(p, "centerX"))("centerY", n(p, "centerY"))(
          "reverse", flag(p, "reverse", false) ? 1 : 0));
}
void glass_wipe_fx(const Value& p, PixelPass& pass) {
  if (n(p, "completion") <= 0) return;
  run(pass, "glass-wipe", Args()("completion", n(p, "completion"))("displacement", n(p, "displacement"))("softness", n(p, "softness")));
}
void image_wipe_fx(const Value& p, PixelPass& pass) {
  if (n(p, "completion") <= 0) return;
  run(pass, "image-wipe",
      Args()("completion", n(p, "completion"))("borderSoftness", n(p, "borderSoftness"))(
          "gradientChannel", std::max(0.0, std::min(4.0, js::round(n(p, "gradientChannel")))))(
          "invertGradient", flag(p, "invertGradient", false) ? 1 : 0));
}
void color_difference_key_fx(const Value& p, PixelPass& pass) {
  run(pass, "color-difference-key",
      Args().rgb("key", parse_hex(str(p, "keyColor", "#00ff00")))("matteInBlack", n(p, "matteInBlack"))("matteInWhite", n(p, "matteInWhite"))(
          "matteGamma", n(p, "matteGamma"))("viewMode", js::round(n(p, "viewMode"))));
}
void wire_removal_fx(const Value& p, PixelPass& pass) {
  run(pass, "wire-removal",
      Args()("pointAX", n(p, "pointAX"))("pointAY", n(p, "pointAY"))("pointBX", n(p, "pointBX"))("pointBY", n(p, "pointBY"))(
          "thickness", n(p, "thickness"))("slope", n(p, "slope")));
}
void broadcast_fx(const Value& p, PixelPass& pass) {
  run(pass, "broadcast-colors",
      Args()("standard", js::round(n(p, "standard")))("how", js::round(n(p, "howToMakeColorSafe")))(
          "maxSignalAmplitude", n(p, "maxSignalAmplitude")));
}
void noise_hls_fx(const Value& p, PixelPass& pass) {
  const double hue = n(p, "hue");
  const double lightness = n(p, "lightness");
  const double saturation = n(p, "saturation");
  if (hue <= 0 && lightness <= 0 && saturation <= 0) return;
  run(pass, "noise-hls",
      Args()("noiseType", js::round(n(p, "noiseType")))("hue", hue)("lightness", lightness)("saturation", saturation)(
          "grainSize", n(p, "grainSize"))("noisePhase", n(p, "noisePhase")));
}
void block_load_fx(const Value& p, PixelPass& pass) {
  if (n(p, "completion") >= 100) return;
  run(pass, "block-load", Args()("completion", n(p, "completion"))("scans", n(p, "scans"))("blockSize", n(p, "blockSize")));
}
void kernel_fx(const Value& p, PixelPass& pass) {
  static constexpr std::array<std::string_view, 9> kK{"k00", "k01", "k02", "k10", "k11", "k12", "k20", "k21", "k22"};
  const double divisor = n(p, "divisor");
  const double offset = n(p, "offset");
  bool identity = divisor == 1 && offset == 0;
  Args a;
  for (std::size_t i = 0; i < 9; ++i) {
    const double v = n(p, kK[i]);
    identity = identity && v == (i == 4 ? 1 : 0);
    a(std::string(kK[i]), v);
  }
  if (identity) return;
  a("divisor", divisor)("offset", offset);
  run(pass, "kernel", a);
}
void glasses_3d_fx(const Value& p, PixelPass& pass) {
  run(pass, "3d-glasses",
      Args()("convergenceOffset", n(p, "convergenceOffset"))("view", js::round(n(p, "view")))("balance", n(p, "balance"))(
          "swapLeftRight", flag(p, "swapLeftRight", false) ? 1 : 0));
}
void fractal_fx(const Value& p, PixelPass& pass) {
  run(pass, "fractal",
      Args()("setType", js::round(n(p, "setType")))("centerX", n(p, "centerX"))("centerY", n(p, "centerY"))(
          "magnification", n(p, "magnification"))("iterations", n(p, "iterations"))("juliaX", n(p, "juliaX"))("juliaY", n(p, "juliaY"))(
          "colorPhase", n(p, "colorPhase"))("colorCycles", n(p, "colorCycles")).rgb("inside", parse_hex(str(p, "insideColor", "#000000"))));
}
void particle_systems_fx(const Value& p, PixelPass& pass) {
  if (n(p, "birthRate") <= 0) return;
  const double animation = js::round(n(p, "animation"));
  run(pass, "particle-systems",
      Args()("time", n(p, "time"))("birthRate", n(p, "birthRate"))("longevity", n(p, "longevity"))("producerX", n(p, "producerX"))(
          "producerY", n(p, "producerY"))("producerRadiusX", n(p, "producerRadiusX"))("producerRadiusY", n(p, "producerRadiusY"))(
          "animation", animation)("direction", animation == 2 && n(p, "direction") == 0 ? 270 : n(p, "direction"))(
          "spread", n(p, "spread"))("velocity", n(p, "velocity"))("velocityVariation", n(p, "velocityVariation"))(
          "gravity", n(p, "gravity"))("resistance", n(p, "resistance"))("birthSize", n(p, "birthSize"))("deathSize", n(p, "deathSize"))(
          "sizeVariation", n(p, "sizeVariation")).rgb("birth", parse_hex(str(p, "birthColor", "#ffe27a"))).rgb(
          "death", parse_hex(str(p, "deathColor", "#ff3b00")))("opacity", n(p, "opacity"))("blend", js::round(n(p, "blend")))(
          "seed", std::floor(n(p, "seed"))));
}
void bubbles_fx(const Value& p, PixelPass& pass) {
  if (n(p, "bubbleAmount") <= 0 || n(p, "opacity") <= 0) return;
  run(pass, "cc-bubbles",
      Args()("bubbleAmount", n(p, "bubbleAmount"))("bubbleSpeed", n(p, "bubbleSpeed"))("wobbleAmplitude", n(p, "wobbleAmplitude"))(
          "wobbleFrequency", n(p, "wobbleFrequency"))("bubbleSize", n(p, "bubbleSize"))("sizeVariation", n(p, "sizeVariation"))(
          "shading", js::round(n(p, "shading"))).rgb("color", parse_hex(str(p, "color", "#ffffff")))("opacity", n(p, "opacity"))(
          "evolution", n(p, "evolution"))("seed", n(p, "seed")));
}

constexpr std::array<std::pair<std::string_view, Adapter>, 139> kAdapters{{
    {"venetian-blinds", venetian_blinds},
    {"gradient-wipe", gradient_wipe},
    {"card-wipe", card_wipe},
    {"simple-choker", simple_choker_fx},
    {"linear-color-key", linear_color_key_fx},
    {"shift-channels", shift_channels_fx},
    {"vibrance", vibrance_fx},
    {"bulge", bulge_fx},
    {"twirl", twirl_fx},
    {"spherize", spherize_fx},
    {"corner-pin", corner_pin_fx},
    {"bezier-warp", bezier_warp_fx},
    {"cell-pattern", cell_pattern_fx},
    {"turbulent-noise", turbulent_noise_fx},
    {"add-grain", add_grain_fx},
    {"median", median_fx},
    {"selective-color", selective_color_fx},
    {"apply-color-lut", apply_color_lut_fx},
    {"shadow-highlight", shadow_highlight_fx},
    {"colorama", colorama_fx},
    {"mosaic", mosaic_fx},
    {"find-edges", find_edges_fx},
    {"roughen-edges", roughen_edges_fx},
    {"gaussian-blur", gaussian_blur_fx},
    {"fast-box-blur", fast_box_blur_fx},
    {"radial-blur", radial_blur_fx},
    {"wave-warp", wave_warp_fx},
    {"turbulent-displace", turbulent_displace_fx},
    {"curl-noise", curl_noise_fx},
    {"sharpen", sharpen_fx},
    {"noise", noise_fx},
    {"keylight", keylight_fx},
    {"photo-filter", photo_filter_fx},
    {"black-and-white", black_and_white_fx},
    {"tritone", tritone_fx},
    {"threshold", threshold_fx},
    {"polar-coordinates", polar_fx},
    {"liquify", liquify_fx},
    {"mesh-warp", mesh_warp_fx},
    {"optics-compensation", optics_fx},
    {"mirror", mirror_fx},
    {"offset", offset_fx},
    {"emboss", emboss_fx},
    {"scatter", scatter_fx},
    {"radial-wipe", radial_wipe_fx},
    {"block-dissolve", block_dissolve_fx},
    {"luma-key", luma_key_fx},
    {"minimax", minimax_fx},
    {"channel-blur", channel_blur_fx},
    {"unsharp-mask", unsharp_mask_fx},
    {"bilateral-blur", bilateral_fx},
    {"smart-blur", smart_blur_fx},
    {"camera-lens-blur", camera_lens_fx},
    {"ripple", ripple_fx},
    {"magnify", magnify_fx},
    {"warp", warp_fx},
    {"page-turn", page_turn_fx},
    {"split", split_fx},
    {"slant", slant_fx},
    {"smear", smear_fx},
    {"rolling-shutter", rolling_shutter_fx},
    {"radial-shadow", radial_shadow_fx},
    {"cartoon", cartoon_fx},
    {"brush-strokes", brush_strokes_fx},
    {"strobe-light", strobe_fx},
    {"color-emboss", color_emboss_fx},
    {"halftone", halftone_fx},
    {"kaleidoscope", kaleidoscope_fx},
    {"vignette", vignette_fx},
    {"burn-film", burn_film_fx},
    {"equalize", equalize_fx},
    {"auto-levels", auto_levels_fx},
    {"auto-contrast", auto_contrast_fx},
    {"auto-color", auto_color_fx},
    {"change-color", change_color_fx},
    {"change-to-color", change_to_color_fx},
    {"leave-color", leave_color_fx},
    {"toner", toner_fx},
    {"color-key", color_key_fx},
    {"color-range", color_range_fx},
    {"extract", extract_fx},
    {"spill-suppressor", spill_fx},
    {"matte-choker", matte_choker_fx},
    {"alpha-levels", alpha_levels_fx},
    {"solid-composite", solid_composite_fx},
    {"channel-combiner", channel_combiner_fx},
    {"remove-color-matting", remove_matting_fx},
    {"iris-wipe", iris_wipe_fx},
    {"light-wipe", light_wipe_fx},
    {"line-sweep", line_sweep_fx},
    {"grid-wipe", grid_wipe_fx},
    {"dust-scratches", dust_fx},
    {"noise-alpha", noise_alpha_fx},
    {"star-burst", star_burst_fx},
    {"snowfall", snowfall_fx},
    {"rainfall", rainfall_fx},
    {"write-on", write_on_fx},
    {"light-burst", light_burst_fx},
    {"deep-glow", deep_glow_fx},
    {"beam-path", beam_path_fx},
    {"path-stroke", path_stroke_fx},
    {"scribble", scribble_fx},
    {"glass", glass_fx},
    {"texturize", texturize_fx},
    {"threads", threads_fx},
    {"chromatic-aberration", chromatic_fx},
    {"hex-tile", hex_tile_fx},
    {"vector-blur", vector_blur_fx},
    {"flo-motion", flo_motion_fx},
    {"lens", lens_fx},
    {"griddler", griddler_fx},
    {"ball-action", ball_action_fx},
    {"drizzle", drizzle_fx},
    {"jaws", jaws_fx},
    {"pixel-polly", pixel_polly_fx},
    {"twister", twister_fx},
    {"card-dance", card_dance_fx},
    {"unmult", unmult_fx},
    {"cc-composite", cc_composite_fx},
    {"cc-scatterize", cc_scatterize_fx},
    {"radial-fast-blur", radial_fast_blur_fx},
    {"cross-blur", cross_blur_fx},
    {"scale-wipe", scale_wipe_fx},
    {"plastic", plastic_fx},
    {"cc-tiler", cc_tiler_fx},
    {"ripple-pulse", ripple_pulse_fx},
    {"radial-scale-wipe", radial_scale_wipe_fx},
    {"glass-wipe", glass_wipe_fx},
    {"image-wipe", image_wipe_fx},
    {"color-difference-key", color_difference_key_fx},
    {"wire-removal", wire_removal_fx},
    {"broadcast-colors", broadcast_fx},
    {"noise-hls", noise_hls_fx},
    {"block-load", block_load_fx},
    {"kernel", kernel_fx},
    {"3d-glasses", glasses_3d_fx},
    {"fractal", fractal_fx},
    {"particle-systems", particle_systems_fx},
    {"cc-bubbles", bubbles_fx},
}};

const Adapter* find_adapter(std::string_view type) noexcept {
  for (const auto& [name, fn] : kAdapters) {
    if (name == type) return &fn;
  }
  return nullptr;
}

}  // namespace

bool is_pixel_effect(std::string_view type) noexcept { return find_adapter(type) != nullptr; }

bool apply_pixel_effect(std::string_view type, const Value& params, PixelPass& pass) {
  const Adapter* fn = find_adapter(type);
  if (fn == nullptr) return false;
  (*fn)(params, pass);
  return true;
}

std::span<const std::string_view> pixel_effect_types() noexcept {
  static const std::vector<std::string_view> names = [] {
    std::vector<std::string_view> v;
    for (const auto& [name, fn] : kAdapters) v.push_back(name);
    return v;
  }();
  return names;
}

}  // namespace premation::effects
