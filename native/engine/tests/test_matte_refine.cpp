// AE parity 3.1 / 3.2: the soft-matte maths of the video Object Matte.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <vector>

#include "jobs/matte_refine.hpp"

namespace mt = premation::jobs::matte;
namespace pm = premation::scene::pixmo;

TEST_CASE("the guided filter pulls a misplaced matte edge onto the picture's edge", "[jobs][matte]") {
  constexpr int W = 40;
  constexpr int H = 20;
  std::vector<float> I(W * H);
  std::vector<float> p(W * H);
  for (int y = 0; y < H; ++y)
    for (int x = 0; x < W; ++x) {
      I[static_cast<std::size_t>(y * W + x)] = x < 20 ? 0.9f : 0.1f;  // the subject's edge at x = 20
      p[static_cast<std::size_t>(y * W + x)] = x < 23 ? 1.0f : 0.0f;  // the segmentation's edge, 3 px off
    }
  const std::vector<float> q = mt::guided_filter(p, I, W, H, 4, 1e-4);
  // Where the 0.5 level is crossed along the row.
  auto crossing = [&](const std::vector<float>& v) {
    for (int x = 1; x < W; ++x) {
      if (v[static_cast<std::size_t>(10 * W + x)] < 0.5f) return x;
    }
    return W;
  };
  CHECK(std::abs(crossing(q) - 20) < std::abs(crossing(p) - 20));
  CHECK(q[10 * W + 10] > 0.95f);  // well inside stays opaque
  CHECK(q[10 * W + 32] < 0.05f);  // well outside stays clear
}

TEST_CASE("decontamination takes the background colour out of edge pixels", "[jobs][matte]") {
  constexpr int W = 64;
  constexpr int H = 16;
  std::vector<std::uint8_t> rgba(W * H * 4, 255);
  std::vector<float> a(W * H);
  for (int y = 0; y < H; ++y)
    for (int x = 0; x < W; ++x) {
      const std::size_t i = static_cast<std::size_t>(y * W + x);
      // Subject red (200,0,0) on the left, a green screen (0,200,0) on the right, a 50 % edge column.
      const double alpha = x < 30 ? 1.0 : x == 30 ? 0.5 : 0.0;
      a[i] = static_cast<float>(alpha);
      rgba[i * 4] = static_cast<std::uint8_t>(200 * alpha);
      rgba[i * 4 + 1] = static_cast<std::uint8_t>(200 * (1 - alpha));
      rgba[i * 4 + 2] = 0;
    }
  mt::decontaminate(rgba, a, W, H, 1.0);
  const std::size_t e = static_cast<std::size_t>(8 * W + 30) * 4;
  CHECK(rgba[e + 1] < 30);   // the green spill is gone
  CHECK(rgba[e] > 170);      // the subject's red is back
}

TEST_CASE("seeds sit inside the matte, background seeds outside it", "[jobs][matte]") {
  constexpr int W = 100;
  constexpr int H = 80;
  std::vector<float> a(W * H, 0.0f);
  for (int y = 20; y < 60; ++y)
    for (int x = 30; x < 70; ++x) a[static_cast<std::size_t>(y * W + x)] = 1.0f;
  const mt::Seeds s = mt::seeds_from_matte(a, W, H);
  REQUIRE_FALSE(s.empty);
  CHECK(s.box.x0 == 30);
  CHECK(s.box.x1 == 70);
  int fg = 0;
  int bg = 0;
  for (const auto& p : s.points) {
    const float v = a[static_cast<std::size_t>(static_cast<int>(p.y) * W + static_cast<int>(p.x))];
    if (p.label == 1) {
      ++fg;
      CHECK(v == 1.0f);
    } else {
      ++bg;
      CHECK(v == 0.0f);
    }
  }
  CHECK(fg >= 1);
  CHECK(bg >= 2);
  CHECK(mt::seeds_from_matte(std::vector<float>(W * H, 0.0f), W, H).empty);
}

