// E4 effect kernels — the JavaScript number semantics the TypeScript kernels
// lean on, as inline C++.
//
// The TS kernels (src/core/effects/*.ts) compute in IEEE doubles and store into
// `Uint8ClampedArray` / `Uint16Array` / `Float32Array`. Each store is a
// conversion with its own rounding rule, and parity with the TS bake is only
// exact if the C++ performs the SAME conversion at the SAME point:
//
//   Uint8ClampedArray   ToUint8Clamp: NaN → 0, clamp to [0, 255], round half
//                       to EVEN (not half up, not truncate).
//   Uint16Array         ToUint16: truncate toward zero, modulo 2^16.
//   Float32Array        round to nearest float32.
//
// Everything else is `motion::js` (V8's Math: round, exp, sin, hypot, …). The
// engine is built with -ffp-contract=off, so `a * b + c` is two roundings here
// exactly as in V8.
#pragma once

#include <cmath>
#include <cstdint>
#include <span>

#include "jsmath.hpp"

namespace premation::effects {

namespace js = motion::js;

/// A straight (non-premultiplied) RGBA8 buffer, row-major, stride w·4 — the
/// shape `getImageData` hands every TS kernel.
struct RgbaView {
  std::span<std::uint8_t> data;
  int w = 0;
  int h = 0;
  [[nodiscard]] std::size_t pixels() const noexcept {
    return static_cast<std::size_t>(w) * static_cast<std::size_t>(h);
  }
};

/// `Uint8ClampedArray[i] = v` — ECMAScript ToUint8Clamp.
[[nodiscard]] inline std::uint8_t u8c(double v) noexcept {
  if (!(v > 0.0)) return 0;  // NaN, -0, negatives
  if (v >= 255.0) return 255;
  const double f = std::floor(v);
  const double half = f + 0.5;
  if (half < v) return static_cast<std::uint8_t>(f + 1.0);
  if (v < half) return static_cast<std::uint8_t>(f);
  const auto fi = static_cast<std::uint32_t>(f);
  return static_cast<std::uint8_t>((fi & 1U) != 0U ? fi + 1U : fi);
}

/// ECMAScript ToUint32 (`x >>> 0`). The common in-range case is a truncating
/// cast; everything else (NaN, ±Inf, |x| ≥ 2^32) takes motion::js's exact
/// fmod path. Same result either way.
[[nodiscard]] inline std::uint32_t ju32(double x) noexcept {
  if (x > -2147483648.0 && x < 4294967296.0) return static_cast<std::uint32_t>(static_cast<std::int64_t>(x));
  return js::to_uint32(x);
}
/// ECMAScript ToInt32 (`x | 0`).
[[nodiscard]] inline std::int32_t ji32(double x) noexcept { return static_cast<std::int32_t>(ju32(x)); }

/// `Uint16Array[i] = v` for the non-negative, below-2^16 values the kernels
/// store (ToUint16 truncates toward zero).
[[nodiscard]] inline std::uint16_t u16t(double v) noexcept {
  return static_cast<std::uint16_t>(ju32(v));
}

/// `v < 0 ? 0 : v > 255 ? 255 : v` (colorSpace.ts `clamp255`; NaN passes through).
[[nodiscard]] inline double clamp255(double v) noexcept { return v < 0 ? 0 : v > 255 ? 255 : v; }
/// `clamp01`.
[[nodiscard]] inline double clamp01(double v) noexcept { return v < 0 ? 0 : v > 1 ? 1 : v; }

/// `luma` from colorEffects.ts (Rec. 601) — Find Edges, Emboss, Vibrance, Add Grain.
[[nodiscard]] inline double luma601(double r, double g, double b) noexcept {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
/// `luma` from colorSpace.ts (Rec. 709) — the aeBlurAdvanced family.
[[nodiscard]] inline double luma709(double r, double g, double b) noexcept {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

[[nodiscard]] inline int clampi(int v, int lo, int hi) noexcept { return v < lo ? lo : v > hi ? hi : v; }

/// `Math.round(x)` of a finite double as an int (callers clamp first).
[[nodiscard]] inline int jround_i(double x) noexcept { return static_cast<int>(js::round(x)); }

[[nodiscard]] inline std::size_t idx4(int x, int y, int w) noexcept {
  return (static_cast<std::size_t>(y) * static_cast<std::size_t>(w) + static_cast<std::size_t>(x)) * 4U;
}

}  // namespace premation::effects
