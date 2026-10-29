// motion_expr — AE path expressions (path.cpp): `value` on a path property,
// createPath, points / inTangents / outTangents / isClosed, pointOnPath /
// tangentOnPath / normalOnPath by arc length, mask("…").maskPath and
// content("…").path through a fake Host, at another time, and the errors.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <optional>
#include <string>

#include "expr.hpp"

namespace {

namespace ex = motion::expr;
using Catch::Approx;

/// A layer with a mask "Ring" (a 100 px square, moving right 10 px a second)
/// and a shape path (a line); another layer "B" with a mask "M" (a triangle).
struct PathHost final : ex::Host {
  std::optional<ex::PathSample> path_at(const std::u16string* layer, bool mask, const std::u16string* name, double t) override {
    if (layer != nullptr && *layer == u"B") {
      if (!mask || (name != nullptr && *name != u"M")) return std::nullopt;
      ex::PathSample s;
      s.points = {{0, 0}, {50, 100}, {100, 0}};
      return s;
    }
    if (layer != nullptr) return std::nullopt;
    if (mask) {
      if (name != nullptr && *name != u"Ring" && *name != u"1") return std::nullopt;
      const double dx = 10 * t;
      ex::PathSample s;
      s.points = {{dx, 0}, {dx + 100, 0}, {dx + 100, 100}, {dx, 100}};
      return s;
    }
    ex::PathSample s;
    s.points = {{0, 0}, {200, 0}};
    s.closed = false;
    return s;
  }
};

/// A 100 px square with corner vertices: the property's own value.
ex::PathSample square() {
  ex::PathSample s;
  s.points = {{0, 0}, {100, 0}, {100, 100}, {0, 100}};
  return s;
}

ex::PathResult run(const std::string& src, double t = 0) {
  static PathHost host;
  static const ex::PathSample own = square();
  ex::Context c;
  c.time = t;
  c.path_value = &own;
  c.host = &host;
  return ex::Expression::compile(ex::utf8_to_utf16(src)).run_path(c);
}

double num(const std::string& src, double t = 0) {
  static PathHost host;
  static const ex::PathSample own = square();
  ex::Context c;
  c.time = t;
  c.path_value = &own;
  c.host = &host;
  const ex::Result r = ex::Expression::compile(ex::utf8_to_utf16(src)).run(c);
  INFO((r.error ? ex::utf16_to_utf8(*r.error) : std::string()));
  REQUIRE(r.kind == ex::Result::Kind::kNumber);
  return r.number;
}

}  // namespace

TEST_CASE("path expressions: value, createPath and the point lists", "[expr][path]") {
  // `value` passes the path through unchanged.
  auto r = run("value");
  REQUIRE(r.result);
  CHECK(r.result->points.size() == 4);
  CHECK(r.result->closed);
  // AE's classic: move every vertex, keep the tangents.
  r = run("var p = value.points(); for (var i = 0; i < p.length; i++) p[i] = p[i] + [10, 20];\n"
          "createPath(p, value.inTangents(), value.outTangents(), value.isClosed())");
  REQUIRE(r.result);
  CHECK(r.result->points[2][0] == 110);
  CHECK(r.result->points[2][1] == 120);
  // A built path, open, with tangents.
  r = run("createPath([[0,0],[100,0]], [[0,0],[-30,0]], [[30,0],[0,0]], false)");
  REQUIRE(r.result);
  CHECK_FALSE(r.result->closed);
  CHECK(r.result->out_tangents[0][0] == 30);
  CHECK(r.result->in_tangents[1][0] == -30);
  // createPath() alone: AE's default square.
  r = run("createPath()");
  REQUIRE(r.result);
  CHECK(r.result->points.size() == 4);
  CHECK(num("value.points().length") == 4);
  CHECK(num("value.isClosed() ? 1 : 0") == 1);
  CHECK(num("value.inTangents()[0][0]") == 0);
}

TEST_CASE("pointOnPath / tangentOnPath / normalOnPath go by arc length", "[expr][path]") {
  // The square's perimeter is 400: 0.25 is the second corner, 0.125 the middle of the top edge.
  CHECK(num("value.pointOnPath(0.125)[0]") == Approx(50).margin(0.5));
  CHECK(num("value.pointOnPath(0.125)[1]") == Approx(0).margin(0.5));
  CHECK(num("value.pointOnPath(0.375)[0]") == Approx(100).margin(0.5));
  CHECK(num("value.pointOnPath(0.375)[1]") == Approx(50).margin(0.5));
  CHECK(num("value.tangentOnPath(0.125)[0]") == Approx(1).margin(1e-6));
  // Clockwise on screen: the top edge's normal points up (outward).
  CHECK(num("value.normalOnPath(0.125)[1]") == Approx(-1).margin(1e-6));
  // An open line: half way along it.
  CHECK(num("createPath([[0,0],[100,0]], [], [], false).pointOnPath(0.5)[0]") == Approx(50).margin(0.5));
  CHECK(num("value.pointOnPath()[0]") == Approx(100).margin(0.5));  // default 0.5: the opposite corner
}

TEST_CASE("mask(\"…\").maskPath and content(\"…\").path read the layer's paths, at any time", "[expr][path]") {
  CHECK(num("mask(\"Ring\").maskPath.points()[0][0]", 2) == 20);
  CHECK(num("thisLayer.mask(1).maskPath.points()[1][0]", 0) == 100);
  // At another time: the mask as it is then.
  CHECK(num("mask(\"Ring\").maskPath.points(5)[0][0]", 0) == 50);
  CHECK(num("content(\"Shape 1\").content(\"Path 1\").path.pointOnPath(0.5)[0]") == Approx(100).margin(0.5));
  CHECK(num("content(\"Shape 1\").content(\"Path 1\").path.isClosed() ? 1 : 0") == 0);
  // Another layer's mask, as a whole path.
  auto r = run("thisComp.layer(\"B\").mask(\"M\").maskPath");
  REQUIRE(r.result);
  CHECK(r.result->points.size() == 3);
}

TEST_CASE("path expressions say what is wrong", "[expr][path]") {
  auto r = run("42");
  CHECK_FALSE(r.result);
  REQUIRE(r.error);
  CHECK(ex::utf16_to_utf8(*r.error).find("must return a path") != std::string::npos);
  r = run("mask(\"Nope\").maskPath");
  REQUIRE(r.error);
  CHECK(ex::utf16_to_utf8(*r.error).find("no mask of that name") != std::string::npos);
  r = run("createPath([[0,0],[1,1]], [[0,0]])");
  REQUIRE(r.error);
  CHECK(ex::utf16_to_utf8(*r.error).find("one [x, y] per point") != std::string::npos);
  r = run("createPath(5)");
  REQUIRE(r.error);
}
