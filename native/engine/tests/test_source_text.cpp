// Source Text expressions on the scene builder: evaluateSourceText's result
// becomes the layer's text and style (applySourceTextExpressionResult).
#include <catch2/catch_test_macros.hpp>

#include <string>

#include "docexpr.hpp"
#include "docio.hpp"
#include "json.hpp"
#include "model.hpp"
#include "snapshot_build.hpp"

using premation::js::Json;
namespace doc = premation::doc;
namespace sc = premation::scene;

namespace {

const char* kProject = R"json({
  "version":"1.9.0",
  "scene":{"version":"1.0.0","nodes":[
    {"id":"comp_root","name":"Composition 1","parent":null,"children":["plain","bang","sized","shift"],
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "visible":true,"locked":false,
     "components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
    {"id":"plain","name":"Plain","children":[],"parent":"comp_root",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"plain_t","type":"Transform","props":{"__kind":"text","x":100,"y":80,"rotation":0,"scaleX":100,"scaleY":100}},
       {"id":"plain_s","type":"Style","props":{"opacity":100,"fill":"#ffffff"}},
       {"id":"plain_tx","type":"Text","props":{"content":"Hello","fontSize":48,"fontFamily":"Inter"}}],
     "visible":true,"locked":false},
    {"id":"bang","name":"Bang","children":[],"parent":"comp_root",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"bang_t","type":"Transform","props":{"__kind":"text","x":100,"y":180,"rotation":0,"scaleX":100,"scaleY":100}},
       {"id":"bang_s","type":"Style","props":{"opacity":100,"fill":"#ffffff"}},
       {"id":"bang_tx","type":"Text","props":{"content":"Hello","fontSize":48,"fontFamily":"Inter"}}],
     "visible":true,"locked":false},
    {"id":"sized","name":"Sized","children":[],"parent":"comp_root",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"sized_t","type":"Transform","props":{"__kind":"text","x":100,"y":280,"rotation":0,"scaleX":100,"scaleY":100}},
       {"id":"sized_s","type":"Style","props":{"opacity":100,"fill":"#ffffff"}},
       {"id":"sized_tx","type":"Text","props":{"content":"Hello","fontSize":48,"fontFamily":"Inter"}}],
     "visible":true,"locked":false},
    {"id":"shift","name":"Shift","children":[],"parent":"comp_root",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"shift_t","type":"Transform","props":{"__kind":"text","x":100,"y":380,"rotation":0,"scaleX":100,"scaleY":100}},
       {"id":"shift_s","type":"Style","props":{"opacity":100,"fill":"#ffffff"}},
       {"id":"shift_tx","type":"Text","props":{"content":"Hello","fontSize":48,"fontFamily":"Inter","__runsIndex":"grapheme","__runs":[{"start":3,"end":5,"style":{"fill":"#ff0000"}}]}}],
     "visible":true,"locked":false}
  ]},
  "animation":{"tracks":{},"data":{},"expressions":{
    "bang":{"text.source":{"src":"value + \"!\"","enabled":true}},
    "sized":{"text.source":{"src":"value.style.setFontSize(80)","enabled":true}},
    "shift":{"text.source":{"src":"\"X\" + value","enabled":true}}
  }},
  "comps":{"comp_root":{"id":"comp_root","name":"comp_root","width":1920,"height":1080,"fps":30,"durationSeconds":10,"background":"#101014"}},
  "motionBlur":{"enabled":false,"shutterAngle":180,"shutterPhase":-90,"samples":8,"adaptiveSampleLimit":128},
  "openTabs":{"tabOrder":["tab1"],"activeTabId":"tab1","tabs":{"tab1":{"id":"tab1","compositionId":"comp_root","breadcrumbPath":["comp_root"],"title":"comp_root","time":0,"frame":0}}}
})json";

const sc::RLayer* layer(const sc::Snapshot& s, std::string_view id) {
  for (const sc::RLayer& l : s.layers) {
    if (l.id == id) return &l;
  }
  return nullptr;
}

}  // namespace

TEST_CASE("a Source Text expression replaces the drawn text and its style", "[scene][source-text]") {
  const auto parsed = premation::js::parse(kProject);
  REQUIRE(parsed.has_value());
  doc::Document d;
  doc::EditorView view;
  (void)doc::restore_document(d, view, *parsed, {});
  doc::ExprCache cache;
  const doc::DocExprEnv env(d, view, cache);
  const sc::BuildContext ctx{d, view, env, cache, nullptr, {}};
  const sc::Snapshot snap = sc::build_snapshot(ctx, sc::snapshot_comp_of(d, "comp_root"), 0, std::nullopt);

  for (const sc::LayerError& e : snap.layerErrors) {
    INFO(e.layerId << ": " << e.message);
    CHECK(e.message != "source text expressions");
  }

  const sc::RLayer* plain = layer(snap, "plain");
  REQUIRE(plain != nullptr);
  CHECK(plain->text == std::optional<std::string>("Hello"));
  CHECK(plain->fontSize == 48);

  const sc::RLayer* bang = layer(snap, "bang");
  REQUIRE(bang != nullptr);
  CHECK(bang->text == std::optional<std::string>("Hello!"));

  const sc::RLayer* sized = layer(snap, "sized");
  REQUIRE(sized != nullptr);
  CHECK(sized->text == std::optional<std::string>("Hello"));
  CHECK(sized->fontSize == 80);

  const sc::RLayer* shift = layer(snap, "shift");
  REQUIRE(shift != nullptr);
  CHECK(shift->text == std::optional<std::string>("XHello"));
  REQUIRE(shift->runs.is_array());
  REQUIRE(shift->runs.arr().size() == 1);
  CHECK(shift->runs.arr()[0].at("start").num() == 4);
  CHECK(shift->runs.arr()[0].at("end").num() == 6);
  CHECK(shift->runs.arr()[0].at("style").at("fill").str() == "#ff0000");
}