TEST_CASE("choke shrinks, feather softens, motion blur smears along the flow", "[jobs][matte]") {
  constexpr int W = 48;
  constexpr int H = 16;
  std::vector<float> a(W * H, 0.0f);
  for (int y = 0; y < H; ++y)
    for (int x = 0; x < 24; ++x) a[static_cast<std::size_t>(y * W + x)] = x >= 23 ? 0.6f : 1.0f;
  std::vector<float> choked = a;
  mt::choke_feather(choked, W, H, 50, 0);
  CHECK(choked[8 * W + 23] < 0.6f);
  std::vector<float> feathered = a;
  mt::choke_feather(feathered, W, H, 0, 6);
  CHECK(feathered[8 * W + 26] > 0.05f);
  pm::FlowField flow;
  flow.cols = 6;
  flow.rows = 2;
  flow.step = 8;
  flow.dx.assign(12, 8.0f);
  flow.dy.assign(12, 0.0f);
  flow.valid.assign(12, 1);
  const std::vector<float> blurred = mt::motion_blur(a, flow, W, H, 180);
  CHECK(blurred[8 * W + 25] > 0.1f);
  CHECK(blurred[8 * W + 10] > 0.99f);
  const std::vector<float> moved = mt::warp_by_flow(a, flow, W, H);
  CHECK(moved[8 * W + 30] > 0.99f);  // the matte moved 8 px right
}

TEST_CASE("edge snap finds an edge of colour alone, and leaves pixels far from the edge as they are", "[jobs][matte][subject]") {
  // A red subject (x < 60) on a green ground of the SAME luma: the luma guide sees no edge here.
  constexpr int W = 120;
  constexpr int H = 40;
  std::vector<std::uint8_t> rgba(static_cast<std::size_t>(W * H) * 4);
  std::vector<float> coarse(static_cast<std::size_t>(W * H));
  for (int y = 0; y < H; ++y)
    for (int x = 0; x < W; ++x) {
      const std::size_t i = static_cast<std::size_t>(y * W + x);
      const bool subject = x < 60;
      rgba[i * 4 + 0] = subject ? 200 : 60;
      rgba[i * 4 + 1] = subject ? 60 : 125;  // 0.299·R + 0.587·G alike on both sides
      rgba[i * 4 + 2] = 40;
      rgba[i * 4 + 3] = 255;
      // The model's edge: 5 px too far right and soft over ±4 px (its 256² grid, upsampled).
      coarse[i] = static_cast<float>(std::clamp((65.0 - x) / 8.0 + 0.5, 0.0, 1.0));
    }
  const std::vector<float> lumaOnly = mt::guided_filter(coarse, mt::luma(rgba, W, H), W, H, 8, 1e-3);
  const std::vector<float> snapped = mt::snap_edge(coarse, rgba, W, H, 8);
  const auto crossing = [&](const std::vector<float>& a) {
    for (int x = 0; x + 1 < W; ++x)
      if (a[static_cast<std::size_t>(20 * W + x)] >= 0.5f && a[static_cast<std::size_t>(20 * W + x + 1)] < 0.5f) return x;
    return -1;
  };
  CHECK(std::abs(crossing(snapped) - 59) <= 1);  // on the colour edge
  CHECK(std::abs(crossing(lumaOnly) - 59) > 2);  // the luma guide could not move it
  CHECK(snapped[static_cast<std::size_t>(20 * W + 59)] > 0.8f);  // a hard edge stays hard
  CHECK(snapped[static_cast<std::size_t>(20 * W + 61)] < 0.2f);
  CHECK(snapped[static_cast<std::size_t>(20 * W + 10)] == coarse[static_cast<std::size_t>(20 * W + 10)]);   // far inside: untouched
  CHECK(snapped[static_cast<std::size_t>(20 * W + 110)] == coarse[static_cast<std::size_t>(20 * W + 110)]);  // far outside: untouched
}

