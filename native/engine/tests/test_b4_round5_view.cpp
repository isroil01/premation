// B4 round 5, slice B (ENGINE_API.md §15.14): the VIEW half of the overlay
// geometry push — setOverlayGeometry `groups` (per-overlay kinds) and `views`
// (the resolved view camera per view mode, FrameGeometry.views), and the
// `scene3d` kind (a camera's / light's / 3D layer's reference-geometry inputs).
// The TypeScript twin pins the same cases in
// src/core/engine/__tests__/overlayScene3d.test.ts.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cmath>
#include <map>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include "core/overlay_geometry.hpp"
#include "core/values.hpp"
#include "session_harness.hpp"
#include "transform.hpp"

using namespace premation;
using namespace premation::test;
using Catch::Approx;

namespace {

constexpr api::Time kSec = 705'600'000;

api::LayerId make_layer(Harness& h, api::LayerKind kind) {
  api::CreateLayer c;
  c.comp = "comp_root";
  c.kind = kind;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_layer(r);
}

void set_value(Harness& h, const api::LayerId& layer, const std::string& path, api::Value v) {
  api::SetProperty sp;
  sp.prop = {layer, path};
  sp.value = std::move(v);
  REQUIRE(is_ok(h.run(cmd(sp))));
}

struct Frame {
  std::map<std::string, api::OverlayView> views;
  std::map<std::string, api::OverlayLayerGeometry> layers;
  std::size_t messages = 0;
};

/// Subscribe viewport 1, render one frame at `t`, and collect its geometry (the records merged per layer).
Frame frame_with(Harness& h, const api::SetOverlayGeometry& sub, api::Time t) {
  api::SetViewport v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  REQUIRE(is_ok(h.run(cmd(sub))));
  h.release_all();
  h.frameMsgs.clear();
  REQUIRE(is_ok(h.run(cmd(api::Seek{t}))));
  h.advance(std::chrono::milliseconds(40));
  Frame f;
  bool ready = false;
  for (const auto& m : h.frameMsgs) {
    if (std::holds_alternative<api::FrameReady>(m.v)) ready = true;
    const auto* g = std::get_if<api::FrameGeometry>(&m.v);
    if (g == nullptr || ready) continue;
    ++f.messages;
    for (const auto& view : g->views) f.views[view.mode] = view;
    for (const auto& r : g->layers) {
      auto& cur = f.layers[r.layer];
      cur.layer = r.layer;
      cur.matrix.insert(cur.matrix.end(), r.matrix.begin(), r.matrix.end());
      cur.box.insert(cur.box.end(), r.box.begin(), r.box.end());
      cur.path.insert(cur.path.end(), r.path.begin(), r.path.end());
      if (r.scene) cur.scene = r.scene;
    }
  }
  REQUIRE(ready);
  return f;
}

}  // namespace

TEST_CASE("setOverlayGeometry views: each view mode carries its resolved view camera", "[b4r5][view]") {
  Harness h;
  (void)h.hello();
  const auto cam1 = make_layer(h, api::LayerKind::camera);
  const auto cam2 = make_layer(h, api::LayerKind::camera);
  set_value(h, cam1, "transform/position", doc::v_vec3(100, 200, -1500));
  const double focal = motion::xf::default_camera(1920, 1080).focal_length;

  api::SetOverlayGeometry sub;
  sub.viewport = 1;
  sub.views = {"active", "camera:" + cam1, "top", "camera:nope"};
  const Frame f = frame_with(h, sub, 0);
  REQUIRE(f.views.size() == 4);

  // The named camera, looked through.
  const auto& named = f.views.at("camera:" + cam1);
  CHECK(named.camera == cam1);
  CHECK(named.live_camera == cam1);
  REQUIRE(named.lens.size() == 9);
  CHECK(named.lens[0] == Approx(100));
  CHECK(named.lens[1] == Approx(200));
  CHECK(named.lens[2] == Approx(-1500));
  CHECK(named.lens[3] == Approx(focal));
  CHECK(named.lens[4] == Approx(960));  // the principal point stays on the comp centre
  CHECK(named.comp_width == Approx(1920));

  // Active Camera: the topmost enabled camera (the one created last); an axis view reports it too;
  // a stale camera view falls back to it.
  const auto& active = f.views.at("active");
  CHECK(active.camera == cam2);
  CHECK(active.lens[0] == Approx(960));
  CHECK(active.lens[2] == Approx(-focal));
  CHECK(f.views.at("top").camera == cam2);
  CHECK(f.views.at("camera:nope").camera == cam2);

  // No camera at all: the default camera, no layer.
  api::DeleteLayers del;
  del.layers = {cam1, cam2};
  REQUIRE(is_ok(h.run(cmd(del))));
  const Frame none = frame_with(h, sub, 0);
  const auto& def = none.views.at("active");
  CHECK(def.camera.empty());
  CHECK(def.live_camera.empty());
  CHECK(def.lens[2] == Approx(-focal));
}

