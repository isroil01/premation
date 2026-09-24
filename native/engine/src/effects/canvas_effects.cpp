// Canvas-drawn effects (see canvas_effects.hpp), ported from
// canvas2dEffects.ts (fill, linear wipe), generatePatterns.ts (checkerboard,
// grid) and generateAdvanced.ts (circle, ellipse, radio waves, light rays,
// light sweep). Each keeps the TS's call order, its V8 Math (motion_jsmath)
// and its colour strings, so its Canvas2D program is the TS's
// (tests/test_canvas_effects.cpp, against canvasEffectsCrossEngine.test.ts).

#include "canvas_effects.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdlib>
#include <cmath>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "jsmath.hpp"
#include "numconv.hpp"
#include "pixel_ops.hpp"
#include "raster/css.hpp"

namespace premation::effects {
namespace {

using raster::Canvas2D;
using raster::Gradient;
using raster::Style;
using raster::json::Value;

constexpr double kPi = 3.141592653589793;  // Math.PI

// ── the TS param helpers ─────────────────────────────────────────────────────

/// effectNumber: the param when it is a number, else 0.
double num(const Value& p, std::string_view k) {
  const Value& v = p[k];
  return v.is_number() ? v.num() : 0;
}
/// str(e, k, fallback).
std::string str(const Value& p, std::string_view k, std::string_view fb) {
  const Value& v = p[k];
  return v.is_string() ? v.str() : std::string(fb);
}
/// bool(e, k, fallback).
bool flag(const Value& p, std::string_view k, bool fb) {
  const Value& v = p[k];
  return v.is_bool() ? v.truthy() : fb;
}

/// @utils/lang clamp01: NaN → 0.
double clamp01_lang(double v) { return v > 0 ? (v > 1 ? 1 : v) : 0; }
/// colorSpace.ts clamp01: NaN passes through.
double clamp01_cs(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

double cos_js(double x) { return motion::js::cos(x); }
double sin_js(double x) { return motion::js::sin(x); }
std::string js(double v) { return motion::js::number_to_string(v); }

/// fillStyle / strokeStyle / shadowColor = <css string>: the canvas ignores what it cannot parse.
void fill_css(Canvas2D& c, std::string_view css) {
  if (const auto col = raster::css::parse_color(css)) {
    Style s;
    s.color = *col;
    c.setFillStyle(s);
  }
}
void stroke_css(Canvas2D& c, std::string_view css) {
  if (const auto col = raster::css::parse_color(css)) {
    Style s;
    s.color = *col;
    c.setStrokeStyle(s);
  }
}

/// generateAdvanced.ts rgba(hex, alpha): `#rrggbb` / `#rgb` → rgba(r,g,b,alpha), else mid grey.
std::string rgba(const std::string& hex, double alpha) {
  std::string s = hex;
  const auto issp = [](unsigned char ch) { return std::isspace(ch) != 0; };
  while (!s.empty() && issp(static_cast<unsigned char>(s.back()))) s.pop_back();
  std::size_t b = 0;
  while (b < s.size() && issp(static_cast<unsigned char>(s[b]))) ++b;
  s = s.substr(b);
  const auto hexv = [](char ch) {
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
  };
  const auto all_hex = [&](std::string_view h) { return std::ranges::all_of(h, [&](char ch) { return hexv(ch) >= 0; }); };
  std::string full;
  if (s.size() == 7 && s[0] == '#' && all_hex(std::string_view(s).substr(1))) {
    full = s.substr(1);
  } else if (s.size() == 4 && s[0] == '#' && all_hex(std::string_view(s).substr(1))) {
    for (std::size_t i = 1; i < 4; ++i) full += std::string(2, s[i]);
  } else {
    return "rgba(128,128,128," + js(alpha) + ")";
  }
  int n = 0;
  for (const char ch : full) n = n * 16 + hexv(ch);
  return "rgba(" + std::to_string((n >> 16) & 255) + "," + std::to_string((n >> 8) & 255) + "," + std::to_string(n & 255) + "," +
         js(alpha) + ")";
}

/// A gradient under construction: CanvasGradient's addColorStop (unparseable colours ignored).
struct Grad {
  std::shared_ptr<Gradient> g = std::make_shared<Gradient>();
  void stop(double offset, std::string_view css) const {
    if (const auto col = raster::css::parse_color(css)) g->add_stop(offset, *col);
  }
  [[nodiscard]] Style style() const {
    Style s;
    s.kind = Style::Kind::gradient;
    s.gradient = g;
    return s;
  }
};
Grad radial(double x0, double y0, double r0, double x1, double y1, double r1) {
  Grad out;
  out.g->kind = Gradient::Kind::radial;
  out.g->p = {x0, y0, r0, x1, y1, r1};
  return out;
}
Grad linear(double x0, double y0, double x1, double y1) {
  Grad out;
  out.g->kind = Gradient::Kind::linear;
  out.g->p = {x0, y0, x1, y1, 0, 0};
  return out;
}

/// generateAdvanced.ts compositeFor: 0 over · 1 add · 2 screen · 3 multiply · 4 inside.
std::string_view composite_for(double mode) {
  const double m = motion::js::round(mode);
  if (m == 1) return "lighter";
  if (m == 2) return "screen";
  if (m == 3) return "multiply";
  if (m == 4) return "source-atop";
  return "source-over";
}

/// withComposite: run `fn` under a composite mode, restoring the previous one.
void with_composite(Canvas2D& oc, double mode, const std::function<void()>& fn) {
  const std::string prev = oc.globalCompositeOperation();
  (void)oc.setGlobalCompositeOperation(composite_for(mode));
  fn();
  (void)oc.setGlobalCompositeOperation(prev);
}

/// generatePatterns.ts withPatternClip: source-atop, inside a save / restore.
void with_pattern_clip(Canvas2D& oc, const std::function<void()>& fn) {
  oc.save();
  (void)oc.setGlobalCompositeOperation("source-atop");
  fn();
  oc.restore();
}

// ── canvas2dEffects.ts ───────────────────────────────────────────────────────

void apply_fill(Canvas2D& oc, double w, double h, const Value& p) {
  const std::string color = str(p, "color", "#ffffff");
  const double opacity = clamp01_lang(num(p, "opacity") / 100);
  if (opacity <= 0) return;
  oc.save();
  oc.setTransform({});
  (void)oc.setGlobalCompositeOperation("source-atop");
  oc.setGlobalAlpha(opacity);
  fill_css(oc, color);
  oc.fillRect(0, 0, w, h);
  oc.restore();
}

void apply_linear_wipe(Canvas2D& oc, double w, double h, const Value& p) {
  const double completion = std::max(0.0, std::min(100.0, num(p, "completion"))) / 100;
  if (completion <= 0) return;
  if (completion >= 1) {
    oc.save();
    oc.setTransform({});
    (void)oc.setGlobalCompositeOperation("destination-out");
    fill_css(oc, "#000");
    oc.fillRect(0, 0, w, h);
    oc.restore();
    return;
  }
  const double rad = (num(p, "wipeAngle") * kPi) / 180;
  const double feather = std::max(0.0, num(p, "feather"));
  const double cx = w / 2;
  const double cy = h / 2;
  const double span = std::abs(w * cos_js(rad)) + std::abs(h * sin_js(rad));
  const double half = span / 2;
  const double pos = -half + completion * span;
  const double gx = cos_js(rad);
  const double gy = sin_js(rad);
  const double soft = std::max(feather, 0.01);
  const Grad g = linear(cx + gx * (pos - soft / 2), cy + gy * (pos - soft / 2), cx + gx * (pos + soft / 2), cy + gy * (pos + soft / 2));
  g.stop(0, "rgba(0,0,0,1)");
  g.stop(1, "rgba(0,0,0,0)");
  oc.save();
  oc.setTransform({});
  (void)oc.setGlobalCompositeOperation("destination-out");
  oc.setFillStyle(g.style());
  oc.fillRect(0, 0, w, h);
  oc.restore();
}

// ── generatePatterns.ts ──────────────────────────────────────────────────────

void draw_checkerboard(Canvas2D& oc, double w, double h, const Value& p) {
  const double sizeW = std::max(1.0, num(p, "width"));
  const double sizeH = std::max(1.0, num(p, "height"));
  const double anchorX = num(p, "anchorX");
  const double anchorY = num(p, "anchorY");
  const std::string colorA = str(p, "colorA", "#000000");
  const std::string colorB = str(p, "colorB", "#ffffff");
  const double opacity = num(p, "opacity") / 100;
  if (opacity <= 0) return;
  with_pattern_clip(oc, [&] {
    oc.setGlobalAlpha(std::min(1.0, opacity));
    const double startX = -sizeW + std::fmod(std::fmod(anchorX, sizeW) + sizeW, sizeW);
    const double startY = -sizeH + std::fmod(std::fmod(anchorY, sizeH) + sizeH, sizeH);
    double row = 0;
    for (double y = startY; y < h; y += sizeH, ++row) {
      double col = 0;
      for (double x = startX; x < w; x += sizeW, ++col) {
        fill_css(oc, std::fmod(row + col, 2) == 0 ? colorA : colorB);
        oc.fillRect(x, y, sizeW, sizeH);
      }
    }
  });
}

void draw_grid(Canvas2D& oc, double w, double h, const Value& p) {
  const double pitchX = std::max(1.0, num(p, "width"));
  const double pitchY = std::max(1.0, num(p, "height"));
  const double thickness = std::max(0.0, num(p, "thickness"));
  const double anchorX = num(p, "anchorX");
  const double anchorY = num(p, "anchorY");
  const double opacity = num(p, "opacity") / 100;
  if (thickness <= 0 || opacity <= 0) return;
  with_pattern_clip(oc, [&] {
    oc.setGlobalAlpha(std::min(1.0, opacity));
    stroke_css(oc, str(p, "color", "#ffffff"));
    oc.setLineWidth(thickness);
    const double snap = std::fmod(motion::js::round(thickness), 2) == 1 ? 0.5 : 0;
    oc.beginPath();
    for (double x = std::fmod(std::fmod(anchorX, pitchX) + pitchX, pitchX); x <= w; x += pitchX) {
      oc.moveTo(motion::js::round(x) + snap, 0);
      oc.lineTo(motion::js::round(x) + snap, h);
    }
    for (double y = std::fmod(std::fmod(anchorY, pitchY) + pitchY, pitchY); y <= h; y += pitchY) {
      oc.moveTo(0, motion::js::round(y) + snap);
      oc.lineTo(w, motion::js::round(y) + snap);
    }
    oc.stroke();
  });
}

// ── generateAdvanced.ts ──────────────────────────────────────────────────────

void draw_circle(Canvas2D& oc, double w, double h, const Value& p) {
  const double r = std::max(0.0, num(p, "radius"));
  if (r <= 0) return;
  const double a = clamp01_cs(num(p, "opacity") / 100);
  if (a <= 0) return;
  const std::string color = str(p, "color", "#ffffff");
  const double cx = w / 2 + num(p, "centerX");
  const double cy = h / 2 + num(p, "centerY");
  const double feath = std::max(0.0, std::min(r, num(p, "feather")));
  const double thickness = num(p, "thickness");
  const bool invert = flag(p, "invertCircle", false);
  with_composite(oc, num(p, "composite"), [&] {
    oc.save();
    if (invert) {
      fill_css(oc, rgba(color, a));
      oc.fillRect(0, 0, w, h);
      (void)oc.setGlobalCompositeOperation("destination-out");
    }
    if (thickness > 0) {
      const double inner = std::max(0.0, r - thickness);
      const Grad g = radial(cx, cy, 0, cx, cy, r);
      const double i0 = inner / r;
      g.stop(0, rgba(color, 0));
      g.stop(std::max(0.0, i0 - 1e-4), rgba(color, 0));
      g.stop(std::min(1.0, i0 + feath / r), rgba(color, a));
      g.stop(std::max(0.0, 1 - feath / r), rgba(color, a));
      g.stop(1, rgba(color, 0));
      oc.setFillStyle(g.style());
    } else if (feath > 0) {
      const Grad g = radial(cx, cy, std::max(0.0, r - feath), cx, cy, r);
      g.stop(0, rgba(color, a));
      g.stop(1, rgba(color, 0));
      oc.setFillStyle(g.style());
    } else {
      fill_css(oc, rgba(color, a));
    }
    oc.beginPath();
    oc.arc(cx, cy, r, 0, kPi * 2, false);
    oc.fill(raster::FillRule::nonzero);
    oc.restore();
  });
}

void draw_ellipse(Canvas2D& oc, double w, double h, const Value& p) {
  const double rx = std::max(0.0, num(p, "ellipseWidth") / 2);
  const double ry = std::max(0.0, num(p, "ellipseHeight") / 2);
  const double a = clamp01_cs(num(p, "opacity") / 100);
  if (rx <= 0 || ry <= 0 || a <= 0) return;
  const std::string color = str(p, "color", "#ffffff");
  const double softness = num(p, "softness");
  with_composite(oc, num(p, "composite"), [&] {
    oc.save();
    oc.translate(w / 2 + num(p, "centerX"), h / 2 + num(p, "centerY"));
    oc.rotate((num(p, "rotation") * kPi) / 180);
    stroke_css(oc, rgba(color, a));
    oc.setLineWidth(std::max(0.5, num(p, "thickness")));
    if (softness > 0) {
      if (const auto col = raster::css::parse_color(rgba(color, a))) oc.setShadowColor(*col);
      oc.setShadowBlur(softness);
    }
    oc.beginPath();
    oc.ellipse(0, 0, rx, ry, 0, 0, kPi * 2, false);
    oc.stroke();
    oc.restore();
  });
}

void draw_radio_waves(Canvas2D& oc, double w, double h, const Value& p) {
  const double n = std::max(1.0, std::min(64.0, motion::js::round(num(p, "waveCount"))));
  const double maxRadius = num(p, "maxRadius");
  const std::array<double, 2> wh{w, h};
  const double maxR = maxRadius > 0 ? maxRadius : motion::js::hypot(wh) / 2;
  const double a = clamp01_cs(num(p, "opacity") / 100);
  if (a <= 0) return;
  const double cx = w / 2 + num(p, "centerX");
  const double cy = h / 2 + num(p, "centerY");
  const double fade = clamp01_cs(num(p, "fadeOut") / 100);
  const double phase = num(p, "phase");
  const std::string color = str(p, "color", "#7dd3fc");
  with_composite(oc, num(p, "composite"), [&] {
    oc.save();
    oc.setLineWidth(std::max(0.5, num(p, "thickness")));
    for (double i = 0; i < n; ++i) {
      const double t = std::fmod(std::fmod((phase / 360) + i / n, 1) + 1, 1);
      const double r = t * maxR;
      if (r <= 0.5) continue;
      const double alpha = a * (1 - fade * t);
      if (alpha <= 0) continue;
      stroke_css(oc, rgba(color, alpha));
      oc.beginPath();
      oc.arc(cx, cy, r, 0, kPi * 2, false);
      oc.stroke();
    }
    oc.restore();
  });
}

void draw_light_rays(Canvas2D& oc, double w, double h, const Value& p) {
  const double n = std::max(1.0, std::min(256.0, motion::js::round(num(p, "rayCount"))));
  const double a = clamp01_cs(num(p, "opacity") / 100);
  const double length = num(p, "rayLength");
  if (a <= 0 || length <= 0) return;
  const double cx = w / 2 + num(p, "centerX");
  const double cy = h / 2 + num(p, "centerY");
  const double rot = (num(p, "rotation") * kPi) / 180;
  const double arcV = clamp01_cs(num(p, "spread") / 100) * kPi * 2;
  const double arc = arcV == 0 || std::isnan(arcV) ? kPi * 2 : arcV;  // `|| Math.PI * 2`
  const std::string color = str(p, "color", "#fff3c4");
  const double falloff = num(p, "falloff");
  // The TS LCG runs on doubles: the product can pass 2^53 and round before ToUint32.
  double state = motion::js::to_uint32(motion::js::round(num(p, "seed")) * 22695477 + 1);
  const auto rand = [&state] {
    state = motion::js::to_uint32(state * 22695477 + 1);
    return state / 4294967296.0;
  };
  with_composite(oc, num(p, "composite"), [&] {
    oc.save();
    for (double i = 0; i < n; ++i) {
      const double ang = rot + (i / n) * arc - arc / 2 + (rand() - 0.5) * (arc / n) * 0.6;
      const double len = length * (0.55 + rand() * 0.45);
      const double halfWidth = (arc / n) * 0.35;
      const Grad g = linear(cx, cy, cx + cos_js(ang) * len, cy + sin_js(ang) * len);
      g.stop(0, rgba(color, a));
      g.stop(clamp01_cs(1 - falloff / 100), rgba(color, a * 0.35));
      g.stop(1, rgba(color, 0));
      oc.setFillStyle(g.style());
      oc.beginPath();
      oc.moveTo(cx, cy);
      oc.lineTo(cx + cos_js(ang - halfWidth) * len, cy + sin_js(ang - halfWidth) * len);
      oc.lineTo(cx + cos_js(ang + halfWidth) * len, cy + sin_js(ang + halfWidth) * len);
      oc.closePath();
      oc.fill(raster::FillRule::nonzero);
    }
    oc.restore();
  });
}

void draw_light_sweep(Canvas2D& oc, double w, double h, const Value& p) {
  const double a = clamp01_cs(num(p, "intensity") / 100);
  const double width = num(p, "sweepWidth");
  if (a <= 0 || width <= 0) return;
  const double rad = (num(p, "angle") * kPi) / 180;
  const double span = std::abs(w * cos_js(rad)) + std::abs(h * sin_js(rad));
  const double t = num(p, "position") / 100;
  const double cx = w / 2 + cos_js(rad) * (t - 0.5) * span;
  const double cy = h / 2 + sin_js(rad) * (t - 0.5) * span;
  const double half = width / 2;
  const double soft = clamp01_cs(num(p, "softness") / 100);
  const std::string color = str(p, "color", "#ffffff");
  with_composite(oc, num(p, "composite"), [&] {
    oc.save();
    const Grad g = linear(cx - cos_js(rad) * half, cy - sin_js(rad) * half, cx + cos_js(rad) * half, cy + sin_js(rad) * half);
    g.stop(0, rgba(color, 0));
    g.stop(std::max(0.001, 0.5 - 0.5 * (1 - soft)), rgba(color, a * 0.5));
    g.stop(0.5, rgba(color, a));
    g.stop(std::min(0.999, 0.5 + 0.5 * (1 - soft)), rgba(color, a * 0.5));
    g.stop(1, rgba(color, 0));
    oc.setFillStyle(g.style());
    oc.fillRect(0, 0, w, h);
    oc.restore();
  });
}

// ── canvas2dEffects.ts, round two: the styles and drawn passes (E4) ──────────

std::string trim_ws(const std::string& s) {
  std::size_t b = 0;
  std::size_t e = s.size();
  while (b < e && std::isspace(static_cast<unsigned char>(s[b])) != 0) ++b;
  while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1])) != 0) --e;
  return s.substr(b, e - b);
}
/// canvas2dEffects.ts parseHex: `#rrggbb` / `#rgb` → bytes, else mid grey.
std::array<double, 3> parse_hex(const std::string& hex) {
  const std::string s = trim_ws(hex);
  const auto hexv = [](char ch) { return std::isxdigit(static_cast<unsigned char>(ch)) != 0; };
  const auto bytes = [](const std::string& h6) {
    const long v = std::strtol(h6.c_str(), nullptr, 16);
    return std::array<double, 3>{static_cast<double>((v >> 16) & 255), static_cast<double>((v >> 8) & 255), static_cast<double>(v & 255)};
  };
  if (s.size() == 7 && s[0] == '#' && std::all_of(s.begin() + 1, s.end(), hexv)) return bytes(s.substr(1));
  if (s.size() == 4 && s[0] == '#' && std::all_of(s.begin() + 1, s.end(), hexv)) {
    return bytes(std::string(2, s[1]) + std::string(2, s[2]) + std::string(2, s[3]));
  }
  return {128, 128, 128};
}
/// canvas2dEffects.ts withA(hex, a).
std::string with_a(const std::string& hex, double a) {
  const auto [r, g, b] = parse_hex(hex);
  return "rgba(" + js(r) + "," + js(g) + "," + js(b) + "," + js(clamp01_lang(a)) + ")";
}
/// drawImage(src, dx, dy): the whole source at its own size.
void draw_at(Canvas2D& dst, const Canvas2D& src, double dx, double dy) {
  const double sw = src.width();
  const double sh = src.height();
  dst.drawImage(src, 0, 0, sw, sh, dx, dy, sw, sh);
}
void filter_css(Canvas2D& c, std::string_view css) { (void)c.setFilterString(css); }
/// `ctx.filter = size > 0 ? 'blur(<size>px)' : 'none'`.
void blur_or_none(Canvas2D& c, double size) { filter_css(c, size > 0 ? "blur(" + js(size) + "px)" : std::string("none")); }
/// The reset the styles apply to each working buffer before use.
void reset(Canvas2D& c, double w, double h) {
  c.setTransform({});
  (void)c.setGlobalCompositeOperation("source-over");
  c.setGlobalAlpha(1);
  filter_css(c, "none");
  c.clearRect(0, 0, w, h);
}
/// silhouetteOf(oc): the style silhouette when fill opacity installed one, else the canvas itself.
const Canvas2D& silhouette_of(const CanvasEffectContext& x, const Canvas2D& oc) { return x.silhouette != nullptr ? *x.silhouette : oc; }