TEST_CASE("edge snap leaves a matte with no edge alone", "[jobs][matte][subject]") {
  std::vector<std::uint8_t> rgba(16 * 16 * 4, 128);
  const std::vector<float> none(16 * 16, 0.0f);
  CHECK(mt::snap_edge(none, rgba, 16, 16, 4) == none);
}
TEST_CASE("edge snap keeps a striped subject whole and grades a blurred edge", "[jobs][matte][subject]") {
  constexpr int W = 120;
  constexpr int H = 40;
  std::vector<std::uint8_t> rgba(static_cast<std::size_t>(W * H) * 4, 255);
  std::vector<float> coarse(static_cast<std::size_t>(W * H));
  for (int y = 0; y < H; ++y)
    for (int x = 0; x < W; ++x) {
      const std::size_t i = static_cast<std::size_t>(y * W + x);
      // Subject x < 60: stripes of white and black every 3 rows (a striped shirt), on mid blue.
      // The edge is blurred over x 57…63 (motion), linearly from the subject's colour to the ground.
      const double t = std::clamp((x - 57) / 6.0, 0.0, 1.0);
      const double sub = (y / 3) % 2 == 0 ? 250.0 : 15.0;
      rgba[i * 4 + 0] = static_cast<std::uint8_t>(std::lround(sub * (1 - t) + 40 * t));
      rgba[i * 4 + 1] = static_cast<std::uint8_t>(std::lround(sub * (1 - t) + 90 * t));
      rgba[i * 4 + 2] = static_cast<std::uint8_t>(std::lround(sub * (1 - t) + 200 * t));
      coarse[i] = static_cast<float>(std::clamp((63.0 - x) / 8.0 + 0.5, 0.0, 1.0));
    }
  const std::vector<float> s = mt::snap_edge(coarse, rgba, W, H, 8);
  // Inside the subject, in the band, on either kind of stripe: still subject.
  for (int y : {1, 4, 7, 10})
    for (int x = 50; x <= 55; ++x) CHECK(s[static_cast<std::size_t>(y * W + x)] > 0.85f);
  // The blurred edge reads as a ramp, not a step: about half-way at its middle.
  const float mid = s[static_cast<std::size_t>(1 * W + 60)];
  CHECK(mid > 0.25f);
  CHECK(mid < 0.75f);
  // Past the blur: ground.
  for (int x = 66; x <= 72; ++x) CHECK(s[static_cast<std::size_t>(1 * W + x)] < 0.1f);
}
TEST_CASE("edge snap at 1080p: the time it adds to a selection", "[.bench][matte]") {
  // A person-sized ellipse on a noisy ground, its coarse edge 5 px out — how long one snap takes.
  constexpr int W = 1920;
  constexpr int H = 1080;
  std::vector<std::uint8_t> rgba(static_cast<std::size_t>(W) * H * 4);
  std::vector<float> coarse(static_cast<std::size_t>(W) * H);
  std::uint32_t seed = 7;
  for (int y = 0; y < H; ++y)
    for (int x = 0; x < W; ++x) {
      const std::size_t i = static_cast<std::size_t>(y) * W + static_cast<std::size_t>(x);
      seed = seed * 1664525u + 1013904223u;
      const double e = std::hypot((x - 960.0) / 300.0, (y - 560.0) / 480.0);
      const auto noise = static_cast<int>(seed >> 28);
      rgba[i * 4 + 0] = static_cast<std::uint8_t>(e < 1 ? 180 + noise : 40 + noise);
      rgba[i * 4 + 1] = static_cast<std::uint8_t>(e < 1 ? 120 + noise : 90 + noise);
      rgba[i * 4 + 2] = static_cast<std::uint8_t>(e < 1 ? 90 + noise : 160 + noise);
      rgba[i * 4 + 3] = 255;
      coarse[i] = static_cast<float>(std::clamp((1.0 - e) * 300.0 / 8.0 + 0.5 + 5.0 / 8.0, 0.0, 1.0));
    }
  const auto t0 = std::chrono::steady_clock::now();
  const std::vector<float> s = mt::snap_edge(coarse, rgba, W, H, 9);
  const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  WARN("snap_edge 1920x1080, radius 9: " << ms << " ms");
  CHECK(s.size() == coarse.size());
}
TEST_CASE("edge snap trusts the model where subject and ground are nearly the same colour", "[jobs][matte][subject]") {
  // Dark jeans on a wall in shadow: both near-black, a few levels of noise — the colours cannot
  // place the edge, so the model's matte must come through whole (no holes along the leg).
  constexpr int W = 120;
  constexpr int H = 40;
  std::vector<std::uint8_t> rgba(static_cast<std::size_t>(W * H) * 4, 255);
  std::vector<float> coarse(static_cast<std::size_t>(W * H));
  std::uint32_t seed = 3;
  for (int y = 0; y < H; ++y)
    for (int x = 0; x < W; ++x) {
      const std::size_t i = static_cast<std::size_t>(y * W + x);
      seed = seed * 1664525u + 1013904223u;
      const int noise = static_cast<int>(seed >> 29) * 3 - 9;  // ±9 levels
      const int base = x < 60 ? 30 : 42;
      for (std::size_t c = 0; c < 3; ++c) rgba[i * 4 + c] = static_cast<std::uint8_t>(std::clamp(base + noise, 0, 255));
      coarse[i] = static_cast<float>(std::clamp((61.0 - x) / 6.0 + 0.5, 0.0, 1.0));
    }
  const std::vector<float> s = mt::snap_edge(coarse, rgba, W, H, 8);
  for (int y = 2; y < H - 2; ++y)
    for (int x = 50; x <= 57; ++x) {
      const std::size_t i = static_cast<std::size_t>(y * W + x);
      if (coarse[i] >= 0.99f) CHECK(s[i] > 0.85f);
    }
}