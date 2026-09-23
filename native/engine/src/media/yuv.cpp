#include "yuv.hpp"

#include <algorithm>
#include <cmath>

namespace premation::media {

LumaCoefficients luma_coefficients(Matrix m) noexcept {
  switch (m) {
    case Matrix::bt709: return {0.2126, 0.0722};
    case Matrix::fcc: return {0.30, 0.11};
    case Matrix::bt470bg:
    case Matrix::smpte170m: return {0.299, 0.114};
    case Matrix::smpte240m: return {0.212, 0.087};
    case Matrix::bt2020nc:
    case Matrix::bt2020c:  // constant-luminance decoded with the NCL matrix (the ffmpeg/swscale approximation)
      return {0.2627, 0.0593};
    default: return {0.2126, 0.0722};
  }
}

Matrix resolve_matrix(Matrix m, Primaries p, std::uint32_t height) noexcept {
  switch (m) {
    case Matrix::bt709:
    case Matrix::fcc:
    case Matrix::bt470bg:
    case Matrix::smpte170m:
    case Matrix::smpte240m:
    case Matrix::ycgco:
    case Matrix::bt2020nc:
    case Matrix::bt2020c:
    case Matrix::rgb: return m;
    default: break;
  }
  if (p == Primaries::bt2020) return Matrix::bt2020nc;
  if (p == Primaries::bt470bg || p == Primaries::smpte170m) return Matrix::smpte170m;
  if (p == Primaries::bt709) return Matrix::bt709;
  return height < 720 ? Matrix::smpte170m : Matrix::bt709;
}

Range resolve_range(Range r) noexcept { return r == Range::full ? Range::full : Range::limited; }

YuvToRgb yuv_to_rgb(const FrameFormat& f) noexcept {
  YuvToRgb out;
  const double n = f.bitDepth;
  const double maxCode = std::exp2(n) - 1;
  const double s = std::exp2(n - 8);  // limited-range code scale (16·s … 235·s)
  out.alphaScale = static_cast<float>(1.0 / maxCode);

  // Per-channel normalisation: value = (code − off) · scale.
  double yOff = 0;
  double yScale = 1 / maxCode;
  double cOff = std::exp2(n - 1);
  double cScale = 1 / maxCode;
  if (f.range == Range::limited) {
    yOff = 16 * s;
    yScale = 1 / (219 * s);
    cOff = 128 * s;
    cScale = 1 / (224 * s);
  }

  auto set_row = [&out](int row, double a, double b, double c, double d) {
    const auto r = static_cast<std::size_t>(row) * 4;
    out.m.at(r + 0) = static_cast<float>(a);
    out.m.at(r + 1) = static_cast<float>(b);
    out.m.at(r + 2) = static_cast<float>(c);
    out.m.at(r + 3) = static_cast<float>(d);
  };

  if (f.layout == Layout::planarRgb || f.layout == Layout::packedRgba || f.matrix == Matrix::rgb) {
    // Planar GBR arrives in component order (R, G, B — the decoder maps
    // ffmpeg's plane order), so every RGB layout is a per-channel scale here.
    const double off = f.range == Range::limited ? 16 * s : 0;
    const double sc = f.range == Range::limited ? 1 / (219 * s) : 1 / maxCode;
    set_row(0, sc, 0, 0, -off * sc);
    set_row(1, 0, sc, 0, -off * sc);
    set_row(2, 0, 0, sc, -off * sc);
    return out;
  }

  if (f.matrix == Matrix::ycgco) {
    // H.273 eq. for YCgCo: t = Y − Cg; G = Y + Cg; B = t − Co; R = t + Co  (Cb slot = Cg, Cr slot = Co).
    const double ys = yScale;
    const double cs = cScale;
    set_row(0, ys, -cs, cs, -yOff * ys + cOff * cs - cOff * cs);
    set_row(1, ys, cs, 0, -yOff * ys - cOff * cs);
    set_row(2, ys, -cs, -cs, -yOff * ys + 2 * cOff * cs);
    return out;
  }

  const LumaCoefficients k = luma_coefficients(f.matrix);
  const double kg = 1 - k.kr - k.kb;
  // R = Y + 2(1−Kr)·Cr ; B = Y + 2(1−Kb)·Cb ; G = Y − (2Kb(1−Kb)/Kg)·Cb − (2Kr(1−Kr)/Kg)·Cr
  const double rCr = 2 * (1 - k.kr);
  const double bCb = 2 * (1 - k.kb);
  const double gCb = -2 * k.kb * (1 - k.kb) / kg;
  const double gCr = -2 * k.kr * (1 - k.kr) / kg;
  const double ys = yScale;
  const double cs = cScale;
  // Fold the offsets into the 4th column: value(code) = code·scale − off·scale.
  set_row(0, ys, 0, rCr * cs, -yOff * ys - rCr * cOff * cs);
  set_row(1, ys, gCb * cs, gCr * cs, -yOff * ys - (gCb + gCr) * cOff * cs);
  set_row(2, ys, bCb * cs, 0, -yOff * ys - bCb * cOff * cs);
  return out;
}

std::array<double, 4> convert_codes(const YuvToRgb& c, double y, double cb, double cr, double a,
                                    bool hasAlpha) noexcept {
  std::array<double, 4> o{};
  for (std::size_t r = 0; r < 3; ++r) {
    const double v = c.m.at(r * 4 + 0) * y + c.m.at(r * 4 + 1) * cb + c.m.at(r * 4 + 2) * cr + c.m.at(r * 4 + 3);
    o.at(r) = std::clamp(v, 0.0, 1.0);
  }
  o[3] = hasAlpha ? std::clamp(a * c.alphaScale, 0.0, 1.0) : 1.0;
  return o;
}

InputSpaceGuess input_space_of(const ColorInfo& c) noexcept {
  InputSpaceGuess g;
  const bool wide = c.primaries == Primaries::bt2020;
  if (c.transfer == Transfer::linear) {
    g.renderColorSpace = wide ? 5 : 2;  // linearRec2020 : linearSrgb
    return g;
  }
  if (c.transfer == Transfer::pq || c.transfer == Transfer::hlg) {
    g.renderColorSpace = 4;  // rec2020 primaries; the PQ/HLG curve itself is not a RenderColorSpace yet
    g.hdrUnmodelled = true;
    return g;
  }
  if (c.transfer == Transfer::srgb || c.transfer == Transfer::iec61966_2_4) {
    g.renderColorSpace = 0;
    return g;
  }
  g.renderColorSpace = wide ? 4 : 1;
  return g;
}

}  // namespace premation::media
