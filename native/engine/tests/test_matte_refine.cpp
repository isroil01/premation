// AE parity 3.1 / 3.2: the soft-matte maths of the video Object Matte.

#include <catch2/catch_test_macros.hpp>

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