void apply_four_color_gradient(CanvasEffectContext& x, Canvas2D& oc, double w, double h, const Value& p) {
  const double blend = clamp01_lang(num(p, "blend") / 100);
  if (blend <= 0) return;
  const std::array<std::array<double, 3>, 4> c{parse_hex(str(p, "colorTL", "#ff0000")), parse_hex(str(p, "colorTR", "#00ff00")),
                                               parse_hex(str(p, "colorBL", "#0000ff")), parse_hex(str(p, "colorBR", "#ffff00"))};
  Canvas2D& grad = x.scratch(oc, "4cg", 2, 2);
  std::vector<std::uint8_t> d(16);
  for (std::size_t i = 0; i < 4; ++i) {
    for (std::size_t k = 0; k < 3; ++k) d[i * 4 + k] = static_cast<std::uint8_t>(c[i][k]);
    d[i * 4 + 3] = 255;
  }
  grad.putImageData(d, 2, 2, 0, 0);
  oc.save();
  oc.setTransform({});
  (void)oc.setGlobalCompositeOperation("source-atop");
  oc.setGlobalAlpha(blend);
  oc.setImageSmoothing(true);
  oc.drawImage(grad, 0.5, 0.5, 1, 1, 0, 0, w, h);
  oc.restore();
}

