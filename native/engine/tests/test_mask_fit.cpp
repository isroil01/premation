// AE parity 5.4 — whole-mask tracking: the fitted transforms recover a known
// motion of the tracked points, and the mask's tangents follow the linear part.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include "mask_fit.hpp"

using Catch::Approx;
using premation::jobs::tracking::Pt;
namespace mf = premation::jobs::maskfit;

namespace {

std::vector<Pt> moved(const std::vector<Pt>& src, double a, double b, double c, double d, double tx, double ty) {
  std::vector<Pt> out;
  for (const Pt& p : src) out.push_back(Pt{a * p.x + c * p.y + tx, b * p.x + d * p.y + ty});
  return out;
}

const std::vector<Pt> kSrc{{10, 10}, {90, 15}, {80, 70}, {20, 60}, {50, 40}};

}  // namespace

TEST_CASE("mask fit: position, rotation, scale, affine recover the motion", "[jobs][maskfit]") {
  {
    const auto t = mf::fit_affine(kSrc, moved(kSrc, 1, 0, 0, 1, 7, -3), mf::Method::position);
    REQUIRE(t);
    CHECK(t->tx == Approx(7));
    CHECK(t->ty == Approx(-3));
  }
  const double ang = 0.3;
  {
    const auto dst = moved(kSrc, std::cos(ang), std::sin(ang), -std::sin(ang), std::cos(ang), 12, 5);
    const auto t = mf::fit_affine(kSrc, dst, mf::Method::positionRotation);
    REQUIRE(t);
    CHECK(t->a == Approx(std::cos(ang)).margin(1e-9));
    CHECK(t->b == Approx(std::sin(ang)).margin(1e-9));
    CHECK(t->tx == Approx(12).margin(1e-9));
    // Position & Rotation never scales, even when the points did.
    const auto scaled = moved(kSrc, 2 * std::cos(ang), 2 * std::sin(ang), -2 * std::sin(ang), 2 * std::cos(ang), 0, 0);
    const auto r = mf::fit_affine(kSrc, scaled, mf::Method::positionRotation);
    REQUIRE(r);
    CHECK(std::hypot(r->a, r->b) == Approx(1));
    const auto s = mf::fit_affine(kSrc, scaled, mf::Method::positionScaleRotation);
    REQUIRE(s);
    CHECK(std::hypot(s->a, s->b) == Approx(2));
  }
  {
    const auto dst = moved(kSrc, 1.2, 0.1, 0.3, 0.9, -4, 6);
    const auto t = mf::fit_affine(kSrc, dst, mf::Method::affine);
    REQUIRE(t);
    CHECK(t->a == Approx(1.2));
    CHECK(t->b == Approx(0.1));
    CHECK(t->c == Approx(0.3));
    CHECK(t->d == Approx(0.9));
    CHECK(t->tx == Approx(-4));
    CHECK(t->ty == Approx(6));
  }
  CHECK_FALSE(mf::fit_affine(std::vector<Pt>{{0, 0}}, std::vector<Pt>{{1, 1}}, mf::Method::positionRotation));
  CHECK_FALSE(mf::fit_affine(kSrc, kSrc, mf::Method::vertices));
}

TEST_CASE("mask fit: a path moves with its tangents (affine and perspective)", "[jobs][maskfit]") {
  premation::api::BezierPath path;
  path.vertices = {0, 0, 10, 0, 10, 10};
  path.in_tangents = {0, 0, -2, 0, 0, -2};
  path.out_tangents = {2, 0, 0, 2, 0, 0};
  path.closed = true;
  mf::Affine t;
  t.a = 0;
  t.b = 1;
  t.c = -1;
  t.d = 0;  // a quarter turn
  t.tx = 5;
  premation::api::BezierPath a = path;
  mf::transform_path(a, t);
  CHECK(a.vertices[2] == Approx(5));
  CHECK(a.vertices[3] == Approx(10));
  CHECK(a.out_tangents[0] == Approx(0));
  CHECK(a.out_tangents[1] == Approx(2));
  // The identity homography leaves the path alone.
  premation::jobs::tracking::Mat3 id{1, 0, 0, 0, 1, 0, 0, 0, 1};
  premation::api::BezierPath h = path;
  mf::transform_path(h, id);
  for (std::size_t i = 0; i < path.vertices.size(); ++i) CHECK(h.vertices[i] == Approx(path.vertices[i]));
  for (std::size_t i = 0; i < path.out_tangents.size(); ++i) CHECK(h.out_tangents[i] == Approx(path.out_tangents[i]).margin(1e-5));
}
