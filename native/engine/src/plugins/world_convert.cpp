#include "world_convert.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstring>

namespace premation::plugins {
namespace {

float clamp01(float v) noexcept { return v < 0 ? 0.0F : v > 1 ? 1.0F : (std::isnan(v) ? 0.0F : v); }

std::uint8_t to8(float v) noexcept { return static_cast<std::uint8_t>(std::lround(clamp01(v) * 255.0F)); }
std::uint16_t to16(float v) noexcept { return static_cast<std::uint16_t>(std::lround(clamp01(v) * 65535.0F)); }

/// One texel of `tf` at `p` → 4 floats.
std::array<float, 4> read_texel(const std::uint8_t* p, TexelFormat tf) noexcept {
  std::array<float, 4> v{};
  switch (tf) {
    case TexelFormat::rgba8:
      for (std::size_t c = 0; c < 4; ++c) v.at(c) = static_cast<float>(p[c]) / 255.0F;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      break;
    case TexelFormat::rgba16f:
      for (std::size_t c = 0; c < 4; ++c) {
        std::uint16_t h = 0;
        std::memcpy(&h, p + c * 2, 2);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
        v.at(c) = half_to_float(h);
      }
      break;
    case TexelFormat::rgba32f: std::memcpy(v.data(), p, 16); break;
  }
  return v;
}

}  // namespace

std::uint32_t texel_bytes(TexelFormat f) noexcept {
  return f == TexelFormat::rgba32f ? 16 : f == TexelFormat::rgba16f ? 8 : 4;
}

float half_to_float(std::uint16_t h) noexcept {
  const std::uint32_t sign = (std::uint32_t{h} & 0x8000U) << 16U;
  const std::uint32_t exp = (h >> 10U) & 0x1FU;
  std::uint32_t man = h & 0x3FFU;
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
      bits = sign | static_cast<std::uint32_t>(127 - 15 - e) << 23U | (man & 0x3FFU) << 13U;
    }
  } else if (exp == 31) {
    bits = sign | 0x7F800000U | man << 13U;
  } else {
    bits = sign | (exp + 112U) << 23U | man << 13U;
  }
  return std::bit_cast<float>(bits);
}

std::uint16_t float_to_half(float f) noexcept {
  const auto x = std::bit_cast<std::uint32_t>(f);
  const std::uint32_t sign = (x >> 16U) & 0x8000U;
  const std::uint32_t absx = x & 0x7FFFFFFFU;
  if (absx >= 0x7F800000U) return static_cast<std::uint16_t>(sign | 0x7C00U | (absx > 0x7F800000U ? 0x200U : 0U));  // inf / NaN
  if (absx >= 0x477FF000U) return static_cast<std::uint16_t>(sign | 0x7C00U);  // rounds past the largest half: inf
  if (absx < 0x38800000U) {
    // Subnormal half (or zero): shift the full mantissa, round to nearest even.
    if (absx < 0x33000000U) return static_cast<std::uint16_t>(sign);  // < half of the smallest subnormal
    const std::uint32_t e = absx >> 23U;
    const std::uint32_t m = (absx & 0x7FFFFFU) | 0x800000U;
    const std::uint32_t shift = 126U - e;  // 14 − (e − 127) + 13 − 1 … into a 10-bit field
    std::uint32_t r = m >> shift;
    const std::uint32_t rem = m & ((1U << shift) - 1U);
    const std::uint32_t half = 1U << (shift - 1U);
    if (rem > half || (rem == half && (r & 1U) != 0)) ++r;
    return static_cast<std::uint16_t>(sign | r);
  }
  // Normal: rebias the exponent, round the 13 dropped mantissa bits to nearest even.
  std::uint32_t r = ((absx >> 13U) - (112U << 10U));
  const std::uint32_t rem = absx & 0x1FFFU;
  if (rem > 0x1000U || (rem == 0x1000U && (r & 1U) != 0)) ++r;
  return static_cast<std::uint16_t>(sign | r);
}

