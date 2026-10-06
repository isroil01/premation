// Content-Aware Fill's PatchMatch (src/core/effects/contentAwareFill.ts) on a
// synthetic picture: a flat field with a hole is filled from the field.

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <algorithm>
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

// ── AE parity 3.7: multi-scale fill, Bézier holes, modes, lighting ───────

#include <cmath>

#include "content_aware_fill.hpp"

namespace {

namespace caf = premation::jobs::caf;

std::vector<std::uint8_t> picture(int w, int h, auto colour) {
  std::vector<std::uint8_t> rgba(static_cast<std::size_t>(w * h * 4), 255);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const auto c = colour(x, y);
      const std::size_t p = static_cast<std::size_t>((y * w + x) * 4);
      rgba[p] = c[0];
      rgba[p + 1] = c[1];
      rgba[p + 2] = c[2];
    }
  }
  return rgba;
}

std::vector<std::uint8_t> box_hole(int w, int h, int x0, int y0, int x1, int y1) {
  std::vector<std::uint8_t> hole(static_cast<std::size_t>(w * h), 0);
  for (int y = y0; y < y1; ++y)
    for (int x = x0; x < x1; ++x) hole[static_cast<std::size_t>(y * w + x)] = 255;
  return hole;
}

/// Mean absolute error over the hole, red channel.
double hole_error(const std::vector<std::uint8_t>& a, const std::vector<std::uint8_t>& b, const std::vector<std::uint8_t>& hole) {
  double sum = 0;
  int n = 0;
  for (std::size_t i = 0; i < hole.size(); ++i) {
    if (hole[i] == 0) continue;
    sum += std::abs(static_cast<int>(a[i * 4]) - static_cast<int>(b[i * 4]));
    ++n;
  }
  return n > 0 ? sum / n : 0;
}

caf::HolePath circle(double cx, double cy, double r) {
  constexpr double k = 0.5522847498;
  caf::HolePath p;
  p.points = {
      {cx, cy - r, cx - k * r, cy - r, cx + k * r, cy - r},
      {cx + r, cy, cx + r, cy - k * r, cx + r, cy + k * r},
      {cx, cy + r, cx + k * r, cy + r, cx - k * r, cy + r},
      {cx - r, cy, cx - r, cy + k * r, cx - r, cy - k * r},
  };
  return p;
}

}  // namespace

TEST_CASE("multi-scale patch match continues stripes through a hole", "[caf][ae]") {
  constexpr int kW = 64;
  constexpr int kH = 64;
  auto stripes = [](int x, int) {
    const std::uint8_t v = (x / 4) % 2 == 0 ? 220 : 30;
    return std::array<std::uint8_t, 3>{v, v, v};
  };
  const auto truth = picture(kW, kH, stripes);
  auto rgba = truth;
  const auto hole = box_hole(kW, kH, 24, 24, 40, 40);
  for (std::size_t i = 0; i < hole.size(); ++i)
    if (hole[i] != 0) rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 128;
  CHECK(caf::inpaint_multiscale(rgba, kW, kH, hole) == 16 * 16);
  CHECK(hole_error(rgba, truth, hole) < 25.0);
  // Deterministic: the same input fills the same way.
  auto again = truth;
  for (std::size_t i = 0; i < hole.size(); ++i)
    if (hole[i] != 0) again[i * 4] = again[i * 4 + 1] = again[i * 4 + 2] = 128;
  (void)caf::inpaint_multiscale(again, kW, kH, hole);
  CHECK(again == rgba);
}

TEST_CASE("edge blend fills a gradient smoothly", "[caf][ae]") {
  constexpr int kW = 48;
  constexpr int kH = 32;
  auto ramp = [](int x, int) {
    const auto v = static_cast<std::uint8_t>(x * 5);
    return std::array<std::uint8_t, 3>{v, 100, 50};
  };
  const auto truth = picture(kW, kH, ramp);
  auto rgba = truth;
  const auto hole = box_hole(kW, kH, 10, 8, 38, 24);
  for (std::size_t i = 0; i < hole.size(); ++i)
    if (hole[i] != 0) rgba[i * 4] = 0;
  CHECK(caf::edge_blend_fill(rgba, kW, kH, hole) > 0);
  CHECK(hole_error(rgba, truth, hole) < 3.0);
}

