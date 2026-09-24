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

#include <bit>
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

/// Round to nearest, ties to even, for |v| < 2^51: adding and removing
/// 1.5 · 2^52 leaves no fraction bits, and IEEE addition rounds half to even.
/// (Baseline x86-64 has no SSE4.1 `roundsd`, so std::nearbyint / std::floor
/// are libm calls; this is two adds, and it vectorises.) Needs the default
/// rounding mode, which the engine never changes.
[[nodiscard]] inline double round_half_even(double v) noexcept {
  constexpr double kMagic = 6755399441055744.0;  // 1.5 · 2^52
  return (v + kMagic) - kMagic;
}

/// `Uint8ClampedArray[i] = v` — ECMAScript ToUint8Clamp: NaN → 0, clamp to
/// [0, 255], round half to even. Branch-free (compare-selects).
[[nodiscard]] inline std::uint8_t u8c(double v) noexcept {
  double c = v > 0.0 ? v : 0.0;  // NaN and negatives → 0
  c = c < 255.0 ? c : 255.0;
  return static_cast<std::uint8_t>(static_cast<int>(round_half_even(c)));
}

/// `Math.floor(x)` for the |x| < 2^51 lattice coordinates the noise kernels
/// floor. Differs from std::floor only in returning +0 for -0, which no
/// caller can observe (it is only subtracted or converted to an integer).
[[nodiscard]] inline double floor_fast(double x) noexcept {
  if (!(x > -2251799813685248.0 && x < 2251799813685248.0)) return std::floor(x);
  const double r = round_half_even(x);
  return r > x ? r - 1.0 : r;
}

/// ECMAScript ToUint32 (`x >>> 0`). The common in-range case is a truncating
/// cast; everything else (NaN, ±Inf, |x| ≥ 2^32) takes motion::js's exact
/// fmod path. Same result either way.
[[nodiscard]] inline std::uint32_t ju32(double x) noexcept {
  // Any finite |x| < 2^63 truncates exactly into an int64, whose low 32 bits
  // are trunc(x) mod 2^32 — the JS hashes' 2^40…2^62 sums included.
  if (x > -9223372036854775808.0 && x < 9223372036854775808.0) {
    return static_cast<std::uint32_t>(static_cast<std::uint64_t>(static_cast<std::int64_t>(x)));
  }
  if (!std::isfinite(x)) return 0;
  // |x| ≥ 2^63: an integer mant · 2^e with e ≥ 11, so its low 32 bits are
  // (mant << e) mod 2^32, and 0 once e ≥ 32 (the hashes' 1.4e18 · seed terms).
  const auto bits = std::bit_cast<std::uint64_t>(x);
  const int e = static_cast<int>((bits >> 52U) & 0x7FFU) - 1075;
  if (e >= 32) return 0;
  const std::uint64_t mant = (bits & ((std::uint64_t{1} << 52U) - 1U)) | (std::uint64_t{1} << 52U);
  const auto low = static_cast<std::uint32_t>(mant << static_cast<unsigned>(e));
  return (bits >> 63U) != 0U ? static_cast<std::uint32_t>(0U - low) : low;
}
/// ECMAScript ToInt32 (`x | 0`).
[[nodiscard]] inline std::int32_t ji32(double x) noexcept { return static_cast<std::int32_t>(ju32(x)); }

/// `Uint16Array[i] = v` for the values the box blur stores: finite, in
/// [0, 65536) (a mean of premultiplied bytes + 0.5), where ToUint16 is a
/// truncation — a plain cast, so the store loops vectorise.
[[nodiscard]] inline std::uint16_t u16t(double v) noexcept {
  return static_cast<std::uint16_t>(static_cast<std::int32_t>(v));
}

/// `Math.round(x)` (V8: ceil, minus one when that overshot by more than a
/// half) for finite |x| < 2^51, as an index: the sign of a zero result is not
/// kept, which a sample coordinate cannot observe. No libm call.
[[nodiscard]] inline double round_index(double x) noexcept {
  if (!(x > -2251799813685248.0 && x < 2251799813685248.0)) return js::round(x);
  double r = round_half_even(x);
  if (r < x) r += 1.0;  // ceil
  if (r - 0.5 > x) r -= 1.0;
  return r;
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
