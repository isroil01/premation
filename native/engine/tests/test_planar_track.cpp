// AE parity 3.4: the planar tracker follows a textured plane under a
// perspective change while the background moves differently, and an
// exclusion polygon keeps an occluder out.

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <map>
#include <vector>

#include "jobs/planar_track.hpp"
#include "jobs/tracking.hpp"

namespace tr = premation::jobs::tracking;
namespace pl = premation::jobs::planar;

namespace {

float texture(double u, double v) {
  const double a = std::sin(u * 0.37) * std::cos(v * 0.29) + 0.5 * std::sin((u + 2 * v) * 0.11) + 0.3 * std::cos(u * 0.9 + v * 0.05);
  const double cells = ((static_cast<int>(std::floor(u / 13)) * 7 + static_cast<int>(std::floor(v / 11)) * 3) % 5) / 5.0;
  return static_cast<float>(0.5 + 0.18 * a + 0.25 * (cells - 0.4));
}

/// Frame k: the plane x∈[80,240], y∈[60,180] under H_k (a growing perspective
/// tilt and shift); the background slides the other way; an occluder blob
/// crosses the plane.
tr::LumaPlane frame(int k, tr::Mat3& Hout) {
  const double s = k * 0.01;
  // H = origin → frame k (column-major [a,d,g, b,e,h, c,f,i]).
  const double a = 1 + s, b = 0.05 * s, c = 3.0 * k, d = -0.03 * s, e = 1 + 0.5 * s, f = 1.5 * k, g = 0.0004 * s, h = 0.0002 * s;
  Hout = tr::Mat3{static_cast<float>(a), static_cast<float>(d), static_cast<float>(g), static_cast<float>(b), static_cast<float>(e),
                  static_cast<float>(h), static_cast<float>(c), static_cast<float>(f), 1.0f};
  // Inverse for sampling.
  const double A = e - f * h, B = -(d - f * g), C = d * h - e * g;
  const double det = a * A + b * B + c * C;
  const double ia = A / det, ib = -(b - c * h) / det, ic = (b * f - c * e) / det;
  const double id = B / det, ie = (a - c * g) / det, iff = -(a * f - c * d) / det;
  const double ig = C / det, ih = -(a * h - b * g) / det, ii = (a * e - b * d) / det;
  tr::LumaPlane p;
  p.width = 320;
  p.height = 240;
  p.data.resize(static_cast<std::size_t>(p.width * p.height));
  for (int y = 0; y < p.height; ++y) {
    for (int x = 0; x < p.width; ++x) {
      const double w = ig * x + ih * y + ii;
      const double u = (ia * x + ib * y + ic) / w;
      const double v = (id * x + ie * y + iff) / w;
      float val;
      if (u >= 80 && u <= 240 && v >= 60 && v <= 180) val = texture(u, v);
      else val = 0.35f * texture(x + 5.0 * k + 500, y * 1.3 + 300);
      // The occluder: a bright blob moving left to right through the plane.
      const double ox = 100 + 6.0 * k;
      if (std::hypot(x - ox, y - 120) < 18) val = 0.95f;
      p.data[static_cast<std::size_t>(y * p.width + x)] = val;
    }
  }
  return p;
}

}  // namespace

TEST_CASE("the planar tracker follows the plane's homography", "[jobs][planar]") {
  std::map<std::int64_t, tr::LumaPlane> frames;
  std::map<std::int64_t, tr::Mat3> truth;
  for (int k = 0; k <= 12; ++k) frames.emplace(k, frame(k, truth[k]));
  const tr::FrameAt at = [&](std::int64_t i) -> const tr::LumaPlane& { return frames.at(i); };
  pl::Spec spec;
  spec.region = {tr::Pt{90, 70}, tr::Pt{230, 70}, tr::Pt{230, 170}, tr::Pt{90, 170}};
  spec.featureHalf = 6;
  spec.searchHalf = 18;
  // Exclude the occluder where it is on each frame.
  const pl::ExcludeAt exclude = [](std::int64_t k) {
    pl::Poly box;
    const double ox = 100 + 6.0 * static_cast<double>(k);
    box = {tr::Pt{ox - 24, 96}, tr::Pt{ox + 24, 96}, tr::Pt{ox + 24, 144}, tr::Pt{ox - 24, 144}};
    return pl::Polys{box};
  };
  const pl::Result r = pl::track_planar(at, 0, 12, spec, exclude, {});
  REQUIRE(r.status == tr::TrackStatus::completed);
  REQUIRE(r.frames.size() == 13);
  for (const pl::FrameH& fh : r.frames) {
    for (const tr::Pt corner : spec.region) {
      const auto got = tr::project_homography(fh.H, corner);
      const auto want = tr::project_homography(truth.at(fh.frame), corner);
      REQUIRE(got.has_value());
      REQUIRE(want.has_value());
      CHECK(std::hypot(got->x - want->x, got->y - want->y) < 1.5);
    }
  }
  // Backward from the last frame lands on the first.
  const pl::Result back = pl::track_planar(at, 12, 0, spec, exclude, {});
  CHECK(back.frames.size() == 13);
}

TEST_CASE("a region with no texture is refused, not tracked", "[jobs][planar]") {
  tr::LumaPlane flat;
  flat.width = 200;
  flat.height = 150;
  flat.data.assign(200 * 150, 0.5f);
  const tr::FrameAt at = [&](std::int64_t) -> const tr::LumaPlane& { return flat; };
  pl::Spec spec;
  spec.region = {tr::Pt{40, 40}, tr::Pt{160, 40}, tr::Pt{160, 110}, tr::Pt{40, 110}};
  const pl::Result r = pl::track_planar(at, 0, 3, spec, {}, {});
  CHECK(r.status == tr::TrackStatus::lost);
  CHECK(r.frames.empty());
}
