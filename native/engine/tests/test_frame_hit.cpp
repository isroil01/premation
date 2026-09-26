// hitTest over a built frame (scene/frame_hit.hpp): the drawn quads of a
// RenderFrameScene, topmost first — rotated, projective (corner pin / 3D card)
// and edge-on quads, meshes by their bounds, mattes and adjustments never.
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <numbers>
#include <string>
#include <vector>

#include "frame_hit.hpp"

namespace sc = premation::scene;
namespace api = premation::api;

namespace {

/// The unit square → a w × h box at (x, y), rotated `deg` about its top-left
/// (column-major Mat3, as frame_build writes it).
api::Renderable quad(std::string id, double x, double y, double w, double h, double deg = 0) {
  const double r = deg * std::numbers::pi / 180;
  const double c = std::cos(r);
  const double s = std::sin(r);
  api::Renderable q;
  q.id = std::move(id);
  q.model_matrix = {w * c, w * s, 0, -h * s, h * c, 0, x, y, 1};
  q.bounds = api::Rect{x - h, y - h, w + 2 * h, w + 2 * h};  // loose: the quad test decides
  return q;
}

api::RenderFrameScene scene_of(std::vector<api::Renderable> rs) {
  api::RenderFrameScene s;
  s.width = 1920;
  s.height = 1080;
  s.renderables = std::move(rs);
  return s;
}

}  // namespace

TEST_CASE("frame hit: topmost first, the quad not its bounding box", "[scene][hit]") {
  const auto s = scene_of({quad("back", 0, 0, 400, 400), quad("front", 100, 100, 100, 100)});
  CHECK(sc::hit_renderables(s, 150, 150) == std::vector<std::string>{"front", "back"});
  CHECK(sc::hit_renderables(s, 50, 50) == std::vector<std::string>{"back"});
  CHECK(sc::hit_renderables(s, 500, 500).empty());
  CHECK(sc::hit_renderables(s, 400, 400) == std::vector<std::string>{"back"});  // edges are inside

  // A 45° rotated square: its AABB corner is outside the quad.
  const auto r = scene_of({quad("rot", 500, 100, 200, 200, 45)});
  CHECK(sc::hit_renderables(r, 500, 250) == std::vector<std::string>{"rot"});
  CHECK(sc::hit_renderables(r, 620, 120).empty());
}

TEST_CASE("frame hit: projective quads, edge-on planes, meshes, mattes and adjustments", "[scene][hit]") {
  // A homography (a corner pin, a 3D card): the unit square onto the
  // trapezoid (0,0) (100,0) (80,50) (20,50).
  api::Renderable pin;
  pin.id = "pin";
  // Heckbert's square → quad: (0,0)→p0, (1,0)→p1, (1,1)→p2, (0,1)→p3.
  {
    const double x0 = 0, y0 = 0, x1 = 100, y1 = 0, x2 = 80, y2 = 50, x3 = 20, y3 = 50;
    const double sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
    const double dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const double den = dx1 * dy2 - dx2 * dy1;
    const double g = (sx * dy2 - dx2 * sy) / den;
    const double h = (dx1 * sy - sx * dy1) / den;
    const double a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
    const double d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
    pin.model_matrix = {a, d, g, b, e, h, c, f, 1};
    pin.bounds = api::Rect{0, 0, 100, 50};
  }
  CHECK(sc::renderable_contains(pin, 50, 25));
  CHECK(sc::renderable_contains(pin, 50, 49));
  CHECK_FALSE(sc::renderable_contains(pin, 5, 45));   // inside the bounds, outside the trapezoid
  CHECK_FALSE(sc::renderable_contains(pin, 95, 45));

  api::Renderable edge = quad("edge", 100, 100, 200, 0);  // no area
  CHECK_FALSE(sc::renderable_contains(edge, 150, 100));

  api::Renderable mesh = quad("mesh", 0, 0, 10, 10);
  mesh.bounds = api::Rect{0, 0, 300, 300};
  mesh.deformed_mesh = api::RenderDeformedMesh{};
  CHECK(sc::renderable_contains(mesh, 200, 200));  // meshes: their bounds

  api::Renderable matte = quad("matte", 0, 0, 500, 500);
  matte.matte_source = true;
  api::Renderable adj = quad("adj", 0, 0, 500, 500);
  adj.adjustment = api::RenderAdjustment{};
  CHECK(sc::hit_renderables(scene_of({matte, adj}), 10, 10).empty());
}
