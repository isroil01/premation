// Port of src/core/effects/noiseHash.ts — the u32 value-noise family the GPU
// kernels and the CPU bake share. `Math.imul` / `>>> 0` are u32 wrap-around,
// so this is plain uint32 arithmetic; the interpolation stays in doubles, in
// the TS's operation order.
#pragma once

#include <cmath>
#include <cstdint>

#include "pixel_ops.hpp"

namespace premation::effects {

/// `hash01u(x, y, seed)` for already-ToUint32'd inputs.
[[nodiscard]] inline double hash01u(std::uint32_t x, std::uint32_t y, std::uint32_t seed) noexcept {
  std::uint32_t n = x * 374761393U + y * 668265263U + seed * 2147483647U;
  n = (n ^ (n >> 13U)) * 1274126177U;
  n = n ^ (n >> 16U);
  return static_cast<double>(n) / 4294967296.0;
}

/// GLSL `mix`.
[[nodiscard]] inline double mixd(double a, double b, double t) noexcept { return a * (1 - t) + b * t; }

/// `vnoiseU(px, py, seed)`; `seed` is the JS number (floored integer or not,
/// it goes through `>>> 0`).
[[nodiscard]] inline double vnoise_u(double px, double py, double seed) noexcept {
  const double ix = std::floor(px);
  const double iy = std::floor(py);
  const double fx = px - ix;
  const double fy = py - iy;
  const double ux = fx * fx * (3 - 2 * fx);
  const double uy = fy * fy * (3 - 2 * fy);
  const std::uint32_t xi = ju32(ix);
  const std::uint32_t yi = ju32(iy);
  const std::uint32_t xi1 = ju32(ix + 1);
  const std::uint32_t yi1 = ju32(iy + 1);
  const std::uint32_t s = ju32(seed);
  const double a = hash01u(xi, yi, s);
  const double b = hash01u(xi1, yi, s);
  const double c = hash01u(xi, yi1, s);
  const double d = hash01u(xi1, yi1, s);
  return mixd(mixd(a, b, ux), mixd(c, d, ux), uy);
}

/// `vnoiseF(px, py, seed)` — a float seed glides between two integer seeds.
[[nodiscard]] inline double vnoise_f(double px, double py, double seed) noexcept {
  const double s0 = std::floor(seed);
  return mixd(vnoise_u(px, py, s0), vnoise_u(px, py, s0 + 1), seed - s0);
}

}  // namespace premation::effects
