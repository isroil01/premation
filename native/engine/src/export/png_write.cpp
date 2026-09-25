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

}  // namespace

bool encode_png_rgba8(std::span<const std::uint8_t> rgba, std::uint32_t width, std::uint32_t height,
                      std::vector<std::uint8_t>& out) {
  const std::size_t row = std::size_t{width} * 4;
  std::vector<std::uint8_t> filtered((row + 1) * height);
  for (std::uint32_t y = 0; y < height; ++y) {
    const auto cur = rgba.subspan(std::size_t{y} * row, row);
    const auto up = y == 0 ? std::span<const std::uint8_t>() : rgba.subspan(std::size_t{y - 1} * row, row);
    const auto dst = std::span<std::uint8_t>(filtered).subspan(std::size_t{y} * (row + 1), row + 1);
    dst[0] = kPaeth;
    for (std::size_t i = 0; i < row; ++i) {
      const int a = i >= 4 ? cur[i - 4] : 0;
      const int b = up.empty() ? 0 : up[i];
      const int c = i >= 4 && !up.empty() ? up[i - 4] : 0;
      dst[i + 1] = static_cast<std::uint8_t>(cur[i] - paeth(a, b, c));
    }
  }
  std::vector<std::uint8_t> idat;
  if (!zlib_compress(filtered, kZlibLevel, idat)) return false;

  out.clear();
  out.reserve(idat.size() + 64);
  constexpr std::array<std::uint8_t, 8> kSignature = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'};
  out.insert(out.end(), kSignature.begin(), kSignature.end());
  std::vector<std::uint8_t> ihdr;
  put_u32(ihdr, width);
  put_u32(ihdr, height);
  ihdr.insert(ihdr.end(), {8, 6, 0, 0, 0});  // 8 bits, RGBA, deflate, adaptive filtering, no interlace
  chunk(out, "IHDR", ihdr);
  const std::array<std::uint8_t, 1> perceptual = {0};
  chunk(out, "sRGB", perceptual);
  chunk(out, "IDAT", idat);
  chunk(out, "IEND", {});
  return true;
}

}  // namespace premation::exporter
