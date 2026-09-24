// src/core/effects/colorSpace.ts (rgbToHsl, hslToRgb, hueDistance,
// smoothstep) as inline C++, in the TS's operation order, shared by the colour
// and keying kernels.
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

#include "pixel_ops.hpp"
#include "thread_pool.hpp"

namespace premation::effects {

struct Hsl {
  double h, s, l;
};

/// `rgbToHsl(r, g, b)` (0–255 in, 0–1 out).
[[nodiscard]] inline Hsl rgb_to_hsl(double r, double g, double b) noexcept {
  const double rn = r / 255;
  const double gn = g / 255;
  const double bn = b / 255;
  const double mx = std::max(rn, std::max(gn, bn));
  const double mn = std::min(rn, std::min(gn, bn));
  const double l = (mx + mn) / 2;
  const double d = mx - mn;
  if (d == 0) return {0, 0, l};
  const double s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  double h = 0;
  if (mx == rn) {
    h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  } else if (mx == gn) {
    h = ((bn - rn) / d + 2) / 6;
  } else {
    h = ((rn - gn) / d + 4) / 6;
  }
  return {h, s, l};
}

[[nodiscard]] inline double hue_to_channel(double p, double q, double t) noexcept {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1.0 / 6) return p + (q - p) * 6 * t;
  if (t < 1.0 / 2) return q;
  if (t < 2.0 / 3) return p + (q - p) * (2.0 / 3 - t) * 6;
  return p;
}

/// `hslToRgb(h, s, l)` → 0–255 doubles (clamped, not rounded).
[[nodiscard]] inline std::array<double, 3> hsl_to_rgb(double h, double s, double l) noexcept {
  if (s == 0) {
    const double v = clamp255(l * 255);
    return {v, v, v};
  }
  const double q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const double p = 2 * l - q;
  return {clamp255(hue_to_channel(p, q, h + 1.0 / 3) * 255), clamp255(hue_to_channel(p, q, h) * 255),
          clamp255(hue_to_channel(p, q, h - 1.0 / 3) * 255)};
}

/// `hueDistance(a, b)` on the unit hue circle.
[[nodiscard]] inline double hue_distance(double a, double b) noexcept {
  const double d = std::fmod(std::fabs(a - b), 1.0);
  return d > 0.5 ? 1 - d : d;
}

/// `smoothstep(edge0, edge1, x)` (colorSpace.ts: its clamp01 lets NaN through).
[[nodiscard]] inline double smoothstep(double e0, double e1, double x) noexcept {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const double t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/// @utils/lang `clamp01` — NaN → 0 (unlike colorSpace.ts `clamp01`).
[[nodiscard]] inline double clamp01_lang(double v) noexcept { return v > 0 ? (v > 1 ? 1 : v) : 0; }

/// `Uint8Array[i] = v` (NOT clamped): ToUint8, truncation modulo 256. The
/// callers store clamp255'd values, so this is the truncation.
[[nodiscard]] inline std::uint8_t u8t(double v) noexcept {
  if (!(v > -1.0 && v < 256.0)) return static_cast<std::uint8_t>(js::to_uint32(v) & 0xFFU);
  return static_cast<std::uint8_t>(static_cast<int>(v));
}

/// Straight RGBA pixels of `img`, rows split over `pool`; `fn(px)` per pixel.
template <class Fn>
void each_pixel(RgbaView img, ThreadPool* pool, Fn&& fn) {
  std::uint8_t* data = img.data.data();
  const auto w = static_cast<std::size_t>(img.w);
  for_rows(pool, img.h, [&](int y0, int y1) {
    std::uint8_t* p = data + static_cast<std::size_t>(y0) * w * 4;
    std::uint8_t* const e = data + static_cast<std::size_t>(y1) * w * 4;
    for (; p != e; p += 4) fn(p);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  });
}

}  // namespace premation::effects