void apply_stroke(CanvasEffectContext& x, Canvas2D& oc, double w, double h, const Value& p) {
  const double width = std::max(0.0, num(p, "width"));
  const double opacity = clamp01_lang(num(p, "opacity") / 100);
  if (width <= 0 || opacity <= 0) return;
  const std::string color = str(p, "color", "#ffffff");
  const Value& pos = p["position"];
  const bool inside = (pos.is_string() && pos.str() == "inside") || (pos.is_number() && pos.num() == 1);
  const bool center = !inside && ((pos.is_string() && pos.str() == "center") || (pos.is_number() && pos.num() == 2));
  const auto uw = static_cast<std::uint32_t>(w);
  const auto uh = static_cast<std::uint32_t>(h);
  Canvas2D& snap = x.scratch(oc, "stroke-snap", uw, uh);
  snap.setTransform({});
  snap.clearRect(0, 0, w, h);
  draw_at(snap, silhouette_of(x, oc), 0, 0);
  Canvas2D& ring = x.scratch(oc, "stroke-ring", uw, uh);
  ring.setTransform({});
  ring.clearRect(0, 0, w, h);
  (void)ring.setGlobalCompositeOperation("source-over");
  constexpr int kSteps = 32;
  const double radius = center ? width * 0.5 : width;
  for (int i = 0; i < kSteps; ++i) {
    const double a = (static_cast<double>(i) / kSteps) * kPi * 2;
    draw_at(ring, snap, cos_js(a) * radius, sin_js(a) * radius);
  }
  (void)ring.setGlobalCompositeOperation("source-in");
  fill_css(ring, color);
  ring.fillRect(0, 0, w, h);
  if (!inside) {
    (void)ring.setGlobalCompositeOperation("destination-out");
    draw_at(ring, snap, 0, 0);
  }
  if (inside || center) {
    Canvas2D& inner = x.scratch(oc, "stroke-inner", uw, uh);
    inner.setTransform({});
    inner.clearRect(0, 0, w, h);
    draw_at(inner, snap, 0, 0);
    (void)inner.setGlobalCompositeOperation("source-in");
    fill_css(inner, color);
    inner.fillRect(0, 0, w, h);
    (void)inner.setGlobalCompositeOperation("destination-out");
    for (int i = 0; i < kSteps; ++i) {
      const double a = (static_cast<double>(i) / kSteps) * kPi * 2;
      draw_at(inner, snap, cos_js(a) * radius, sin_js(a) * radius);
    }
    if (inside) ring.clearRect(0, 0, w, h);
    (void)ring.setGlobalCompositeOperation("source-over");
    draw_at(ring, inner, 0, 0);
  }
  oc.save();
  oc.setTransform({});
  (void)oc.setGlobalCompositeOperation(inside ? "source-atop" : "destination-over");
  oc.setGlobalAlpha(opacity);
  draw_at(oc, ring, 0, 0);
  oc.restore();
}

