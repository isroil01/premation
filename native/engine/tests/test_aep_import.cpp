// After Effects project reading (core/aep/aep_read.cpp) against aep_build.hpp,
// the C++ port of src/core/aep/__tests__/aepRead.test.ts. Each case writes a
// real RIFX file and reads it back, so a wrong offset in the builder or the
// reader fails here. The cases are the ones where a slipped field still looks
// plausible: the three adjacent time rationals, a fractional frame rate, and
// a solid's name living in `opti` rather than the item's Utf8.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <limits>

#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "aep_build.hpp"
#include "core/aep/aep_apply.hpp"
#include "core/aep/aep_plan.hpp"
#include "core/aep/aep_read.hpp"
#include "core/aep/riff.hpp"
#include "session_harness.hpp"

using namespace premation::doc::aep;
namespace b = premation::test::aepb;

namespace {

AepProject read_file(const b::Buf& file) {
  const ChunkTree tree = parse_rifx(file);
  return read_aep_project(tree.root);
}

b::CompItemOptions comp_main() {
  b::CompItemOptions c;
  c.id = 1;
  c.name = "Main";
  c.width = 200;
  c.height = 100;
  c.fps = 24;
  c.durationSeconds = 10;
  return c;
}

}  // namespace

TEST_CASE("aep: a composition's size, rate, duration and background", "[aep]") {
  b::CompItemOptions c = comp_main();
  c.bg[0] = 10;
  c.bg[1] = 20;
  c.bg[2] = 30;
  const AepProject project = read_file(b::aep_file({b::comp_item(c)}));
  REQUIRE(project.comps.size() == 1);
  const AepComp& main = project.comps[0];
  REQUIRE(main.name == "Main");
  REQUIRE(main.width == 200);
  REQUIRE(main.height == 100);
  REQUIRE(main.fps == Catch::Approx(24));
  REQUIRE(main.durationSeconds == Catch::Approx(10));
  REQUIRE(main.background.r == 10);
  REQUIRE(main.background.g == 20);
  REQUIRE(main.background.b == 30);
}

TEST_CASE("aep: a fractional frame rate is not truncated", "[aep]") {
  b::CompItemOptions c = comp_main();
  c.fps = 29.97;
  const AepProject project = read_file(b::aep_file({b::comp_item(c)}));
  REQUIRE(project.comps[0].fps == Catch::Approx(29.97).margin(0.001));
}

TEST_CASE("aep: an open-ended work area reads as infinite", "[aep]") {
  const AepProject project = read_file(b::aep_file({b::comp_item(comp_main())}));
  REQUIRE(std::isinf(project.comps[0].workAreaEnd));
}

TEST_CASE("aep: the timebase keyframes are counted in", "[aep]") {
  b::CompItemOptions c = comp_main();
  c.timebase = 23976;
  const AepProject project = read_file(b::aep_file({b::comp_item(c)}));
  REQUIRE(project.comps[0].internalTimebase == Catch::Approx(23976));
}

TEST_CASE("aep: the After Effects version that wrote the file", "[aep]") {
  const AepProject project = read_file(b::aep_file({b::comp_item(comp_main())}, 24, 6));
  REQUIRE(project.aeVersion == "24.6");
}

TEST_CASE("aep: a folder and the path of the items inside it", "[aep]") {
  b::FootageItemOptions logo;
  logo.id = 3;
  logo.name = "logo";
  logo.width = 64;
  logo.height = 64;
  const AepProject project = read_file(b::aep_file({b::folder_item(2, "Assets", {b::footage_item(logo)})}));
  REQUIRE(project.footage.size() == 1);
  REQUIRE(project.footage[0].name == "logo");
  REQUIRE(project.footage[0].folder.size() == 1);
  REQUIRE(project.footage[0].folder[0] == "Assets");
}

TEST_CASE("aep: a footage path out of the alias JSON", "[aep]") {
  b::FootageItemOptions plate;
  plate.id = 3;
  plate.name = "plate";
  plate.width = 1920;
  plate.height = 1080;
  plate.path = "C:\\shots\\plate.mov";
  const AepProject project = read_file(b::aep_file({b::footage_item(plate)}));
  REQUIRE(project.footage.size() == 1);
  REQUIRE(project.footage[0].path == "C:\\shots\\plate.mov");
}

