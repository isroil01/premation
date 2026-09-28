// B4 round 5 (ENGINE_API.md §15.14): the rig in the overlay geometry push and
// getRigPose — scene/rig_overlay.cpp over rig_mesh.cpp's RigModel, injected
// into the Session as its RigQueries. The TypeScript twin
// (src/core/engine/__tests__/rigOverlay.test.ts) pins the same document with
// the same numbers.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cmath>
#include <optional>
#include <string>
#include <tuple>
#include <type_traits>
#include <variant>
#include <vector>

#include "core/overlay_geometry.hpp"
#include "core/overlay_rig_pack.hpp"
#include "rig_overlay.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;
using Catch::Approx;

namespace {

constexpr api::Time kSec = 705'600'000;

constexpr const char* kPuppet = R"({"pins":[{"id":"pin_1","x":-30,"y":0},{"id":"pin_2","x":30,"y":0}],"meshDensity":6})";
constexpr const char* kSkeleton =
    R"({"bones":[{"id":"b1","parentId":null,"length":40,"x":-40,"y":0,"rotation":0},)"
    R"({"id":"b2","parentId":"b1","length":40,"x":40,"y":0,"rotation":0}],)"
    R"("ikTargets":[{"boneId":"b2","x":20,"y":30,"chainLength":2}]})";

// The TypeScript engine's answers for this document (rigOverlay.test.ts).
constexpr std::size_t kRigVertices = 49;
constexpr std::size_t kRigTriangleIndices = 216;
constexpr std::size_t kRigEdgeIndices = 168;
constexpr double kB1Posed = -0.11257736117490785;
constexpr double kB2Posed = 1.1524499403514277;
constexpr double kPin2X = 16.54445209026038;
constexpr double kPin2Y = 29.034143940688796;
constexpr double kKey0X = 18.54620209937986;
constexpr double kKey0OutX = 17.208550881897814;

api::LayerId make_shape(Harness& h, const char* name) {
  api::CreateLayer c;
  c.comp = "comp_root";
  c.kind = api::LayerKind::shape;
  c.name = name;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_layer(r);
}

void set_json(Harness& h, const api::LayerId& layer, const char* path, const char* json) {
  api::SetProperty s;
  s.prop = {layer, path};
  s.value = doc::v_json(json);
  REQUIRE(is_ok(h.run(cmd(s))));
}

api::LayerId rigged_layer(Harness& h) {
  const auto layer = make_shape(h, "R");
  set_json(h, layer, "layer/puppet", kPuppet);
  set_json(h, layer, "layer/skeleton", kSkeleton);
  api::AddKeyframes a;
  for (const auto& [t, x, y] : std::vector<std::tuple<api::Time, double, double>>{{0, 30, 0}, {kSec, 50, 20}}) {
    api::KeyframeInsert k;
    k.prop = {layer, "puppet/pins/pin_2/position"};
    k.time = t;
    k.value = vec2(x, y);
    a.keys.push_back(std::move(k));
  }
  REQUIRE(is_ok(h.run(cmd(a))));
  return layer;
}

/// Subscribe viewport 1 to `layer`'s rig and collect the next frame's merged `rig` (nullopt = none sent).
std::optional<api::OverlayRig> pushed_rig(Harness& h, const api::LayerId& layer, const api::OverlayRigOptions& opts,
                                          api::Time at, std::vector<api::OverlayKind> kinds = {api::OverlayKind::rig}) {
  api::SetViewport v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  api::SetOverlayGeometry sub;
  sub.viewport = 1;
  sub.layers = {layer};
  sub.kinds = std::move(kinds);
  sub.rig = opts;
  REQUIRE(is_ok(h.run(cmd(sub))));
  h.release_all();
  h.frameMsgs.clear();
  REQUIRE(is_ok(h.run(cmd(api::Seek{at}))));
  h.advance(std::chrono::milliseconds(40));
  std::optional<api::OverlayRig> out;
  bool last = false;
  for (const auto& m : h.frameMsgs) {
    const auto* g = std::get_if<api::FrameGeometry>(&m.v);
    if (g == nullptr) continue;
    // Every part fits the frame channel's payload cap.
    std::vector<std::uint8_t> bytes;
    frames::encode(frames::Message{.v = *g}, bytes);
    CHECK(bytes.size() <= frames::kMaxPayload);
    last = last || g->last;
    for (const auto& r : g->layers) {
      REQUIRE(r.layer == layer);
      if (!r.rig) continue;
      if (!out) out = api::OverlayRig{};
      const auto cat = [](auto& to, const auto& from) { to.insert(to.end(), from.begin(), from.end()); };
      cat(out->pins, r.rig->pins);
      cat(out->bones, r.rig->bones);
      cat(out->ik, r.rig->ik);
      cat(out->vertices, r.rig->vertices);
      cat(out->rest, r.rig->rest);
      cat(out->triangles, r.rig->triangles);
      cat(out->edges, r.rig->edges);
      cat(out->weights, r.rig->weights);
      cat(out->pin_path, r.rig->pin_path);
      cat(out->pin_keys, r.rig->pin_keys);
    }
  }
  CHECK(last);
  return out;
}

api::RigPose rig_pose(Harness& h, api::GetRigPose q) {
  const auto r = h.ask(qry(std::move(q)));
  REQUIRE(is_ok(r));
  const auto& res = std::get<api::QueryResult>(r.outcome.v).v;
  REQUIRE(std::holds_alternative<api::RigPose>(res));
  return std::get<api::RigPose>(res);
}

}  // namespace

