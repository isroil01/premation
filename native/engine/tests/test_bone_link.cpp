// Character rig, Tier 1: part layers that follow a bone of their character
// (core/bone_link.hpp), bindToBone / createCharacter (core/handlers_character.cpp),
// and the IK limb settings stretch / softness (core/skeleton_pose.cpp).

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <numbers>
#include <string>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

#include "core/skeleton_pose.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;
using Catch::Approx;

namespace {

/// The query's typed answer.
template <class T>
T query(Harness& h, api::Query q) {
  const auto r = h.ask(std::move(q));
  REQUIRE(is_ok(r));
  return std::visit(
      [](const auto& x) -> T {
        if constexpr (std::is_same_v<std::decay_t<decltype(x)>, T>) {
          return x;
        } else {
          FAIL("unexpected query result type");
          return T{};
        }
      },
      std::get<api::QueryResult>(r.outcome.v).v);
}

api::LayerId make_rect(Harness& h, const char* name, double x, double y) {
  api::CreateLayer c;
  c.comp = "comp_root";
  c.kind = api::LayerKind::shape;
  c.name = name;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  const api::LayerId id = result_layer(r);
  api::SetProperty s;
  s.prop = {id, "transform/position"};
  s.value = vec2(x, y);
  REQUIRE(is_ok(h.run(cmd(s))));
  return id;
}

void set_json(Harness& h, const api::LayerId& layer, const char* path, const std::string& json) {
  api::SetProperty s;
  s.prop = {layer, path};
  s.value = doc::v_json(json);
  REQUIRE(is_ok(h.run(cmd(s))));
}

std::pair<double, double> world_xy(Harness& h, const api::LayerId& id) {
  api::GetLayerTransforms q;
  q.layers = {id};
  q.time = 0;
  const auto list = query<api::LayerTransformList>(h, qry(q));
  REQUIRE(list.transforms.size() == 1);
  return {list.transforms[0].matrix[12], list.transforms[0].matrix[13]};
}

api::LayerInfo info_of(Harness& h, const api::LayerId& id) {
  api::GetLayers q;
  q.layers = {id};
  const auto d = query<api::LayerDetails>(h, qry(q));
  REQUIRE(d.layers.size() == 1);
  return d.layers[0];
}

api::LayerId group_of(Harness& h, const std::vector<api::LayerId>& layers) {
  api::GroupLayers g;
  g.layers = layers;
  g.name = "Pip";
  const auto r = h.run(cmd(g));
  REQUIRE(is_ok(r));
  return result_layer(r);
}

/// One bone at the group's origin pointing right, bind pose = rotation 0; `rotation` is the live pose.
std::string one_bone(double rotation) {
  return R"({"bones":[{"id":"b","parentId":null,"length":50,"x":0,"y":0,"rotation":)" + std::to_string(rotation) +
         R"(}],"bindPose":[{"id":"b","x":0,"y":0,"rotation":0}]})";
}

}  // namespace

TEST_CASE("bone link: a bound part follows its bone, binding never moves it", "[character]") {
  Harness h;
  (void)h.hello();
  const auto part = make_rect(h, "Arm", 300, 200);
  const auto group = group_of(h, {part});
  set_json(h, group, "layer/skeleton", one_bone(0));
  CHECK(info_of(h, group).character == true);

  const auto before = world_xy(h, part);
  api::BindToBone b;
  b.layers = {part};
  b.character = group;
  b.bone = "b";
  REQUIRE(is_ok(h.run(cmd(b))));
  CHECK(info_of(h, part).parent_bone == std::optional<std::string>("b"));
  CHECK(world_xy(h, part).first == Approx(before.first));
  CHECK(world_xy(h, part).second == Approx(before.second));

  // Turn the bone 90°: the part swings about the bone's root (the group's origin).
  const auto g = world_xy(h, group);
  set_json(h, group, "layer/skeleton", one_bone(std::numbers::pi / 2));
  const double rx = before.first - g.first;
  const double ry = before.second - g.second;
  CHECK(world_xy(h, part).first == Approx(g.first - ry));
  CHECK(world_xy(h, part).second == Approx(g.second + rx));

  // Detach keeps the part where it stands (now in the group's space, no bone).
  const auto turned = world_xy(h, part);
  api::BindToBone off;
  off.layers = {part};
  off.character = group;
  REQUIRE(is_ok(h.run(cmd(off))));
  CHECK_FALSE(info_of(h, part).parent_bone.has_value());
  CHECK(world_xy(h, part).first == Approx(turned.first));
  CHECK(world_xy(h, part).second == Approx(turned.second));

  // Undo restores the binding.
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  CHECK(info_of(h, part).parent_bone == std::optional<std::string>("b"));
  CHECK(world_xy(h, part).first == Approx(turned.first));
}

