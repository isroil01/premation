// F1: a read-back surface row → the bytes the raw pipe hands ffmpeg.
//
// The TypeScript raw pipe sends what `getImageData` returns from a 2D canvas
// the WebGPU frame was drawn into (src/core/export/rawPipe.ts): straight-alpha
// 8-bit RGBA, top-down, no padding. The surface holds PREMULTIPLIED RGBA8, so
// every pixel with 0 < a < 255 is unpremultiplied here the way Skia's raster
// pipeline does it for Chromium's readback (float c/a, rounded to nearest by
// the 2^23 trick); a = 255 is copied and a = 0 becomes 0,0,0,0. Opaque frames
// are therefore byte-identical by construction; partially transparent pixels
// follow the model, which is not verified against Chromium beyond ±1.
#pragma once

#include <array>
#include <cstdint>
#include <cstring>
#include <span>

namespace premation::exporter {

/// Skia's `to_unorm`: round(v × 255) in float, v clamped to [0, 1].
[[nodiscard]] inline std::uint8_t unorm8(float v) noexcept {
  v = v < 0 ? 0 : v > 1 ? 1 : v;
  const float r = v * 255.0F + 8388608.0F;  // 2^23: the float add rounds to nearest even
  std::uint32_t bits = 0;
  std::memcpy(&bits, &r, sizeof bits);
  return static_cast<std::uint8_t>(bits ^ 0x4b000000U);
}

/// One pixel, premultiplied → straight.
inline void unpremultiply_px(const std::uint8_t* src, std::uint8_t* dst, bool bgra) noexcept {
  // NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  const std::uint8_t a = src[3];
  const std::uint8_t r = src[bgra ? 2 : 0];
  const std::uint8_t g = src[1];
  const std::uint8_t b = src[bgra ? 0 : 2];
  if (a == 255) {
    dst[0] = r;
    dst[1] = g;
    dst[2] = b;
    dst[3] = 255;
    return;
  }
  if (a == 0) {
    dst[0] = dst[1] = dst[2] = dst[3] = 0;
    return;
  }
  const float inv = 1.0F / (static_cast<float>(a) * (1.0F / 255.0F));
  dst[0] = unorm8(static_cast<float>(r) * (1.0F / 255.0F) * inv);
  dst[1] = unorm8(static_cast<float>(g) * (1.0F / 255.0F) * inv);
  dst[2] = unorm8(static_cast<float>(b) * (1.0F / 255.0F) * inv);
  dst[3] = a;
  // NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic)
}

/// A padded surface (`stride` bytes per row) → tight straight RGBA (`width × 4` per row).
/// Rows of fully opaque RGBA are copied with memcpy.
inline void surface_to_straight_rgba(std::span<const std::uint8_t> src, std::uint32_t width, std::uint32_t height,
                                     std::uint32_t stride, bool bgra, std::span<std::uint8_t> dst) noexcept {
  const std::size_t row = std::size_t{width} * 4;
  for (std::uint32_t y = 0; y < height; ++y) {
    const std::uint8_t* s = src.data() + std::size_t{y} * stride;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    std::uint8_t* d = dst.data() + std::size_t{y} * row;           // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    bool opaque = !bgra;
    for (std::size_t i = 3; opaque && i < row; i += 4) opaque = s[i] == 255;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    if (opaque) {
      std::memcpy(d, s, row);
      continue;
    }
    for (std::size_t i = 0; i < row; i += 4) unpremultiply_px(s + i, d + i, bgra);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  }
}

/// IEEE binary16 → float (exact).
[[nodiscard]] inline float half_to_float(std::uint16_t h) noexcept {
  const std::uint32_t sign = (std::uint32_t{h} & 0x8000U) << 16U;
  const std::uint32_t exp = (std::uint32_t{h} >> 10U) & 0x1FU;
  std::uint32_t man = std::uint32_t{h} & 0x3FFU;
  std::uint32_t bits = 0;
  if (exp == 0) {
    if (man == 0) {
      bits = sign;
    } else {  // subnormal: normalise
      int e = -1;
      do {
        ++e;
        man <<= 1U;
      } while ((man & 0x400U) == 0);
      bits = sign | (static_cast<std::uint32_t>(127 - 15 - e) << 23U) | ((man & 0x3FFU) << 13U);
    }
  } else if (exp == 31) {
    bits = sign | 0x7F800000U | (man << 13U);
  } else {
    bits = sign | ((exp + 127 - 15) << 23U) | (man << 13U);
  }
  float f = 0;
  std::memcpy(&f, &bits, sizeof f);
  return f;
}

/// F1 16-bit output: a half-float premultiplied surface (display-encoded,
/// 8 bytes a pixel, `stride` per row) → straight RGBA64 little-endian, the
/// `-pix_fmt rgba64le` raw input. Channels are clamped to [0, 1] and rounded
/// to nearest (round(v × 65535)); a = 0 becomes 0.
inline void half_surface_to_rgba64(std::span<const std::uint8_t> src, std::uint32_t width, std::uint32_t height,
                                   std::uint32_t stride, std::span<std::uint8_t> dst) noexcept {
  const auto u16 = [](float v) {
    v = v < 0 || v != v ? 0 : v > 1 ? 1 : v;  // NaN → 0
    return static_cast<std::uint16_t>(v * 65535.0F + 0.5F);
  };
  for (std::uint32_t y = 0; y < height; ++y) {
    const std::uint8_t* s = src.data() + std::size_t{y} * stride;              // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    std::uint8_t* d = dst.data() + std::size_t{y} * std::size_t{width} * 8;    // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    for (std::uint32_t x = 0; x < width; ++x) {
      std::array<std::uint16_t, 4> h{};
      std::memcpy(h.data(), s + std::size_t{x} * 8, 8);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      const float a = half_to_float(h[3]);
      std::array<std::uint16_t, 4> o{};
      if (a > 0) {
        const float inv = a >= 1 ? 1.0F : 1.0F / a;
        for (std::size_t c = 0; c < 3; ++c) o[c] = u16(half_to_float(h[c]) * inv);  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
        o[3] = u16(a);
      }
      std::memcpy(d + std::size_t{x} * 8, o.data(), 8);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic): little-endian hosts only (x86-64, arm64)
    }
  }
}

}  // namespace premation::exporter