void apply_beam(CanvasEffectContext& /*x*/, Canvas2D& oc, double w, double h, const Value& p) {
  const double sx = (num(p, "startX") / 100) * w;
  const double sy = (num(p, "startY") / 100) * h;
  const double ex = (num(p, "endX") / 100) * w;
  const double ey = (num(p, "endY") / 100) * h;
  const double length = clamp01_lang(num(p, "length") / 100);
  const double thickness = std::max(0.5, num(p, "thickness"));
  const double softness = clamp01_lang(num(p, "softness") / 100);
  const std::string color = str(p, "color", "#ffffff");
  if (length <= 0) return;
  const double hx = sx + (ex - sx) * length;
  const double hy = sy + (ey - sy) * length;
  constexpr double kTail = 0.35;
  const double t0 = std::max(0.0, length - kTail);
  const double tx = sx + (ex - sx) * t0;
  const double ty = sy + (ey - sy) * t0;
  oc.save();
  oc.setTransform({});
  (void)oc.setGlobalCompositeOperation("lighter");
  const Grad g = linear(tx, ty, hx, hy);
  g.stop(0, with_a(color, 0));
  g.stop(1, with_a(color, 1));
  oc.setStrokeStyle(g.style());
  oc.setLineCap(raster::LineCap::round);
  oc.setLineWidth(thickness * (1 + softness * 3));
  oc.setGlobalAlpha(0.35);
  oc.beginPath();
  oc.moveTo(tx, ty);
  oc.lineTo(hx, hy);
  oc.stroke();
  oc.setLineWidth(thickness);
  oc.setGlobalAlpha(1);
  oc.beginPath();
  oc.moveTo(tx, ty);
  oc.lineTo(hx, hy);
  oc.stroke();
  oc.restore();
}

