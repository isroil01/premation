// The tracker jobs' arithmetic (jobs/tracking.hpp, jobs/stabilize.hpp) on
// synthetic frames — no decode, no document:
//   - a textured field moved by known sub-pixel offsets is tracked to within
//     a fifth of a pixel on every frame (NCC search + Lucas-Kanade refine);
//   - a backward walk is exactly the forward walk of the reversed clip, and
//     a both-ways merge is one ascending sample per frame;
//   - a cancelled walk stops where it was cancelled;
//   - the corner pin's homography fit maps its correspondences, and RANSAC
//     votes an outlier out;
//   - the smooth stabilizer measures known integer jitter pair by pair and
//     its corrections cancel it.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

#include "jobs/stabilize.hpp"
#include "jobs/tracking.hpp"

using namespace premation::jobs;
namespace tr = premation::jobs::tracking;
namespace st = premation::jobs::stabilize;

namespace {

constexpr int kW = 160;
constexpr int kH = 120;

struct Blob {
  double x, y, s, a;
};

/// A deterministic field of Gaussian blobs (fixed LCG): smooth, non-periodic,
/// structured in both axes everywhere — a sub-pixel shift is exactly f(x − ox).
std::vector<Blob> blobs() {
  std::vector<Blob> out;
  std::uint32_t s = 12345U;
  auto next = [&s] {
    s = s * 1664525U + 1013904223U;
    return static_cast<double>(s >> 8U) / 16777216.0;
  };
  for (int i = 0; i < 300; ++i) {
    const double x = -20 + next() * (kW + 40);
    const double y = -20 + next() * (kH + 40);
    const double sg = 1.8 + next() * 2.2;
    const double a = (next() - 0.5) * 0.8;
    out.push_back(Blob{x, y, sg, a});
  }
  return out;
}

double field(const std::vector<Blob>& bs, double u, double v) {
  double f = 0.5;
  for (const Blob& b : bs) {
    const double dx = u - b.x;
    const double dy = v - b.y;
    f += b.a * std::exp(-(dx * dx + dy * dy) / (2 * b.s * b.s));
  }
  return f;
}

tr::LumaPlane plane_at(const std::vector<Blob>& bs, double ox, double oy) {
  tr::LumaPlane p;
  p.width = kW;
  p.height = kH;
  p.data.resize(static_cast<std::size_t>(kW) * kH);
  for (int y = 0; y < kH; ++y) {
    for (int x = 0; x < kW; ++x) {
      p.data[static_cast<std::size_t>(y) * kW + static_cast<std::size_t>(x)] = static_cast<float>(field(bs, x - ox, y - oy));
    }
  }
  return p;
}

struct Offset {
  double x, y;
};

std::vector<Offset> subpixel_path(int n) {
  std::vector<Offset> o;
  for (int i = 0; i < n; ++i) o.push_back(Offset{0.37 * i, -0.23 * i + 0.1 * (i % 3)});
  return o;
}

}  // namespace

TEST_CASE("tracking: a moving texture is tracked to sub-pixel accuracy", "[jobs][tracking]") {
  const std::vector<Blob> bs = blobs();
  const std::vector<Offset> path = subpixel_path(12);
  std::vector<tr::LumaPlane> frames;
  for (const Offset& o : path) frames.push_back(plane_at(bs, o.x, o.y));

  const tr::PointSeed seed{80, 60, 10, 12};
  const tr::FrameAt at = [&frames](std::int64_t i) -> const tr::LumaPlane& { return frames[static_cast<std::size_t>(i)]; };
  const tr::MultiTrackResult r = tr::track_points(at, 0, 11, std::span(&seed, 1), tr::TrackOptions{}, {});
  REQUIRE(r.status == tr::TrackStatus::completed);
  REQUIRE(r.tracks.size() == 1);
  REQUIRE(r.tracks[0].size() == 12);
  for (std::size_t i = 0; i < 12; ++i) {
    const tr::TrackSample& s = r.tracks[0][i];
    CHECK(s.frame == static_cast<std::int64_t>(i));
    CHECK_FALSE(s.coasted);
    CHECK(s.confidence > 0.9);
    CHECK(std::abs(s.x - (80 + path[i].x)) < 0.2);
    CHECK(std::abs(s.y - (60 + path[i].y)) < 0.2);
  }
}

