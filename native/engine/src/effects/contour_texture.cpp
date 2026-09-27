// Alpha contours as a Vegas data texture (see contour_texture.hpp).
#include "contour_texture.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstring>

#include "alpha_contours.hpp"

namespace premation::effects {

ContourTexture pack_alpha_contours(std::span<const std::uint8_t> premulRgba, std::uint32_t w, std::uint32_t h, double threshold,
                                   double ss) {
  ContourTexture out;
  const std::size_t n = static_cast<std::size_t>(w) * h;
  if (w == 0 || h == 0 || premulRgba.size() < n * 4) return out;
  std::vector<std::uint8_t> alpha(n);
  for (std::size_t i = 0; i < n; ++i) alpha[i] = premulRgba[i * 4 + 3];
  const std::vector<AlphaContour> contours =
      extract_alpha_contours(alpha, static_cast<int>(w), static_cast<int>(h), std::clamp(threshold, 1.0, 254.0));

  std::vector<float> f(kContourHeaderFloats, 0.0F);
  std::size_t vertices = 0;
  std::size_t kept = 0;
  for (const AlphaContour& c : contours) {
    if (c.size() >= 2) {
      vertices += c.size();
      ++kept;
    }
  }
  f.reserve(kContourHeaderFloats + kept * 4 + vertices * 4);
  // Contour table, then vertices (cell-centre units → raster px from the corner).
  std::vector<float> verts;
  verts.reserve(vertices * 4);
  std::uint32_t first = 0;
  std::uint32_t index = 0;
  for (const AlphaContour& c : contours) {
    if (c.size() < 2) continue;
    double arc = 0;
    for (std::size_t i = 0; i < c.size(); ++i) {
      if (i > 0) arc += std::hypot(c[i].x - c[i - 1].x, c[i].y - c[i - 1].y);
      verts.push_back(static_cast<float>(c[i].x + 0.5));
      verts.push_back(static_cast<float>(c[i].y + 0.5));
      verts.push_back(static_cast<float>(arc));
      verts.push_back(static_cast<float>(index));
    }
    const double total = arc + std::hypot(c.front().x - c.back().x, c.front().y - c.back().y);
    f.push_back(static_cast<float>(first));
    f.push_back(static_cast<float>(c.size()));
    f.push_back(static_cast<float>(total));
    f.push_back(0.0F);
    first += static_cast<std::uint32_t>(c.size());
    ++index;
  }
  f.insert(f.end(), verts.begin(), verts.end());
  f[0] = static_cast<float>(vertices);
  f[1] = static_cast<float>(kept);
  f[2] = static_cast<float>(w);
  f[3] = static_cast<float>(h);
  f[4] = static_cast<float>(ss > 0 ? ss : 1);

  out.vertices = static_cast<std::uint32_t>(vertices);
  out.contours = static_cast<std::uint32_t>(kept);
  out.height = static_cast<std::uint32_t>((f.size() + kContourTexWidth - 1) / kContourTexWidth);
  out.rgba.assign(static_cast<std::size_t>(out.width) * out.height * 4, 0);
  for (std::size_t i = 0; i < f.size(); ++i) {
    const auto bits = std::bit_cast<std::uint32_t>(f[i]);
    out.rgba[i * 4] = static_cast<std::uint8_t>(bits & 0xFFU);
    out.rgba[i * 4 + 1] = static_cast<std::uint8_t>((bits >> 8U) & 0xFFU);
    out.rgba[i * 4 + 2] = static_cast<std::uint8_t>((bits >> 16U) & 0xFFU);
    out.rgba[i * 4 + 3] = static_cast<std::uint8_t>(bits >> 24U);
  }
  return out;
}

float contour_float(const ContourTexture& t, std::uint32_t i) noexcept {
  const std::size_t o = static_cast<std::size_t>(i) * 4;
  if (o + 3 >= t.rgba.size()) return 0;
  const std::uint32_t bits = static_cast<std::uint32_t>(t.rgba[o]) | (static_cast<std::uint32_t>(t.rgba[o + 1]) << 8U) |
                             (static_cast<std::uint32_t>(t.rgba[o + 2]) << 16U) | (static_cast<std::uint32_t>(t.rgba[o + 3]) << 24U);
  return std::bit_cast<float>(bits);
}

}  // namespace premation::effects
