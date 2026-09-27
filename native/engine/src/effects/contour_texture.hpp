// E4: the Vegas effect on the GPU — the alpha contours of a layer's content
// raster (alpha_contours.hpp, vegas.ts extractAlphaContours) packed as a data
// texture the render graph's VEGAS_FX pass reads (shaders/wgsl/vegas-gpu.wgsl).
//
// Contours depend only on the content and the threshold, so they are made once
// per content (scene_textures.cpp keys the texture by the content raster's hash
// and the threshold); every Vegas param — segments, length, rotation, width,
// hardness, the opacity profile, the phase — is a uniform of the pass, so an
// animated Vegas re-draws its dashes without touching the CPU.
//
// Layout: one IEEE-754 float32 per RGBA8 texel (bytes little-endian in r g b a;
// the shader reassembles the bits with bitcast), kContourTexWidth texels a row:
//
//   [0..7]     vertexCount, contourCount, rasterW, rasterH, ss (raster px per
//              layer px), 0, 0, 0
//   [8..)      per contour: firstVertex, vertexCount, total arc (raster px), 0
//   then       per vertex: x, y (raster px from the raster's top-left corner),
//              arc from the contour's first vertex (raster px), contour index
//
// Every vertex starts one segment, to the next vertex of its contour (the last
// closes the loop): the pass draws vertexCount instances.
#pragma once

#include <cstdint>
#include <span>
#include <vector>

namespace premation::effects {

inline constexpr std::uint32_t kContourTexWidth = 1024;
inline constexpr std::uint32_t kContourHeaderFloats = 8;

struct ContourTexture {
  std::uint32_t width = kContourTexWidth;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> rgba;  ///< width × height × 4
  std::uint32_t vertices = 0;
  std::uint32_t contours = 0;
};

/// The contours of `premulRgba`'s alpha (w × h, rows top-down) at `threshold`
/// (1..254, of the alpha the CPU Vegas would see), packed as above. `ss` is
/// the raster's scale over layer px (Vegas widths are layer px).
[[nodiscard]] ContourTexture pack_alpha_contours(std::span<const std::uint8_t> premulRgba, std::uint32_t w, std::uint32_t h,
                                                 double threshold, double ss);

/// The float at texel `i` of a packed texture (tests; the shader's `fetch`).
[[nodiscard]] float contour_float(const ContourTexture& t, std::uint32_t i) noexcept;

}  // namespace premation::effects
