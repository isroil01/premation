// The EXR reader (scene/exr_read.hpp, exr.ts decodeExr + floatExr.ts
// exrToFloatRgba) over synthetic files: NONE / RLE / ZIPS chunks (the ZIP
// stream built from stored deflate blocks, so the test needs no compressor),
// HALF / FLOAT / UINT channels, Y-only images, and exr.ts's refusals.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

#include "exr_read.hpp"

namespace exr = premation::scene::exr;

namespace {

using Bytes = std::vector<std::uint8_t>;

void put_i32(Bytes& b, std::int32_t v) {
  const auto u = static_cast<std::uint32_t>(v);
  for (unsigned k = 0; k < 4; ++k) b.push_back(static_cast<std::uint8_t>((u >> (8U * k)) & 0xFFU));
}
void put_str(Bytes& b, const std::string& s) {
  b.insert(b.end(), s.begin(), s.end());
  b.push_back(0);
}
void put_u16(Bytes& b, std::uint16_t v) {
  b.push_back(static_cast<std::uint8_t>(v & 0xFFU));
  b.push_back(static_cast<std::uint8_t>(v >> 8U));
}

struct Ch {
  std::string name;
  int type;  // 0 UINT, 1 HALF, 2 FLOAT
};

/// A single-part scanline EXR header (sorted channels, the given compression).
Bytes header(int w, int h, const std::vector<Ch>& chans, int compression, std::int32_t version = 2) {
  Bytes b;
  put_i32(b, 20000630);
  put_i32(b, version);
  Bytes list;
  for (const Ch& c : chans) {
    put_str(list, c.name);
    put_i32(list, c.type);
    for (int k = 0; k < 4; ++k) list.push_back(0);  // pLinear + reserved
    put_i32(list, 1);
    put_i32(list, 1);
  }
  list.push_back(0);
  put_str(b, "channels");
  put_str(b, "chlist");
  put_i32(b, static_cast<std::int32_t>(list.size()));
  b.insert(b.end(), list.begin(), list.end());
  put_str(b, "compression");
  put_str(b, "compression");
  put_i32(b, 1);
  b.push_back(static_cast<std::uint8_t>(compression));
  put_str(b, "dataWindow");
  put_str(b, "box2i");
  put_i32(b, 16);
  put_i32(b, 0);
  put_i32(b, 0);
  put_i32(b, w - 1);
  put_i32(b, h - 1);
  put_str(b, "lineOrder");
  put_str(b, "lineOrder");
  put_i32(b, 1);
  b.push_back(0);
  put_str(b, "note");
  put_str(b, "string");
  put_i32(b, 5);
  for (const char c : std::string("hello")) b.push_back(static_cast<std::uint8_t>(c));
  b.push_back(0);  // end of header
  const int lines = compression == 3 ? 16 : 1;
  const int blocks = (h + lines - 1) / lines;
  for (int k = 0; k < blocks * 8; ++k) b.push_back(0);  // offset table (skipped by the reader)
  return b;
}

/// exr.ts exrPredictorEncode.
Bytes predictor_encode(const Bytes& data) {
  const std::size_t n = data.size();
  Bytes out(n, 0);
  const std::size_t half = (n + 1) / 2;
  for (std::size_t i = 0, j = 0; j < n; ++i, j += 2) out[i] = data[j];
  for (std::size_t i = half, j = 1; j < n; ++i, j += 2) out[i] = data[j];
  for (std::size_t i = n - 1; i >= 1; --i) out[i] = static_cast<std::uint8_t>((out[i] - out[i - 1] + 128 + 256) & 0xFF);
  return out;
}

/// A zlib stream of `data` in one STORED deflate block (RFC 1950 / 1951).
Bytes zlib_stored(const Bytes& data) {
  Bytes z{0x78, 0x01, 0x01};
  const auto len = static_cast<std::uint16_t>(data.size());
  put_u16(z, len);
  put_u16(z, static_cast<std::uint16_t>(~len));
  z.insert(z.end(), data.begin(), data.end());
  std::uint32_t a = 1;
  std::uint32_t bsum = 0;
  for (const std::uint8_t v : data) {
    a = (a + v) % 65521U;
    bsum = (bsum + a) % 65521U;
  }
  const std::uint32_t adler = (bsum << 16U) | a;
  for (int k = 3; k >= 0; --k) z.push_back(static_cast<std::uint8_t>((adler >> (8U * static_cast<unsigned>(k))) & 0xFFU));
  return z;
}

/// EXR RLE of `data` as literal runs only (≤ 127 bytes each).
Bytes rle_literal(const Bytes& data) {
  Bytes out;
  for (std::size_t i = 0; i < data.size();) {
    const std::size_t n = std::min<std::size_t>(127, data.size() - i);
    out.push_back(static_cast<std::uint8_t>(256 - n));
    out.insert(out.end(), data.begin() + static_cast<std::ptrdiff_t>(i), data.begin() + static_cast<std::ptrdiff_t>(i + n));
    i += n;
  }
  return out;
}

void put_chunk(Bytes& file, int y, const Bytes& payload) {
  put_i32(file, y);
  put_i32(file, static_cast<std::int32_t>(payload.size()));
  file.insert(file.end(), payload.begin(), payload.end());
}

// One 2 × 2 image, channels B G R (HALF) + A (FLOAT): line y's raw bytes.
Bytes line_bytes(int y) {
  Bytes b;
  const std::uint16_t halves[2][3][2] = {{{0x3C00, 0x0000}, {0x3800, 0x3C00}, {0x4000, 0x3400}},   // y0: B, G, R
                                         {{0x0001, 0x3C00}, {0xC000, 0x3800}, {0x7C00, 0x3C00}}};  // y1
  for (int c = 0; c < 3; ++c) {
    for (int x = 0; x < 2; ++x) put_u16(b, halves[y][c][x]);
  }
  const float alpha[2][2] = {{1.0F, 0.5F}, {0.25F, -1.0F}};
  for (int x = 0; x < 2; ++x) {
    std::uint32_t u = 0;
    std::memcpy(&u, &alpha[y][x], 4);
    put_i32(b, static_cast<std::int32_t>(u));
  }
  return b;
}

const std::vector<Ch> kBGRA = {{"A", 2}, {"B", 1}, {"G", 1}, {"R", 1}};

}  // namespace