/// canvas2dEffects.ts applyInterior: an interior band inside the layer's own alpha.
void apply_interior(CanvasEffectContext& x, Canvas2D& oc, double w, double h, const std::string& color, double opacity, double size,
                    double dx, double dy, std::string_view blend) {
  if (opacity <= 0) return;
  const double pad = std::ceil(size * 3 + std::max(std::abs(dx), std::abs(dy))) + 2;
  const double pw = w + pad * 2;
  const double ph = h + pad * 2;
  const auto upw = static_cast<std::uint32_t>(pw);
  const auto uph = static_cast<std::uint32_t>(ph);
  Canvas2D& sc = x.scratch(oc, "interior-silhouette", upw, uph);
  Canvas2D& ic = x.scratch(oc, "interior-inverse", upw, uph);
  Canvas2D& bc = x.scratch(oc, "interior-band", upw, uph);
  for (Canvas2D* c : {&sc, &ic, &bc}) reset(*c, pw, ph);
  draw_at(sc, silhouette_of(x, oc), pad, pad);
  fill_css(ic, "#000");
  ic.fillRect(0, 0, pw, ph);
  (void)ic.setGlobalCompositeOperation("destination-out");
  draw_at(ic, sc, 0, 0);
  blur_or_none(bc, size);
  draw_at(bc, ic, dx, dy);
  filter_css(bc, "none");
  (void)bc.setGlobalCompositeOperation("source-in");
  fill_css(bc, color);
  bc.fillRect(0, 0, pw, ph);
  (void)bc.setGlobalCompositeOperation("destination-in");
  draw_at(bc, sc, 0, 0);
  oc.save();
  oc.setTransform({});
  (void)oc.setGlobalCompositeOperation(blend);
  oc.setGlobalAlpha(opacity);
  oc.drawImage(bc, pad, pad, w, h, 0, 0, w, h);
  oc.restore();
}

void apply_inner_shadow(CanvasEffectContext& x, Canvas2D& oc, double w, double h, const Value& p) {
  const double distance = std::max(0.0, num(p, "distance"));
  const double rad = (num(p, "angle") * kPi) / 180;
  apply_interior(x, oc, w, h, str(p, "color", "#000000"), clamp01_lang(num(p, "opacity") / 100), std::max(0.0, num(p, "softness")),
                 cos_js(rad) * distance, sin_js(rad) * distance, "source-over");
}

void apply_inner_glow(CanvasEffectContext& x, Canvas2D& oc, double w, double h, const Value& p) {
  apply_interior(x, oc, w, h, str(p, "color", "#ffd070"), clamp01_lang(num(p, "opacity") / 100), std::max(0.0, num(p, "size")), 0, 0,
                 "lighter");
}

