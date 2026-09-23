// motion_jsmath — ECMAScript Number ⇄ String, exactly.
//
// The expression language concatenates numbers into strings (`"x = " + x`),
// compares strings with numbers, formats with `toFixed`, and parses numeric
// literals and strings. Each of those is specified to the digit by ECMA-262,
// and each is observable in a Source Text result or a string comparison, so
// each is ported rather than approximated:
//
//   number_to_string   Number::toString(x) — the SHORTEST digit string that
//                      round-trips, closest to x, ties to even; then the
//                      spec's fixed/exponential layout.
//   to_fixed / to_precision / to_exponential
//                      Number.prototype methods: exact decimal value of the
//                      double, ties rounded to the LARGER n (spec), not to even.
//   number_to_radix    V8's DoubleToRadixCString (toString(radix != 10)).
//   string_to_number   StringToNumber: whitespace trim, Infinity, 0x/0o/0b,
//                      decimal — correctly rounded.
//
// No CRT involvement (no printf, no strtod): results do not depend on the
// process locale or on the platform's formatting routines. Everything is exact
// big-integer arithmetic (BigUint in numconv.cpp).

#ifndef MOTION_JSMATH_NUMCONV_HPP
#define MOTION_JSMATH_NUMCONV_HPP

#include <string>
#include <string_view>

namespace motion::js {

/// Number::toString(x) (radix 10). "NaN", "Infinity", "-Infinity", "0" for ±0.
[[nodiscard]] std::string number_to_string(double x);

/// Number.prototype.toString(radix) for 2 <= radix <= 36, radix != 10 — V8's
/// DoubleToRadixCString. Precondition: radix in range (the caller throws).
[[nodiscard]] std::string number_to_radix(double x, int radix);

/// Number.prototype.toFixed(f). Precondition: 0 <= f <= 100.
[[nodiscard]] std::string to_fixed(double x, int f);

/// Number.prototype.toPrecision(p). Precondition: 1 <= p <= 100.
[[nodiscard]] std::string to_precision(double x, int p);

/// Number.prototype.toExponential(f); f < 0 means "undefined" (shortest).
/// Precondition: f <= 100.
[[nodiscard]] std::string to_exponential(double x, int f);

/// StringToNumber over UTF-16 code units (the language's string type).
[[nodiscard]] double string_to_number(std::u16string_view s);

/// StringToNumber over ASCII (numeric literal tokens).
[[nodiscard]] double string_to_number(std::string_view s);

}  // namespace motion::js

#endif  // MOTION_JSMATH_NUMCONV_HPP