TEST_CASE("bone link: bindToBone refuses what is not a character or a bone", "[character]") {
  Harness h;
  (void)h.hello();
  const auto part = make_rect(h, "Arm", 0, 0);
  const auto other = make_rect(h, "Other", 50, 0);
  const auto group = group_of(h, {other});
  api::BindToBone b;
  b.layers = {part};
  b.character = group;
  b.bone = "b";
  CHECK_FALSE(is_ok(h.run(cmd(b))));  // a group with no skeleton
  set_json(h, group, "layer/skeleton", one_bone(0));
  b.bone = "nope";
  CHECK_FALSE(is_ok(h.run(cmd(b))));
  b.bone = "b";
  b.layers = {group};
  CHECK_FALSE(is_ok(h.run(cmd(b))));  // the character itself
}

TEST_CASE("bone link: deleting the bone unbinds its parts where they stand", "[character]") {
  Harness h;
  (void)h.hello();
  const auto part = make_rect(h, "Arm", 120, 80);
  const auto group = group_of(h, {part});
  set_json(h, group, "layer/skeleton", one_bone(0));
  api::BindToBone b;
  b.layers = {part};
  b.character = group;
  b.bone = "b";
  REQUIRE(is_ok(h.run(cmd(b))));
  set_json(h, group, "layer/skeleton", one_bone(std::numbers::pi / 3));
  const auto turned = world_xy(h, part);

  api::RemovePropertyGroups r;
  r.groups = {api::PropRef{group, "skeleton/bones/b"}};
  REQUIRE(is_ok(h.run(cmd(r))));
  CHECK_FALSE(info_of(h, part).parent_bone.has_value());
  CHECK(world_xy(h, part).first == Approx(turned.first).margin(1e-6));
  CHECK(world_xy(h, part).second == Approx(turned.second).margin(1e-6));
}

TEST_CASE("bone link: setParent out of the character ends the binding where the part stands", "[character]") {
  Harness h;
  (void)h.hello();
  const auto part = make_rect(h, "Arm", 120, 80);
  const auto group = group_of(h, {part});
  set_json(h, group, "layer/skeleton", one_bone(0));
  api::BindToBone b;
  b.layers = {part};
  b.character = group;
  b.bone = "b";
  REQUIRE(is_ok(h.run(cmd(b))));
  set_json(h, group, "layer/skeleton", one_bone(std::numbers::pi / 4));
  const auto turned = world_xy(h, part);
  api::SetParent p;
  p.layers = {part};
  p.keep_world_transform = true;
  REQUIRE(is_ok(h.run(cmd(p))));
  CHECK_FALSE(info_of(h, part).parent_bone.has_value());
  CHECK(world_xy(h, part).first == Approx(turned.first).margin(1e-6));
  CHECK(world_xy(h, part).second == Approx(turned.second).margin(1e-6));
}

TEST_CASE("bone link: a 3D part follows its bone too", "[character]") {
  Harness h;
  (void)h.hello();
  const auto part = make_rect(h, "Arm", 300, 200);
  api::SetLayerSwitches sw;
  sw.layers = {part};
  sw.patch.three_d = true;
  REQUIRE(is_ok(h.run(cmd(sw))));
  const auto group = group_of(h, {part});
  set_json(h, group, "layer/skeleton", one_bone(0));
  const auto before = world_xy(h, part);
  api::BindToBone b;
  b.layers = {part};
  b.character = group;
  b.bone = "b";
  REQUIRE(is_ok(h.run(cmd(b))));
  CHECK(world_xy(h, part).first == Approx(before.first).margin(1e-6));
  CHECK(world_xy(h, part).second == Approx(before.second).margin(1e-6));
  const auto g = world_xy(h, group);
  set_json(h, group, "layer/skeleton", one_bone(std::numbers::pi / 2));
  CHECK(world_xy(h, part).first == Approx(g.first - (before.second - g.second)).margin(1e-6));
  CHECK(world_xy(h, part).second == Approx(g.second + (before.first - g.first)).margin(1e-6));
}

