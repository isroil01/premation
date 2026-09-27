// Engine jobs, round 2 — the pure halves on synthetic data (no decode, no
// document): mask vertex sampling (maskVertexSampling.ts), the subspace
// stabilizer's grid (subspaceWarp.ts), the camera solve (planarPose.ts,
// sfmCamera.ts), the roto matte (rotoMatte.ts / grabCut.ts), content-aware
// fill (contentAwareFill.ts) and auto-reframe (saliency.ts / reframePath.ts).

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include "jobs/mask_sampling.hpp"

using Catch::Approx;
namespace ms = premation::jobs::masksample;

namespace {

ms::SamplablePath circle(int n, double r, bool closed = true) {
  ms::SamplablePath p;
  p.closed = closed;
  for (int i = 0; i < n; ++i) {
    const double a = 2 * 3.141592653589793 * i / n;
    p.points.push_back(ms::Pt{r * std::cos(a), r * std::sin(a)});
  }
  return p;
}

}  // namespace

TEST_CASE("mask sampling: within the cap every vertex is its own slot", "[jobs][mask]") {
  const std::vector<ms::SamplablePath> paths{circle(12, 50), circle(5, 20)};
  const ms::VertexSampling s = ms::sample_mask_vertices(paths, 64);
  REQUIRE(s.total == 17);
  REQUIRE(s.tracked.size() == 17);
  for (int v = 0; v < 17; ++v) {
    CHECK(s.slotOf[static_cast<std::size_t>(v)] == v);
    CHECK(s.tracked[static_cast<std::size_t>(v)] == v);
  }
}

TEST_CASE("mask sampling: past the cap an even subset is tracked and a translation stays exact", "[jobs][mask]") {
  const std::vector<ms::SamplablePath> paths{circle(200, 100), circle(40, 10, false)};
  const ms::VertexSampling s = ms::sample_mask_vertices(paths, 64);
  REQUIRE(s.total == 240);
  REQUIRE(s.tracked.size() == 64);
  // Strictly increasing picks, and every tracked vertex maps back to its slot.
  for (std::size_t k = 1; k < s.tracked.size(); ++k) CHECK(s.tracked[k] > s.tracked[k - 1]);
  for (std::size_t k = 0; k < s.tracked.size(); ++k) CHECK(s.slotOf[static_cast<std::size_t>(s.tracked[k])] == static_cast<int>(k));
  // A pure translation of every slot moves every vertex by exactly that delta.
  const std::vector<ms::Pt> deltas(s.tracked.size(), ms::Pt{3.5, -2});
  for (const ms::Pt& d : ms::blend_vertex_deltas(s, deltas)) {
    CHECK(d.x == Approx(3.5));
    CHECK(d.y == Approx(-2));
  }
}

TEST_CASE("mask sampling: an untracked vertex blends its neighbours by arc length", "[jobs][mask]") {
  // An open line of 5 equally spaced points, 3 tracked: 0, 2, 4.
  ms::SamplablePath line;
  line.closed = false;
  for (int i = 0; i < 5; ++i) line.points.push_back(ms::Pt{static_cast<double>(i) * 10, 0});
  const ms::VertexSampling s = ms::sample_mask_vertices({line}, 3);
  REQUIRE(s.tracked == std::vector<int>{0, 2, 4});
  const std::vector<ms::Pt> out = ms::blend_vertex_deltas(s, {ms::Pt{0, 0}, ms::Pt{10, 0}, ms::Pt{20, 0}});
  CHECK(out[1].x == Approx(5));
  CHECK(out[3].x == Approx(15));
}
