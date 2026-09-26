// Cover-slot UV crop (mediaSlots.ts coverUvRect) and standalone backdrop blur,
// both drawn by the render graph and previously still reported unported.
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <cmath>
#include <string>

#include "docexpr.hpp"
#include "docio.hpp"
#include "frame_build.hpp"
#include "json.hpp"
#include "model.hpp"
#include "snapshot_build.hpp"

using premation::js::Json;
namespace doc = premation::doc;
namespace sc = premation::scene;

namespace {

bool close(double a, double b) { return std::abs(a - b) <= 1e-9; }

Json asset(const char* id, double w, double h, double par) {
  Json a = Json::object();
  a.set("id", Json::string(id));
  a.set("name", Json::string(id));
  a.set("type", Json::string("video"));
  a.set("src", Json::string(std::string("file:///clips/") + id));
  Json md = Json::object();
  md.set("width", Json::number(w));
  md.set("height", Json::number(h));
  a.set("metadata", std::move(md));
  if (par != 1) {
    Json ip = Json::object();
    ip.set("par", Json::number(par));
    a.set("interpret", std::move(ip));
  }
  return a;
}

const char* kProject = R"({
  "version":"1.9.0",
  "scene":{"version":"1.0.0","nodes":[
    {"id":"comp_root","name":"Composition 1","parent":null,"children":["tall","wide","par","wash"],
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "visible":true,"locked":false,
     "components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
    {"id":"tall","name":"tall","children":[],"parent":"comp_root",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"tall_t","type":"Transform","props":{"__kind":"image","x":960,"y":540,"rotation":0,"scaleX":100,"scaleY":100,"width":1920,"height":1080,"assetId":"clipTall","src":"file:///clips/clipTall","slotFit":"cover"}},
       {"id":"tall_s","type":"Style","props":{"opacity":100}}],
     "visible":true,"locked":false},
    {"id":"wide","name":"wide","children":[],"parent":"comp_root",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"wide_t","type":"Transform","props":{"__kind":"image","x":960,"y":540,"rotation":0,"scaleX":100,"scaleY":100,"width":1920,"height":1080,"assetId":"clipWide","src":"file:///clips/clipWide","slotFit":"cover"}},
       {"id":"wide_s","type":"Style","props":{"opacity":100}}],
     "visible":true,"locked":false},
    {"id":"par","name":"par","children":[],"parent":"comp_root",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"par_t","type":"Transform","props":{"__kind":"image","x":500,"y":500,"rotation":0,"scaleX":100,"scaleY":100,"width":1000,"height":1000,"assetId":"clipPar","src":"file:///clips/clipPar","slotFit":"cover"}},
       {"id":"par_s","type":"Style","props":{"opacity":100}}],
     "visible":true,"locked":false},
    {"id":"wash","name":"wash","children":[],"parent":"comp_root",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"wash_t","type":"Transform","props":{"__kind":"shape","x":200,"y":200,"rotation":0,"scaleX":100,"scaleY":100,"width":400,"height":300}},
       {"id":"wash_s","type":"Style","props":{"opacity":100,"fill":"#ffffff","backdropBlur":12}}],
     "visible":true,"locked":false}
  ]},
  "animation":{"tracks":{},"expressions":{}},
  "comps":{"comp_root":{"id":"comp_root","name":"comp_root","width":1920,"height":1080,"fps":30,"durationSeconds":10,"background":"#101014"}},
  "motionBlur":{"enabled":false,"shutterAngle":180,"shutterPhase":-90,"samples":8,"adaptiveSampleLimit":128},
  "openTabs":{"tabOrder":["tab1"],"activeTabId":"tab1","tabs":{"tab1":{"id":"tab1","compositionId":"comp_root","breadcrumbPath":["comp_root"],"title":"comp_root","time":0,"frame":0}}}
})";

const sc::RLayer* layer(const sc::Snapshot& s, std::string_view id) {
  for (const sc::RLayer& l : s.layers) {
    if (l.id == id) return &l;
  }
  return nullptr;
}

}  // namespace

TEST_CASE("cover UV matches mediaSlots.ts coverUvRect", "[scene][cover]") {
  CHECK_FALSE(sc::cover_uv_rect(3840, 2160, 1920, 1080).has_value());
  CHECK_FALSE(sc::cover_uv_rect(0, 2160, 1920, 1080).has_value());
  CHECK_FALSE(sc::cover_uv_rect(3840, 2160, 0, 1080).has_value());

  const auto tall = sc::cover_uv_rect(1080, 1920, 1920, 1080);
  REQUIRE(tall.has_value());
  const double tallH = (1080.0 / 1920.0) / (1920.0 / 1080.0);
  CHECK(close((*tall)[0], 0));
  CHECK(close((*tall)[2], 1));
  CHECK(close((*tall)[3], tallH));
  CHECK(close((*tall)[1], (1.0 - tallH) / 2));

  const auto phone = sc::cover_uv_rect(3840, 2160, 320, 690);
  REQUIRE(phone.has_value());
  CHECK(close((*phone)[1], 0));
  CHECK(close((*phone)[3], 1));
  CHECK((*phone)[2] < 0.3);
}

TEST_CASE("a cover slot crops in UV and a backdrop blur is no longer unported", "[scene][cover]") {
  const auto parsed = premation::js::parse(kProject);
  REQUIRE(parsed.has_value());
  doc::Document d;
  doc::EditorView view;
  (void)doc::restore_document(d, view, *parsed, {asset("clipTall", 1080, 1920, 1), asset("clipWide", 3840, 2160, 1), asset("clipPar", 1000, 1000, 2)});
  doc::ExprCache cache;
  const doc::DocExprEnv env(d, view, cache);
  const sc::BuildContext ctx{d, view, env, cache, nullptr, {}};
  const sc::Snapshot snap = sc::build_snapshot(ctx, sc::snapshot_comp_of(d, "comp_root"), 0, std::nullopt);

  for (const sc::LayerError& e : snap.layerErrors) {
    INFO(e.layerId << ": " << e.message);
    CHECK(e.message != "media slot cover crop");
    CHECK(e.message != "backdrop blur");
  }

  const sc::RLayer* tall = layer(snap, "tall");
  REQUIRE(tall != nullptr);
  REQUIRE(tall->uvRect.has_value());
  const double tallH = (1080.0 / 1920.0) / (1920.0 / 1080.0);
  CHECK(close((*tall->uvRect)[3], tallH));

  const sc::RLayer* wide = layer(snap, "wide");
  REQUIRE(wide != nullptr);
  CHECK_FALSE(wide->uvRect.has_value());

  const sc::RLayer* par = layer(snap, "par");
  REQUIRE(par != nullptr);
  REQUIRE(par->uvRect.has_value());
  CHECK(close((*par->uvRect)[0], 0.25));
  CHECK(close((*par->uvRect)[2], 0.5));
  CHECK(close((*par->uvRect)[3], 1));

  const sc::RLayer* wash = layer(snap, "wash");
  REQUIRE(wash != nullptr);
  REQUIRE(wash->backdropBlur.has_value());
  CHECK(close(*wash->backdropBlur, 12));

  const sc::FrameBuild frame = sc::build_frame_scene(snap, 1);
  const premation::api::Renderable* drawn = nullptr;
  for (const premation::api::Renderable& r : frame.scene.renderables) {
    if (r.id == "tall") drawn = &r;
  }
  REQUIRE(drawn != nullptr);
  REQUIRE(drawn->uv_rect.has_value());
  CHECK_THAT(drawn->uv_rect->height, Catch::Matchers::WithinAbs(tallH, 1e-9));
}
