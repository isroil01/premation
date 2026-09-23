// Uniform packing — packages/renderer/src/pipeline/uniforms.ts, float for float.
//
// std140 as the builtin WGSL declares it: a mat3x3<f32> is three columns padded
// to vec4 (12 floats), every other field a vec4. Each packer appends to a
// caller-owned float vector (reused across draws: no per-draw allocation once
// warm) and returns the span it wrote.
#pragma once

#include <array>
#include <span>
#include <vector>

#include "rg_math.hpp"

namespace premation::rg {

using Vec4 = std::array<double, 4>;

struct ColorTransform {
  std::array<double, 9> m{1, 0, 0, 0, 1, 0, 0, 0, 1};
  std::array<double, 3> offset{0, 0, 0};
};

/// SolidShape: (kind, radiusPx, worldW, worldH); kind 0 = plain rect.
struct SolidShape {
  double kind = 0, radiusPx = 0, width = 0, height = 0;
};

class Packer {
 public:
  explicit Packer(std::vector<float>& out, const ColorPipeline& color) noexcept : out_(&out), color_(&color) {
    out_->clear();
  }
  Packer& mat3(const Mat3& m) {
    push(m.m[0], m.m[1], m.m[2], 0);
    push(m.m[3], m.m[4], m.m[5], 0);
    push(m.m[6], m.m[7], m.m[8], 0);
    return *this;
  }
  Packer& mat4(const Mat4& m) {
    for (const float v : m.m) out_->push_back(v);
    return *this;
  }
  Packer& vec4(double a, double b, double c, double d) {
    push(f32(a), f32(b), f32(c), f32(d));
    return *this;
  }
  Packer& vec4(const Vec4& v) { return vec4(v[0], v[1], v[2], v[3]); }
  Packer& rect(const Rect& r) { return vec4(r.x, r.y, r.width, r.height); }
  /// packColor: working-space rgb, a × opacity.
  Packer& color(const Color& c, double opacity = 1) {
    const Color w = to_working(c, *color_);
    return vec4(w.r, w.g, w.b, w.a * opacity);
  }
  /// writeWorkingRgba (no opacity factor).
  Packer& working_rgba(const Color& c) {
    const Color w = to_working(c, *color_);
    return vec4(w.r, w.g, w.b, w.a);
  }
  /// packColorRows: three (m row, offset) vec4s.
  Packer& color_rows(const ColorTransform& ct) {
    for (std::size_t r = 0; r < 3; ++r) vec4(ct.m[r * 3], ct.m[r * 3 + 1], ct.m[r * 3 + 2], ct.offset[r]);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index): r < 3
    return *this;
  }
  /// packSrcSpaceFlags: x=sampleLinear, y=aces working, z=display mode.
  Packer& src_space(bool sampleLinear) {
    // Colour-managed: textures are pre-converted and the display encode is the
    // OCIO pass, so no shader applies the TS ACES matrix or ODT.
    if (color_->managed) return vec4(sampleLinear ? 1 : 0, 0, 0, 0);
    double display = 0;
    switch (color_->display) {
      case DisplayTransform::aces: display = 1; break;
      case DisplayTransform::pq: display = 2; break;
      case DisplayTransform::hlg: display = 3; break;
      default: break;
    }
    return vec4(sampleLinear ? 1 : 0, color_->working == WorkingSpace::aces_cg ? 1 : 0, display, 0);
  }
  [[nodiscard]] std::span<const float> span() const noexcept { return *out_; }
  [[nodiscard]] const ColorPipeline& pipeline() const noexcept { return *color_; }

 private:
  void push(float a, float b, float c, float d) {
    out_->push_back(a);
    out_->push_back(b);
    out_->push_back(c);
    out_->push_back(d);
  }
  std::vector<float>* out_;
  const ColorPipeline* color_;
};

inline const ColorTransform kIdentityColor{};

/// packSolid: mat3 mvp + colour + shape.
inline std::span<const float> pack_solid(Packer p, const Mat3& mvp, const Color& c, double opacity,
                                         const SolidShape& s = {}) {
  return p.mat3(mvp).color(c, opacity).vec4(s.kind, s.radiusPx, s.width, s.height).span();
}

/// packTextured: mat3 mvp + uvRect + tint + 3 colour rows + srcSpace.
inline std::span<const float> pack_textured(Packer p, const Mat3& mvp, const Rect& uv, const Color& tint,
                                            double opacity, const ColorTransform& ct = kIdentityColor,
                                            bool sampleLinear = false) {
  return p.mat3(mvp).rect(uv).color(tint, opacity).color_rows(ct).src_space(sampleLinear).span();
}

/// packBlur.
inline std::span<const float> pack_blur(Packer p, const Mat3& mvp, const Rect& uv, double dirX, double dirY,
                                        double radiusPx) {
  return p.mat3(mvp).rect(uv).vec4(dirX, dirY, radiusPx, 0).span();
}

/// packFxBlock: mvp + uvRect + N param rows + fxBox.
inline std::span<const float> pack_fx_block(Packer p, const Mat3& mvp, const Rect& uv, std::span<const Vec4> rows,
                                            const Rect& fxBox) {
  p.mat3(mvp).rect(uv);
  for (const Vec4& r : rows) p.vec4(r);
  return p.rect(fxBox).span();
}

/// packFill.
inline std::span<const float> pack_fill(Packer p, const Mat3& mvp, const Rect& uv, const Color& c) {
  return p.mat3(mvp).rect(uv).working_rgba(c).span();
}

/// packStroke (position: 0 Outside, 1 Inside, 2 Center, 3 alpha-dilate).
inline std::span<const float> pack_stroke(Packer p, const Mat3& mvp, const Rect& uv, const Color& c, double width,
                                          double texelW, double texelH, double position) {
  return p.mat3(mvp).rect(uv).working_rgba(c).vec4(width, texelW, texelH, position).span();
}

/// packSharpen.
inline std::span<const float> pack_sharpen(Packer p, const Mat3& mvp, const Rect& uv, double texelW, double texelH,
                                           double amount) {
  return p.mat3(mvp).rect(uv).vec4(texelW, texelH, amount, 0).span();
}

}  // namespace premation::rg
