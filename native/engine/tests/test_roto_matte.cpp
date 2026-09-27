// Roto matte arithmetic (jobs/roto_matte.cpp), the pure half of the stopped
// roto job. Flood fill, a boundary path, and a dilate that grows a single
// seed by one pixel.

#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <vector>

#include "roto_matte.hpp"

using premation::jobs::roto::Matte;
using premation::jobs::roto::Pt;
using premation::jobs::roto::Seed;
using premation::jobs::roto::flood_matte;
using premation::jobs::roto::matte_to_path;
using premation::jobs::roto::morph_dilate;

namespace {

std::vector<std::uint8_t> solid(int w, int h, std::uint8_t r, std::uint8_t g, std::uint8_t b) {
  std::vector<std::uint8_t> rgba(static_cast<std::size_t>(w) * static_cast<std::size_t>(h) * 4, 0);
  for (std::size_t i = 0; i < rgba.size(); i += 4) {
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
  }
  return rgba;
}

}  // namespace

TEST_CASE("roto: a seed floods a uniform picture and refuses an empty seed list", "[roto]") {
  const std::vector<std::uint8_t> rgba = solid(4, 3, 200, 10, 10);
  const Matte filled = flood_matte(rgba, 4, 3, {Seed{1.2, 1.4, 32}});
  REQUIRE(filled.size() == 12);
  for (const std::uint8_t px : filled) REQUIRE(px == 255);

  const Matte empty = flood_matte(rgba, 4, 3, {});
  for (const std::uint8_t px : empty) REQUIRE(px == 0);
}

TEST_CASE("roto: a colour outside the tolerance stops the flood", "[roto]") {
  std::vector<std::uint8_t> rgba = solid(2, 1, 0, 0, 0);
  rgba[4] = 255;
  rgba[5] = 255;
  rgba[6] = 255;
  rgba[7] = 255;
  const Matte filled = flood_matte(rgba, 2, 1, {Seed{0, 0, 8}});
  REQUIRE(filled[0] == 255);
  REQUIRE(filled[1] == 0);
}

TEST_CASE("roto: the path is the boundary texel centres", "[roto]") {
  Matte mask(9, 0);
  mask[4] = 255;
  const std::vector<Pt> path = matte_to_path(mask, 3, 3);
  REQUIRE(path.size() == 1);
  REQUIRE(path[0].x == 1.5);
  REQUIRE(path[0].y == 1.5);
}

TEST_CASE("roto: dilate grows a single pixel by the radius", "[roto]") {
  Matte mask(9, 0);
  mask[4] = 255;
  const Matte grown = morph_dilate(mask, 3, 3, 1);
  REQUIRE(grown[4] == 255);
  REQUIRE(grown[0] == 255);
  REQUIRE(grown[1] == 255);
  REQUIRE(grown[3] == 255);
  REQUIRE(grown[5] == 255);
  REQUIRE(grown[8] == 255);
}
