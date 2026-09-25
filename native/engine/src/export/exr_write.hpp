// F1: an EXR sequence frame as exportManager.ts `renderExrSequenceZip` writes
// it. The pixels are the float scene-color target — linear working space,
// premultiplied, before the display encode — read back the way
// WebGPUBackend.readRenderTargetFloatAsync does (rgba8unorm as v / 255 in a
// Float32Array, rgba16float decoded, rgba32float as is) and stored through
// exr.ts `floatToHalf`; the file is exr.ts `encodeExr` with pixelType 'half':
// uncompressed, single part, one scanline per chunk, channels A B G R — byte
// for byte.
#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <span>
#include <string_view>
#include <vector>

namespace premation::exporter {

/// The scene-color target's texel format.
enum class LinearFormat : std::uint8_t { unorm8, float16, float32 };

/// exr.ts `floatToHalf` (JavaScript doubles; Math.round rounds half up).
[[nodiscard]] inline std::uint16_t float_to_half(double f) noexcept {
  if (std::isnan(f)) return 0x7E00;
  const unsigned sign = std::signbit(f) ? 0x8000U : 0U;
  const auto half = [sign](unsigned bits) { return static_cast<std::uint16_t>(sign | bits); };
  const double a = std::fabs(f);
  if (a == 0 || a < 0x1p-24) return half(0);
  if (std::isinf(a) || a >= 65520) return half(0x7C00U);
  const auto round = [](double v) { return static_cast<unsigned>(std::floor(v + 0.5)); };
  if (a < 0x1p-14) return half(round(a * 0x1p24));
  int e2 = 0;
  (void)std::frexp(a, &e2);
  const int exp = e2 - 1;  // Math.floor(Math.log2(a))
  auto e = static_cast<unsigned>(exp + 15);
  unsigned m = round((std::ldexp(a, -exp) - 1) * 1024);
  if (m == 1024) {
    m = 0;
    e += 1;
  }
  if (e >= 31) return half(0x7C00U);
  return half((e << 10U) | m);
}

/// A read-back target (`stride` bytes a row, top-down) → tight RGBA binary16, little-endian.
inline void target_to_half_rgba(std::span<const std::uint8_t> src, std::uint32_t width, std::uint32_t height,
                                std::uint32_t stride, LinearFormat format, std::span<std::uint8_t> dst) noexcept {
  static const std::array<std::uint16_t, 256> kUnorm = [] {
    std::array<std::uint16_t, 256> t{};
    for (std::size_t i = 0; i < t.size(); ++i) {
      t[i] = float_to_half(static_cast<float>(static_cast<double>(i) / 255.0));  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
    }
    return t;
  }();
  const std::size_t values = std::size_t{width} * 4;
  for (std::uint32_t y = 0; y < height; ++y) {
    const auto row = src.subspan(std::size_t{y} * stride);
    std::uint8_t* out = dst.data() + std::size_t{y} * values * 2;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    for (std::size_t i = 0; i < values; ++i) {
      std::uint16_t h = 0;
      switch (format) {
        case LinearFormat::unorm8: h = kUnorm[row[i]]; break;  // NOLINT(cppcoreguidelines-pro-bounds-constant-array-index)
        case LinearFormat::float16: {
          // binary16 → double → floatToHalf is the identity except that every NaN becomes 0x7e00.
          std::memcpy(&h, &row[i * 2], 2);
          if ((h & 0x7C00U) == 0x7C00U && (h & 0x3FFU) != 0) h = 0x7E00;
          break;
        }
        case LinearFormat::float32: {
          float v = 0;
          std::memcpy(&v, &row[i * 4], 4);
          h = float_to_half(v);
          break;
        }
      }
      std::memcpy(out + i * 2, &h, 2);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic): little-endian hosts only (x86-64, arm64)
    }
  }
}

/// `encodeExr` of tight RGBA binary16 (little-endian, top-down) as HALF planes A, B, G, R.
[[nodiscard]] inline std::vector<std::uint8_t> encode_exr_half(std::span<const std::uint8_t> rgba, std::uint32_t width,
                                                               std::uint32_t height) {
  std::vector<std::uint8_t> out;
  const auto bytes = [&](const void* p, std::size_t n) {
    const auto* b = static_cast<const std::uint8_t*>(p);
    out.insert(out.end(), b, b + n);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  };
  const auto i32 = [&](std::int32_t v) { bytes(&v, 4); };
  const auto f32 = [&](float v) { bytes(&v, 4); };
  const auto str = [&](std::string_view s) {
    bytes(s.data(), s.size());
    out.push_back(0);
  };
  constexpr std::array<std::size_t, 4> kOrder = {3, 2, 1, 0};  // A B G R: EXR sorts channels by name
  i32(20000630);
  i32(2);
  str("channels");
  str("chlist");
  i32(static_cast<std::int32_t>(kOrder.size() * 18 + 1));
  for (const char* name : {"A", "B", "G", "R"}) {
    str(name);
    i32(1);  // HALF
    i32(0);  // pLinear + reserved
    i32(1);  // xSampling
    i32(1);  // ySampling
  }
  out.push_back(0);
  str("compression");
  str("compression");
  i32(1);
  out.push_back(0);  // NONE
  const auto box = [&] {
    i32(0);
    i32(0);
    i32(static_cast<std::int32_t>(width) - 1);
    i32(static_cast<std::int32_t>(height) - 1);
  };
  str("dataWindow");
  str("box2i");
  i32(16);
  box();
  str("displayWindow");
  str("box2i");
  i32(16);
  box();
  str("lineOrder");
  str("lineOrder");
  i32(1);
  out.push_back(0);
  str("pixelAspectRatio");
  str("float");
  i32(4);
  f32(1);
  str("screenWindowCenter");
  str("v2f");
  i32(8);
  f32(0);
  f32(0);
  str("screenWindowWidth");
  str("float");
  i32(4);
  f32(1);
  out.push_back(0);

  const std::size_t lineBytes = std::size_t{width} * 2 * kOrder.size();
  const std::size_t chunkBytes = 8 + lineBytes;
  const std::uint64_t first = out.size() + std::uint64_t{height} * 8;
  for (std::uint32_t y = 0; y < height; ++y) {
    const std::uint64_t off = first + std::uint64_t{y} * chunkBytes;
    bytes(&off, 8);
  }
  out.resize(static_cast<std::size_t>(first) + chunkBytes * height);
  for (std::uint32_t y = 0; y < height; ++y) {
    std::uint8_t* chunk = out.data() + first + std::size_t{y} * chunkBytes;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    const auto line = static_cast<std::int32_t>(lineBytes);
    std::memcpy(chunk, &y, 4);
    std::memcpy(chunk + 4, &line, 4);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    const std::uint8_t* px = rgba.data() + std::size_t{y} * width * 8;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    std::uint8_t* plane = chunk + 8;  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    for (const std::size_t c : kOrder) {
      for (std::uint32_t x = 0; x < width; ++x, plane += 2) std::memcpy(plane, px + std::size_t{x} * 8 + c * 2, 2);  // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    }
  }
  return out;
}

}  // namespace premation::exporter
