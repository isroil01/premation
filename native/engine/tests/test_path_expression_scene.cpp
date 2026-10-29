// AE path expressions on the scene builder: a Mask Path's expression
// (`mask.<id>.path`) and a shape Path's (`path.points`) become the outline the
// frame draws; an expression that errors leaves the path as authored.
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
    {"id":"comp_root","name":"Composition 1","parent":null,"children":["masked","broken","outline"],
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "visible":true,"locked":false,
     "components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
    {"id":"masked","name":"Masked","children":[],"parent":"comp_root",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"masked_t","type":"Transform","props":{"__kind":"shape","x":200,"y":200,"rotation":0,"scaleX":100,"scaleY":100,"width":200,"height":200}},
       {"id":"masked_s","type":"Style","props":{"opacity":100,"fill":"#ffffff"}},
       {"id":"masked_fx","type":"fx","props":{"mask":{"paths":[{"id":"m1","mode":"add","closed":true,"feather":0,"opacity":1,"expansion":0,"inverted":false,
         "points":[{"x":0,"y":0,"inX":0,"inY":0,"outX":0,"outY":0},{"x":50,"y":0,"inX":50,"inY":0,"outX":50,"outY":0},{"x":50,"y":50,"inX":50,"inY":50,"outX":50,"outY":50}]}]}}}],
     "visible":true,"locked":false},
    {"id":"broken","name":"Broken","children":[],"parent":"comp_root",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"broken_t","type":"Transform","props":{"__kind":"shape","x":600,"y":200,"rotation":0,"scaleX":100,"scaleY":100,"width":200,"height":200}},
       {"id":"broken_s","type":"Style","props":{"opacity":100,"fill":"#ffffff"}},
       {"id":"broken_fx","type":"fx","props":{"mask":{"paths":[{"id":"m2","mode":"add","closed":true,"feather":0,"opacity":1,"expansion":0,"inverted":false,
         "points":[{"x":0,"y":0,"inX":0,"inY":0,"outX":0,"outY":0},{"x":30,"y":0,"inX":30,"inY":0,"outX":30,"outY":0},{"x":30,"y":30,"inX":30,"inY":30,"outX":30,"outY":30}]}]}}}],
     "visible":true,"locked":false},
    {"id":"outline","name":"Outline","children":[],"parent":"comp_root",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"outline_t","type":"Transform","props":{"__kind":"shape","x":400,"y":500,"rotation":0,"scaleX":100,"scaleY":100}},
       {"id":"outline_s","type":"Style","props":{"opacity":100,"fill":"#ffffff"}},
       {"id":"outline_g","type":"Geometry","props":{"points":[{"x":0,"y":-10},{"x":10,"y":10},{"x":-10,"y":10}],"open":false}}],
     "visible":true,"locked":false}
  ]},
  "animation":{"tracks":{},"data":{},"expressions":{
    "masked":{"mask.m1.path":{"src":"var p = value.points(); for (var i = 0; i < p.length; i++) p[i] = p[i] + [time * 10, 0];\ncreatePath(p, value.inTangents(), value.outTangents(), false)","enabled":true}},
    "broken":{"mask.m2.path":{"src":"nope()","enabled":true}},
    "outline":{"path.points":{"src":"thisComp.layer(\"Masked\").mask(\"Mask 1\").maskPath","enabled":true}}
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

const Json& first_mask_path(const sc::RLayer& l) { return l.mask.at("paths").arr().at(0); }

}  // namespace

TEST_CASE("Mask Path and shape Path expressions are the outlines the frame draws", "[scene][path-expr]") {
  const auto parsed = premation::js::parse(kProject);
  REQUIRE(parsed.has_value());
  doc::Document d;
  doc::EditorView view;
  (void)doc::restore_document(d, view, *parsed, {});
  doc::ExprCache cache;
  const doc::DocExprEnv env(d, view, cache);
  const sc::BuildContext ctx{d, view, env, cache, nullptr, {}};
  // At 2 s: every vertex of the mask moved right 20 px, and the path opened.
  const sc::Snapshot snap = sc::build_snapshot(ctx, sc::snapshot_comp_of(d, "comp_root"), 2, std::nullopt);

  const sc::RLayer* masked = layer(snap, "masked");
  REQUIRE(masked != nullptr);
  REQUIRE(masked->mask.at("paths").is_array());
  const Json& m = first_mask_path(*masked);
  CHECK(m.at("points").arr().at(1).at("x").num() == 70);
  CHECK(m.at("points").arr().at(1).at("outX").num() == 70);
  CHECK_FALSE(m.at("closed").b());
  CHECK(m.at("mode").str() == "add");  // the path's other settings stay

  // The error leaves the authored mask.
  const sc::RLayer* broken = layer(snap, "broken");
  REQUIRE(broken != nullptr);
  CHECK(first_mask_path(*broken).at("points").arr().at(1).at("x").num() == 30);

  // A shape that follows Masked's post-expression mask.
  const sc::RLayer* outline = layer(snap, "outline");
  REQUIRE(outline != nullptr);
  REQUIRE(outline->pathPoints.is_array());
  REQUIRE(outline->pathPoints.arr().size() == 3);
  CHECK(outline->pathPoints.arr().at(0).at("x").num() == 20);
  CHECK(outline->pathPoints.arr().at(2).at("y").num() == 50);
  CHECK(outline->pathOpen);
}