TEST_CASE("setOverlayGeometry views: the camera tools' camera must be live at the frame", "[b4r5][view]") {
  Harness h;
  (void)h.hello();
  const auto cam1 = make_layer(h, api::LayerKind::camera);
  const auto cam2 = make_layer(h, api::LayerKind::camera);
  // The topmost camera starts at 2 s: before that the renderer (and the camera tools) use the one below.
  api::LayerTimingPatch patch;
  patch.layer = cam2;
  patch.in_point = 2 * kSec;
  api::SetLayerTiming timing;
  timing.items = {patch};
  REQUIRE(is_ok(h.run(cmd(timing))));
  api::SetOverlayGeometry sub;
  sub.viewport = 1;
  sub.views = {"active"};
  const Frame early = frame_with(h, sub, 0);
  CHECK(early.views.at("active").camera == cam2);       // the chrome's rule: no in/out test
  CHECK(early.views.at("active").live_camera == cam1);  // the renderer's rule
  const Frame late = frame_with(h, sub, 3 * kSec);
  CHECK(late.views.at("active").live_camera == cam2);
}

TEST_CASE("setOverlayGeometry scene3d: cameras, lights and 3D layers; groups keep each overlay's kinds", "[b4r5][view]") {
  Harness h;
  (void)h.hello();
  const auto cam = make_layer(h, api::LayerKind::camera);
  const auto light = make_layer(h, api::LayerKind::light);
  const auto flat = make_layer(h, api::LayerKind::solid);
  const auto deep = make_layer(h, api::LayerKind::solid);
  api::SetLayerSwitches sw;
  sw.layers = {deep};
  sw.patch.three_d = true;
  REQUIRE(is_ok(h.run(cmd(sw))));

  api::SetOverlayGeometry sub;
  sub.viewport = 1;
  api::OverlayRequest scene;
  scene.layers = {cam, light, flat, deep};
  scene.kinds = {api::OverlayKind::scene3d};
  api::OverlayRequest sel;
  sel.layers = {deep};
  sel.kinds = {api::OverlayKind::transform};
  sub.groups = {scene, sel};
  const Frame f = frame_with(h, sub, 0);
  const double focal = motion::xf::default_camera(1920, 1080).focal_length;

  // The camera: its resolved lens, no POI (a one-node camera), its focus distance (the focal length), no DOF.
  const auto& c = f.layers.at(cam);
  REQUIRE(c.scene.has_value());
  CHECK(c.scene->role == api::Scene3DRole::camera);
  REQUIRE(c.scene->lens.size() == 9);
  CHECK(c.scene->lens[2] == Approx(-focal));
  CHECK(c.scene->poi.empty());
  CHECK(c.scene->focus_distance == Approx(focal));
  CHECK(c.scene->dof.empty());
  // A top-level layer's parent is its composition root: the identity.
  CHECK(c.scene->parent == std::vector<double>{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1});
  CHECK(c.matrix.empty());  // the scene group asked for scene3d only

  // The light: a point light at its stored depth, the radius the insert gave it.
  const auto& l = f.layers.at(light);
  REQUIRE(l.scene.has_value());
  CHECK(l.scene->role == api::Scene3DRole::light);
  CHECK(l.scene->light_type == "point");
  REQUIRE(l.scene->position.size() == 3);
  CHECK(l.scene->position[2] == Approx(-444));
  REQUIRE(l.scene->light.size() == 4);
  CHECK(l.scene->light[0] == Approx(864));

  // A 2D layer has no scene record; a 3D one has its sampled local transform — and the selection group's
  // transform (a layer named by two groups gets both kinds).
  CHECK_FALSE(f.layers.at(flat).scene.has_value());
  const auto& d = f.layers.at(deep);
  REQUIRE(d.scene.has_value());
  CHECK(d.scene->role == api::Scene3DRole::layer);
  REQUIRE(d.scene->local.size() == 12);
  CHECK(d.scene->local[6] == Approx(1));  // scaleX
  CHECK(d.scene->local[8] == Approx(1));  // scaleZ
  CHECK(d.scene->local[9] == Approx(0));  // orientationX..Z
  CHECK(d.scene->local[11] == Approx(0));
  CHECK(d.scene->extrusion == Approx(0));
  CHECK(d.matrix.size() == 16);
}

TEST_CASE("pack_frame_geometry: views ride the first message under the payload cap", "[b4r5][view]") {
  std::vector<api::OverlayLayerGeometry> layers;
  for (int i = 0; i < 40; ++i) {
    api::OverlayLayerGeometry g;
    g.layer = "layer_" + std::to_string(i);
    g.matrix.assign(16, 1.0);
    api::OverlayScene3D s;
    s.role = api::Scene3DRole::layer;
    s.local.assign(9, 2.0);
    s.parent.assign(16, 3.0);
    g.scene = s;
    layers.push_back(std::move(g));
  }
  std::vector<api::OverlayView> views(3);
  for (std::size_t i = 0; i < views.size(); ++i) {
    views[i].mode = i == 0 ? "active" : "custom" + std::to_string(i);
    views[i].camera = "cam";
    views[i].lens.assign(9, 1.0);
  }
  const auto msgs = doc::pack_frame_geometry(1, 2, 3, 4, 5, layers, views);
  REQUIRE(msgs.size() > 1);
  CHECK(msgs.front().views.size() == 3);
  std::size_t scenes = 0;
  for (const auto& m : msgs) {
    if (&m != &msgs.front()) CHECK(m.views.empty());
    std::vector<std::uint8_t> bytes;
    frames::encode(frames::Message{.v = m}, bytes);
    CHECK(bytes.size() <= frames::kMaxPayload);
    for (const auto& r : m.layers) scenes += r.scene ? 1 : 0;
  }
  CHECK(scenes == 40);
}
