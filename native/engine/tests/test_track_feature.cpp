// AE parity 3.6: one-click feature picking (autoFeature.ts restored in the
// engine, jobs/track_feature.hpp) and the Warp Stabilizer's framing zoom
// (jobs/stabilize.hpp framing_scales).

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include "jobs/stabilize.hpp"
#include "jobs/track_feature.hpp"
#include "jobs/tracking.hpp"

namespace tr = premation::jobs::tracking;
namespace ft = premation::jobs::feature;
namespace st = premation::jobs::stabilize;

namespace {

tr::LumaPlane plane(int w, int h, float v = 0.5f) {
  tr::LumaPlane p;
  p.width = w;
  p.height = h;
  p.data.assign(static_cast<std::size_t>(w * h), v);
  return p;
}

void rect(tr::LumaPlane& p, int x0, int y0, int x1, int y1, float v) {
  for (int y = y0; y < y1; ++y)
    for (int x = x0; x < x1; ++x) p.data[static_cast<std::size_t>(y * p.width + x)] = v;
}

}  // namespace

TEST_CASE("a flat area has nothing to track", "[jobs][feature]") {
  const tr::LumaPlane p = plane(200, 160);
  CHECK_FALSE(ft::pick_feature(p).has_value());
}

TEST_CASE("a straight edge is not a feature; a corner is, and the pick sits on it", "[jobs][feature]") {
  tr::LumaPlane edge = plane(200, 160, 0.2f);
  rect(edge, 100, 0, 200, 160, 0.9f);  // one vertical edge: slides along y
  CHECK_FALSE(ft::pick_feature(edge, {tr::Pt{100, 80}, 40.0, 24}).has_value());

  tr::LumaPlane corner = plane(200, 160, 0.2f);
  rect(corner, 100, 70, 200, 160, 0.9f);  // a corner at (100, 70)
  const auto f = ft::pick_feature(corner, {tr::Pt{110, 80}, 40.0, 24});
  REQUIRE(f.has_value());
  CHECK(std::abs(f->x - 100) <= 2);
  CHECK(std::abs(f->y - 70) <= 2);
  CHECK(f->distinctness > 0.2);  // edge-like rivals on the rings correlate partly with a lone corner
}

TEST_CASE("periodic texture reads as ambiguous", "[jobs][feature]") {
  tr::LumaPlane checker = plane(240, 240);
  for (int y = 0; y < 240; ++y)
    for (int x = 0; x < 240; ++x) checker.data[static_cast<std::size_t>(y * 240 + x)] = ((x / 12 + y / 12) % 2) ? 0.9f : 0.1f;
  const auto f = ft::pick_feature(checker, {tr::Pt{120, 120}, 60.0, 24});
  REQUIRE(f.has_value());
  CHECK(f->distinctness < 0.5);
}

TEST_CASE("the plan measures motion, sizes the search from it and finds a companion", "[jobs][feature]") {
  auto scene_at = [](int shift) {
    tr::LumaPlane p = plane(320, 240, 0.15f);
    rect(p, 120 + shift, 90, 150 + shift, 120, 0.85f);  // feature: a block
    rect(p, 190 + shift, 130, 214 + shift, 150, 0.6f);  // a second block nearby
    return p;
  };
  const tr::LumaPlane anchor = scene_at(0);
  const std::vector<tr::LumaPlane> probes = {scene_at(6), scene_at(12)};
  const auto plan = ft::plan_track(anchor, probes, {tr::Pt{122, 92}, 50.0, 24});
  REQUIRE(plan.has_value());
  REQUIRE(plan->motionPerFrame.has_value());
  CHECK(std::abs(*plan->motionPerFrame - 6) < 1.0);
  CHECK(plan->searchHalf >= 6 * 2);
  CHECK(plan->featureHalf >= 6);
  CHECK(plan->featureHalf <= 16);
  REQUIRE(plan->companion.has_value());
  CHECK(std::hypot(plan->companion->x - plan->x, plan->companion->y - plan->y) > 20);
}

TEST_CASE("framing zooms just enough to hide a shifted frame's border", "[jobs][stabilize][framing]") {
  // Moving the frame 10 px right in 100 px leaves 40 px of picture left of
  // the centre: a 50 px half-width needs 1.25×.
  const st::Sim shift{1, 0, 10, 0};
  CHECK(std::abs(st::border_free_scale(shift, 100, 100) - 1.25) < 1e-9);
  CHECK(st::border_free_scale(st::Sim{}, 100, 100) == 1);

  const std::vector<st::Sim> path = {st::Sim{}, shift, st::Sim{1, 0, -4, 0}, st::Sim{}};
  const auto only = st::framing_scales(path, 100, 100, st::Framing::stabilizeOnly, 1.5, 1);
  CHECK(only == std::vector<double>(4, 1.0));
  const auto crop = st::framing_scales(path, 100, 100, st::Framing::stabilizeCrop, 1.5, 1);
  for (const double k : crop) CHECK(std::abs(k - 1.25) < 1e-9);
  const auto autoScale = st::framing_scales(path, 100, 100, st::Framing::cropAutoScale, 1.5, 1);
  CHECK(autoScale[1] >= 1.25 - 1e-9);  // never less than the frame needs
  CHECK(autoScale[2] >= 1.0 / (1 - 0.08) - 1e-9);
  const auto capped = st::framing_scales(path, 100, 100, st::Framing::stabilizeCrop, 1.1, 1);
  CHECK(std::abs(capped[0] - 1.1) < 1e-9);
  // The applied correction keeps only what `method` writes.
  const st::Sim rotated = st::sim_from(0.1, 1.2, 5, -3);
  const st::Sim posOnly = st::applied_correction(rotated, 50, 50, false, false);
  CHECK(posOnly.a == 1);
  CHECK(posOnly.b == 0);
  const st::XY c = st::apply_sim(rotated, 50, 50);
  CHECK(std::abs(st::apply_sim(posOnly, 50, 50).x - c.x) < 1e-9);
}