TEST_CASE("overlay rig: live pins, solved bones, IK goals, the mesh, focus weights and pin path", "[b4r5][rig]") {
  Harness h;
  (void)h.hello();
  scene::DocRigQueries rig;
  h.session.set_rig_queries(&rig);
  const auto layer = rigged_layer(h);
  const auto r = pushed_rig(h, layer, api::OverlayRigOptions{"pin_2", "b2", false}, kSec / 2);
  REQUIRE(r.has_value());
  REQUIRE(r->pins.size() == 2);
  CHECK(r->pins[0].id == "pin_1");
  CHECK(r->pins[1].kind == "advanced");
  CHECK(r->pins[1].cx == Approx(40));  // halfway along its keys, before the skeleton
  CHECK(r->pins[1].cy == Approx(10));
  REQUIRE(r->bones.size() == 2);
  CHECK(r->bones[0].rotation == 0);
  CHECK(r->bones[0].world.size() == 6);
  REQUIRE(r->ik.size() == 1);
  CHECK(r->ik[0].bone == "b2");
  CHECK(r->ik[0].enabled);
  CHECK(r->ik[0].mode == "ik");
  CHECK(r->ik[0].pole.empty());
  CHECK(r->ik[0].chain_length == 2);
  CHECK(r->vertices.size() == r->rest.size());
  CHECK(r->weights.size() == r->rest.size() / 2);
  CHECK(r->pin_path.size() == 2 * 25);
  REQUIRE(r->pin_keys.size() == 2 * 9);
  CHECK(r->pin_keys[1] == Approx(30));
  CHECK(r->pin_keys[10] == Approx(50));
  CHECK(std::isnan(r->pin_keys[5]));  // the first key has no in-handle
  // The TypeScript engine's numbers.
  CHECK(r->rest.size() / 2 == kRigVertices);
  CHECK(r->triangles.size() == kRigTriangleIndices);
  CHECK(r->edges.size() == kRigEdgeIndices);
  CHECK(r->bones[0].posed_rotation == Approx(kB1Posed).margin(1e-6));
  CHECK(r->bones[1].posed_rotation == Approx(kB2Posed).margin(1e-6));
  CHECK(r->pins[1].x == Approx(kPin2X).margin(1e-4));
  CHECK(r->pins[1].y == Approx(kPin2Y).margin(1e-4));
  CHECK(r->pin_keys[3] == Approx(kKey0X).margin(1e-4));
  CHECK(r->pin_keys[7] == Approx(kKey0OutX).margin(1e-4));

  // No focus: no weights, no pin path. No rig kind: no rig record.
  const auto plain = pushed_rig(h, layer, api::OverlayRigOptions{}, kSec / 2);
  REQUIRE(plain.has_value());
  CHECK(plain->weights.empty());
  CHECK(plain->pin_path.empty());
  CHECK_FALSE(pushed_rig(h, layer, api::OverlayRigOptions{}, kSec / 2, {api::OverlayKind::transform}).has_value());
}

