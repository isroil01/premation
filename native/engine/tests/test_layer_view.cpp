// The Layer panel on the scene builder (BuildContext::layerView, setViewport
// `layer`): the one layer alone — eye on, un-soloed, live — placed
// untransformed at the frame's centre with none of what the comp does to it,
// and the untouched source when Render is off.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <string>
#include <string_view>

#include "docexpr.hpp"
#include "docio.hpp"
#include "json.hpp"
#include "model.hpp"
#include "snapshot_build.hpp"

using Catch::Approx;
namespace doc = premation::doc;
namespace sc = premation::scene;

namespace {

// A 320×220 comp: `content` (a placed, rotated, half-size, 40 % solid with one
// effect, eye OFF), `child` parented under it, and `other` SOLOED — so the comp
// walk draws `other` alone and the Layer panel of `content` must ignore all of that.
const char* kProject = R"json({
  "version":"1.9.0",
  "scene":{"version":"1.0.0","nodes":[
    {"id":"comp_root","name":"Composition 1","parent":null,"children":["content","other"],
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},"visible":true,"locked":false,
     "components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
    {"id":"content","name":"content","children":["child"],"parent":"comp_root",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"content_t","type":"Transform","props":{"__kind":"shape","x":200,"y":150,"rotation":30,"scaleX":50,"scaleY":50,"width":100,"height":60}},
       {"id":"content_s","type":"Style","props":{"opacity":40,"fill":"#000"}},
       {"id":"content_fx","type":"fx","props":{"solid":true,"fill":"#ff2d55","effects":[{"id":"a1","type":"hue-rotate","params":{"amount":140}}]}}],
     "visible":false,"locked":false},
    {"id":"child","name":"child","children":[],"parent":"content",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"child_t","type":"Transform","props":{"__kind":"shape","x":10,"y":10,"rotation":0,"width":20,"height":20}},
       {"id":"child_s","type":"Style","props":{"opacity":100,"fill":"#000"}},
       {"id":"child_fx","type":"fx","props":{"solid":true,"fill":"#ffffff"}}],
     "visible":true,"locked":false},
    {"id":"other","name":"other","children":[],"parent":"comp_root",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"other_t","type":"Transform","props":{"__kind":"shape","x":40,"y":40,"rotation":0,"width":30,"height":30}},
       {"id":"other_s","type":"Style","props":{"opacity":100,"fill":"#000"}},
       {"id":"other_fx","type":"fx","props":{"solid":true,"fill":"#00ff00"}}],
     "visible":true,"locked":false,"solo":true}
  ]},
  "comps":{"comp_root":{"id":"comp_root","name":"comp_root","width":320,"height":220,"fps":30,"durationSeconds":10,"background":"#0c0c12"}},
  "motionBlur":{"enabled":false,"shutterAngle":180,"shutterPhase":-90,"samples":8,"adaptiveSampleLimit":128},
  "openTabs":{"tabOrder":["tab1"],"activeTabId":"tab1","tabs":{"tab1":{"id":"tab1","compositionId":"comp_root","breadcrumbPath":["comp_root"],"title":"comp_root","time":0,"frame":0}}}
})json";

const sc::RLayer* layer(const sc::Snapshot& s, std::string_view id) {
  for (const sc::RLayer& l : s.layers) {
    if (l.id == id) return &l;
  }
  return nullptr;
}

struct Fixture {
  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  Fixture() {
    const auto parsed = premation::js::parse(kProject);
    REQUIRE(parsed.has_value());
    (void)doc::restore_document(d, view, *parsed, {});
  }
  sc::Snapshot build(const std::optional<sc::BuildContext::LayerView>& lv) {
    const doc::DocExprEnv env(d, view, cache);
    sc::BuildContext ctx{d, view, env, cache, nullptr, {}};
    ctx.layerView = lv;
    sc::SnapshotComp comp = sc::snapshot_comp_of(d, "comp_root");
    if (lv) {
      // The frame builder sizes the Layer panel's frame to the layer's source (engine_frames.cpp).
      comp.width = 100;
      comp.height = 60;
      comp.transparent = true;
    }
    return sc::build_snapshot(ctx, comp, 0, std::nullopt);
  }
};

}  // namespace

TEST_CASE("the comp walk honours the eye and the solo: only `other` draws", "[scene][layer-view]") {
  Fixture f;
  const sc::Snapshot s = f.build(std::nullopt);
  const sc::RLayer* other = layer(s, "other");
  REQUIRE(other != nullptr);
  CHECK(other->visible);
  // A hidden / un-soloed layer is at most an invisible stub in the comp walk.
  for (const char* id : {"content", "child"}) {
    const sc::RLayer* l = layer(s, id);
    CHECK((l == nullptr || !l->visible));
  }
}

TEST_CASE("layerView: the one layer, eye on and un-soloed, centred and untransformed", "[scene][layer-view]") {
  Fixture f;
  const sc::Snapshot s = f.build(sc::BuildContext::LayerView{"content", true, std::nullopt});
  REQUIRE(s.layers.size() == 1);
  const sc::RLayer& l = s.layers.front();
  CHECK(l.id == "content");
  // Not the layer parented to it, not the soloed sibling.
  CHECK(layer(s, "child") == nullptr);
  CHECK(layer(s, "other") == nullptr);
  // Placed at the frame's centre, with none of what the comp does to it.
  CHECK(l.x == Approx(50));
  CHECK(l.y == Approx(30));
  CHECK(l.rotation == 0);
  CHECK(l.scaleX == 1);
  CHECK(l.scaleY == 1);
  CHECK(l.opacity == 1);
  CHECK(l.blend == "normal");
  CHECK(l.visible);
  CHECK(l.depth == 0);
  CHECK_FALSE(l.matrix.has_value());
  CHECK_FALSE(l.world3d.has_value());
  CHECK_FALSE(l.matte.has_value());
  CHECK(l.motionSamples.empty());
  // Render on: its own effects stay.
  CHECK(l.effects.size() == 1);
  // No 3D block, since nothing is 3D any more.
  CHECK_FALSE(s.camera3d.has_value());
}

TEST_CASE("layerView with Render off: the untouched source", "[scene][layer-view]") {
  Fixture f;
  const sc::Snapshot s = f.build(sc::BuildContext::LayerView{"content", false, std::nullopt});
  REQUIRE(s.layers.size() == 1);
  const sc::RLayer& l = s.layers.front();
  CHECK(l.effects.empty());
  CHECK(l.mask.is_undefined());
  CHECK(l.paint.is_undefined());
  CHECK_FALSE(l.cornerPin.has_value());
  CHECK_FALSE(l.glass.has_value());
  CHECK_FALSE(l.backdropBlur.has_value());
}

TEST_CASE("layerView of a layer that is not in the comp draws nothing", "[scene][layer-view]") {
  Fixture f;
  const sc::Snapshot s = f.build(sc::BuildContext::LayerView{"nope", true, std::nullopt});
  CHECK(s.layers.empty());
}