void apply_satin(CanvasEffectContext& x, Canvas2D& oc, double w, double h, const Value& p) {
  const double opacity = clamp01_lang(num(p, "opacity") / 100);
  const double size = std::max(0.0, num(p, "size"));
  const double distance = std::max(0.0, num(p, "distance"));
  if (opacity <= 0 || (size <= 0 && distance <= 0)) return;
  const std::string color = str(p, "color", "#000000");
  const bool invert = p["invert"].is_bool() && p["invert"].truthy();
  const double rad = (num(p, "angle") * kPi) / 180;
  const double dx = cos_js(rad) * distance;
  const double dy = sin_js(rad) * distance;
  const auto uw = static_cast<std::uint32_t>(w);
  const auto uh = static_cast<std::uint32_t>(h);
  Canvas2D& sc = x.scratch(oc, "satin-silhouette", uw, uh);
  Canvas2D& ac = x.scratch(oc, "satin-a", uw, uh);
  Canvas2D& bc = x.scratch(oc, "satin-b", uw, uh);
  Canvas2D& a0c = x.scratch(oc, "satin-a0", uw, uh);
  Canvas2D& nc = x.scratch(oc, "satin-band", uw, uh);
  for (Canvas2D* c : {&sc, &ac, &bc, &a0c, &nc}) reset(*c, w, h);
  draw_at(sc, silhouette_of(x, oc), 0, 0);
  blur_or_none(ac, size);
  draw_at(ac, sc, dx, dy);
  filter_css(ac, "none");
  blur_or_none(bc, size);
  draw_at(bc, sc, -dx, -dy);
  filter_css(bc, "none");
  draw_at(a0c, ac, 0, 0);
  if (invert) {
    draw_at(nc, ac, 0, 0);
    (void)nc.setGlobalCompositeOperation("destination-in");
    draw_at(nc, bc, 0, 0);
  } else {
    (void)ac.setGlobalCompositeOperation("destination-out");
    draw_at(ac, bc, 0, 0);
    (void)bc.setGlobalCompositeOperation("destination-out");
    draw_at(bc, a0c, 0, 0);
    draw_at(nc, ac, 0, 0);
    draw_at(nc, bc, 0, 0);
  }
  (void)nc.setGlobalCompositeOperation("source-in");
  fill_css(nc, color);
  nc.fillRect(0, 0, w, h);
  (void)nc.setGlobalCompositeOperation("destination-in");
  draw_at(nc, sc, 0, 0);
  oc.save();
  oc.setTransform({});
  oc.setGlobalAlpha(opacity);
  draw_at(oc, nc, 0, 0);
  oc.restore();
}

/// `parseInt(s, 16)` on the longest hex prefix (NaN when there is none).
double parse_int_hex(std::string_view s) {
  std::size_t i = 0;
  while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i])) != 0) ++i;
  double v = 0;
  bool any = false;
  for (; i < s.size() && std::isxdigit(static_cast<unsigned char>(s[i])) != 0; ++i) {
    const int ch = s[i];
    v = v * 16 + (ch <= '9' ? ch - '0' : (ch | 0x20) - 'a' + 10);
    any = true;
  }
  return any ? v : std::nan("");
}
/// canvas2dEffects.ts parseRgbTriplet.
std::array<double, 3> parse_rgb_triplet(const std::string& hex) {
  std::string s = trim_ws(hex);
  if (const auto k = s.find('#'); k != std::string::npos) s.erase(k, 1);
  if (s.size() == 3) {
    return {parse_int_hex(std::string(2, s[0])), parse_int_hex(std::string(2, s[1])), parse_int_hex(std::string(2, s[2]))};
  }
  if (s.size() >= 6) return {parse_int_hex(s.substr(0, 2)), parse_int_hex(s.substr(2, 2)), parse_int_hex(s.substr(4, 2))};
  return {255, 255, 255};
}