TEST_CASE("aep: a solid's colour and its own name", "[aep]") {
  b::FootageItemOptions solid;
  solid.id = 4;
  solid.name = "";
  solid.width = 100;
  solid.height = 100;
  solid.solid = true;
  solid.solidColor[0] = 1;
  solid.solidColor[1] = 0.5;
  solid.solidColor[2] = 0;
  solid.solidName = "Orange Solid";
  const AepProject project = read_file(b::aep_file({b::footage_item(solid)}));
  REQUIRE(project.footage.size() == 1);
  REQUIRE(project.footage[0].footageKind == "solid");
  REQUIRE(project.footage[0].name == "Orange Solid");
  REQUIRE(project.footage[0].solidColor.has_value());
  REQUIRE(project.footage[0].solidColor->r == Catch::Approx(1));
  REQUIRE(project.footage[0].solidColor->g == Catch::Approx(0.5));
  REQUIRE(project.footage[0].solidColor->b == Catch::Approx(0));
}

TEST_CASE("aep: footage recorded as missing", "[aep]") {
  b::FootageItemOptions gone;
  gone.id = 5;
  gone.name = "gone";
  gone.width = 10;
  gone.height = 10;
  gone.missing = true;
  const AepProject project = read_file(b::aep_file({b::footage_item(gone)}));
  REQUIRE(project.footage.size() == 1);
  REQUIRE(project.footage[0].missingAtSave);
}

TEST_CASE("aep: the three adjacent time rationals stay in order", "[aep]") {
  b::LayerOptions layer;
  layer.id = 1;
  layer.startTime = 1;
  layer.inPoint = 2;
  layer.outPoint = 8;
  layer.displayName = "Clip";
  b::CompItemOptions c = comp_main();
  c.layers = {b::layer(layer)};
  const AepProject project = read_file(b::aep_file({b::comp_item(c)}));
  REQUIRE(project.comps[0].layers.size() == 1);
  const AepLayer& row = project.comps[0].layers[0];
  REQUIRE(row.startTime == Catch::Approx(1));
  REQUIRE(row.inPoint == Catch::Approx(2));
  REQUIRE(row.outPoint == Catch::Approx(8));
}

TEST_CASE("aep: identity, source, parent and stacking index", "[aep]") {
  b::LayerOptions top;
  top.id = 1;
  top.sourceId = 9;
  top.displayName = "Top";
  b::LayerOptions child;
  child.id = 2;
  child.parentId = 1;
  child.displayName = "Child";
  b::CompItemOptions c = comp_main();
  c.layers = {b::layer(top), b::layer(child)};
  const AepProject project = read_file(b::aep_file({b::comp_item(c)}));
  REQUIRE(project.comps[0].layers.size() == 2);
  REQUIRE(project.comps[0].layers[0].id == 1);
  REQUIRE(project.comps[0].layers[0].index == 1);
  REQUIRE(project.comps[0].layers[0].sourceId == 9);
  REQUIRE(project.comps[0].layers[1].id == 2);
  REQUIRE(project.comps[0].layers[1].index == 2);
  REQUIRE(project.comps[0].layers[1].parentId == 1);
}

TEST_CASE("aep: the layer kind", "[aep]") {
  b::LayerOptions camera;
  camera.id = 1;
  camera.type = 2;
  camera.displayName = "Camera";
  b::CompItemOptions c = comp_main();
  c.layers = {b::layer(camera)};
  const AepProject cameras = read_file(b::aep_file({b::comp_item(c)}));
  REQUIRE(cameras.comps[0].layers[0].kind == LayerKind::camera);

  b::LayerOptions text;
  text.id = 1;
  text.type = 3;
  text.displayName = "Title";
  c.layers = {b::layer(text)};
  const AepProject titles = read_file(b::aep_file({b::comp_item(c)}));
  REQUIRE(titles.comps[0].layers[0].kind == LayerKind::text);
}


// ── importProject of an .aep through the Session (aep_apply.cpp) ─────────

