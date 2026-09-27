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
#include <string>

#include "aep_build.hpp"
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
