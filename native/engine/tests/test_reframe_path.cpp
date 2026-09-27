// Auto-reframe's camera path (src/core/reframe/reframePath.test.ts).

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <vector>

#include "reframe_path.hpp"

using Catch::Approx;
namespace rf = premation::jobs::reframe;

namespace {

const rf::Geometry kWideToTall{1920, 1080, 1080, 1920};

rf::Attention at(double x, double confidence = 1) { return rf::Attention{x, 0.5, confidence}; }

}  // namespace

TEST_CASE("cover scale fills a tall target from a wide source", "[reframe]") {
  CHECK(rf::cover_scale(kWideToTall) == Approx(1920.0 / 1080.0));
  CHECK(rf::cover_scale(rf::Geometry{1920, 1080, 1920, 1080}) == 1);
}

TEST_CASE("pan range is horizontal only for wide to tall", "[reframe]") {
  const rf::Pan range = rf::pan_range(kWideToTall);
  CHECK(range.x > 500);
  CHECK(range.y == Approx(0).margin(1e-6));
  const rf::Pan same = rf::pan_range(rf::Geometry{1920, 1080, 960, 540});
  CHECK(same.x == Approx(0).margin(1e-6));
  CHECK(same.y == Approx(0).margin(1e-6));
}

TEST_CASE("a centred subject holds and a right-side subject pans left", "[reframe]") {
  rf::PathOptions opts;
  std::vector<rf::Attention> still(24, at(0.5));
  const rf::XYPath held = rf::build_reframe_path(still, {}, kWideToTall, opts);
  for (const double x : held.x) CHECK(std::abs(x) < 1);
  std::vector<rf::Attention> right(60, at(0.8));
  const rf::XYPath moved = rf::build_reframe_path(right, {}, kWideToTall, opts);
  CHECK(moved.x.back() < 0);
  const rf::Pan range = rf::pan_range(kWideToTall);
  std::vector<rf::Attention> edge(60, at(1));
  const rf::XYPath clamped = rf::build_reframe_path(edge, {}, kWideToTall, opts);
  for (const double x : clamped.x) CHECK(std::abs(x) <= range.x + 1e-6);
}

TEST_CASE("dead-zone jitter stays locked and a real move is followed", "[reframe]") {
  rf::PathOptions opts;
  std::vector<rf::Attention> jitter;
  for (int i = 0; i < 60; ++i) jitter.push_back(at(0.5 + (i % 2 == 0 ? 0.02 : -0.02)));
  const rf::XYPath locked = rf::build_reframe_path(jitter, {}, kWideToTall, opts);
  const auto [lo, hi] = std::minmax_element(locked.x.begin(), locked.x.end());
  CHECK(*hi - *lo < 1);
  std::vector<rf::Attention> leave;
  for (int i = 0; i < 60; ++i) leave.push_back(at(i < 30 ? 0.5 : 0.85));
  const rf::XYPath followed = rf::build_reframe_path(leave, {}, kWideToTall, opts);
  CHECK(std::abs(followed.x[59]) > 400);
}
