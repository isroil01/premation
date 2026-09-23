// motion_jsmath — JavaScript `Math` and Number semantics, bit-for-bit.
//
// WHY THIS EXISTS. The TypeScript engine runs on V8, and V8 does not call the
// platform libm for `Math.sin` & co.: it carries its own port of fdlibm
// (src/base/ieee754.cc — fdlibm 5.3 plus a few FreeBSD msun routines). fdlibm is
// not correctly rounded (it is within 1 ulp), so any other libm — the MSVC UCRT,
// glibc, Apple's libm — returns a different last bit for a few percent of
// inputs. That is invisible in a rendered pixel but it is NOT invisible in the
// expression language: `hash01(n) = frac(sin(n * 127.1) * 43758.5453)` (the
// noise behind `wiggle`, `random`, `noise`) multiplies the last bit of `sin` by
// 43758 and keeps the fraction, so one ulp of `sin` is a completely different
// wiggle. Parity with the TypeScript therefore REQUIRES V8's math, and a port of
// it is also the only way to get the same value on every platform we ship on.
//
// Every function here names the fdlibm / V8 routine it mirrors and keeps its
// operation order. Verified against Node 24 (V8 13.6) over the golden corpus in
// native/tests (golden_jsmath.inc: several thousand inputs per function, every
// range and special value) with exact bit equality.
//
// Only + - * / sqrt floor trunc fabs (all correctly rounded IEEE operations)
// are used as primitives, and the library is compiled with -ffp-contract=off,
// so the result is the same on x86-64, arm64 and wasm. The one exception is
// `pow`, which V8 itself delegates to the platform libm (see fdlibm.cpp).

#ifndef MOTION_JSMATH_JSMATH_HPP
#define MOTION_JSMATH_JSMATH_HPP

#include <bit>
#include <cmath>
#include <cstdint>
#include <limits>
#include <span>

namespace motion::js {

// ── fdlibm / V8 ieee754 (fdlibm.cpp) ────────────────────────────────────────

[[nodiscard]] double sin(double x) noexcept;
[[nodiscard]] double cos(double x) noexcept;
[[nodiscard]] double tan(double x) noexcept;
[[nodiscard]] double asin(double x) noexcept;
[[nodiscard]] double acos(double x) noexcept;
[[nodiscard]] double atan(double x) noexcept;
[[nodiscard]] double atan2(double y, double x) noexcept;
[[nodiscard]] double exp(double x) noexcept;
[[nodiscard]] double expm1(double x) noexcept;
[[nodiscard]] double log(double x) noexcept;
[[nodiscard]] double log1p(double x) noexcept;
[[nodiscard]] double log2(double x) noexcept;
[[nodiscard]] double log10(double x) noexcept;
[[nodiscard]] double sinh(double x) noexcept;
[[nodiscard]] double cosh(double x) noexcept;
[[nodiscard]] double tanh(double x) noexcept;
[[nodiscard]] double asinh(double x) noexcept;
[[nodiscard]] double acosh(double x) noexcept;
[[nodiscard]] double atanh(double x) noexcept;
[[nodiscard]] double cbrt(double x) noexcept;
/// `Math.pow`: ECMAScript's special cases (NaN for (±1) ** ±Infinity and
/// x ** NaN), V8's y == 2 / y == 0.5 fast paths, then the PLATFORM std::pow —
/// because that is what V8 does (measured; see fdlibm.cpp). The one function
/// here that is not identical across platforms, exactly as in the TS engine.
[[nodiscard]] double pow(double x, double y) noexcept;

// ── The rest of Math, as V8's builtins compute it ───────────────────────────

inline constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
inline constexpr double kInf = std::numeric_limits<double>::infinity();

/// `Math.round` — V8 `Float64Round`: ceil(x), minus one when that overshot by
/// more than a half. Keeps -0 for -0.5 < x <= -0 as the spec requires.
[[nodiscard]] inline double round(double x) noexcept {
  if (!std::isfinite(x)) return x;
  double r = std::ceil(x);
  if (r - 0.5 > x) r -= 1.0;
  return r;
}

/// `Math.sign`.
[[nodiscard]] inline double sign(double x) noexcept {
  if (std::isnan(x) || x == 0) return x;
  return x > 0 ? 1.0 : -1.0;
}

/// `Math.fround`: the nearest float32, widened back.
[[nodiscard]] inline double fround(double x) noexcept {
  return static_cast<double>(static_cast<float>(x));
}

/// ECMAScript ToInt32 / ToUint32 (modulo 2^32).
[[nodiscard]] std::uint32_t to_uint32(double x) noexcept;
[[nodiscard]] inline std::int32_t to_int32(double x) noexcept {
  return std::bit_cast<std::int32_t>(to_uint32(x));
}

/// `Math.clz32`.
[[nodiscard]] inline double clz32(double x) noexcept {
  return static_cast<double>(std::countl_zero(to_uint32(x)));
}

/// `Math.imul`.
[[nodiscard]] inline double imul(double a, double b) noexcept {
  const std::uint32_t p = to_uint32(a) * to_uint32(b);
  return static_cast<double>(std::bit_cast<std::int32_t>(p));
}

/// `Math.max(...args)` over already-converted numbers. -0 < +0; any NaN wins.
[[nodiscard]] double max_of(std::span<const double> v) noexcept;
/// `Math.min(...args)`.
[[nodiscard]] double min_of(std::span<const double> v) noexcept;

/// `Math.hypot(...args)` — V8's Torque builtin: scale by the largest
/// magnitude, Kahan-compensated sum of squares, sqrt, rescale. An Infinity
/// anywhere wins over a NaN anywhere (spec order).
[[nodiscard]] double hypot(std::span<const double> v) noexcept;

/// JavaScript `%` (C fmod, exact).
[[nodiscard]] inline double mod(double a, double b) noexcept { return std::fmod(a, b); }

}  // namespace motion::js

#endif  // MOTION_JSMATH_JSMATH_HPP
