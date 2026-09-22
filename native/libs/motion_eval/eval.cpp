// motion_eval — the non-template half of the port (see eval.hpp).
//
// Bit-identity rule for every arithmetic line: keep the TypeScript's operand
// order and associativity. JavaScript evaluates `a * b * c` as `(a * b) * c`
// and `p + q + r` as `(p + q) + r`; C++ does the same, and with
// -ffp-contract=off no multiply-add pair is fused. The line references are to
// packages/animation/src/interpolate.ts.

#include "eval.hpp"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <span>
#include <string_view>

namespace motion::eval {

namespace {

// `x < 0 ? 0 : x > 1 ? 1 : x` — the TypeScript clamp, NaN-free by precondition.
[[nodiscard]] constexpr double clamp01(double x) noexcept {
  return x < 0.0 ? 0.0 : (x > 1.0 ? 1.0 : x);
}

// A double that is an exact integer in [lo, hi]. Used to decode the packed
// `easing` / `flags` fields; anything else is a malformed track, not a cast.
[[nodiscard]] bool is_exact_integer_in(double d, double lo, double hi) noexcept {
  if (std::isnan(d) || std::isinf(d)) return false;
  if (d < lo || d > hi) return false;
  return std::floor(d) == d;
}

}  // namespace

// interpolate.ts 13–29 — cubicBezierEase
double cubic_bezier_ease(double x1, double y1, double x2, double y2, double x) noexcept {
  const double t = clamp01(x);
  const double cx = 3.0 * x1;
  const double bx = 3.0 * (x2 - x1) - cx;
  const double ax = 1.0 - cx - bx;
  const double cy = 3.0 * y1;
  const double by = 3.0 * (y2 - y1) - cy;
  const double ay = 1.0 - cy - by;
  const auto sample_x = [&](double u) noexcept { return ((ax * u + bx) * u + cx) * u; };
  const auto sample_y = [&](double u) noexcept { return ((ay * u + by) * u + cy) * u; };
  const auto d_x = [&](double u) noexcept { return (3.0 * ax * u + 2.0 * bx) * u + cx; };
  double s = t;
  for (int i = 0; i < 8; ++i) {
    const double dx = sample_x(s) - t;
    if (std::fabs(dx) < 1e-5) break;
    const double d = d_x(s);
    if (std::fabs(d) < 1e-6) break;
    s -= dx / d;
  }
  // Math.max(0, Math.min(1, s)) — s is finite here, so the plain clamp is the same.
  return sample_y(clamp01(s));
}

// interpolate.ts 32–52 — ease
double ease(std::int32_t kind, double x) noexcept {
  const double t = clamp01(x);
  switch (kind) {
    case MOTION_EASING_STEP:
      return 0.0;  // never reached by the sampler (it holds before easing); kept for parity
    case MOTION_EASING_EASE_IN:
      return t * t;
    case MOTION_EASING_EASE_OUT:
      return t * (2.0 - t);
    case MOTION_EASING_EASE:
      return cubic_bezier_ease(0.25, 0.1, 0.25, 1.0, t);
    case MOTION_EASING_AUTO_BEZIER:
    case MOTION_EASING_CONTINUOUS_BEZIER:
      return cubic_bezier_ease(0.333, 0.0, 0.667, 1.0, t);
    case MOTION_EASING_EASE_IN_OUT:
      return t < 0.5 ? 2.0 * t * t : -1.0 + (4.0 - 2.0 * t) * t;
    case MOTION_EASING_LINEAR:
    case MOTION_EASING_HOLD:
    case MOTION_EASING_BEZIER:
    default:
      return t;
  }
}

// interpolate.ts 59–63 — cubicValueAt
double cubic_value_at(double v0, double v1, double v2, double v3, double u) noexcept {
  const double s = clamp01(u);
  const double m = 1.0 - s;
  return m * m * m * v0 + 3.0 * m * m * s * v1 + 3.0 * m * s * s * v2 + s * s * s * v3;
}

std::string_view validate_keyframe(const Keyframe& k) noexcept {
  if (std::isnan(k.t)) return "keyframe time is NaN";
  if (std::isnan(k.value)) return "keyframe value is NaN";
  if (k.easing < 0 || k.easing >= kEasingCount) return "keyframe easing is not a motion_easing";
  constexpr std::uint32_t known_bits =
      MOTION_KF_HAS_BEZIER | MOTION_KF_HAS_SI | MOTION_KF_HAS_SO | MOTION_KF_SPATIAL_MASK;
  if ((k.flags & ~known_bits) != 0u) return "keyframe flags carry unknown bits";
  if (spatial_mode(k) >= static_cast<std::uint32_t>(MOTION_SPATIAL_COUNT_)) return "keyframe spatial mode is not a motion_spatial";
  if ((k.flags & MOTION_KF_HAS_BEZIER) != 0u) {
    if (std::isnan(k.c0) || std::isnan(k.c1) || std::isnan(k.c2) || std::isnan(k.c3)) {
      return "keyframe bezier handle is NaN";
    }
  }
  if ((k.flags & MOTION_KF_HAS_SI) != 0u && std::isnan(k.si)) return "keyframe si is NaN";
  if ((k.flags & MOTION_KF_HAS_SO) != 0u && std::isnan(k.so)) return "keyframe so is NaN";
  return {};
}

std::string_view validate_packed_keyframe(std::span<const double> ten) noexcept {
  if (ten.size() < kPackedDoubles) return "packed keyframe is short";
  if (!is_exact_integer_in(ten[2], 0.0, static_cast<double>(kEasingCount - 1))) {
    return "packed easing is not an integer in range";
  }
  if (!is_exact_integer_in(ten[3], 0.0, static_cast<double>(std::numeric_limits<std::uint32_t>::max()))) {
    return "packed flags is not an integer in range";
  }
  return validate_keyframe(PackedSource{.data = ten, .count = 1}.get(0));
}

Keyframe PackedSource::get(std::size_t i) const noexcept {
  const std::span<const double> ten = data.subspan(i * kPackedDoubles, kPackedDoubles);
  return Keyframe{.t = ten[0],
                  .value = ten[1],
                  .easing = static_cast<std::int32_t>(ten[2]),
                  .flags = static_cast<std::uint32_t>(ten[3]),
                  .c0 = ten[4],
                  .c1 = ten[5],
                  .c2 = ten[6],
                  .c3 = ten[7],
                  .si = ten[8],
                  .so = ten[9]};
}

}  // namespace motion::eval