TEST_CASE("tracking: match_patch finds a known sub-pixel displacement", "[jobs][tracking]") {
  const std::vector<Blob> bs = blobs();
  const tr::LumaPlane a = plane_at(bs, 0, 0);
  const tr::LumaPlane b = plane_at(bs, 3.4, -2.3);
  const std::vector<float> ref = tr::extract_patch(a, 70, 50, 10);
  REQUIRE(ref.size() == 21U * 21U);
  const auto m = tr::match_patch(ref, 10, b, 70, 50, 8);
  REQUIRE(m.has_value());
  CHECK(std::abs(m->x - 73.4) < 0.1);
  CHECK(std::abs(m->y - 47.7) < 0.1);
  CHECK(m->confidence > 0.95);
  // Off the plane: no patch, no match.
  CHECK(tr::extract_patch(a, -1, 5, 10).empty());
}

TEST_CASE("tracking: backward is the reversed forward walk; both ways merge ascending", "[jobs][tracking]") {
  const std::vector<Blob> bs = blobs();
  const std::vector<Offset> path = subpixel_path(10);
  std::vector<tr::LumaPlane> frames;
  for (const Offset& o : path) frames.push_back(plane_at(bs, o.x, o.y));
  constexpr std::int64_t last = 9;
  const tr::PointSeed seeds[2] = {{80 + path[9].x, 60 + path[9].y, 10, 12}, {50 + path[9].x, 70 + path[9].y, 8, 12}};

  const tr::FrameAt fwd = [&frames](std::int64_t i) -> const tr::LumaPlane& { return frames[static_cast<std::size_t>(i)]; };
  const tr::FrameAt rev = [&frames](std::int64_t i) -> const tr::LumaPlane& {
    return frames[static_cast<std::size_t>(last - i)];
  };
  const tr::MultiTrackResult back = tr::track_points(fwd, last, 0, seeds, tr::TrackOptions{}, {});
  const tr::MultiTrackResult reversed = tr::track_points(rev, 0, last, seeds, tr::TrackOptions{}, {});
  REQUIRE(back.status == reversed.status);
  REQUIRE(back.tracks.size() == 2);
  for (std::size_t p = 0; p < 2; ++p) {
    REQUIRE(back.tracks[p].size() == reversed.tracks[p].size());
    for (std::size_t i = 0; i < back.tracks[p].size(); ++i) {
      const tr::TrackSample& b = back.tracks[p][i];
      const tr::TrackSample& f = reversed.tracks[p][i];
      CHECK(b.frame == last - f.frame);
      CHECK(b.x == f.x);  // the same arithmetic on the same planes: bit-equal
      CHECK(b.y == f.y);
      CHECK(b.confidence == f.confidence);
      CHECK(b.coasted == f.coasted);
    }
  }
  // Backward from the last frame lands on frame 0's truth too.
  CHECK(std::abs(back.tracks[0].back().x - 80) < 0.25);
  CHECK(std::abs(back.tracks[0].back().y - 60) < 0.25);

  // Both ways from frame 4: backward 4→0 then forward 4→9, the anchor once.
  const tr::PointSeed mid{80 + path[4].x, 60 + path[4].y, 10, 12};
  const tr::MultiTrackResult b2 = tr::track_points(fwd, 4, 0, std::span(&mid, 1), tr::TrackOptions{}, {});
  const tr::MultiTrackResult f2 = tr::track_points(fwd, 4, 9, std::span(&mid, 1), tr::TrackOptions{}, {});
  const std::vector<tr::TrackSample> merged = tr::merge_bidirectional(b2.tracks[0], f2.tracks[0]);
  REQUIRE(merged.size() == 10);
  for (std::size_t i = 0; i < merged.size(); ++i) {
    CHECK(merged[i].frame == static_cast<std::int64_t>(i));
    CHECK(std::abs(merged[i].x - (80 + path[i].x)) < 0.25);
  }
  CHECK(merged[4].x == mid.x);
  CHECK(merged[4].confidence == 1);
}

TEST_CASE("tracking: a cancelled walk stops where it was cancelled", "[jobs][tracking]") {
  const std::vector<Blob> bs = blobs();
  const std::vector<Offset> path = subpixel_path(12);
  std::vector<tr::LumaPlane> frames;
  for (const Offset& o : path) frames.push_back(plane_at(bs, o.x, o.y));
  int reads = 0;
  const tr::FrameAt at = [&](std::int64_t i) -> const tr::LumaPlane& {
    ++reads;
    return frames[static_cast<std::size_t>(i)];
  };
  // The job's progress callback: false once the control reports cancelled (here: before the third step).
  const tr::OnProgress cancelAt3 = [](std::int64_t done, std::int64_t total) {
    CHECK(total == 12);
    return done < 3;
  };
  const tr::PointSeed seed{80, 60, 10, 12};
  const tr::MultiTrackResult r = tr::track_points(at, 0, 11, std::span(&seed, 1), tr::TrackOptions{}, cancelAt3);
  CHECK(r.status == tr::TrackStatus::cancelled);
  REQUIRE(r.tracks.size() == 1);
  CHECK(r.tracks[0].size() == 3);  // the start frame + two steps
  CHECK(reads == 3);               // no frame decoded after the cancel
}