TEST_CASE("getRigPose: a drawn point maps back through the pose; a vertex names its bind weights", "[b4r5][rig]") {
  Harness h;
  (void)h.hello();
  const auto layer = rigged_layer(h);
  api::GetRigPose q;
  q.layer = layer;
  q.time = kSec / 2;
  q.points = {api::Vec2{kPin2X, kPin2Y}};
  q.vertex = 0;
  // No rig hook injected: the scene port is not here.
  CHECK(is_error(h.ask(qry(q)), api::ErrorCode::unsupported));
  scene::DocRigQueries rig;
  h.session.set_rig_queries(&rig);
  const auto pose = rig_pose(h, q);
  REQUIRE(pose.bones.size() == 2);
  CHECK(pose.bones[1].posed_rotation == Approx(kB2Posed).margin(1e-6));
  REQUIRE(pose.rest.size() == 1);
  CHECK(pose.rest[0].x == Approx(40).margin(0.05));  // the drawn pin unskins to its pre-skeleton point
  CHECK(pose.rest[0].y == Approx(10).margin(0.05));
  CHECK(pose.anchors.size() == 1);
  CHECK(pose.vertex_count == kRigVertices);
  double total = 0;
  for (std::size_t i = 0; i < pose.weights.size(); ++i) {
    total += pose.weights[i].weight;
    if (i > 0) CHECK(pose.weights[i - 1].weight >= pose.weights[i].weight);
  }
  CHECK(total > 0);
  CHECK(total <= 1 + 1e-9);
  q.layer = "nope";
  CHECK(is_error(h.ask(qry(q)), api::ErrorCode::not_found));
}

TEST_CASE("overlay rig authoring: a layer with no rig still gets the Puppet tool's mesh", "[b4r5][rig]") {
  Harness h;
  (void)h.hello();
  scene::DocRigQueries rig;
  h.session.set_rig_queries(&rig);
  const auto bare = make_shape(h, "bare");
  CHECK_FALSE(pushed_rig(h, bare, api::OverlayRigOptions{}, 0).has_value());
  const auto r = pushed_rig(h, bare, api::OverlayRigOptions{"", "", true}, 0);
  REQUIRE(r.has_value());
  CHECK(r->pins.empty());
  CHECK(r->bones.empty());
  CHECK_FALSE(r->rest.empty());
  CHECK(r->vertices == r->rest);
  CHECK_FALSE(r->edges.empty());
}

TEST_CASE("split_overlay_rig: a large rig splits under the payload cap in whole groups and merges back", "[b4r5][rig]") {
  api::OverlayLayerGeometry g;
  g.layer = "layer_with_a_big_rig";
  g.matrix.assign(16, 1.0);
  api::OverlayRig rig;
  for (int i = 0; i < 40; ++i) {
    api::RigPinPose p;
    p.id = "pin_" + std::to_string(i);
    p.kind = "advanced";
    rig.pins.push_back(p);
    api::RigBonePose b;
    b.id = "bone_" + std::to_string(i);
    b.world.assign(6, 1.0);
    rig.bones.push_back(b);
  }
  for (int i = 0; i < 3000; ++i) {
    rig.vertices.push_back(static_cast<double>(i));
    rig.rest.push_back(-static_cast<double>(i));
  }
  for (std::uint32_t i = 0; i < 4500; ++i) rig.triangles.push_back(i % 1500);
  for (int i = 0; i < 90; ++i) rig.pin_keys.push_back(static_cast<double>(i));
  g.rig = rig;
  const auto msgs = doc::pack_frame_geometry(1, 2, 3, 4, 5, {g});
  REQUIRE(msgs.size() > 1);
  api::OverlayRig merged;
  for (const auto& m : msgs) {
    std::vector<std::uint8_t> bytes;
    frames::encode(frames::Message{.v = m}, bytes);
    CHECK(bytes.size() <= frames::kMaxPayload);
    for (const auto& r : m.layers) {
      if (!r.rig) continue;
      CHECK(r.rig->vertices.size() % 2 == 0);
      CHECK(r.rig->triangles.size() % 3 == 0);
      CHECK(r.rig->pin_keys.size() % 9 == 0);
      const auto cat = [](auto& to, const auto& from) { to.insert(to.end(), from.begin(), from.end()); };
      cat(merged.pins, r.rig->pins);
      cat(merged.bones, r.rig->bones);
      cat(merged.vertices, r.rig->vertices);
      cat(merged.rest, r.rig->rest);
      cat(merged.triangles, r.rig->triangles);
      cat(merged.pin_keys, r.rig->pin_keys);
    }
  }
  CHECK(merged.pins == rig.pins);
  CHECK(merged.bones == rig.bones);
  CHECK(merged.vertices == rig.vertices);
  CHECK(merged.rest == rig.rest);
  CHECK(merged.triangles == rig.triangles);
  CHECK(merged.pin_keys == rig.pin_keys);
  CHECK(doc::estimate_overlay_rig(rig) > frames::kMaxPayload);
}
