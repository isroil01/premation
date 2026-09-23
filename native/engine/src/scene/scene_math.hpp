// Small numeric helpers shared by the scene builder — JavaScript Math where the
// TypeScript result depends on it (motion_jsmath is V8's fdlibm, bit for bit),
// and the renderer's float32 Mat3 (packages/renderer core/math/Mat3.ts).
#pragma once

#include <array>
#include <cmath>
#include <numbers>
#include <span>

#include "jsmath.hpp"

namespace premation::scene {

/// `Math.hypot(a, b)`.
[[nodiscard]] inline double hypot2(double a, double b) noexcept {
  const std::array<double, 2> v{a, b};
  return motion::js::hypot(std::span<const double>(v));
}

/// `Math.PI / 180`.
inline constexpr double kDeg = std::numbers::pi / 180;

/// packages/renderer Mat3: a Float32Array(9), column-major (m[6], m[7] = translation).
/// Every product rounds to float32 per element, as the TypeScript's typed array stores it.
struct Mat3 {
  std::array<float, 9> m{1, 0, 0, 0, 1, 0, 0, 0, 1};
  static Mat3 identity() noexcept { return {}; }
};

/// Mat3.multiply(a, b) — a·b, computed in float64 per element then stored float32
/// (JavaScript reads Float32Array elements as doubles and the store rounds).
[[nodiscard]] inline Mat3 mat3_mul(const Mat3& a, const Mat3& b) noexcept {
  Mat3 o;
  const auto& A = a.m;
  const auto& B = b.m;
  for (std::size_t c = 0; c < 3; ++c) {
    for (std::size_t r = 0; r < 3; ++r) {
      const double v = (static_cast<double>(A[r]) * B[c * 3]) + (static_cast<double>(A[3 + r]) * B[(c * 3) + 1]) +
                       (static_cast<double>(A[6 + r]) * B[(c * 3) + 2]);
      o.m[(c * 3) + r] = static_cast<float>(v);
    }
  }
  return o;
}

}  // namespace premation::scene