TEST_CASE("a Bézier mask is the hole, with subtract and inverted", "[caf][ae]") {
  constexpr int kW = 64;
  constexpr int kH = 64;
  std::vector<std::uint8_t> hole(static_cast<std::size_t>(kW * kH), 0);
  caf::HolePath disc = circle(32, 32, 20);
  const int area = caf::raster_hole_paths(hole, kW, kH, std::span<const caf::HolePath>(&disc, 1));
  const double expect = 3.14159265 * 20 * 20;
  CHECK(std::abs(area - expect) / expect < 0.03);
  // Vertices only (the old polygon) would be a diamond of area 2r².
  CHECK(area > 2 * 20 * 20 + 100);

  caf::HolePath grown = disc;
  grown.expansion = 4;
  CHECK(caf::raster_hole_paths(hole, kW, kH, std::span<const caf::HolePath>(&grown, 1)) > area);

  std::vector<caf::HolePath> ring = {disc, circle(32, 32, 10)};
  ring[1].subtract = true;
  const int ringArea = caf::raster_hole_paths(hole, kW, kH, ring);
  CHECK(hole[static_cast<std::size_t>(32 * kW + 32)] == 0);
  CHECK(std::abs(ringArea - 3.14159265 * (400 - 100)) / (3.14159265 * 300) < 0.05);

  caf::HolePath outside = disc;
  outside.inverted = true;
  CHECK(caf::raster_hole_paths(hole, kW, kH, std::span<const caf::HolePath>(&outside, 1)) == kW * kH - area);
}

TEST_CASE("lighting correction removes a brightness step at the hole's edge", "[caf][ae]") {
  constexpr int kW = 40;
  constexpr int kH = 40;
  auto flat = [](int, int) { return std::array<std::uint8_t, 3>{150, 150, 150}; };
  auto rgba = picture(kW, kH, flat);
  const auto hole = box_hole(kW, kH, 12, 12, 28, 28);
  for (std::size_t i = 0; i < hole.size(); ++i)
    if (hole[i] != 0) rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 110;  // a darker fill
  auto subtle = rgba;
  caf::correct_lighting(subtle, kW, kH, hole, caf::lighting_strength(caf::Lighting::subtle));
  caf::correct_lighting(rgba, kW, kH, hole, caf::lighting_strength(caf::Lighting::strong));
  const auto truth = picture(kW, kH, flat);
  CHECK(hole_error(rgba, truth, hole) < 2.0);
  const double e = hole_error(subtle, truth, hole);
  CHECK(e > 15.0);
  CHECK(e < 35.0);
}

TEST_CASE("a reference frame anchors the fill and flow carries it through a pan", "[caf][ae]") {
  constexpr int kW = 96;
  constexpr int kH = 64;
  auto scene_at = [](int shift) {
    return [shift](int x, int y) {
      const int u = x + shift;
      const auto v = static_cast<std::uint8_t>(60 + 40 * std::sin(u * 0.21) + 30 * std::cos(y * 0.17) + ((u / 9 + y / 9) % 2) * 50);
      return std::array<std::uint8_t, 3>{v, static_cast<std::uint8_t>(255 - v), 90};
    };
  };
  std::vector<caf::SequenceFrame> frames(5);
  std::vector<std::vector<std::uint8_t>> truths;
  const auto hole = box_hole(kW, kH, 40, 20, 60, 44);
  for (int i = 0; i < 5; ++i) {
    truths.push_back(picture(kW, kH, scene_at(2 * i)));
    frames[static_cast<std::size_t>(i)].rgba = truths.back();
    frames[static_cast<std::size_t>(i)].hole = hole;
    for (std::size_t p = 0; p < hole.size(); ++p)
      if (hole[p] != 0) frames[static_cast<std::size_t>(i)].rgba[p * 4] = 0;  // the object to remove
  }
  frames[0].reference = truths[0];
  caf::SequenceOptions opts;
  opts.mode = caf::FillMode::surface;
  const caf::SequenceStats st = caf::fill_sequence(frames, kW, kH, opts);
  CHECK(st.fromReference == 20 * 24);
  CHECK(st.propagated > 0);
  CHECK(hole_error(frames[0].rgba, truths[0], hole) == 0);
  for (std::size_t i = 1; i < 5; ++i) {
    CHECK(hole_error(frames[i].rgba, truths[i], hole) < 12.0);
    CHECK_FALSE(std::any_of(frames[i].hole.begin(), frames[i].hole.end(), [](std::uint8_t v) { return v != 0; }));
  }
}

TEST_CASE("edge blend mode fills every frame without synthesis", "[caf][ae]") {
  constexpr int kW = 32;
  constexpr int kH = 32;
  auto flat = [](int, int) { return std::array<std::uint8_t, 3>{70, 80, 90}; };
  std::vector<caf::SequenceFrame> frames(2);
  for (auto& f : frames) {
    f.rgba = picture(kW, kH, flat);
    f.hole = box_hole(kW, kH, 8, 8, 20, 20);
  }
  caf::SequenceOptions opts;
  opts.mode = caf::FillMode::edgeBlend;
  const caf::SequenceStats st = caf::fill_sequence(frames, kW, kH, opts);
  CHECK(st.synthesized == 0);
  CHECK(st.propagated == 0);
  CHECK(st.blended == 2 * 12 * 12);
  CHECK(frames[1].rgba[static_cast<std::size_t>((10 * kW + 10) * 4)] == 70);
}
