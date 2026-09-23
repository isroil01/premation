// motion_jsmath — V8's Math and Number<->String, bit for bit.
//
// golden_jsmath.inc / golden_numconv.inc are written by RUNNING Node
// (native/tests/gen_golden_jsmath.ts). Exact equality: NaN matches NaN, -0 is
// not +0, strings compare code unit by code unit. The rows are expanded into
// static TABLES and checked in a loop (one inline block per row made this
// translation unit take gigabytes under ASan).

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>

#include "jsmath.hpp"
#include "numconv.hpp"

namespace {

namespace js = motion::js;

struct MathRow {
  std::string_view name;
  int arity;
  std::uint64_t x, y, e;
};

// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define MOTION_JSMATH_1(name, xb, eb) MathRow{#name, 1, xb, 0, eb},
#define MOTION_JSMATH_2(name, xb, yb, eb) MathRow{#name, 2, xb, yb, eb},
constexpr MathRow kMathRows[] = {  // NOLINT(cppcoreguidelines-avoid-c-arrays)
#include "golden_jsmath.inc"
};
#undef MOTION_JSMATH_1
#undef MOTION_JSMATH_2

enum class NumOp : std::uint8_t { kToString, kFixed, kPrecision, kExponential, kRadix, kParse };
struct NumRow {
  NumOp op;
  std::uint64_t x;
  int arg;
  std::u16string_view s;
};
#define MOTION_NUM_TOSTRING(xb, str) NumRow{NumOp::kToString, xb, 0, str},
#define MOTION_NUM_FIXED(xb, f, str) NumRow{NumOp::kFixed, xb, f, str},
#define MOTION_NUM_PRECISION(xb, p, str) NumRow{NumOp::kPrecision, xb, p, str},
#define MOTION_NUM_EXPONENTIAL(xb, f, str) NumRow{NumOp::kExponential, xb, f, str},
#define MOTION_NUM_RADIX(xb, r, str) NumRow{NumOp::kRadix, xb, r, str},
#define MOTION_NUM_PARSE(str, xb) NumRow{NumOp::kParse, xb, 0, str},
constexpr NumRow kNumRows[] = {  // NOLINT(cppcoreguidelines-avoid-c-arrays)
#include "golden_numconv.inc"
};
// NOLINTEND(cppcoreguidelines-macro-usage)

double from_bits(std::uint64_t b) { return std::bit_cast<double>(b); }
bool same(double a, double b) {
  if (std::isnan(a) && std::isnan(b)) return true;
  return std::bit_cast<std::uint64_t>(a) == std::bit_cast<std::uint64_t>(b);
}
std::u16string wide(const std::string& s) { return {s.begin(), s.end()}; }

double call(std::string_view n, double x, double y) {
  const std::array<double, 2> v{x, y};
  if (n == "sin") return js::sin(x);
  if (n == "cos") return js::cos(x);
  if (n == "tan") return js::tan(x);
  if (n == "asin") return js::asin(x);
  if (n == "acos") return js::acos(x);
  if (n == "atan") return js::atan(x);
  if (n == "exp") return js::exp(x);
  if (n == "expm1") return js::expm1(x);
  if (n == "log") return js::log(x);
  if (n == "log1p") return js::log1p(x);
  if (n == "log2") return js::log2(x);
  if (n == "log10") return js::log10(x);
  if (n == "sinh") return js::sinh(x);
  if (n == "cosh") return js::cosh(x);
  if (n == "tanh") return js::tanh(x);
  if (n == "asinh") return js::asinh(x);
  if (n == "acosh") return js::acosh(x);
  if (n == "atanh") return js::atanh(x);
  if (n == "cbrt") return js::cbrt(x);
  if (n == "round") return js::round(x);
  if (n == "sign") return js::sign(x);
  if (n == "fround") return js::fround(x);
  if (n == "clz32") return js::clz32(x);
  if (n == "atan2") return js::atan2(x, y);
  if (n == "pow") return js::pow(x, y);
  if (n == "hypot2") return js::hypot(v);
  if (n == "imul") return js::imul(x, y);
  if (n == "max2") return js::max_of(v);
  if (n == "min2") return js::min_of(v);
  if (n == "mod") return js::mod(x, y);
  FAIL("unknown golden function " << n);
  return 0;
}

}  // namespace

TEST_CASE("Math.* matches V8 bit for bit", "[jsmath][golden]") {
  int bad = 0;
  int pow_ulp = 0;  // Math.pow is the platform libm in V8 too: <= 1 ulp is reported, not failed
  for (const MathRow& r : std::span(kMathRows)) {
    const double got = call(r.name, from_bits(r.x), from_bits(r.y));
    const double want = from_bits(r.e);
    if (same(got, want)) continue;
    const auto a = std::bit_cast<std::uint64_t>(got);
    const auto b = std::bit_cast<std::uint64_t>(want);
    if (r.name == "pow" && std::isfinite(got) && std::isfinite(want) && std::signbit(got) == std::signbit(want) &&
        (a > b ? a - b : b - a) <= 1) {
      ++pow_ulp;
      continue;
    }
    ++bad;
    UNSCOPED_INFO(r.name << "(" << from_bits(r.x) << ", " << from_bits(r.y) << ") = " << got << ", V8 " << want);
  }
  INFO(std::size(kMathRows) << " rows, pow rows 1 ulp off: " << pow_ulp);
  CHECK(bad == 0);
}

TEST_CASE("Number <-> String matches V8 exactly", "[jsmath][golden]") {
  int bad = 0;
  for (const NumRow& r : std::span(kNumRows)) {
    const double x = from_bits(r.x);
    bool ok = false;
    switch (r.op) {
      case NumOp::kToString: ok = wide(js::number_to_string(x)) == r.s; break;
      case NumOp::kFixed: ok = wide(js::to_fixed(x, r.arg)) == r.s; break;
      case NumOp::kPrecision: ok = wide(js::to_precision(x, r.arg)) == r.s; break;
      case NumOp::kExponential: ok = wide(js::to_exponential(x, r.arg)) == r.s; break;
      case NumOp::kRadix: ok = wide(js::number_to_radix(x, r.arg)) == r.s; break;
      case NumOp::kParse: ok = same(js::string_to_number(r.s), x); break;
    }
    if (!ok) {
      ++bad;
      UNSCOPED_INFO("op " << static_cast<int>(r.op) << " x=" << x << " arg=" << r.arg);
    }
  }
  INFO(std::size(kNumRows) << " rows");
  CHECK(bad == 0);
}