void apply_bevel(CanvasEffectContext& x, Canvas2D& oc, double w, double h, const Value& p) {
  const double size = std::max(1.0, num(p, "size"));
  const double depth = std::max(0.0, num(p, "depth")) / 100;
  const double hi_opacity = clamp01_lang(num(p, "highlightOpacity") / 100);
  const double lo_opacity = clamp01_lang(num(p, "shadowOpacity") / 100);
  if (depth <= 0 || (hi_opacity <= 0 && lo_opacity <= 0)) return;
  const bool down = p["direction"].is_string() && p["direction"].str() == "down";
  const double angle_deg = num(p, "angle") + (down ? 180 : 0);
  const double alt_deg = std::max(0.0, std::min(90.0, num(p, "altitude")));
  const auto hi_color = parse_rgb_triplet(str(p, "highlightColor", "#ffffff"));
  const auto lo_color = parse_rgb_triplet(str(p, "shadowColor", "#000000"));
  constexpr double kMaxWork = 640;  // BEVEL_MAX_WORK
  const double scale_cap = std::min(1.0, kMaxWork / std::max(w, h));
  const double ww = std::max(1.0, motion::js::round(w * scale_cap));
  const double wh = std::max(1.0, motion::js::round(h * scale_cap));
  const double s = ww / w;
  const auto uww = static_cast<std::uint32_t>(ww);
  const auto uwh = static_cast<std::uint32_t>(wh);
  Canvas2D& sc = x.scratch(oc, "bevel-silhouette", uww, uwh);
  Canvas2D& rc = x.scratch(oc, "bevel-ramp", uww, uwh);
  Canvas2D& hc = x.scratch(oc, "bevel-hi", uww, uwh);
  Canvas2D& lc = x.scratch(oc, "bevel-lo", uww, uwh);
  for (Canvas2D* c : {&sc, &rc, &hc, &lc}) reset(*c, ww, wh);
  sc.drawImage(silhouette_of(x, oc), 0, 0, w, h, 0, 0, ww, wh);
  filter_css(rc, "blur(" + js(std::max(0.5, size * s)) + "px)");
  draw_at(rc, sc, 0, 0);
  filter_css(rc, "none");
  const std::vector<std::uint8_t> src = rc.getImageData(0, 0, uww, uwh);
  const std::vector<std::uint8_t> mask = sc.getImageData(0, 0, uww, uwh);
  const std::size_t npx = static_cast<std::size_t>(uww) * uwh;
  std::vector<std::uint8_t> hi(npx * 4, 0);
  std::vector<std::uint8_t> lo(npx * 4, 0);
  const double rad = (angle_deg * kPi) / 180;
  const double alt = (alt_deg * kPi) / 180;
  const double lx = cos_js(rad) * cos_js(alt);
  const double ly = sin_js(rad) * cos_js(alt);
  const double lz = sin_js(alt);
  std::vector<float> height(npx);  // Float32Array
  for (std::size_t q = 0; q < npx; ++q) height[q] = static_cast<float>(src[q * 4 + 3] / 255.0);
  const double depth_scale = depth * 8 * s;
  const std::size_t bw = uww;
  const std::size_t bh = uwh;
  for (std::size_t y = 0; y < bh; ++y) {
    const std::size_t row = y * bw;
    const std::size_t up = (y > 0 ? y - 1 : 0) * bw;
    const std::size_t dn = (y < bh - 1 ? y + 1 : bh - 1) * bw;
    for (std::size_t xx = 0; xx < bw; ++xx) {
      const std::size_t q = row + xx;
      const std::size_t i = q * 4;
      const double a = mask[i + 3];
      if (a == 0) continue;
      const std::size_t left = xx > 0 ? q - 1 : row;
      const std::size_t right = xx < bw - 1 ? q + 1 : row + bw - 1;
      const double gx = (static_cast<double>(height[right]) - static_cast<double>(height[left])) * 0.5;
      const double gy = (static_cast<double>(height[dn + xx]) - static_cast<double>(height[up + xx])) * 0.5;
      const double nx = -gx * depth_scale;
      const double ny = -gy * depth_scale;
      const double len = std::sqrt(nx * nx + ny * ny + 1);
      const double shade = (nx * lx + ny * ly + lz) / len - lz;
      if (shade == 0) continue;
      const double alpha_scale = a / 255;
      if (shade > 0) {
        if (hi_opacity == 0) continue;
        for (std::size_t k = 0; k < 3; ++k) hi[i + k] = effects::u8c(hi_color[k]);
        hi[i + 3] = effects::u8c((shade < 1 ? shade : 1) * hi_opacity * alpha_scale * 255);
      } else {
        if (lo_opacity == 0) continue;
        const double mag = -shade;
        for (std::size_t k = 0; k < 3; ++k) lo[i + k] = effects::u8c(lo_color[k]);
        lo[i + 3] = effects::u8c((mag < 1 ? mag : 1) * lo_opacity * alpha_scale * 255);
      }
    }
  }
  hc.putImageData(hi, uww, uwh, 0, 0);
  lc.putImageData(lo, uww, uwh, 0, 0);
  oc.save();
  oc.setTransform({});
  if (s == 1) {
    (void)oc.setGlobalCompositeOperation("lighter");
    draw_at(oc, hc, 0, 0);
    (void)oc.setGlobalCompositeOperation("multiply");
    draw_at(oc, lc, 0, 0);
  } else {
    Canvas2D& fc = x.scratch(oc, "bevel-band-full", static_cast<std::uint32_t>(w), static_cast<std::uint32_t>(h));
    const auto blit = [&](const Canvas2D& band, std::string_view op) {
      reset(fc, w, h);
      fc.drawImage(band, 0, 0, ww, wh, 0, 0, w, h);
      (void)fc.setGlobalCompositeOperation("destination-in");
      draw_at(fc, silhouette_of(x, oc), 0, 0);
      (void)oc.setGlobalCompositeOperation(op);
      draw_at(oc, fc, 0, 0);
    };
    blit(hc, "lighter");
    blit(lc, "multiply");
  }
  oc.restore();
}

void apply_directional_blur(CanvasEffectContext& x, Canvas2D& oc, double w, double h, const Value& p) {
  const double length = std::max(0.0, num(p, "length"));
  if (length < 1) return;
  const double rad = (num(p, "direction") * kPi) / 180;
  const double dx = cos_js(rad);
  const double dy = sin_js(rad);
  const double steps = std::max(1.0, std::min(64.0, motion::js::round(length)));
  const auto uw = static_cast<std::uint32_t>(w);
  const auto uh = static_cast<std::uint32_t>(h);
  Canvas2D& sc = x.scratch(oc, "dirblur-src", uw, uh);
  Canvas2D& ac = x.scratch(oc, "dirblur-acc", uw, uh);
  for (Canvas2D* c : {&sc, &ac}) reset(*c, w, h);
  draw_at(sc, oc, 0, 0);
  std::vector<double> weights;
  double total = 0;
  for (double i = -steps; i <= steps; ++i) {
    const double t = 1 - std::abs(i) / (steps + 1);
    weights.push_back(t);
    total += t;
  }
  (void)ac.setGlobalCompositeOperation("lighter");
  std::size_t k = 0;
  for (double i = -steps; i <= steps; ++i) {
    const double off = (i / steps) * (length / 2);
    ac.setGlobalAlpha(weights[k++] / total);
    draw_at(ac, sc, dx * off, dy * off);
  }
  ac.setGlobalAlpha(1);
  oc.save();
  oc.setTransform({});
  (void)oc.setGlobalCompositeOperation("copy");
  draw_at(oc, ac, 0, 0);
  oc.restore();
}

void apply_transform(CanvasEffectContext& x, Canvas2D& oc, double w, double h, const Value& p) {
  const double scale = std::max(0.0, num(p, "scale")) / 100;
  const double rot = (num(p, "rotation") * kPi) / 180;
  const double px = num(p, "positionX");
  const double py = num(p, "positionY");
  const double opacity = clamp01_lang(num(p, "opacity") / 100);
  if (scale == 1 && rot == 0 && px == 0 && py == 0 && opacity == 1) return;
  Canvas2D& sc = x.scratch(oc, "xform-src", static_cast<std::uint32_t>(w), static_cast<std::uint32_t>(h));
  reset(sc, w, h);
  draw_at(sc, oc, 0, 0);
  oc.save();
  oc.setTransform({});
  (void)oc.setGlobalCompositeOperation("copy");
  oc.clearRect(0, 0, w, h);
  (void)oc.setGlobalCompositeOperation("source-over");
  oc.setGlobalAlpha(opacity);
  oc.translate(w / 2 + px, h / 2 + py);
  oc.rotate(rot);
  oc.scale(scale, scale);
  draw_at(oc, sc, -w / 2, -h / 2);
  oc.restore();
}