namespace {

/// FakePorts reads file bytes from `<dir>/<hex of the path>.bin`.
void seed_bytes(const std::filesystem::path& dir, const std::string& path, const b::Buf& bytes) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string name;
  for (const char c : path) {
    const auto u = static_cast<unsigned char>(c);
    name.push_back(kHex[u >> 4U]);
    name.push_back(kHex[u & 15U]);
  }
  std::ofstream out(dir / (name + ".bin"), std::ios::binary);
  out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));  // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
}

b::Buf promo_aep() {
  b::FootageItemOptions solid;
  solid.id = 9;
  solid.name = "Red Solid";
  solid.solid = true;
  solid.solidColor[0] = 1;
  solid.solidName = "Red Solid";
  b::FootageItemOptions plate;
  plate.id = 10;
  plate.name = "plate.mov";
  plate.path = "/missing/footage/plate.mov";
  b::LayerOptions bg;
  bg.id = 1;
  bg.sourceId = 9;
  bg.displayName = "Background";
  bg.outPoint = 10;
  b::LayerOptions shot;
  shot.id = 2;
  shot.sourceId = 10;
  shot.parentId = 1;
  shot.displayName = "Shot";
  shot.outPoint = 10;
  b::CompItemOptions c = comp_main();
  c.layers = {b::layer(bg), b::layer(shot)};
  return b::aep_file({b::folder_item(20, "Footage", {b::footage_item(solid), b::footage_item(plate)}), b::comp_item(c)});
}

}  // namespace

TEST_CASE("aep: importProject builds the comps, layers and footage as ONE undoable entry", "[aep][import]") {
  namespace api = premation::api;
  namespace t = premation::test;
  const std::filesystem::path dir = std::filesystem::temp_directory_path() / "premation-aep-import-test";
  std::filesystem::create_directories(dir);
  const std::string path = "/projects/Promo.aep";
  seed_bytes(dir, path, promo_aep());
  t::Harness h(3, dir.string());
  (void)h.hello();
  const auto history = [&h] {
    return t::result_as<api::HistoryState>(std::get<api::QueryResult>(h.ask(t::qry(api::GetHistory{})).outcome.v)).entries.size();
  };
  const std::size_t before = history();
  api::ImportProject imp;
  imp.path = path;
  const auto r = h.run(t::cmd(imp));
  REQUIRE(t::is_ok(r));
  const auto result = t::result_as<api::ImportProjectResult>(r);
  REQUIRE(result.summary);
  CHECK(result.summary->comps == 1);
  CHECK(result.summary->layers == 2);
  // The folder named after the file first, then what it holds; the main comp to open.
  REQUIRE(result.items.size() >= 3);
  REQUIRE(result.open_comp);
  // The test ports import any path (a fake record), so nothing is missing here;
  // on disk (FilePorts + the engine's media probe) an unreadable file is listed.
  CHECK(result.missing_footage.empty());
  CHECK(history() == before + 1);
  api::GetItems q;
  q.items = {result.items.front(), *result.open_comp};
  const auto items = t::result_as<api::ItemDetails>(std::get<api::QueryResult>(h.ask(t::qry(q)).outcome.v));
  REQUIRE(items.items.size() == 2);
  CHECK(items.items[0].name == "Promo");
  CHECK(items.items[1].name == "Main");
  // Undo removes everything imported.
  REQUIRE(t::is_ok(h.run(t::cmd(api::Undo{}))));
  CHECK(t::is_error(h.ask(t::qry(q)), api::ErrorCode::not_found));
  std::filesystem::remove_all(dir);
}

TEST_CASE("aep: importProject refuses a project with no compositions and a file it cannot read", "[aep][import]") {
  namespace api = premation::api;
  namespace t = premation::test;
  const std::filesystem::path dir = std::filesystem::temp_directory_path() / "premation-aep-import-test2";
  std::filesystem::create_directories(dir);
  b::FootageItemOptions solid;
  solid.id = 9;
  solid.name = "S";
  solid.solid = true;
  seed_bytes(dir, "/p/Empty.aep", b::aep_file({b::footage_item(solid)}));
  seed_bytes(dir, "/p/Junk.aep", b::bytes_of("not a riff file at all"));
  t::Harness h(3, dir.string());
  (void)h.hello();
  api::ImportProject empty;
  empty.path = "/p/Empty.aep";
  CHECK(t::is_error(h.run(t::cmd(empty)), api::ErrorCode::decode));
  api::ImportProject junk;
  junk.path = "/p/Junk.aep";
  CHECK_FALSE(t::is_ok(h.run(t::cmd(junk))));
  std::filesystem::remove_all(dir);
}

