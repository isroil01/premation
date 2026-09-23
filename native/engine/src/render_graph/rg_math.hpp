// Math the render graph shares with packages/renderer, reproduced to the BIT.
//
// The TypeScript renderer keeps matrices in Float32Array (core/math/Mat3.ts,
// Mat4.ts): every product is computed in double from float inputs and ROUNDED
// TO FLOAT when stored. Uniform blocks are Float32Array too. These helpers do
// the same — double temporaries, float storage — so an mvp here is the same 32
// bits the TS engine uploaded (-ffp-contract=off keeps the sums unfused).
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

namespace premation::rg {

constexpr float f32(double v) noexcept { return static_cast<float>(v); }

struct Rect {
  double x = 0, y = 0, width = 0, height = 0;
};

struct Color {
  double r = 0, g = 0, b = 0, a = 0;
  static constexpr Color white(double alpha = 1) noexcept { return {1, 1, 1, alpha}; }
  static constexpr Color transparent() noexcept { return {0, 0, 0, 0}; }
};

/// Column-major 3×3 (Mat3.ts): translation in m[6], m[7].
struct Mat3 {
  std::array<float, 9> m{1, 0, 0, 0, 1, 0, 0, 0, 1};
  float operator[](std::size_t i) const noexcept { return m[i]; }  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
};

/// Mat3.multiply(a, b): apply b first, then a.
inline Mat3 mul(const Mat3& a, const Mat3& b) noexcept {
  const double a00 = a.m[0], a01 = a.m[1], a02 = a.m[2];
  const double a10 = a.m[3], a11 = a.m[4], a12 = a.m[5];
  const double a20 = a.m[6], a21 = a.m[7], a22 = a.m[8];
  const double b00 = b.m[0], b01 = b.m[1], b02 = b.m[2];
  const double b10 = b.m[3], b11 = b.m[4], b12 = b.m[5];
  const double b20 = b.m[6], b21 = b.m[7], b22 = b.m[8];
  Mat3 o;
  o.m[0] = f32(b00 * a00 + b01 * a10 + b02 * a20);
  o.m[1] = f32(b00 * a01 + b01 * a11 + b02 * a21);
  o.m[2] = f32(b00 * a02 + b01 * a12 + b02 * a22);
  o.m[3] = f32(b10 * a00 + b11 * a10 + b12 * a20);
  o.m[4] = f32(b10 * a01 + b11 * a11 + b12 * a21);
  o.m[5] = f32(b10 * a02 + b11 * a12 + b12 * a22);
  o.m[6] = f32(b20 * a00 + b21 * a10 + b22 * a20);
  o.m[7] = f32(b20 * a01 + b21 * a11 + b22 * a21);
  o.m[8] = f32(b20 * a02 + b21 * a12 + b22 * a22);
  return o;
}

inline Mat3 translation(double tx, double ty) noexcept {
  Mat3 o;
  o.m[6] = f32(tx);
  o.m[7] = f32(ty);
  return o;
}

inline Mat3 scaling(double sx, double sy) noexcept {
  Mat3 o;
  o.m[0] = f32(sx);
  o.m[4] = f32(sy);
  return o;
}

/// Mat3.ortho(left, right, bottom, top).
inline Mat3 ortho(double left, double right, double bottom, double top) noexcept {
  double w = right - left;
  double h = top - bottom;
  if (w == 0) w = 1;
  if (h == 0) h = 1;
  Mat3 o;
  o.m[0] = f32(2 / w);
  o.m[4] = f32(2 / h);
  o.m[6] = f32(-(right + left) / w);
  o.m[7] = f32(-(top + bottom) / h);
  return o;
}

struct Vec2 {
  double x = 0, y = 0;
};

inline Vec2 transform_point(const Mat3& m, Vec2 p) noexcept {
  return {static_cast<double>(m.m[0]) * p.x + static_cast<double>(m.m[3]) * p.y + static_cast<double>(m.m[6]),
          static_cast<double>(m.m[1]) * p.x + static_cast<double>(m.m[4]) * p.y + static_cast<double>(m.m[7])};
}

/// Mat3.invert (affine). False when singular.
inline bool invert(const Mat3& m, Mat3& out) noexcept {
  const double a = m.m[0], b = m.m[1], c = m.m[3], d = m.m[4], e = m.m[6], f = m.m[7];
  const double det = a * d - b * c;
  if (std::abs(det) < 1e-12) return false;
  const double id = 1 / det;
  out = Mat3{};
  out.m[0] = f32(d * id);
  out.m[1] = f32(-b * id);
  out.m[2] = 0;
  out.m[3] = f32(-c * id);
  out.m[4] = f32(a * id);
  out.m[5] = 0;
  out.m[6] = f32((c * f - d * e) * id);
  out.m[7] = f32((b * e - a * f) * id);
  out.m[8] = 1;
  return true;
}

/// modelFromRect (passUtils.ts): the unit quad onto a world rect.
inline Mat3 model_from_rect(const Rect& r) noexcept { return mul(translation(r.x, r.y), scaling(r.width, r.height)); }

/// screenMvp(): [0,1]² → clip with top-left at (-1, +1).
inline Mat3 screen_mvp() noexcept { return ortho(0, 1, 1, 0); }

inline bool rects_intersect(const Rect& a, const Rect& b) noexcept {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/// Column-major 4×4 (Mat4.ts).
struct Mat4 {
  std::array<float, 16> m{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
};

inline Mat4 mul(const Mat4& a, const Mat4& b) noexcept {
  Mat4 o;
  for (std::size_t c = 0; c < 4; ++c) {
    for (std::size_t r = 0; r < 4; ++r) {
      double s = 0;
      for (std::size_t k = 0; k < 4; ++k) {
        s += static_cast<double>(a.m[k * 4 + r]) * static_cast<double>(b.m[c * 4 + k]);
      }
      o.m[c * 4 + r] = f32(s);
    }
  }
  return o;
}

/// Mat4.fromMat3: an affine 2D map lifted to act on x/y, z and w untouched.
inline Mat4 mat4_from_mat3(const Mat3& a) noexcept {
  Mat4 o;
  o.m = {a.m[0], a.m[1], 0, a.m[2], a.m[3], a.m[4], 0, a.m[5], 0, 0, 1, 0, a.m[6], a.m[7], 0, a.m[8]};
  return o;
}

// ── Colour (shaders/linearWorkingSpace.ts) ────────────────────────────────

/// IEC 61966-2-1 decode, the same numbers as `srgbChanToLinear`.
inline double srgb_to_linear(double c) noexcept { return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }

inline double linear_to_srgb(double c) noexcept {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * std::pow(std::max(c, 0.0), 1 / 2.4) - 0.055;
}

enum class WorkingSpace : std::uint8_t { srgb_linear, aces_cg };
enum class DisplayTransform : std::uint8_t { srgb, aces, pq, hlg };

/// The active colour pipeline (colorPipeline.ts `ColorPipelineConfig`). One
/// value per frame, carried by the RenderView; D3 adds OCIO behind `ocio`.
struct ColorPipeline {
  WorkingSpace working = WorkingSpace::srgb_linear;
  DisplayTransform display = DisplayTransform::srgb;
  std::uint32_t bitDepth = 16;
  /// D3 hook: an OCIO config/look replaces workingToDisplay. Unset today — the
  /// output is exactly the TS transfer functions.
  bool ocio = false;
};

/// toWorkingColor: authored display-referred RGB → working-space values.
inline Color to_working(const Color& c, const ColorPipeline& p) noexcept {
  double r = srgb_to_linear(c.r);
  double g = srgb_to_linear(c.g);
  double b = srgb_to_linear(c.b);
  if (p.working == WorkingSpace::aces_cg) {
    const double nr = 0.613097396 * r + 0.339523469 * g + 0.047379562 * b;
    const double ng = 0.070194066 * r + 0.916353879 * g + 0.013452032 * b;
    const double nb = 0.020615588 * r + 0.109569769 * g + 0.869814633 * b;
    r = nr;
    g = ng;
    b = nb;
  }
  return {r, g, b, c.a};
}

}  // namespace premation::rg