TEST_CASE("tracking: a point off the frame is born dead and the walk reports lost", "[jobs][tracking]") {
  const std::vector<Blob> bs = blobs();
  std::vector<tr::LumaPlane> frames{plane_at(bs, 0, 0), plane_at(bs, 1, 0)};
  const tr::FrameAt at = [&frames](std::int64_t i) -> const tr::LumaPlane& { return frames[static_cast<std::size_t>(i)]; };
  const tr::PointSeed seed{-5, 10, 10, 12};
  const tr::MultiTrackResult r = tr::track_points(at, 0, 1, std::span(&seed, 1), tr::TrackOptions{}, {});
  CHECK(r.status == tr::TrackStatus::lost);
  REQUIRE(r.tracks[0].size() == 1);
  CHECK(r.tracks[0][0].coasted);
  CHECK(r.tracks[0][0].confidence == 0);
}

TEST_CASE("tracking: homography fit and RANSAC", "[jobs][tracking]") {
  // A perspective map: the unit-ish quad (0..100) onto a skewed quad.
  const auto H = [](tr::Pt p) {
    const double w = 0.0012 * p.x + 0.0007 * p.y + 1;
    return tr::Pt{(1.1 * p.x + 0.2 * p.y + 30) / w, (-0.1 * p.x + 0.9 * p.y + 12) / w};
  };
  std::vector<tr::Pt> src;
  std::vector<tr::Pt> dst;
  for (int y = 0; y <= 100; y += 25) {
    for (int x = 0; x <= 100; x += 50) {
      src.push_back(tr::Pt{static_cast<double>(x), static_cast<double>(y)});
      dst.push_back(H(src.back()));
    }
  }
  const auto fit = tr::fit_homography(src, dst);
  REQUIRE(fit.has_value());
  for (std::size_t i = 0; i < src.size(); ++i) {
    const auto p = tr::project_homography(*fit, src[i]);
    REQUIRE(p.has_value());
    CHECK(std::abs(p->x - dst[i].x) < 0.02);  // Float32 storage of H
    CHECK(std::abs(p->y - dst[i].y) < 0.02);
  }
  // One correspondence slid 40 px (an occluder): RANSAC votes it out.
  std::vector<tr::Pt> bad = dst;
  bad[4].x += 40;
  tr::RansacOptions ro;
  ro.seed = 7;
  const auto r1 = tr::fit_homography_ransac(src, bad, ro);
  const auto r2 = tr::fit_homography_ransac(src, bad, ro);
  REQUIRE(r1.has_value());
  CHECK_FALSE(r1->inliers[4]);
  CHECK(r1->inlierCount == static_cast<int>(src.size()) - 1);
  CHECK(r1->H == r2->H);  // seeded: the same fit every time
  // A zero weight excludes a point outright.
  ro.weights.assign(src.size(), 1.0);
  ro.weights[4] = 0;
  const auto r3 = tr::fit_homography_ransac(src, bad, ro);
  REQUIRE(r3.has_value());
  CHECK_FALSE(r3->inliers[4]);
  // Smoothing a constant sequence changes nothing (up to Float32).
  const std::vector<std::optional<tr::Mat3>> seq{*fit, *fit, std::nullopt, *fit};
  const auto sm = tr::smooth_homography_sequence(seq, 1);
  REQUIRE(sm.size() == 4);
  CHECK_FALSE(sm[2].has_value());
  for (std::size_t k = 0; k < 9; ++k) CHECK(std::abs((*sm[0])[k] - (*fit)[k]) < 1e-5F);
}