void texels_to_world(std::span<const std::uint8_t> texels, TexelFormat tf, std::uint32_t w, std::uint32_t h,
                     std::size_t rowPitch, PrPixelFormat wf, std::vector<std::uint8_t>& out) {
  const auto bpp = static_cast<std::size_t>(pr_bytes_per_pixel(wf));
  const std::size_t tb = texel_bytes(tf);
  out.resize(std::size_t{w} * h * bpp);
  for (std::uint32_t y = 0; y < h; ++y) {
    const std::uint8_t* row = texels.data() + std::size_t{y} * rowPitch;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    std::uint8_t* dst = out.data() + std::size_t{y} * w * bpp;            // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    if ((tf == TexelFormat::rgba8 && wf == PR_PIXEL_FORMAT_RGBA8) || (tf == TexelFormat::rgba32f && wf == PR_PIXEL_FORMAT_RGBA32F)) {
      std::memcpy(dst, row, std::size_t{w} * bpp);
      continue;
    }
    for (std::uint32_t x = 0; x < w; ++x) {
      const std::array<float, 4> v = read_texel(row + std::size_t{x} * tb, tf);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      std::uint8_t* d = dst + std::size_t{x} * bpp;                             // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      if (wf == PR_PIXEL_FORMAT_RGBA32F) {
        std::memcpy(d, v.data(), 16);
      } else if (wf == PR_PIXEL_FORMAT_RGBA16) {
        const std::array<std::uint16_t, 4> q{to16(v[0]), to16(v[1]), to16(v[2]), to16(v[3])};
        std::memcpy(d, q.data(), 8);
      } else {
        for (std::size_t c = 0; c < 4; ++c) d[c] = to8(v.at(c));  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      }
    }
  }
}

void world_to_texels(const PrWorld& world, TexelFormat tf, std::vector<std::uint8_t>& out) {
  const auto w = static_cast<std::size_t>(std::max(0, world.width));
  const auto h = static_cast<std::size_t>(std::max(0, world.height));
  const std::size_t tb = texel_bytes(tf);
  out.resize(w * h * tb);
  const auto* base = static_cast<const std::uint8_t*>(world.data);
  const auto bpp = static_cast<std::size_t>(pr_bytes_per_pixel(world.format));
  for (std::size_t y = 0; y < h; ++y) {
    const std::uint8_t* row = base + y * static_cast<std::size_t>(world.row_bytes);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    std::uint8_t* dst = out.data() + y * w * tb;                                      // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    if ((tf == TexelFormat::rgba8 && world.format == PR_PIXEL_FORMAT_RGBA8) ||
        (tf == TexelFormat::rgba32f && world.format == PR_PIXEL_FORMAT_RGBA32F)) {
      std::memcpy(dst, row, w * tb);
      continue;
    }
    for (std::size_t x = 0; x < w; ++x) {
      const std::uint8_t* s = row + x * bpp;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      std::array<float, 4> v{};
      if (world.format == PR_PIXEL_FORMAT_RGBA32F) {
        std::memcpy(v.data(), s, 16);
      } else if (world.format == PR_PIXEL_FORMAT_RGBA16) {
        std::array<std::uint16_t, 4> q{};
        std::memcpy(q.data(), s, 8);
        for (std::size_t c = 0; c < 4; ++c) v.at(c) = static_cast<float>(q.at(c)) / 65535.0F;
      } else {
        for (std::size_t c = 0; c < 4; ++c) v.at(c) = static_cast<float>(s[c]) / 255.0F;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      }
      std::uint8_t* d = dst + x * tb;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
      switch (tf) {
        case TexelFormat::rgba8:
          for (std::size_t c = 0; c < 4; ++c) d[c] = to8(v.at(c));  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
          break;
        case TexelFormat::rgba16f:
          for (std::size_t c = 0; c < 4; ++c) {
            const std::uint16_t hv = float_to_half(v.at(c));
            std::memcpy(d + c * 2, &hv, 2);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
          }
          break;
        case TexelFormat::rgba32f: std::memcpy(d, v.data(), 16); break;
      }
    }
  }
}

}  // namespace premation::plugins