// ── Camera program D4: a camera's options carry over 1:1 ────────────────────

TEST_CASE("aep: a camera's Zoom, depth of field, rotation and depth plan 1:1", "[aep][camera][d4]") {
  b::PropertyOptions zoom;
  zoom.value = std::vector<double>{1500};
  b::PropertyOptions dof;
  dof.value = std::vector<double>{1};
  b::PropertyOptions focus;
  focus.value = std::vector<double>{900};
  b::PropertyOptions aperture;
  aperture.value = std::vector<double>{40};
  b::PropertyOptions blur;
  blur.value = std::vector<double>{100};
  b::PropertyOptions position;
  position.dimensions = 3;
  position.spatial = true;
  position.value = std::vector<double>{960, 540, -1500};
  b::PropertyOptions rotY;
  rotY.value = std::vector<double>{25};
  std::vector<b::Buf> options;
  for (const auto& [name, opt] : {std::pair{"ADBE Camera Zoom", zoom}, std::pair{"ADBE Camera Depth of Field", dof},
                                  std::pair{"ADBE Camera Focus Distance", focus}, std::pair{"ADBE Camera Aperture", aperture},
                                  std::pair{"ADBE Camera Blur Level", blur}}) {
    b::append(options, b::property(name, opt));
  }
  std::vector<b::Buf> transform;
  b::append(transform, b::property("ADBE Position", position));
  b::append(transform, b::property("ADBE Rotate Y", rotY));
  b::LayerOptions camera;
  camera.id = 1;
  camera.type = 2;
  camera.displayName = "Shot Cam";
  b::append(camera.properties, b::group("ADBE Transform Group", transform));
  b::append(camera.properties, b::group("ADBE Camera Options Group", options));
  b::CompItemOptions c = comp_main();
  c.layers = {b::layer(camera)};
  const AepImportPlan plan = plan_aep_import(read_file(b::aep_file({b::comp_item(c)})));
  REQUIRE(plan.comps.size() == 1);
  REQUIRE(plan.comps[0].layers.size() == 1);
  const auto& props = plan.comps[0].layers[0].staticProps;
  const auto get = [&](const std::string& k) -> std::optional<double> {
    for (const auto& [key, v] : props) {
      if (key == k) return v;
    }
    return std::nullopt;
  };
  CHECK(get("focalLength") == 1500);
  CHECK(get("focusDistance") == 900);
  CHECK(get("dofAperture") == 40);
  CHECK(get("dofStrength") == Catch::Approx(10));
  CHECK(get("orientationY") == 25);
  CHECK(get("z") == -1500);  // a camera keeps its depth whatever its 3D switch says
  CHECK_FALSE(get("anchorX").has_value());
  CHECK_FALSE(get("rotationY").has_value());
}

namespace {

const PlannedEffect* planned_effect(const PlannedLayer& l, std::string_view type) {
  for (const PlannedEffect& e : l.effects) {
    if (e.type == type) return &e;
  }
  return nullptr;
}

std::optional<premation::js::Json> planned_param(const PlannedEffect* e, std::string_view key) {
  if (e == nullptr) return std::nullopt;
  for (const auto& [k, v] : e->params) {
    if (k == key) return v;
  }
  return std::nullopt;
}

}  // namespace