TEST_CASE("bone link: deleting the bone re-bases the part's keyframes at the playhead", "[character]") {
  constexpr api::Time kSec = 705'600'000;
  Harness h;
  (void)h.hello();
  const auto part = make_rect(h, "Arm", 300, 200);
  api::AddKeyframes a;
  for (const auto& [t, x] : std::vector<std::pair<api::Time, double>>{{0, 300}, {kSec, 400}}) {
    api::KeyframeInsert k;
    k.prop = {part, "transform/position"};
    k.time = t;
    k.value = vec2(x, 200);
    a.keys.push_back(std::move(k));
  }
  REQUIRE(is_ok(h.run(cmd(a))));
  const auto group = group_of(h, {part});
  set_json(h, group, "layer/skeleton", one_bone(0));
  api::BindToBone b;
  b.layers = {part};
  b.character = group;
  b.bone = "b";
  REQUIRE(is_ok(h.run(cmd(b))));
  set_json(h, group, "layer/skeleton", one_bone(std::numbers::pi / 2));
  const auto at0 = world_xy(h, part);

  api::RemovePropertyGroups r;
  r.groups = {api::PropRef{group, "skeleton/bones/b"}};
  REQUIRE(is_ok(h.run(cmd(r))));
  CHECK_FALSE(info_of(h, part).parent_bone.has_value());
  // At the playhead (0) the part stands where it stood; the keys moved with it, keeping their own motion.
  CHECK(world_xy(h, part).first == Approx(at0.first).margin(1e-6));
  CHECK(world_xy(h, part).second == Approx(at0.second).margin(1e-6));
  api::GetLayerTransforms q;
  q.layers = {part};
  q.time = kSec;
  const auto list = query<api::LayerTransformList>(h, qry(q));
  CHECK(list.transforms[0].matrix[12] - at0.first == Approx(100).margin(1e-6));
}

TEST_CASE("createCharacter: named parts get bones, a two-bone leg gets IK, nothing moves", "[character]") {
  Harness h;
  (void)h.hello();
  const auto torso = make_rect(h, "Torso", 400, 300);
  const auto head = make_rect(h, "Head", 400, 180);
  const auto thigh = make_rect(h, "Thigh L", 380, 420);
  const auto shin = make_rect(h, "Shin L", 380, 520);
  std::vector<std::pair<double, double>> before;
  for (const auto& id : {torso, head, thigh, shin}) before.push_back(world_xy(h, id));

  api::CreateCharacter c;
  c.layers = {torso, head, thigh, shin};
  c.name = "Pip";
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  const api::LayerId character = result_layer(r);
  CHECK(info_of(h, character).character == true);

  std::size_t i = 0;
  for (const auto& id : {torso, head, thigh, shin}) {
    CHECK(info_of(h, id).parent.value_or("") == character);
    CHECK(info_of(h, id).parent_bone.has_value());
    CHECK(world_xy(h, id).first == Approx(before[i].first).margin(1e-6));
    CHECK(world_xy(h, id).second == Approx(before[i].second).margin(1e-6));
    ++i;
  }
  CHECK(info_of(h, torso).parent_bone == std::optional<std::string>("bone_torso"));
  CHECK(info_of(h, shin).parent_bone == std::optional<std::string>("bone_shin_l"));

  // One undo removes all of it.
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  CHECK_FALSE(info_of(h, shin).parent_bone.has_value());
  CHECK(world_xy(h, shin).second == Approx(before[3].second).margin(1e-6));
}

TEST_CASE("IK limb: stretch reaches past the limb, softness eases the last pixels", "[character]") {
  using namespace premation::scene::skel;
  const auto bone = [](const char* id, const char* parent, double x, double rotation) {
    Bone b;
    b.id = id;
    b.parentId = parent;
    b.length = 40;
    b.x = x;
    b.rotation = rotation;
    return b;
  };
  const std::vector<Bone> bones = {bone("a", "", 0, 0), bone("b", "a", 40, 0.2)};
  const auto tip = [](const std::vector<Bone>& posed) {
    const WorldMap w = compute_world(posed);
    return bone_tip(w.at("b"), posed[1].length);
  };

  IkTarget stretch{.boneId = "b", .x = 100, .y = 0, .chainLength = 2, .pole = std::nullopt, .blend = 1, .stretch = 1.5, .softness = 0};
  const std::vector<Bone> s = apply_ik(bones, {stretch});
  CHECK(s[0].stretch == Approx(1.25));
  CHECK(s[1].length == Approx(50));
  CHECK(tip(s).x == Approx(100).margin(1e-4));
  CHECK(tip(s).y == Approx(0).margin(1e-6));

  IkTarget capped = stretch;
  capped.x = 200;  // past 1.5 × 80: the limb stops at 120
  const std::vector<Bone> c = apply_ik(bones, {capped});
  CHECK(c[0].stretch == Approx(1.5));
  CHECK(tip(c).x == Approx(120).margin(1e-4));

  IkTarget soft{.boneId = "b", .x = 80, .y = 0, .chainLength = 2, .pole = std::nullopt, .blend = 1, .stretch = 0, .softness = 10};
  const std::vector<Bone> f = apply_ik(bones, {soft});
  const V2 t = tip(f);
  CHECK(std::hypot(t.x, t.y) == Approx(70 + 10 * (1 - std::exp(-1.0))).margin(1e-6));
  CHECK(f[0].stretch == 1);
}
