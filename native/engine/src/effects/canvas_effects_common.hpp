// Shared helpers of the canvas-drawn effects (canvas_effects.cpp,
// canvas_effects_generate.cpp): the TS param readers, colour strings,
// gradients and composite wrappers, each as the TS spells it.
#pragma once

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <functional>
#include <memory>
#include <string>
#include <string_view>

#include "jsmath.hpp"
#include "numconv.hpp"
#include "raster/canvas.hpp"
#include "raster/css.hpp"
#include "raster/json.hpp"

namespace premation::effects::canvas_detail {

using raster::Canvas2D;
using raster::Gradient;
using raster::Style;
using raster::json::Value;

inline constexpr double kPi = 3.141592653589793;  // Math.PI

// ── the TS param helpers ─────────────────────────────────────────────────────

/// effectNumber: the param when it is a number, else 0.
inline double num(const Value& p, std::string_view k) {
  const Value& v = p[k];
  return v.is_number() ? v.num() : 0;
}
/// str(e, k, fallback).
inline std::string str(const Value& p, std::string_view k, std::string_view fb) {
  const Value& v = p[k];
  return v.is_string() ? v.str() : std::string(fb);
}
/// bool(e, k, fallback).
inline bool flag(const Value& p, std::string_view k, bool fb) {
  const Value& v = p[k];
  return v.is_bool() ? v.truthy() : fb;
}

/// @utils/lang clamp01: NaN → 0.
inline double clamp01_lang(double v) { return v > 0 ? (v > 1 ? 1 : v) : 0; }
/// colorSpace.ts clamp01: NaN passes through.
inline double clamp01_cs(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

inline double cos_js(double x) { return motion::js::cos(x); }
inline double sin_js(double x) { return motion::js::sin(x); }
inline std::string jsn(double v) { return motion::js::number_to_string(v); }

/// fillStyle / strokeStyle / shadowColor = <css string>: the canvas ignores what it cannot parse.
inline void fill_css(Canvas2D& c, std::string_view css) {
  if (const auto col = raster::css::parse_color(css)) {
    Style s;
    s.color = *col;
    c.setFillStyle(s);
  }
}
inline void stroke_css(Canvas2D& c, std::string_view css) {
  if (const auto col = raster::css::parse_color(css)) {
    Style s;
    s.color = *col;
    c.setStrokeStyle(s);
  }
}

/// generateAdvanced.ts rgba(hex, alpha): `#rrggbb` / `#rgb` → rgba(r,g,b,alpha), else mid grey.
inline std::string rgba(const std::string& hex, double alpha) {
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
    return "rgba(128,128,128," + jsn(alpha) + ")";
  }
  int n = 0;
  for (const char ch : full) n = n * 16 + hexv(ch);
  return "rgba(" + std::to_string((n >> 16) & 255) + "," + std::to_string((n >> 8) & 255) + "," + std::to_string(n & 255) + "," +
         jsn(alpha) + ")";
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
inline Grad radial(double x0, double y0, double r0, double x1, double y1, double r1) {
  Grad out;
  out.g->kind = Gradient::Kind::radial;
  out.g->p = {x0, y0, r0, x1, y1, r1};
  return out;
}
inline Grad linear(double x0, double y0, double x1, double y1) {
  Grad out;
  out.g->kind = Gradient::Kind::linear;
  out.g->p = {x0, y0, x1, y1, 0, 0};
  return out;
}

/// generateAdvanced.ts compositeFor: 0 over · 1 add · 2 screen · 3 multiply · 4 inside.
inline std::string_view composite_for(double mode) {
  const double m = motion::js::round(mode);
  if (m == 1) return "lighter";
  if (m == 2) return "screen";
  if (m == 3) return "multiply";
  if (m == 4) return "source-atop";
  return "source-over";
}

/// withComposite: run `fn` under a composite mode, restoring the previous one.
inline void with_composite(Canvas2D& oc, double mode, const std::function<void()>& fn) {
  const std::string prev = oc.globalCompositeOperation();
  (void)oc.setGlobalCompositeOperation(composite_for(mode));
  fn();
  (void)oc.setGlobalCompositeOperation(prev);
}

/// generatePatterns.ts withPatternClip: source-atop, inside a save / restore.
inline void with_pattern_clip(Canvas2D& oc, const std::function<void()>& fn) {
  oc.save();
  (void)oc.setGlobalCompositeOperation("source-atop");
  fn();
  oc.restore();
}

}  // namespace premation::effects::canvas_detail