TEST_CASE("aep: effect parameters AE stores in its own units mean the same here", "[aep][effects]") {
  // Drop Shadow: Opacity 0–255, Direction clockwise from up. Fast Box Blur: a 1-based popup.
  // Ramp: Start/End Color and the direction between Start/End of Ramp. Glow: a 0–255 threshold.
  const auto param = [](std::uint32_t index, std::string label, std::uint32_t controlType, std::vector<double> value) {
    b::EffectParamSpec p;
    p.index = index;
    p.label = std::move(label);
    p.controlType = controlType;
    p.color = controlType == 5;
    p.value = std::move(value);
    return p;
  };
  std::vector<b::Buf> parade;
  b::append(parade, b::effect("ADBE Drop Shadow", "Drop Shadow", {param(2, "Opacity", 2, {255}), param(3, "Direction", 3, {180})}));
  b::append(parade, b::effect("ADBE Box Blur2", "Fast Box Blur", {param(1, "Blur Radius", 2, {137}), param(3, "Blur Dimensions", 7, {3})}));
  b::append(parade, b::effect("ADBE Ramp", "Gradient Ramp",
                              {param(1, "Start of Ramp", 6, {0.5, 1}), param(2, "Start Color", 5, {255, 255, 0, 0}),
                               param(3, "End of Ramp", 6, {0.5, 0}), param(4, "End Color", 5, {255, 0, 0, 255})}));
  b::append(parade, b::effect("ADBE Glo2", "Glow", {param(2, "Glow Threshold", 2, {153})}));
  b::LayerOptions solid;
  solid.id = 1;
  solid.displayName = "Fx";
  b::append(solid.properties, b::group("ADBE Effect Parade", parade));
  b::CompItemOptions c = comp_main();
  c.layers = {b::layer(solid)};
  const AepImportPlan plan = plan_aep_import(read_file(b::aep_file({b::comp_item(c)})));
  REQUIRE(plan.comps.size() == 1);
  const PlannedLayer& l = plan.comps[0].layers.at(0);

  const PlannedEffect* shadow = planned_effect(l, "drop-shadow");
  CHECK(planned_param(shadow, "opacity")->num() == Catch::Approx(100));
  CHECK(planned_param(shadow, "angle")->num() == Catch::Approx(90));  // straight down, as AE's 180°
  CHECK(planned_param(planned_effect(l, "fast-box-blur"), "dimensions")->num() == 2);  // Vertical
  const PlannedEffect* ramp = planned_effect(l, "gradient-ramp");
  CHECK(planned_param(ramp, "colorA")->str() == "#ff0000");
  CHECK(planned_param(ramp, "colorB")->str() == "#0000ff");
  CHECK(planned_param(ramp, "angle")->num() == Catch::Approx(-90));  // bottom → top
  CHECK(planned_param(planned_effect(l, "vr-glow"), "threshold")->num() == Catch::Approx(60));
}

TEST_CASE("aep: a track matte whose video AE switched off still comes across as the matte", "[aep]") {
  b::LayerOptions source;
  source.id = 1;
  source.displayName = "Matte";
  source.enabled = false;  // AE turns a track matte's eye off
  b::LayerOptions fill;
  fill.id = 2;
  fill.displayName = "Fill";
  fill.trackMatte = 2;  // alpha inverted
  fill.matteLayerId = 1;
  b::LayerOptions other;
  other.id = 3;
  other.displayName = "Hidden";
  other.enabled = false;
  b::CompItemOptions c = comp_main();
  c.layers = {b::layer(source), b::layer(fill), b::layer(other)};
  const AepImportPlan plan = plan_aep_import(read_file(b::aep_file({b::comp_item(c)})));
  const auto& layers = plan.comps.at(0).layers;
  REQUIRE(layers.size() == 3);
  CHECK(layers[0].flags.enabled);  // this editor only builds a matte source whose eye is on
  CHECK(layers[1].matte->inverted);
  CHECK_FALSE(layers[2].flags.enabled);  // a hidden layer that is no matte stays hidden
}

// ── 2026-11-04: real AE projects (Motion Stretch Text, a CRT/VHS look) ────

