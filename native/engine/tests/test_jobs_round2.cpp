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
#include "jobs/stabilize.hpp"
#include "jobs/track_plans.hpp"

using Catch::Approx;
namespace ms = premation::jobs::masksample;
namespace st = premation::jobs::stabilize;
namespace ta = premation::jobs::trackapply;

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

namespace {

/// A flow field of `cols`×`rows` valid cells moving by (dx(y), dy).
premation::scene::pixmo::FlowField field(int cols, int rows, int step, double dx, double dy, double shear = 0) {
  premation::scene::pixmo::FlowField f;
  f.cols = cols;
  f.rows = rows;
  f.step = step;
  for (int gy = 0; gy < rows; ++gy) {
    for (int gx = 0; gx < cols; ++gx) {
      const double y = (gy + 0.5) * step;
      f.dx.push_back(static_cast<float>(dx + shear * (y - rows * step / 2.0)));
      f.dy.push_back(static_cast<float>(dy));
      f.valid.push_back(1);
    }
  }
  return f;
}

}  // namespace

TEST_CASE("subspace: a uniform translation fits every cell, and the grid samples it", "[jobs][stabilize]") {
  const auto f = field(24, 16, 8, 2, -1);
  const std::vector<st::Cell> cells = st::fit_subspace_warp(f, 4, 4, 1, 1);
  REQUIRE(cells.size() == 16);
  std::vector<ta::SubspaceCell> grid;
  for (const st::Cell& c : cells) {
    CHECK(c.sim.a == Approx(1).margin(1e-9));
    CHECK(c.sim.b == Approx(0).margin(1e-9));
    CHECK(c.sim.tx == Approx(2).margin(1e-9));
    CHECK(c.sim.ty == Approx(-1).margin(1e-9));
    grid.push_back(ta::SubspaceCell{c.cx, c.cy, c.sim});
  }
  const ta::P2 p = ta::sample_subspace(grid, 4, 4, 50, 40, 192, 128);
  CHECK(p.x == Approx(52));
  CHECK(p.y == Approx(39));
  CHECK(st::estimate_rolling_shutter_shear(f, 1, 1) == Approx(0).margin(1e-12));
}

TEST_CASE("subspace: the rolling-shutter shear is the dx-per-row slope", "[jobs][stabilize]") {
  const auto f = field(24, 16, 8, 0, 0, 0.05);
  CHECK(st::estimate_rolling_shutter_shear(f, 1, 1) == Approx(0.05).epsilon(1e-6));
  const st::XY r = st::apply_rolling_shutter_repair(10, 30, 20, 0.05);
  CHECK(r.x == Approx(9.5));
  CHECK(r.y == Approx(30));
}

TEST_CASE("subspace: the mesh plan keys 16 lattice offsets per frame on a Mesh Warp", "[jobs][stabilize]") {
  std::vector<ta::SubspaceCell> cells;
  for (int i = 0; i < 16; ++i) cells.push_back(ta::SubspaceCell{0, 0, st::Sim{1, 0, 4, 0}});
  const std::optional<ta::Plan> plan = ta::plan_subspace_mesh("L", {ta::MeshFrame{cells, 0}, ta::MeshFrame{cells, 0.5}}, 4, 4, 100, 50, 200, 100);
  REQUIRE(plan);
  CHECK(plan->effectType == "mesh-warp");
  CHECK(plan->writes.size() == 32);
  CHECK(plan->count == 64);
  // Every vertex moves 4 flow px = 8 layer px in x, nothing in y.
  CHECK(plan->writes[0].track == "v0X");
  CHECK(plan->writes[0].keys[1].second == Approx(8));
  CHECK(plan->writes[1].keys[0].second == Approx(0));
}
