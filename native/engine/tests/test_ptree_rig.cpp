// C2 (rig keyframing UX): a layer's rig rows in the static property tree —
// After Effects' Puppet ▸ Deform ▸ Puppet Pin N ▸ Position / Rotation … with
// unlit stopwatches from the moment a pin is placed, and the skeleton's bones
// and IK goals the same way. The TypeScript side groups them from these names
// (src/layout/Timeline/rigRowGroups.ts) and merges the mirror's keys onto them
// (buildPropertyRows.ts); the catalog must keep the rig bindings as the owners
// of the rig tracks (props.cpp skips the rig rows).

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "core/item_facts.hpp"
#include "core/props.hpp"
#include "core/ptree.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;

namespace {

constexpr const char* kPuppet =
    R"({"pins":[{"id":"pin_1","x":-30,"y":0},{"id":"pin_2","x":30,"y":0,"kind":"advanced"}],"meshDensity":6})";
constexpr const char* kSkeleton =
    R"({"bones":[{"id":"b1","parentId":null,"length":40,"x":-40,"y":0,"rotation":0},)"
    R"({"id":"b2","parentId":"b1","length":40,"x":40,"y":0,"rotation":0}],)"
    R"("ikTargets":[{"boneId":"b2","x":20,"y":30,"chainLength":2}]})";

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

const doc::StaticPropertyRow* row_of(const std::vector<doc::StaticPropertyRow>& rows, const std::string& prop) {
  const auto it = std::find_if(rows.begin(), rows.end(), [&](const doc::StaticPropertyRow& r) { return r.prop == prop; });
  return it == rows.end() ? nullptr : &*it;
}

std::vector<std::string> props_of(const std::vector<doc::StaticPropertyRow>& rows, std::string_view group) {
  std::vector<std::string> out;
  for (const auto& r : rows) {
    if (r.group == group) out.push_back(r.prop);
  }
  return out;
}

}  // namespace

TEST_CASE("ptree rig: a layer with no rig has no rig rows; rig track names group as 'rig'", "[ptree][rig]") {
  Harness h;
  (void)h.hello();  // Every command before Hello is refused without an error outcome.
  const auto layer = make_shape(h, "plain");
  const auto rows = doc::build_static_property_tree(h.session.document(), layer);
  CHECK(props_of(rows, doc::kRigGroup).empty());
  const auto& d = h.session.document();
  CHECK(doc::group_for_prop(d, "puppet.pin_1.rotation", d.node(layer)) == "rig");
  CHECK(doc::group_for_prop(d, "bone.b1.rotation", d.node(layer)) == "rig");
  CHECK(doc::group_for_prop(d, "ikTarget.b2.x", d.node(layer)) == "rig");
  CHECK(doc::group_for_prop(d, "ikPole.b2.y", d.node(layer)) == "rig");
  CHECK(doc::group_for_prop(d, "ikMode.b2", d.node(layer)) == "rig");
  CHECK(doc::group_for_prop(d, "rotation", d.node(layer)) == "transform");
  CHECK(doc::is_rig_track("puppet.pin_1.position"));
  CHECK_FALSE(doc::is_rig_track("puppetX"));
}

TEST_CASE("ptree rig: puppet pins get Position / Rotation / Scale / Stiffness / Overlap rows on the rig tracks", "[ptree][rig]") {
  Harness h;
  (void)h.hello();
  const auto layer = make_shape(h, "R");
  REQUIRE_FALSE(layer.empty());
  set_json(h, layer, "layer/puppet", kPuppet);
  const auto rows = doc::build_static_property_tree(h.session.document(), layer);
  std::string listed;
  for (const auto& r : rows) listed += r.group + ":" + r.prop + " ";
  CAPTURE(listed);
  REQUIRE_FALSE(rows.empty());

  // Mesh settings: value-only rows (no stopwatch) on their API paths.
  const auto* density = row_of(rows, "puppet/mesh/density");
  {
    std::string all;
    for (const auto& r : rows) all += r.group + ":" + r.prop + " ";
    CAPTURE(all);
    REQUIRE(density != nullptr);
  }
  CHECK(density->group == "rig");
  CHECK(density->label == "Density");
  CHECK(density->members.empty());
  REQUIRE(density->valueProps.has_value());
  CHECK(*density->valueProps == std::vector<std::string>{"puppet/mesh/density"});

  for (const char* pin : {"pin_1", "pin_2"}) {
    const std::string base = std::string("puppet.") + pin + ".";
    const auto* pos = row_of(rows, base + "position");
    REQUIRE(pos != nullptr);
    CHECK(pos->label == "Position");
    CHECK(pos->group == "rig");
    // The data track is the stopwatch's target; the value field edits x / y of the vec2 property.
    CHECK(pos->members == std::vector<std::string>{base + "position"});
    REQUIRE(pos->valueProps.has_value());
    CHECK(*pos->valueProps == std::vector<std::string>{base + "position.x", base + "position.y"});
    CHECK_FALSE(pos->merged.has_value());
    CHECK(pos->valueUnit == std::optional<std::string>{"px"});

    const auto* rot = row_of(rows, base + "rotation");
    REQUIRE(rot != nullptr);
    CHECK(rot->label == "Rotation");
    CHECK(rot->members == std::vector<std::string>{base + "rotation"});
    CHECK(rot->valueUnit == std::optional<std::string>{"°"});

    const auto* scale = row_of(rows, base + "scale");
    REQUIRE(scale != nullptr);
    CHECK(scale->valueUnit == std::optional<std::string>{"%"});
    REQUIRE(row_of(rows, base + "stiffness") != nullptr);
    CHECK(row_of(rows, base + "stiffness")->label == "Stiffness");
    REQUIRE(row_of(rows, base + "overlap") != nullptr);
    CHECK(row_of(rows, base + "overlap")->label == "Overlap");
  }

  // Spec order within a pin: Position, Rotation, Scale, Stiffness, Overlap.
  const auto rig = props_of(rows, "rig");
  const auto at = [&](const std::string& p) { return std::find(rig.begin(), rig.end(), p) - rig.begin(); };
  CHECK(at("puppet.pin_1.position") < at("puppet.pin_1.rotation"));
  CHECK(at("puppet.pin_1.rotation") < at("puppet.pin_1.scale"));
  CHECK(at("puppet.pin_1.scale") < at("puppet.pin_1.stiffness"));
  CHECK(at("puppet.pin_1.stiffness") < at("puppet.pin_1.overlap"));
  CHECK(at("puppet.pin_1.overlap") < at("puppet.pin_2.position"));
  // The rig sits where AE lists the Puppet effect: after Effects, before Transform.
  const auto all = [&](const std::string& p) {
    return std::find_if(rows.begin(), rows.end(), [&](const doc::StaticPropertyRow& r) { return r.prop == p; }) - rows.begin();
  };
  CHECK(all("puppet.pin_2.overlap") < all("__static:anchor"));

  // The catalog keeps the RIG bindings as the owners of the rig tracks (percent scale, pose capture).
  const doc::Catalog cat = doc::catalog_for(h.session.document(), layer);
  const auto it = cat.byMember.find("puppet.pin_2.scale");
  REQUIRE(it != cat.byMember.end());
  CHECK(cat.props[it->second].path == "puppet/pins/pin_2/scale");
  CHECK(cat.props[it->second].special == doc::Special::rig);
  CHECK_FALSE(cat.byPath.contains("layer/puppet.pin_2.scale"));
}