namespace {

AepProp leaf(std::string mn, std::vector<double> value) {
  AepProp p;
  p.matchName = std::move(mn);
  p.value = std::move(value);
  p.dimensions = p.value.size();
  return p;
}
AepProp group_of(std::string mn, std::vector<AepProp> children, std::optional<std::string> name = std::nullopt) {
  AepProp g;
  g.isGroup = true;
  g.matchName = std::move(mn);
  g.name = std::move(name);
  g.children = std::move(children);
  return g;
}
AepShape square(double x0, double y0, double size) {
  AepShape s;
  s.vertices = {{x0, y0}, {x0 + size, y0}, {x0 + size, y0 + size}, {x0, y0 + size}};
  return s;
}
/// A path whose outline is keyed: one AepShape per key, AE's Easy Ease between them.
AepProp keyed_path(std::vector<std::pair<double, AepShape>> keys) {
  AepProp path = leaf("ADBE Vector Shape", {});
  path.shape = keys.at(0).second;
  for (auto& [t, s] : keys) {
    AepKeyframe k;
    k.time = t;
    k.inInterp = Interp::bezier;
    k.outInterp = Interp::bezier;
    k.inSpeed = {0};
    k.outSpeed = {0};
    k.inInfluence = {1.0 / 3};
    k.outInfluence = {1.0 / 3};
    k.shape = s;
    path.keyframes.push_back(std::move(k));
  }
  return path;
}
AepProject one_layer_project(AepLayer layer) {
  AepComp comp;
  comp.id = 1;
  comp.name = "Main";
  comp.width = 1080;
  comp.height = 1920;
  comp.fps = 30;
  comp.durationSeconds = 6;
  comp.layers = {std::move(layer)};
  AepProject p;
  p.comps = {std::move(comp)};
  p.items = {AepItemRef{ItemKind::comp, 1, "Main", {}, 0}};
  return p;
}

}  // namespace

TEST_CASE("aep: a shape layer is a path layer: animated contours, fill, stroke, the hole of an O", "[aep][shapes]") {
  // "O": an outer and an inner contour, each keyed, merged; Stroke listed above Fill (stroke on top).
  AepLayer layer;
  layer.id = 2;
  layer.name = "O";
  layer.kind = LayerKind::shape;
  std::vector<AepProp> contents = {
      group_of("ADBE Vector Shape - Group", {keyed_path({{0, square(0, 0, 100)}, {1, square(0, 0, 300)}})}),
      group_of("ADBE Vector Shape - Group", {keyed_path({{0, square(25, 25, 50)}, {1, square(25, 25, 250)}})}),
      group_of("ADBE Vector Filter - Merge", {}),
      group_of("ADBE Vector Graphic - Stroke", {leaf("ADBE Vector Stroke Color", {0, 0, 1, 1}), leaf("ADBE Vector Stroke Width", {3})}),
      group_of("ADBE Vector Graphic - Fill", {leaf("ADBE Vector Fill Color", {0, 1, 0, 1})}),
      group_of("ADBE Vector Filter - Trim", {}, std::string("Trim Paths 1")),
  };
  std::vector<AepProp> groupXf = {leaf("ADBE Vector Position", {10, 20})};
  layer.properties = group_of("ADBE Layer", {
      group_of("ADBE Root Vectors Group", {group_of("ADBE Vector Group", {group_of("ADBE Vectors Group", contents),
                                                                          group_of("ADBE Vector Transform Group", groupXf)})}),
      group_of("ADBE Transform Group", {leaf("ADBE Anchor Point", {0, 0, 0}), leaf("ADBE Position", {540, 960, 0})}),
  });
  const AepImportPlan plan = plan_aep_import(one_layer_project(std::move(layer)));
  const PlannedLayer& l = plan.comps.at(0).layers.at(0);
  REQUIRE(l.kind == "path");
  REQUIRE(l.shape);
  const PlannedShape& s = *l.shape;
  REQUIRE(s.runs.size() == 2);
  CHECK(s.fill == "#00ff00");
  REQUIRE(s.stroke);
  CHECK(s.stroke->color == "#0000ff");
  CHECK(s.stroke->width == 3);
  CHECK_FALSE(s.fillAboveStroke);
  // Box = every key's outline, group-moved by (10, 20): x 10..310, y 20..320.
  CHECK(s.cx == Catch::Approx(160));
  CHECK(s.cy == Catch::Approx(170));
  CHECK(s.width == Catch::Approx(300));
  // The anchor (AE (0, 0)) lands on the same comp point: ours is AE's minus the centre.
  CHECK(l.prop("anchorX") == Catch::Approx(-160));
  CHECK(l.prop("anchorY") == Catch::Approx(-170));
  // Runs reversed (the top item in AE's Contents is drawn last): run 1 is the outer contour.
  const PlannedRun& outer = s.runs[1];
  REQUIRE(outer.keys.size() == 2);
  CHECK(outer.keys[0].points[0].x == Catch::Approx(10 - 160));
  CHECK(outer.keys[1].points[2].x == Catch::Approx(310 - 160));
  CHECK(outer.keys[0].easing == premation::api::Easing::bezier);
  CHECK((*outer.keys[0].bezier)[1] == 0);  // Easy Ease: a flat handle
  CHECK(plan.summary.keyframes == 4);
  // What does not come across is named, never silent.
  bool trimNamed = false;
  for (const std::string& w : plan.warnings) trimNamed = trimNamed || w.find("Trim Paths 1") != std::string::npos;
  CHECK(trimNamed);
}

