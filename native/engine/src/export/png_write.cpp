#include "png_write.hpp"

#include <array>
#include <cstdlib>
#include <string_view>

#include "zlib.hpp"

namespace premation::exporter {
namespace {

constexpr int kZlibLevel = 6;
constexpr std::uint8_t kPaeth = 4;

std::uint8_t paeth(int a, int b, int c) noexcept {
  const int p = a + b - c;
  const int pa = std::abs(p - a);
  const int pb = std::abs(p - b);
  const int pc = std::abs(p - c);
  return static_cast<std::uint8_t>(pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
}

void put_u32(std::vector<std::uint8_t>& out, std::uint32_t v) {
  for (int s = 24; s >= 0; s -= 8) out.push_back(static_cast<std::uint8_t>(v >> static_cast<unsigned>(s)));
}

void chunk(std::vector<std::uint8_t>& out, std::string_view type, std::span<const std::uint8_t> data) {
  put_u32(out, static_cast<std::uint32_t>(data.size()));
  const std::size_t at = out.size();
  out.insert(out.end(), type.begin(), type.end());
  out.insert(out.end(), data.begin(), data.end());
  put_u32(out, crc32(std::span<const std::uint8_t>(out).subspan(at)));
}

/// Paeth-filtered rows of `bpp` bytes per pixel, deflated, framed as a PNG of `colourType`.
bool encode_png(std::span<const std::uint8_t> px, std::uint32_t width, std::uint32_t height, std::size_t bpp, std::uint8_t colourType,
                std::vector<std::uint8_t>& out, int zlibLevel) {
  const std::size_t row = std::size_t{width} * bpp;
  if (px.size() < row * height) return false;
  std::vector<std::uint8_t> filtered((row + 1) * height);
  for (std::uint32_t y = 0; y < height; ++y) {
    const auto cur = px.subspan(std::size_t{y} * row, row);
    const auto up = y == 0 ? std::span<const std::uint8_t>() : px.subspan(std::size_t{y - 1} * row, row);
    const auto dst = std::span<std::uint8_t>(filtered).subspan(std::size_t{y} * (row + 1), row + 1);
    dst[0] = kPaeth;
    for (std::size_t i = 0; i < row; ++i) {
      const int a = i >= bpp ? cur[i - bpp] : 0;
      const int b = up.empty() ? 0 : up[i];
      const int c = i >= bpp && !up.empty() ? up[i - bpp] : 0;
      dst[i + 1] = static_cast<std::uint8_t>(cur[i] - paeth(a, b, c));
    }
  }
  std::vector<std::uint8_t> idat;
  if (!zlib_compress(filtered, zlibLevel < 0 ? kZlibLevel : zlibLevel, idat)) return false;

  out.clear();
  out.reserve(idat.size() + 64);
  constexpr std::array<std::uint8_t, 8> kSignature = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'};
  out.insert(out.end(), kSignature.begin(), kSignature.end());
  std::vector<std::uint8_t> ihdr;
  put_u32(ihdr, width);
  put_u32(ihdr, height);
  ihdr.insert(ihdr.end(), {8, colourType, 0, 0, 0});  // 8 bits, the colour type, deflate, adaptive filtering, no interlace
  chunk(out, "IHDR", ihdr);
  if (colourType == 6) {
    const std::array<std::uint8_t, 1> perceptual = {0};
    chunk(out, "sRGB", perceptual);
  }
  chunk(out, "IDAT", idat);
  chunk(out, "IEND", {});
  return true;
}

}  // namespace

bool encode_png_rgba8(std::span<const std::uint8_t> rgba, std::uint32_t width, std::uint32_t height,
                      std::vector<std::uint8_t>& out, int zlibLevel) {
  return encode_png(rgba, width, height, 4, 6, out, zlibLevel);  // RGBA
}

bool encode_png_gray8(std::span<const std::uint8_t> gray, std::uint32_t width, std::uint32_t height,
                      std::vector<std::uint8_t>& out, int zlibLevel) {
  return encode_png(gray, width, height, 1, 0, out, zlibLevel);  // greyscale: data, no sRGB tag
}

}  // namespace premation::exporter