TEST_CASE("ptree rig: bones get Position / Rotation / Scale rows, an IK goal its Goal and IK/FK (the pole once present)", "[ptree][rig]") {
  Harness h;
  (void)h.hello();
  const auto layer = make_shape(h, "S");
  REQUIRE_FALSE(layer.empty());
  set_json(h, layer, "layer/skeleton", kSkeleton);
  auto rows = doc::build_static_property_tree(h.session.document(), layer);
  std::string listed;
  for (const auto& r : rows) listed += r.group + ":" + r.prop + " ";
  CAPTURE(listed);
  REQUIRE_FALSE(rows.empty());

  REQUIRE(row_of(rows, "skeleton/mesh/density") != nullptr);
  CHECK(row_of(rows, "skeleton/mesh/density")->members.empty());

  // A vector pose property is ONE row addressed by its API path, keyed as one (merged), on both tracks.
  const auto* pos = row_of(rows, "skeleton/bones/b1/position");
  REQUIRE(pos != nullptr);
  CHECK(pos->label == "Position");
  CHECK(pos->group == "rig");
  CHECK(pos->members == std::vector<std::string>{"bone.b1.x", "bone.b1.y"});
  CHECK(pos->merged == std::optional<std::string>{"skeleton/bones/b1/position"});
  const auto* rot = row_of(rows, "bone.b1.rotation");
  REQUIRE(rot != nullptr);
  CHECK(rot->label == "Rotation");
  CHECK(rot->members == std::vector<std::string>{"bone.b1.rotation"});
  CHECK(rot->valueUnit == std::optional<std::string>{"°"});
  const auto* scale = row_of(rows, "skeleton/bones/b1/scale");
  REQUIRE(scale != nullptr);
  CHECK(scale->members == std::vector<std::string>{"bone.b1.scaleX", "bone.b1.scaleY"});
  CHECK(scale->valueUnit == std::optional<std::string>{"%"});

  // b1 has no IK goal; b2 has one: Goal (target) and IK/FK, no pole yet.
  CHECK(row_of(rows, "skeleton/bones/b1/ik/target") == nullptr);
  const auto* goal = row_of(rows, "skeleton/bones/b2/ik/target");
  REQUIRE(goal != nullptr);
  CHECK(goal->label == "IK Goal");
  CHECK(goal->members == std::vector<std::string>{"ikTarget.b2.x", "ikTarget.b2.y"});
  const auto* mode = row_of(rows, "ikMode.b2");
  REQUIRE(mode != nullptr);
  CHECK(mode->label == "IK/FK");
  CHECK(mode->members == std::vector<std::string>{"ikMode.b2"});
  CHECK(row_of(rows, "skeleton/bones/b2/ik/pole") == nullptr);

  // Add Pole (the optional property): its row appears.
  api::AddProperties add;
  add.parent = {layer, "skeleton/bones/b2/ik"};
  add.names = {"pole"};
  REQUIRE(is_ok(h.run(cmd(add))));
  rows = doc::build_static_property_tree(h.session.document(), layer);
  const auto* pole = row_of(rows, "skeleton/bones/b2/ik/pole");
  REQUIRE(pole != nullptr);
  CHECK(pole->label == "IK Pole");
  CHECK(pole->members == std::vector<std::string>{"ikPole.b2.x", "ikPole.b2.y"});

  // The rig rows reach the AE row projection (getTimelineRows) with their group.
  const auto sets = doc::timeline_rows(h.session.document(), {layer});
  REQUIRE(sets.size() == 1);
  bool seen = false;
  for (const auto& r : sets[0].rows) {
    if (r.prop == "bone.b2.rotation") {
      seen = true;
      CHECK(r.group == "rig");
      CHECK(r.value_props == std::vector<std::string>{"bone.b2.rotation"});
    }
  }
  CHECK(seen);
}