TEST_CASE("aep: a shape layer with nothing drawable stays an empty group, and says so", "[aep][shapes]") {
  AepLayer layer;
  layer.id = 2;
  layer.name = "Stars";
  layer.kind = LayerKind::shape;
  layer.properties = group_of("ADBE Layer", {group_of("ADBE Root Vectors Group", {group_of("ADBE Vector Shape - Star", {})})});
  const AepImportPlan plan = plan_aep_import(one_layer_project(std::move(layer)));
  CHECK(plan.comps.at(0).layers.at(0).kind == "group");
  CHECK(plan.warnings.size() == 2);  // the Star named, and the empty group
}

TEST_CASE("aep: rectangles and ellipses become outlines", "[aep][shapes]") {
  AepLayer layer;
  layer.id = 2;
  layer.name = "Prims";
  layer.kind = LayerKind::shape;
  layer.properties = group_of(
      "ADBE Layer",
      {group_of("ADBE Root Vectors Group",
                {
                    group_of("ADBE Vector Shape - Rect", {leaf("ADBE Vector Rect Size", {200, 100}), leaf("ADBE Vector Rect Roundness", {10})}),
                    group_of("ADBE Vector Shape - Ellipse",
                             {leaf("ADBE Vector Ellipse Size", {50, 50}), leaf("ADBE Vector Ellipse Position", {300, 0})}),
                    group_of("ADBE Vector Graphic - Fill", {leaf("ADBE Vector Fill Color", {1, 1, 1, 1}), leaf("ADBE Vector Fill Opacity", {50})}),
                })});
  const AepImportPlan plan = plan_aep_import(one_layer_project(std::move(layer)));
  const PlannedShape& s = *plan.comps.at(0).layers.at(0).shape;
  REQUIRE(s.runs.size() == 2);
  CHECK(s.runs[1].points.size() == 8);  // a rounded rectangle: two vertices a corner
  CHECK(s.runs[0].points.size() == 4);  // an ellipse
  CHECK(s.width == Catch::Approx(425));  // -100 .. 325
  CHECK(s.fillOpacity == Catch::Approx(0.5));
}

TEST_CASE("aep: an animated mask keeps every outline key", "[aep]") {
  AepLayer layer;
  layer.id = 1;
  layer.name = "Masked";
  layer.kind = LayerKind::av;
  AepMask mask;
  mask.name = "Mask 1";
  mask.shape = square(0, 0, 10);
  AepProp path = keyed_path({{0, square(0, 0, 10)}, {2, square(0, 0, 40)}});
  path.matchName = "ADBE Mask Shape";
  mask.properties = group_of("ADBE Mask Atom", {path});
  layer.masks = {mask};
  const AepImportPlan plan = plan_aep_import(one_layer_project(std::move(layer)));
  const PlannedMask& m = plan.comps.at(0).layers.at(0).masks.at(0);
  REQUIRE(m.keys.size() == 2);
  CHECK(m.keys[1].t == 2);
  CHECK(m.keys[1].points[2].x == Catch::Approx(40 - 540));  // layer space, centre origin (no source: comp-sized)
}

