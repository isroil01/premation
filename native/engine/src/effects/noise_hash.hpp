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
  const double ix = floor_fast(px);
  const double iy = floor_fast(py);
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
  const double s0 = floor_fast(seed);
  return mixd(vnoise_u(px, py, s0), vnoise_u(px, py, s0 + 1), seed - s0);
}

/// `vnoiseF` at one point for several seeds: the lattice cell, its smoothstep
/// weights and the x/y half of every corner hash are shared, only the seed term
/// differs. Each `sample` is bit-identical to `vnoise_f(px, py, seed)`.
class VnoisePoint {
 public:
  VnoisePoint(double px, double py) noexcept {
    const double ix = floor_fast(px);
    const double iy = floor_fast(py);
    const double fx = px - ix;
    const double fy = py - iy;
    ux_ = fx * fx * (3 - 2 * fx);
    uy_ = fy * fy * (3 - 2 * fy);
    const std::uint32_t xi = ju32(ix) * 374761393U;
    const std::uint32_t xi1 = ju32(ix + 1) * 374761393U;
    const std::uint32_t yi = ju32(iy) * 668265263U;
    const std::uint32_t yi1 = ju32(iy + 1) * 668265263U;
    xy_[0] = xi + yi;
    xy_[1] = xi1 + yi;
    xy_[2] = xi + yi1;
    xy_[3] = xi1 + yi1;
  }
  [[nodiscard]] double sample(double seed) const noexcept {
    const double s0 = floor_fast(seed);
    return mixd(at(ju32(s0)), at(ju32(s0 + 1)), seed - s0);
  }

 private:
  [[nodiscard]] static double finish(std::uint32_t n) noexcept {
    n = (n ^ (n >> 13U)) * 1274126177U;
    n = n ^ (n >> 16U);
    return static_cast<double>(n) / 4294967296.0;
  }
  [[nodiscard]] double at(std::uint32_t s) const noexcept {
    const std::uint32_t k = s * 2147483647U;
    const double a = finish(xy_[0] + k);
    const double b = finish(xy_[1] + k);
    const double c = finish(xy_[2] + k);
    const double d = finish(xy_[3] + k);
    return mixd(mixd(a, b, ux_), mixd(c, d, ux_), uy_);
  }
  double ux_ = 0;
  double uy_ = 0;
  std::uint32_t xy_[4]{};  // NOLINT(cppcoreguidelines-avoid-c-arrays)
};

/// aeStylizeAdvanced.ts / aeTransitionsAdvanced.ts `hash2`: `(a·C1 + b·C2) | 0`, then a JS-double multiply
/// (rounds past 2^53) and ToInt32 / ToUint32 at the shifts.
[[nodiscard]] inline double hash2(double a, double b) {
  const std::int32_t n = ji32(a * 374761393.0 + b * 668265263.0);
  const auto un = static_cast<std::uint32_t>(n);
  const auto t = static_cast<std::int32_t>(static_cast<std::uint32_t>(n) ^ (un >> 13U));
  const double m = static_cast<double>(static_cast<std::int64_t>(t) * 1274126177LL);
  const auto um = static_cast<std::uint32_t>(static_cast<std::uint64_t>(static_cast<std::int64_t>(m)));
  return static_cast<double>(um ^ (um >> 16U)) / 4294967296.0;
}

}  // namespace premation::effects