TEST_CASE("stabilize: known integer jitter is measured and cancelled", "[jobs][stabilize]") {
  const std::vector<Blob> bs = blobs();
  struct J {
    int x, y;
  };
  const std::vector<J> jitter{{0, 0}, {2, -1}, {-1, 2}, {1, 1}, {-2, 0}, {0, -2}, {2, 2}, {-1, -1}, {1, -2}, {0, 1}};
  std::vector<st::FloatLuma> frames;
  for (const J& j : jitter) {
    st::FloatLuma f;
    f.w = kW;
    f.h = kH;
    f.data.resize(static_cast<std::size_t>(kW) * kH);
    for (int y = 0; y < kH; ++y) {
      for (int x = 0; x < kW; ++x) {
        f.data[static_cast<std::size_t>(y) * kW + static_cast<std::size_t>(x)] =
            static_cast<float>(255 * field(bs, x - j.x, y - j.y));
      }
    }
    frames.push_back(st::downsample_luma(f, st::flow_factor(kW, kH)));
  }
  REQUIRE(st::flow_factor(kW, kH) == 1);
  std::vector<std::optional<st::Sim>> pairs;
  for (std::size_t i = 0; i + 1 < frames.size(); ++i) {
    const auto m = st::pair_motion(frames[i], frames[i + 1], 1, 1);
    REQUIRE(m.has_value());
    CHECK(std::abs(m->a - 1) < 0.01);
    CHECK(std::abs(m->b) < 0.01);
    CHECK(std::abs(m->tx - (jitter[i + 1].x - jitter[i].x)) < 0.35);
    CHECK(std::abs(m->ty - (jitter[i + 1].y - jitter[i].y)) < 0.35);
    pairs.push_back(m);
  }
  // A very long smoothing window: the smooth camera is (nearly) still, so the
  // corrected position of one scene point is the same on every frame.
  const std::vector<st::Sim> corr = st::stabilizing_corrections(pairs, 1000);
  REQUIRE(corr.size() == jitter.size());
  const st::XY q0 = st::apply_sim(corr[0], 80 + jitter[0].x, 60 + jitter[0].y);
  double worst = 0;
  for (std::size_t i = 0; i < jitter.size(); ++i) {
    const st::XY q = st::apply_sim(corr[i], 80 + jitter[i].x, 60 + jitter[i].y);
    worst = std::max({worst, std::abs(q.x - q0.x), std::abs(q.y - q0.y)});
  }
  CHECK(worst < 0.6);  // the input moved the point by up to 4 px

  // No motion at all: identity corrections.
  const std::vector<std::optional<st::Sim>> still(5, st::Sim{});
  for (const st::Sim& s : st::stabilizing_corrections(still, 15)) {
    CHECK(std::abs(s.a - 1) < 1e-12);
    CHECK(std::abs(s.b) < 1e-12);
    CHECK(std::abs(s.tx) < 1e-12);
    CHECK(std::abs(s.ty) < 1e-12);
  }
  // A failed pair (nullopt) counts as no motion.
  const std::vector<std::optional<st::Sim>> gap{std::nullopt};
  const std::vector<st::Sim> g = st::stabilizing_corrections(gap, 1);
  REQUIRE(g.size() == 2);
  CHECK(std::abs(g[1].tx) < 1e-12);
}

TEST_CASE("stabilize: similarity algebra", "[jobs][stabilize]") {
  const st::Sim s = st::sim_from(0.3, 1.2, 5, -7);
  const st::Sim id = st::compose_sim(s, st::invert_sim(s));
  CHECK(std::abs(id.a - 1) < 1e-12);
  CHECK(std::abs(id.b) < 1e-12);
  CHECK(std::abs(id.tx) < 1e-12);
  CHECK(std::abs(id.ty) < 1e-12);
  CHECK(std::abs(st::sim_rotation(s) - 0.3) < 1e-12);
  CHECK(std::abs(st::sim_scale(s) - 1.2) < 1e-12);
  // fitSimilarity recovers a pure similarity through a trimmed outlier.
  std::vector<st::MotionSamplePoint> pts;
  for (int y = 0; y < 5; ++y) {
    for (int x = 0; x < 5; ++x) {
      const double px = x * 20.0;
      const double py = y * 20.0;
      const st::XY q = st::apply_sim(s, px, py);
      pts.push_back(st::MotionSamplePoint{px, py, q.x - px, q.y - py});
    }
  }
  pts[7].dx += 30;
  const auto fit = st::fit_similarity(pts);
  REQUIRE(fit.has_value());
  CHECK(std::abs(fit->a - s.a) < 1e-9);
  CHECK(std::abs(fit->b - s.b) < 1e-9);
  CHECK(std::abs(fit->tx - s.tx) < 1e-6);
  CHECK(std::abs(fit->ty - s.ty) < 1e-6);
}