TEST_CASE("aep: expressions go to the property they were on", "[aep][expressions]") {
  AepLayer layer;
  layer.id = 1;
  layer.name = "Wiggly";
  layer.kind = LayerKind::av;
  AepProp pos = leaf("ADBE Position", {100, 100, 0});
  pos.expression = "wiggle(2, 30)";
  pos.expressionEnabled = true;
  AepProp opacity = leaf("ADBE Opacity", {100});
  opacity.expression = "loopOut()";
  opacity.expressionEnabled = false;
  layer.properties = group_of("ADBE Layer", {group_of("ADBE Transform Group", {pos, opacity})});
  const AepImportPlan plan = plan_aep_import(one_layer_project(std::move(layer)));
  const auto& ex = plan.comps.at(0).layers.at(0).layerExpressions;
  REQUIRE(ex.size() == 2);
  CHECK(ex[0].path == "transform/position");
  CHECK(ex[0].source == "wiggle(2, 30)");
  CHECK(ex[0].enabled);
  CHECK(ex[1].path == "transform/opacity");
  CHECK_FALSE(ex[1].enabled);  // switched off in AE stays off
}

TEST_CASE("aep: Deep Glow 2, Add Grain and Quick Chromatic Aberration have equivalents", "[aep][effects]") {
  const auto param = [](std::uint32_t index, std::string label, std::uint32_t controlType, std::vector<double> value) {
    b::EffectParamSpec p;
    p.index = index;
    p.label = std::move(label);
    p.controlType = controlType;
    p.color = controlType == 5;
    p.value = std::move(value);
    return p;
  };
  std::vector<b::Buf> parade;
  // "Tint" is Deep Glow 2's twirl heading (a group start): it must not reach the Tint colour.
  b::append(parade, b::effect("PEDG2", "Deep Glow 2", {param(1, "Exposure", 10, {0.5}), param(2, "Threshold", 10, {51}), param(3, "Tint", 13, {0})}));
  b::append(parade, b::effect("VISINF Grain Implant", "Add Grain", {param(1, "Intensity", 10, {2}), param(2, "Size", 10, {0.5})}));
  b::append(parade, b::effect("PEQCAGL", "Quick Chromatic Aberration 3", {}));
  b::LayerOptions solid;
  solid.id = 1;
  solid.displayName = "Fx";
  b::append(solid.properties, b::group("ADBE Effect Parade", parade));
  b::CompItemOptions c = comp_main();
  c.layers = {b::layer(solid)};
  const AepImportPlan plan = plan_aep_import(read_file(b::aep_file({b::comp_item(c)})));
  CHECK(plan.summary.unmappedEffects.empty());
  const PlannedLayer& l = plan.comps.at(0).layers.at(0);
  const PlannedEffect* glow = planned_effect(l, "deep-glow");
  CHECK(planned_param(glow, "exposure")->num() == Catch::Approx(0.5));
  CHECK(planned_param(glow, "threshold")->num() == Catch::Approx(51));
  CHECK_FALSE(planned_param(glow, "tint").has_value());
  const PlannedEffect* grain = planned_effect(l, "add-grain");
  CHECK(planned_param(grain, "intensity")->num() == Catch::Approx(60));  // AE x1 = our 30 %
  CHECK(planned_param(grain, "size")->num() == Catch::Approx(0.5));
  CHECK(planned_param(grain, "saturation")->num() == Catch::Approx(100));  // AE's default colour grain
  CHECK(planned_effect(l, "chromatic-aberration") != nullptr);
}

TEST_CASE("aep: footage AE recorded on another disk is looked for beside the project", "[aep]") {
  const std::vector<std::string> c = footage_candidates(R"(E:\Work\Reel\Final\(Footage)\tunnel.mov)", "C:/Users/me/ae/Final/Reel.aep");
  REQUIRE(c.size() >= 3);
  CHECK(c[0] == R"(E:\Work\Reel\Final\(Footage)\tunnel.mov)");  // the recorded path first
  CHECK(c[1] == "C:/Users/me/ae/Final/tunnel.mov");
  CHECK(c[2] == "C:/Users/me/ae/Final/(Footage)/tunnel.mov");  // Collect Files' layout
  CHECK(footage_candidates("/a.mov", "").size() == 1);
}