void apply_cc_repetile(CanvasEffectContext& x, Canvas2D& oc, double w, double h, const Value& p) {
  const double el = num(p, "expandLeft");
  const double er = num(p, "expandRight");
  const double eu = num(p, "expandUp");
  const double ed = num(p, "expandDown");
  if (el <= 0 && er <= 0 && eu <= 0 && ed <= 0) return;
  oc.setTransform({});
  const auto iw = static_cast<std::uint32_t>(w);
  const auto ih = static_cast<std::uint32_t>(h);
  const std::vector<std::uint8_t> src = oc.getImageData(0, 0, iw, ih);
  // aeRoundSix.ts ccRepeTileData; repeTileModeOf: 0 unfold · 1 repeat · 2 flip-h · 3 flip-v.
  const int mode = static_cast<int>(std::max(0.0, std::min(3.0, motion::js::round(num(p, "tiling")))));
  const auto nonneg = [](double v) { return static_cast<long>(std::max(0.0, motion::js::round(v))); };
  const long l = nonneg(el);
  const long r = nonneg(er);
  const long u = nonneg(eu);
  const long d = nonneg(ed);
  long nw = static_cast<long>(iw);
  long nh = static_cast<long>(ih);
  std::vector<std::uint8_t> out = src;
  if (l != 0 || r != 0 || u != 0 || d != 0) {
    nw = static_cast<long>(iw) + l + r;
    nh = static_cast<long>(ih) + u + d;
    out.assign(static_cast<std::size_t>(nw) * static_cast<std::size_t>(nh) * 4, 0);
    const auto wrap = [](long v, long m) { return ((v % m) + m) % m; };
    const auto map = [&](long q, long size, bool horizontal) -> long {
      if (q >= 0 && q < size) return q;
      if (mode == 0) {
        const long cycle = 2 * (size - 1);
        if (cycle <= 0) return 0;
        const long m = wrap(q, cycle);
        return m >= size ? cycle - m : m;
      }
      if (mode == 1) return wrap(q, size);
      if ((mode == 2 && horizontal) || (mode == 3 && !horizontal)) {
        const auto tile = static_cast<long>(std::floor(static_cast<double>(q) / static_cast<double>(size)));
        const long m = wrap(q, size);
        return std::abs(tile) % 2 == 1 ? size - 1 - m : m;
      }
      return wrap(q, size);
    };
    for (long ny = 0; ny < nh; ++ny) {
      const long sy = map(ny - u, static_cast<long>(ih), false);
      for (long nx = 0; nx < nw; ++nx) {
        const long sx = map(nx - l, static_cast<long>(iw), true);
        const auto si = static_cast<std::size_t>((sy * static_cast<long>(iw) + sx) * 4);
        const auto di = static_cast<std::size_t>((ny * nw + nx) * 4);
        for (std::size_t k = 0; k < 4; ++k) out[di + k] = src[si + k];
      }
    }
  }
  Canvas2D& tc = x.scratch(oc, "repetile", static_cast<std::uint32_t>(nw), static_cast<std::uint32_t>(nh));
  tc.putImageData(out, static_cast<std::uint32_t>(nw), static_cast<std::uint32_t>(nh), 0, 0);
  oc.clearRect(0, 0, w, h);
  oc.drawImage(tc, el, eu, w, h, 0, 0, w, h);
}

using CtxFn = void (*)(CanvasEffectContext&, Canvas2D&, double, double, const Value&);
constexpr std::array<std::pair<std::string_view, CtxFn>, 10> kContextEffects{{
    {"four-color-gradient", apply_four_color_gradient},
    {"stroke", apply_stroke},
    {"beam", apply_beam},
    {"inner-shadow", apply_inner_shadow},
    {"inner-glow", apply_inner_glow},
    {"satin", apply_satin},
    {"bevel", apply_bevel},
    {"directional-blur", apply_directional_blur},
    {"transform", apply_transform},
    {"cc-repetile", apply_cc_repetile},
}};

using Fn = void (*)(Canvas2D&, double, double, const Value&);
constexpr std::array<std::pair<std::string_view, Fn>, 9> kEffects{{
    {"fill", apply_fill},
    {"linear-wipe", apply_linear_wipe},
    {"checkerboard", draw_checkerboard},
    {"grid", draw_grid},
    {"circle", draw_circle},
    {"ellipse", draw_ellipse},
    {"radio-waves", draw_radio_waves},
    {"light-rays", draw_light_rays},
    {"light-sweep", draw_light_sweep},
}};

constexpr std::array<std::string_view, kEffects.size() + kContextEffects.size()> kNames = [] {
  std::array<std::string_view, kEffects.size() + kContextEffects.size()> out{};
  for (std::size_t i = 0; i < kEffects.size(); ++i) out[i] = kEffects[i].first;
  for (std::size_t i = 0; i < kContextEffects.size(); ++i) out[kEffects.size() + i] = kContextEffects[i].first;
  return out;
}();

}  // namespace

raster::Canvas2D& CanvasEffectContext::scratch(const raster::Canvas2D& oc, std::string_view role, std::uint32_t w, std::uint32_t h) {
  for (auto& [name, c] : pool_) {
    if (name == role) {
      if (c->width() != w || c->height() != h) c->resize(w, h);
      return *c;
    }
  }
  pool_.emplace_back(std::string(role), oc.create_canvas(w, h));
  return *pool_.back().second;
}

bool run_canvas_effect(std::string_view type, const raster::json::Value& params, raster::Canvas2D& oc, double w, double h,
                       CanvasEffectContext& ctx) {
  for (const auto& [name, fn] : kEffects) {
    if (name == type) {
      fn(oc, w, h, params);
      return true;
    }
  }
  for (const auto& [name, fn] : kContextEffects) {
    if (name == type) {
      fn(ctx, oc, w, h, params);
      return true;
    }
  }
  return false;
}

bool run_canvas_effect(std::string_view type, const raster::json::Value& params, raster::Canvas2D& oc, double w, double h) {
  CanvasEffectContext ctx;
  return run_canvas_effect(type, params, oc, w, h, ctx);
}

std::span<const std::string_view> ported_canvas_effects() noexcept { return kNames; }

}  // namespace premation::effects
