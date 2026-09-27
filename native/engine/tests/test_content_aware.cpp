// Content-Aware Fill's PatchMatch (src/core/effects/contentAwareFill.ts) on a
// synthetic picture: a flat field with a hole is filled from the field.

#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <span>
#include <vector>

#include "content_aware.hpp"

using premation::jobs::caf::inpaint_patch_match;

TEST_CASE("patch match fills a hole from the surrounding colour", "[caf]") {
  constexpr int kW = 8;
  constexpr int kH = 8;
  std::vector<std::uint8_t> rgba(static_cast<std::size_t>(kW * kH * 4), 0);
  std::vector<std::uint8_t> hole(static_cast<std::size_t>(kW * kH), 0);
  for (int y = 0; y < kH; ++y) {
    for (int x = 0; x < kW; ++x) {
      const std::size_t p = static_cast<std::size_t>((y * kW + x) * 4);
      const bool missing = x >= 3 && x <= 4 && y >= 3 && y <= 4;
      rgba[p] = missing ? 0 : 200;
      rgba[p + 1] = missing ? 0 : 40;
      rgba[p + 2] = missing ? 0 : 10;
      rgba[p + 3] = 255;
      hole[static_cast<std::size_t>(y * kW + x)] = missing ? 255 : 0;
    }
  }
  const int filled = inpaint_patch_match(rgba, kW, kH, hole);
  CHECK(filled == 4);
  for (int y = 3; y <= 4; ++y) {
    for (int x = 3; x <= 4; ++x) {
      const std::size_t p = static_cast<std::size_t>((y * kW + x) * 4);
      CHECK(rgba[p] == 200);
      CHECK(rgba[p + 1] == 40);
      CHECK(rgba[p + 2] == 10);
      CHECK(rgba[p + 3] == 255);
    }
  }
}

TEST_CASE("a polygon rasterises as the hole", "[caf]") {
  using premation::jobs::caf::Poly;
  using premation::jobs::caf::raster_hole;
  std::vector<std::uint8_t> hole(16, 1);
  Poly poly;
  poly.points = {{1, 1}, {3, 1}, {3, 3}, {1, 3}};
  raster_hole(hole, 4, 4, std::span<const Poly>(&poly, 1));
  CHECK(hole[0] == 0);
  CHECK(hole[static_cast<std::size_t>(1 * 4 + 1)] == 255);
  CHECK(hole[static_cast<std::size_t>(2 * 4 + 2)] == 255);
  CHECK(hole[15] == 0);
}

TEST_CASE("patch match leaves a picture with no hole unchanged", "[caf]") {
  std::vector<std::uint8_t> rgba(16, 7);
  std::vector<std::uint8_t> hole(4, 0);
  CHECK(inpaint_patch_match(rgba, 2, 2, hole) == 0);
  CHECK(rgba[0] == 7);
}
