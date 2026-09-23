// A dependency-free PNG encoder (RGBA8, zlib "stored" blocks — no compression).
// For the parity harness's actual frames, which Node reads back with pngjs; size
// is irrelevant there and a zlib dependency is not worth it.
#pragma once

#include <array>
#include <cstdint>
#include <span>
#include <vector>

namespace premation::tools {

inline std::uint32_t crc32(std::span<const std::uint8_t> data, std::uint32_t crc = 0) {
  static const std::array<std::uint32_t, 256> table = [] {
    std::array<std::uint32_t, 256> t{};
    for (std::uint32_t n = 0; n < 256; ++n) {
      std::uint32_t c = n;
      for (int k = 0; k < 8; ++k) c = (c & 1U) != 0 ? 0xEDB88320U ^ (c >> 1) : c >> 1;
      t.at(n) = c;
    }
    return t;
  }();
  crc = ~crc;
  for (const std::uint8_t b : data) crc = table.at((crc ^ b) & 0xFFU) ^ (crc >> 8);
  return ~crc;
}

/// Encode top-down RGBA8 rows as a PNG file.
inline std::vector<std::uint8_t> encode_png(std::uint32_t w, std::uint32_t h, std::span<const std::uint8_t> rgba) {
  std::vector<std::uint8_t> out;
  const auto be32 = [&out](std::uint32_t v) {
    out.push_back(static_cast<std::uint8_t>(v >> 24));
    out.push_back(static_cast<std::uint8_t>(v >> 16));
    out.push_back(static_cast<std::uint8_t>(v >> 8));
    out.push_back(static_cast<std::uint8_t>(v));
  };
  const auto chunk = [&](const char* type, std::span<const std::uint8_t> body) {
    be32(static_cast<std::uint32_t>(body.size()));
    const std::size_t start = out.size();
    for (int i = 0; i < 4; ++i) out.push_back(static_cast<std::uint8_t>(type[i]));  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    out.insert(out.end(), body.begin(), body.end());
    be32(crc32(std::span(out).subspan(start)));
  };
  static constexpr std::array<std::uint8_t, 8> kSig = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'};
  out.insert(out.end(), kSig.begin(), kSig.end());
  std::array<std::uint8_t, 13> ihdr{};
  for (int i = 0; i < 4; ++i) {
    ihdr.at(static_cast<std::size_t>(i)) = static_cast<std::uint8_t>(w >> (24 - 8 * i));
    ihdr.at(static_cast<std::size_t>(4 + i)) = static_cast<std::uint8_t>(h >> (24 - 8 * i));
  }
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  chunk("IHDR", ihdr);

  // Raw scanlines (filter 0) → zlib stored blocks.
  std::vector<std::uint8_t> raw;
  const std::size_t row = std::size_t{w} * 4;
  raw.reserve((row + 1) * h);
  for (std::uint32_t y = 0; y < h; ++y) {
    raw.push_back(0);
    const auto line = rgba.subspan(std::size_t{y} * row, row);
    raw.insert(raw.end(), line.begin(), line.end());
  }
  std::vector<std::uint8_t> z = {0x78, 0x01};
  std::size_t pos = 0;
  do {
    const std::size_t n = std::min<std::size_t>(65535, raw.size() - pos);
    const bool last = pos + n == raw.size();
    z.push_back(last ? 1 : 0);
    z.push_back(static_cast<std::uint8_t>(n & 0xFF));
    z.push_back(static_cast<std::uint8_t>(n >> 8));
    z.push_back(static_cast<std::uint8_t>(~n & 0xFF));
    z.push_back(static_cast<std::uint8_t>((~n >> 8) & 0xFF));
    z.insert(z.end(), raw.begin() + static_cast<std::ptrdiff_t>(pos), raw.begin() + static_cast<std::ptrdiff_t>(pos + n));
    pos += n;
  } while (pos < raw.size());
  std::uint32_t a = 1;
  std::uint32_t b = 0;
  for (const std::uint8_t v : raw) {
    a = (a + v) % 65521U;
    b = (b + a) % 65521U;
  }
  const std::uint32_t adler = (b << 16) | a;
  for (int i = 3; i >= 0; --i) z.push_back(static_cast<std::uint8_t>(adler >> (8 * i)));
  chunk("IDAT", z);
  chunk("IEND", {});
  return out;
}

}  // namespace premation::tools
