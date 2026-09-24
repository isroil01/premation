// Canvas-drawn effects (see canvas_effects.hpp), ported from
// canvas2dEffects.ts (fill, linear wipe), generatePatterns.ts (checkerboard,
// grid) and generateAdvanced.ts (circle, ellipse, radio waves, light rays,
// light sweep). Each keeps the TS's call order, its V8 Math (motion_jsmath)
// and its colour strings, so its Canvas2D program is the TS's
// (tests/test_canvas_effects.cpp, against canvasEffectsCrossEngine.test.ts).

#include "canvas_effects.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <functional>
#include <memory>
#include <string>
#include <utility>

#include "jsmath.hpp"
#include "numconv.hpp"
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

constexpr std::array<std::string_view, kEffects.size()> kNames = [] {
  std::array<std::string_view, kEffects.size()> out{};
  for (std::size_t i = 0; i < kEffects.size(); ++i) out[i] = kEffects[i].first;
  return out;
}();

}  // namespace

bool run_canvas_effect(std::string_view type, const raster::json::Value& params, raster::Canvas2D& oc, double w, double h) {
  for (const auto& [name, fn] : kEffects) {
    if (name == type) {
      fn(oc, w, h, params);
      return true;
    }
  }
  return false;
}

std::span<const std::string_view> ported_canvas_effects() noexcept { return kNames; }

}  // namespace premation::effects
