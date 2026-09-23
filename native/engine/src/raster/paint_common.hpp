// Helpers shared by the C++ painters (vector_paint.cpp, text_paint.cpp): JS
// number semantics (the TS painters' arithmetic runs on V8, so geometry uses
// motion_jsmath's fdlibm port) and the fill-paint model of src/core/paint/fill.ts.
#pragma once

#include <array>
#include <cmath>
#include <numbers>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "canvas.hpp"
#include "json.hpp"
#include "jsmath.hpp"

namespace premation::raster {

inline constexpr double kJsPi = std::numbers::pi;  // == Math.PI

[[nodiscard]] inline double js_hypot(double a, double b) noexcept {
  const std::array<double, 2> v{a, b};
  return motion::js::hypot(v);
}
[[nodiscard]] inline double js_sin(double x) noexcept { return motion::js::sin(x); }
[[nodiscard]] inline double js_cos(double x) noexcept { return motion::js::cos(x); }
[[nodiscard]] inline double js_atan2(double y, double x) noexcept { return motion::js::atan2(y, x); }
[[nodiscard]] inline double js_tan(double x) noexcept { return motion::js::tan(x); }
/// Math.round: half up (toward +∞).
[[nodiscard]] inline double js_round(double x) noexcept { return motion::js::round(x); }
[[nodiscard]] inline double clamp01(double v) noexcept {
  // The TS clamp01 (@utils/lang): NaN passes through untouched.
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/// A colour stop / opacity stop of a FillPaint.
struct ColorStop {
  double offset = 0.0;
  std::string color;
};
struct OpacityStop {
  double offset = 0.0;
  double opacity = 1.0;
};

/// src/core/paint/fill.ts FillPaint (+ the composite / blend fields a paint carries).
struct FillPaint {
  enum class Type : std::uint8_t { solid, linear, radial };
  Type type = Type::solid;
  std::string color;
  double angle = 0.0;
  double cx = 0.5;
  double cy = 0.5;
  double radius = 0.5;
  std::vector<ColorStop> stops;          // sorted by offset (stable)
  std::vector<OpacityStop> opacityStops;  // sorted by offset (stable)
  std::string composite;                  // 'below' | 'above'
  std::string blendMode;                  // '' | 'normal' | …
};

/// Parse a FillPaint; nullopt when absent / not a paint.
[[nodiscard]] std::optional<FillPaint> read_fill_paint(const json::Value& v);

/// makeCanvasGradient(ctx, paint, w, h, ox, oy) → a Canvas2D gradient style.
[[nodiscard]] Style make_canvas_gradient(const FillPaint& paint, double w, double h, double ox = 0, double oy = 0);

/// A CSS colour string → a Canvas2D colour style (nullopt = the canvas would ignore it).
[[nodiscard]] std::optional<Style> color_style(std::string_view css);

/// The stop list makeCanvasGradient hands addColorStop (colour + opacity ramps merged).
[[nodiscard]] std::vector<Gradient::Stop> gradient_stops(const FillPaint& paint);

/// fill.ts applyAlpha / sampleGradientColor / sampleGradientOpacity, as strings the canvas parses.
[[nodiscard]] std::string sample_gradient_color(const std::vector<ColorStop>& sorted, double t);
[[nodiscard]] double sample_gradient_opacity(const std::vector<OpacityStop>& sorted, double t);
[[nodiscard]] std::string apply_alpha(std::string_view color, double opacity);

}  // namespace premation::raster
