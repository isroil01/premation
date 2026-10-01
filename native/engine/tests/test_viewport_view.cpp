// setViewport `view` / `customView` → the snapshot's camera
// (snapshot_build.hpp with_viewport_view): what buildSnapshot.ts read from the
// editor's camera3dMode / customViewCamera, now per viewport.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cmath>

#include "frame_scene.hpp"
#include "snapshot_build.hpp"

using Catch::Approx;
using premation::CustomViewParams;
using premation::ViewportConfig;
using premation::scene::SnapshotComp;
using premation::scene::with_viewport_view;

namespace {

SnapshotComp comp_1920() {
  SnapshotComp s;
  s.rootId = "comp_root";
  s.width = 1920;
  s.height = 1080;
  return s;
}

}  // namespace

TEST_CASE("with_viewport_view: absent, '' and 'active' leave the composition's camera", "[viewport][view]") {
  ViewportConfig v;
  CHECK(with_viewport_view(comp_1920(), v).camera3dMode == "active");
  v.view = "";
  CHECK(with_viewport_view(comp_1920(), v).camera3dMode == "active");
  v.view = "active";
  const SnapshotComp s = with_viewport_view(comp_1920(), v);
  CHECK(s.camera3dMode == "active");
  CHECK_FALSE(s.customViewCamera.has_value());
}

TEST_CASE("with_viewport_view: an axis view or a camera view is the snapshot's camera3dMode", "[viewport][view]") {
  ViewportConfig v;
  v.view = "top";
  CHECK(with_viewport_view(comp_1920(), v).camera3dMode == "top");
  v.view = "camera:cam_1";
  const SnapshotComp s = with_viewport_view(comp_1920(), v);
  CHECK(s.camera3dMode == "camera:cam_1");
  CHECK_FALSE(s.customViewCamera.has_value());
}

TEST_CASE("with_viewport_view: a custom view replaces the scene camera with its orbit about the POI", "[viewport][view]") {
  ViewportConfig v;
  v.view = "custom";

  SECTION("without an orbit there is nothing to replace the scene camera with") {
    const SnapshotComp s = with_viewport_view(comp_1920(), v);
    CHECK(s.camera3dMode == "active");
    CHECK_FALSE(s.customViewCamera.has_value());
  }

  SECTION("the defaults: the comp centre on z = 0, 1.2 × the default focal length, straight on") {
    v.customView = CustomViewParams{};
    const SnapshotComp s = with_viewport_view(comp_1920(), v);
    CHECK(s.camera3dMode == "active");
    REQUIRE(s.customViewCamera.has_value());
    const motion::xf::Camera def = motion::xf::default_camera(1920, 1080);
    CHECK(s.customViewCamera->focal_length == Approx(def.focal_length));
    CHECK(s.customViewCamera->principal.x == Approx(def.principal.x));
    CHECK(s.customViewCamera->principal.y == Approx(def.principal.y));
    CHECK(s.customViewCamera->position.x == Approx(960));
    CHECK(s.customViewCamera->position.y == Approx(540));
    CHECK(s.customViewCamera->position.z == Approx(-def.focal_length * 1.2));
    CHECK_FALSE(s.customViewCamera->orientation.has_value());
  }

  SECTION("yaw = +90 puts the eye at −x of the POI (Left) and looks back at it") {
    v.customView = CustomViewParams{.yaw = 90, .pitch = 0, .distance = 500, .poi = std::array<double, 3>{100, 200, 0}};
    const SnapshotComp s = with_viewport_view(comp_1920(), v);
    REQUIRE(s.customViewCamera.has_value());
    CHECK(s.customViewCamera->position.x == Approx(100 - 500).margin(1e-6));
    CHECK(s.customViewCamera->position.y == Approx(200).margin(1e-6));
    CHECK(s.customViewCamera->position.z == Approx(0).margin(1e-6));
    REQUIRE(s.customViewCamera->orientation.has_value());
    CHECK(std::abs(s.customViewCamera->orientation->yaw) == Approx(90).margin(1e-6));
    CHECK(s.customViewCamera->orientation->pitch == Approx(0).margin(1e-6));
  }
}
