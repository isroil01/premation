// AE parity 3.5: the automatic camera solve on a synthetic shot — random 3D
// points seen by a camera that dollies and pans; the feature tracks are the
// exact projections (the image tracker has its own tests).

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <vector>

#include "jobs/camera_solve.hpp"
#include "jobs/camera_track.hpp"

namespace ct = premation::jobs::camtrack;
namespace cs = premation::jobs::camsolve;

namespace {

struct Shot {
  ct::FeatureTracks tracks;
  std::vector<ct::Pose> poses;
  std::vector<cs::V3> points;
};

Shot make_shot(double f, int frames, std::uint32_t seed) {
  Shot s;
  s.tracks.width = 960;
  s.tracks.height = 540;
  std::uint32_t r = seed;
  auto rnd = [&]() {
    r ^= r << 13;
    r ^= r >> 17;
    r ^= r << 5;
    return (r % 100000) / 100000.0;
  };
  for (int i = 0; i < 160; ++i) s.points.push_back(cs::V3{(rnd() - 0.5) * 8, (rnd() - 0.5) * 4, 6 + rnd() * 8});
  s.tracks.points = static_cast<int>(s.points.size());
  for (int k = 0; k < frames; ++k) {
    const double t = k / static_cast<double>(frames - 1);
    ct::Pose p;
    // Dolly right and forward while panning a little.
    p.R = cs::ypr_to_r(6 * t, -2 * t, 1 * t);
    p.C = cs::V3{1.6 * t, 0.1 * t, 0.8 * t};
    s.poses.push_back(p);
    std::vector<ct::Obs> obs;
    for (int i = 0; i < s.tracks.points; ++i) {
      const auto q = ct::project(p, s.points[static_cast<std::size_t>(i)], f, 480, 270);
      if (q && q->x > 0 && q->y > 0 && q->x < 960 && q->y < 540) obs.push_back(ct::Obs{i, q->x, q->y});
    }
    s.tracks.frames.push_back(std::move(obs));
  }
  return s;
}

}  // namespace

TEST_CASE("the camera angles round-trip through the engine's convention", "[jobs][camtrack]") {
  const cs::M3 R = cs::ypr_to_r(23, -11, 7);
  const ct::Ypr y = ct::r_to_ypr(R);
  CHECK(std::abs(y.yaw - 23) < 1e-9);
  CHECK(std::abs(y.pitch + 11) < 1e-9);
  CHECK(std::abs(y.roll - 7) < 1e-9);
}

TEST_CASE("a dolly-and-pan shot solves with a known lens", "[jobs][camtrack]") {
  const Shot s = make_shot(900, 30, 7);
  ct::SolveOptions o;
  o.focal = 900;
  const auto solved = ct::solve(s.tracks, o);
  REQUIRE(solved.has_value());
  CHECK(solved->solvedFrames >= 28);
  CHECK(solved->rmsPx < 0.5);
  int pts = 0;
  for (const auto& p : solved->points) pts += p ? 1 : 0;
  CHECK(pts > 100);
  // The rotation path matches the truth (the solve's frame is camera 0's).
  const ct::Ypr last = ct::r_to_ypr(solved->poses.back()->R);
  const ct::Ypr truth = ct::r_to_ypr(cs::ypr_to_r(6, -2, 1));
  CHECK(std::abs(last.yaw - truth.yaw) < 0.5);
  CHECK(std::abs(last.pitch - truth.pitch) < 0.5);
  CHECK(std::abs(last.roll - truth.roll) < 0.5);
}

TEST_CASE("the focal length is found when not given", "[jobs][camtrack]") {
  const Shot s = make_shot(1100, 24, 11);
  const auto solved = ct::solve(s.tracks, ct::SolveOptions{});
  REQUIRE(solved.has_value());
  CHECK(std::abs(solved->focal - 1100) / 1100 < 0.15);
  CHECK(solved->rmsPx < 1.0);
}
