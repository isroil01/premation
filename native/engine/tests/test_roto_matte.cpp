// Roto matte arithmetic (jobs/roto_matte.cpp), the pure half of the roto
// job. Flood fill, the outline path (a simple polygon, never a scanline
// zigzag), the polygon fill, the multi-stroke re-seed, and a dilate.

#include <catch2/catch_test_macros.hpp>

#include <cmath>
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

namespace {

double cross(const Pt& o, const Pt& a, const Pt& b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }

/// Proper crossing of segments ab and cd (shared endpoints do not count).
bool segments_cross(const Pt& a, const Pt& b, const Pt& c, const Pt& d) {
  const double d1 = cross(c, d, a);
  const double d2 = cross(c, d, b);
  const double d3 = cross(a, b, c);
  const double d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/// A closed polygon with no two non-adjacent edges crossing.
bool is_simple(const std::vector<Pt>& p) {
  const std::size_t n = p.size();
  for (std::size_t i = 0; i < n; ++i) {
    for (std::size_t j = i + 2; j < n; ++j) {
      if (i == 0 && j == n - 1) continue;  // the closing edge neighbours the first
      if (segments_cross(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return false;
    }
  }
  return true;
}

double area(const std::vector<Pt>& p) {
  double a = 0;
  for (std::size_t i = 0; i < p.size(); ++i) {
    const Pt& u = p[i];
    const Pt& v = p[(i + 1) % p.size()];
    a += u.x * v.y - v.x * u.y;
  }
  return std::abs(a) / 2;
}

}  // namespace

TEST_CASE("roto: a disc's path walks its outline with no self-intersection", "[roto]") {
  const int w = 96;
  const int h = 80;
  Matte mask(static_cast<std::size_t>(w * h), 0);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const double dx = x + 0.5 - 48;
      const double dy = y + 0.5 - 40;
      if (dx * dx + dy * dy <= 30.0 * 30.0) mask[static_cast<std::size_t>(y * w + x)] = 255;
    }
  }
  const std::vector<Pt> path = matte_to_path(mask, w, h);
  REQUIRE(path.size() >= 8);
  REQUIRE(path.size() <= premation::jobs::roto::kMaxPathPoints);
  CHECK(is_simple(path));
  // Every vertex sits on the circle (pixel edges: within ~1.5 px), and the
  // outline encloses the disc's area.
  for (const Pt& p : path) {
    const double r = std::hypot(p.x - 48, p.y - 40);
    CHECK(std::abs(r - 30) < 2.0);
  }
  CHECK(std::abs(area(path) - 3.14159265 * 900) < 0.05 * 3.14159265 * 900);
}

TEST_CASE("roto: an L shape's path is simple and keeps the inner corner", "[roto]") {
  const int w = 64;
  const int h = 64;
  Matte mask(static_cast<std::size_t>(w * h), 0);
  for (int y = 8; y < 56; ++y) {
    for (int x = 8; x < 56; ++x) {
      if (x < 24 || y >= 40) mask[static_cast<std::size_t>(y * w + x)] = 255;
    }
  }
  const std::vector<Pt> path = matte_to_path(mask, w, h);
  REQUIRE(path.size() >= 6);
  CHECK(is_simple(path));
  // 16×48 + 32×16 = 1280 px².
  CHECK(std::abs(area(path) - 1280.0) < 40.0);
  bool innerCorner = false;
  for (const Pt& p : path) {
    if (std::abs(p.x - 24) < 1.01 && std::abs(p.y - 40) < 1.01) innerCorner = true;
  }
  CHECK(innerCorner);
}

TEST_CASE("roto: a big ragged matte decimates to at most 128 vertices, still simple", "[roto]") {
  const int w = 400;
  const int h = 300;
  Matte mask(static_cast<std::size_t>(w * h), 0);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const double a = std::atan2(y - 150.0, x - 200.0);
      const double r = 110 + 12 * std::sin(a * 9);
      if (std::hypot(x - 200.0, y - 150.0) <= r) mask[static_cast<std::size_t>(y * w + x)] = 255;
    }
  }
  const std::vector<Pt> path = matte_to_path(mask, w, h);
  REQUIRE(path.size() >= 32);
  REQUIRE(path.size() <= premation::jobs::roto::kMaxPathPoints);
  CHECK(is_simple(path));
}

TEST_CASE("roto: an empty matte has no path", "[roto]") {
  CHECK(matte_to_path(Matte(64, 0), 8, 8).empty());
}

TEST_CASE("roto: a polygon fills at pixel centres", "[roto]") {
  const Matte m = premation::jobs::roto::fill_polygon({Pt{2, 2}, Pt{6, 2}, Pt{6, 5}, Pt{2, 5}}, 8, 8);
  int on = 0;
  for (const std::uint8_t v : m) on += v != 0 ? 1 : 0;
  CHECK(on == 12);
  CHECK(m[2 * 8 + 2] == 255);
  CHECK(m[1 * 8 + 2] == 0);
}

TEST_CASE("roto: the re-seed uses every stroke inside the carried matte and keeps background strokes out", "[roto]") {
  // Left half red, right half blue; the carried matte covers both halves.
  const int w = 8;
  const int h = 4;
  std::vector<std::uint8_t> rgba = solid(w, h, 200, 0, 0);
  for (int y = 0; y < h; ++y) {
    for (int x = 4; x < w; ++x) {
      const std::size_t i = static_cast<std::size_t>(y * w + x) * 4;
      rgba[i] = 0;
      rgba[i + 2] = 200;
    }
  }
  Matte carried(static_cast<std::size_t>(w * h), 0);
  for (int y = 0; y < h; ++y) {
    for (int x = 1; x < 7; ++x) carried[static_cast<std::size_t>(y * w + x)] = 255;
  }
  // Two foreground strokes, one per half: both halves flood.
  const auto both = premation::jobs::roto::reseed_matte(rgba, carried, w, h, {Seed{1, 1, 10}, Seed{6, 1, 10}}, {}, 10);
  CHECK(both.seeds.size() == 2);
  CHECK(both.add[0] == 255);
  CHECK(both.add[7] == 255);
  // A background stroke on the blue half keeps it out.
  const auto kept = premation::jobs::roto::reseed_matte(rgba, carried, w, h, {Seed{1, 1, 10}, Seed{6, 1, 10}}, {Seed{7, 3, 10}}, 10);
  CHECK(kept.add[0] == 255);
  CHECK(kept.add[7] == 0);
  // A stroke outside the carried matte is not used; with none inside, the centroid is.
  const auto outside = premation::jobs::roto::reseed_matte(rgba, carried, w, h, {Seed{0, 0, 10}}, {}, 10);
  REQUIRE(outside.seeds.size() == 1);
  CHECK(outside.seeds[0].x > 1);
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