TEST_CASE("EXR: half floats as exr.ts halfToFloat", "[scene][exr]") {
  CHECK(exr::half_to_float(0x3C00) == 1.0F);
  CHECK(exr::half_to_float(0xC000) == -2.0F);
  CHECK(exr::half_to_float(0x0001) == static_cast<float>(std::ldexp(1.0, -24)));
  CHECK(std::isinf(exr::half_to_float(0x7C00)));
  CHECK(std::isnan(exr::half_to_float(0x7C01)));
}

TEST_CASE("EXR: NONE, RLE and ZIPS scanline files decode to the same planes", "[scene][exr]") {
  // Channel order in the file is the header's (sorted): A, B, G, R — rebuild the lines that way.
  const auto file_line = [](int y) {
    const Bytes l = line_bytes(y);  // B G R (half) then A (float)
    Bytes out(l.begin() + 12, l.end());  // A first
    out.insert(out.end(), l.begin(), l.begin() + 12);
    return out;
  };
  for (const int compression : {0, 1, 2}) {
    INFO("compression " << compression);
    Bytes f = header(2, 2, kBGRA, compression);
    for (int y = 0; y < 2; ++y) {
      const Bytes raw = file_line(y);
      if (compression == 0) put_chunk(f, y, raw);
      else if (compression == 1) put_chunk(f, y, rle_literal(predictor_encode(raw)));
      else put_chunk(f, y, zlib_stored(predictor_encode(raw)));
    }
    std::string error;
    const auto img = exr::decode(f, exr::zlib_inflate(), error);
    INFO(error);
    REQUIRE(img);
    CHECK(img->width == 2);
    CHECK(img->height == 2);
    REQUIRE(img->channels.size() == 4);
    CHECK(img->attributes.at("note") == "hello");
    const auto rgba = exr::to_float_rgba(*img);
    REQUIRE(rgba);
    const std::vector<float> want = {2.0F, 0.5F, 1.0F, 1.0F,   0.25F, 1.0F, 0.0F, 0.5F,
                                     std::numeric_limits<float>::infinity(), -2.0F, static_cast<float>(std::ldexp(1.0, -24)), 0.25F,
                                     1.0F, 0.5F, 1.0F, 0.0F};
    REQUIRE(rgba->rgba.size() == want.size());
    for (std::size_t i = 0; i < want.size(); ++i) {
      INFO("i " << i);
      CHECK(rgba->rgba[i] == want[i]);
    }
  }
}

TEST_CASE("EXR: a Y-only image fills R, G and B; FLOAT exposure gain", "[scene][exr]") {
  Bytes f = header(1, 1, {{"Y", 2}}, 0);
  Bytes raw;
  const float v = 0.75F;
  std::uint32_t u = 0;
  std::memcpy(&u, &v, 4);
  put_i32(raw, static_cast<std::int32_t>(u));
  put_chunk(f, 0, raw);
  std::string error;
  const auto img = exr::decode(f, exr::zlib_inflate(), error);
  REQUIRE(img);
  const auto rgba = exr::to_float_rgba(*img, 1);  // exposure +1 → ×2
  REQUIRE(rgba);
  CHECK(rgba->rgba == std::vector<float>{1.5F, 1.5F, 1.5F, 1.0F});
}

TEST_CASE("EXR: what exr.ts refuses is refused with its reason", "[scene][exr]") {
  std::string error;
  CHECK_FALSE(exr::decode(Bytes{1, 2, 3, 4}, exr::zlib_inflate(), error));
  CHECK(error == "Not an OpenEXR file.");
  CHECK_FALSE(exr::decode(header(2, 2, kBGRA, 0, 2 | 0x200), exr::zlib_inflate(), error));
  CHECK(error.starts_with("Tiled EXR"));
  CHECK_FALSE(exr::decode(header(2, 2, kBGRA, 4), exr::zlib_inflate(), error));
  CHECK(error.starts_with("EXR compression PIZ"));
  Bytes truncated = header(2, 2, kBGRA, 0);
  put_i32(truncated, 0);
  put_i32(truncated, 100);  // a chunk longer than the file
  CHECK_FALSE(exr::decode(truncated, exr::zlib_inflate(), error));
}
