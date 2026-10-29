// A layer's subjects united with their live edge (scene/subject_matte.hpp).
#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <vector>

#include "subject_matte.hpp"

using namespace premation::scene::subject_matte;

namespace {

/// A w × h premultiplied RGBA8 picture, opaque white inside [x0, x1) × [y0, y1).
std::vector<std::uint8_t> square(std::uint32_t w, std::uint32_t h, std::uint32_t x0, std::uint32_t y0, std::uint32_t x1, std::uint32_t y1) {
  std::vector<std::uint8_t> px(static_cast<std::size_t>(w) * h * 4, 0);
  for (std::uint32_t y = y0; y < y1; ++y)
    for (std::uint32_t x = x0; x < x1; ++x)
      for (std::size_t c = 0; c < 4; ++c) px[(static_cast<std::size_t>(y) * w + x) * 4 + c] = 255;
  return px;
}

std::uint8_t alpha_at(const std::vector<std::uint8_t>& px, std::uint32_t w, std::uint32_t x, std::uint32_t y) {
  return px[(static_cast<std::size_t>(y) * w + x) * 4 + 3];
}

}  // namespace

TEST_CASE("choke shrinks and grows a subject by whole pixels", "[subject]") {
  std::vector<float> a(20 * 20, 0.0f);
  for (std::uint32_t y = 5; y < 15; ++y)
    for (std::uint32_t x = 5; x < 15; ++x) a[y * 20 + x] = 1.0f;
  std::vector<float> shrunk = a;
  refine_alpha(shrunk, 20, 20, 0, 2, 0, false);
  CHECK(shrunk[10 * 20 + 6] == 0.0f);   // 1 px inside the edge: gone
  CHECK(shrunk[10 * 20 + 7] == 1.0f);   // 2 px inside: kept
  std::vector<float> grown = a;
  refine_alpha(grown, 20, 20, 0, -2, 0, false);
  CHECK(grown[10 * 20 + 3] == 1.0f);    // 2 px outside: covered
  CHECK(grown[10 * 20 + 2] == 0.0f);
}

TEST_CASE("a subject touching the frame's edge keeps it when choked", "[subject]") {
  std::vector<float> a(10 * 10, 0.0f);
  for (std::uint32_t y = 0; y < 10; ++y)
    for (std::uint32_t x = 0; x < 5; ++x) a[y * 10 + x] = 1.0f;
  refine_alpha(a, 10, 10, 0, 2, 0, false);
  CHECK(a[5 * 10 + 0] == 1.0f);
  CHECK(a[5 * 10 + 2] == 1.0f);
  CHECK(a[5 * 10 + 3] == 0.0f);
}

TEST_CASE("feather softens the edge, contrast steepens it, invert flips it", "[subject]") {
  std::vector<float> a(40, 0.0f);
  for (std::size_t i = 20; i < 40; ++i) a[i] = 1.0f;
  std::vector<float> soft = a;
  refine_alpha(soft, 40, 1, 6, 0, 0, false);
  CHECK(soft[19] > 0.2f);
  CHECK(soft[19] < 0.5f);
  CHECK(soft[20] > 0.5f);
  std::vector<float> steep = soft;
  refine_alpha(steep, 40, 1, 0, 0, 0.8, false);
  CHECK(steep[17] < soft[17]);
  CHECK(steep[22] > soft[22]);
  std::vector<float> inv = a;
  refine_alpha(inv, 40, 1, 0, 0, 0, true);
  CHECK(inv[0] == 1.0f);
  CHECK(inv[39] == 0.0f);
}

TEST_CASE("subjects unite, a hidden one covers nothing", "[subject]") {
  const std::vector<std::uint8_t> left = square(16, 8, 0, 0, 6, 8);
  const std::vector<std::uint8_t> right = square(16, 8, 10, 0, 16, 8);
  std::vector<Part> parts(2);
  parts[0].frame = Picture{16, 8, left};
  parts[1].frame = Picture{16, 8, right};
  std::uint32_t w = 0;
  std::uint32_t h = 0;
  std::vector<std::uint8_t> both = combine(parts, w, h);
  REQUIRE(w == 16);
  REQUIRE(h == 8);
  CHECK(alpha_at(both, w, 2, 4) == 255);
  CHECK(alpha_at(both, w, 12, 4) == 255);
  CHECK(alpha_at(both, w, 8, 4) == 0);
  parts[1].hidden = true;
  std::vector<std::uint8_t> one = combine(parts, w, h);
  CHECK(alpha_at(one, w, 2, 4) == 255);
  CHECK(alpha_at(one, w, 12, 4) == 0);
  parts[0].hidden = true;
  std::vector<std::uint8_t> none = combine(parts, w, h);
  REQUIRE(none.size() == static_cast<std::size_t>(16) * 8 * 4);
  CHECK(alpha_at(none, w, 2, 4) == 0);
}

TEST_CASE("temporal smooth mixes in the neighbouring frames", "[subject]") {
  const std::vector<std::uint8_t> now = square(8, 1, 0, 0, 4, 1);
  const std::vector<std::uint8_t> next = square(8, 1, 0, 0, 6, 1);
  std::vector<Part> parts(1);
  parts[0].frame = Picture{8, 1, now};
  parts[0].blend.emplace_back(Picture{8, 1, next}, 0.5);
  std::uint32_t w = 0;
  std::uint32_t h = 0;
  const std::vector<std::uint8_t> out = combine(parts, w, h);
  CHECK(alpha_at(out, w, 2, 0) == 255);
  CHECK(alpha_at(out, w, 4, 0) >= 127);
  CHECK(alpha_at(out, w, 4, 0) <= 128);
  CHECK(alpha_at(out, w, 7, 0) == 0);
}
