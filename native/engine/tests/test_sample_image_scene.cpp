// AE `sampleImage` on the scene builder: the area average over a layer's
// pixels (doc::average_layer_pixels), an expression that samples another
// layer through the evaluation's pixel probe (one draw per layer and time in a
// frame), a layer whose drawing samples itself (a cycle, reported), and the
// frame sampleImage draws a layer in (its own space, alone).
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <memory>
#include <string>
#include <vector>

#include "docexpr.hpp"
#include "docio.hpp"
#include "json.hpp"
#include "model.hpp"
#include "native_scene.hpp"
#include "snapshot_build.hpp"

using Catch::Approx;
using premation::js::Json;
namespace doc = premation::doc;
namespace sc = premation::scene;

namespace {

const char* kProject = R"json({
  "version":"1.9.0",
  "scene":{"version":"1.0.0","nodes":[
    {"id":"comp_root","name":"Composition 1","parent":null,"children":["red","probe","self"],
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "visible":true,"locked":false,
     "components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
    {"id":"red","name":"Red","children":[],"parent":"comp_root",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"red_t","type":"Transform","props":{"__kind":"shape","x":300,"y":200,"rotation":30,"scaleX":1.5,"scaleY":1.5,"anchorX":50,"anchorY":0,"width":200,"height":100,"shapeType":"rect"}},
       {"id":"red_s","type":"Style","props":{"opacity":100,"fill":"#ff0000"}}],
     "visible":true,"locked":false},
    {"id":"probe","name":"Probe","children":[],"parent":"comp_root",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"probe_t","type":"Transform","props":{"__kind":"shape","x":600,"y":200,"rotation":0,"scaleX":1,"scaleY":1,"width":50,"height":50,"shapeType":"rect"}},
       {"id":"probe_s","type":"Style","props":{"opacity":100,"fill":"#ffffff"}}],
     "visible":true,"locked":false},
    {"id":"self","name":"Self","children":[],"parent":"comp_root",
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"self_t","type":"Transform","props":{"__kind":"shape","x":900,"y":200,"rotation":0,"scaleX":1,"scaleY":1,"width":50,"height":50,"shapeType":"rect"}},
       {"id":"self_s","type":"Style","props":{"opacity":100,"fill":"#ffffff"}}],
     "visible":true,"locked":false}
  ]},
  "animation":{"tracks":{},"data":{},"expressions":{
    "probe":{
      "opacity":{"src":"var c = thisComp.layer(\"Red\").sampleImage([-120, 0], [3, 3]); c[1] * 100","enabled":true},
      "rotation":{"src":"thisComp.layer(\"Red\").sampleImage([0, 0])[2] * 100","enabled":true},
      "x":{"src":"var r = thisComp.layer(\"Red\"); r.sampleImage(r.fromComp([300, 200]))[3] * 100","enabled":true}},
    "self":{"opacity":{"src":"sampleImage([1, 1])[0] * 100","enabled":true}}
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

TEST_CASE("sampleImage averages the covered pixels, colour weighted by alpha", "[scene][sampleImage]") {
  // 2 × 2: red | transparent / half-alpha green | blue (premultiplied).
  doc::LayerPixels px;
  px.width = 2;
  px.height = 2;
  px.rgba = {1, 0, 0, 1, 0, 0, 0, 0, 0, 0.5F, 0, 0.5F, 0, 0, 1, 1};

  auto at = [&](std::array<double, 2> p, std::array<double, 2> r) { return doc::average_layer_pixels(px, p, r); };
  CHECK(at({0.5, 0.5}, {0.5, 0.5}) == std::array<double, 4>{1, 0, 0, 1});
  CHECK(at({1.2, 1.7}, {0, 0}) == std::array<double, 4>{0, 0, 1, 1});  // the one pixel under the point
  // The top row: red and transparent — still red, half covered.
  const auto top = at({1, 0.5}, {1, 0.5});
  CHECK(top[0] == Approx(1));
  CHECK(top[3] == Approx(0.5));
  // The half-alpha green is straight green, not dark green.
  const auto green = at({0.5, 1.5}, {0.5, 0.5});
  CHECK(green[1] == Approx(1));
  CHECK(green[3] == Approx(0.5));
  // All four: premultiplied sum (1, 0.5, 1, 2.5) over 4 px.
  const auto all = at({1, 1}, {1, 1});
  CHECK(all[0] == Approx(0.4));
  CHECK(all[1] == Approx(0.2));
  CHECK(all[2] == Approx(0.4));
  CHECK(all[3] == Approx(0.625));
  // A quarter of a pixel each: half on red, half outside the layer.
  const auto edge = at({0, 0.5}, {0.5, 0.5});
  CHECK(edge[0] == Approx(1));
  CHECK(edge[3] == Approx(0.5));
  CHECK(at({10, 10}, {0.5, 0.5}) == std::array<double, 4>{});
  // Drawn at half size: layer point (1, 1) is pixel (0.5, 0.5).
  px.scale = 0.5;
  CHECK(at({1, 1}, {1, 1}) == std::array<double, 4>{1, 0, 0, 1});
}

TEST_CASE("an expression samples another layer through the pixel probe", "[scene][sampleImage]") {
  const auto parsed = premation::js::parse(kProject);
  REQUIRE(parsed.has_value());
  doc::Document d;
  doc::EditorView view;
  (void)doc::restore_document(d, view, *parsed, {});
  doc::ExprCache cache;
  const doc::DocExprEnv env(d, view, cache);

  struct Call {
    std::string node;
    double t = 0;
    bool post = true;
  };
  std::vector<Call> calls;
  std::string selfError;
  cache.pixelProbe = [&](const doc::DocExprEnv& e, std::string_view node, double t, bool post, std::string& error)
      -> std::shared_ptr<const doc::LayerPixels> {
    calls.push_back({std::string(node), t, post});
    if (node == "self") {
      // Drawing Self evaluates its own expression, which samples Self again.
      std::string inner;
      CHECK(e.layer_pixels(node, t, post, inner) == nullptr);
      selfError = inner;
      error = inner;
      return nullptr;
    }
    // Red's 200 × 100 box: the left half half-alpha (0.2, 0.6, 0) straight, the right half blue.
    auto px = std::make_shared<doc::LayerPixels>();
    px->width = 200;
    px->height = 100;
    px->boxWidth = 200;
    px->boxHeight = 100;
    for (std::uint32_t y = 0; y < 100; ++y) {
      for (std::uint32_t x = 0; x < 200; ++x) {
        const std::array<float, 4> c = x < 100 ? std::array<float, 4>{0.1F, 0.3F, 0, 0.5F} : std::array<float, 4>{0, 0, 1, 1};
        px->rgba.insert(px->rgba.end(), c.begin(), c.end());
      }
    }
    return px;
  };

  const sc::BuildContext ctx{d, view, env, cache, nullptr, {}};
  doc::ExprErrorCapture capture(cache);
  const doc::ExprEvalScope scope(cache);  // one frame, as build_native_frame opens it
  const sc::Snapshot snap = sc::build_snapshot(ctx, sc::snapshot_comp_of(d, "comp_root"), 2, std::nullopt);
  const std::vector<doc::ExprRuntimeError> errors = capture.take();

  const sc::RLayer* probe = layer(snap, "probe");
  REQUIRE(probe != nullptr);
  // The point is in toComp / fromComp's layer space: [0, 0] is Red's anchor,
  // 50 px right of its box's centre (box x 150, blue); [-120, 0] is box x 30.
  CHECK(probe->opacity == Approx(0.6));       // green 0.6 (straight, not darkened by alpha), opacity 0..1
  CHECK(probe->rotation == Approx(100));      // blue under the anchor
  CHECK(probe->x == Approx(100));             // sampleImage(fromComp(position)): the anchor's pixel
  // Three samples of Red at one time: drawn once (the frame's memo).
  std::size_t redDraws = 0;
  for (const Call& c : calls) {
    if (c.node != "red") continue;
    ++redDraws;
    CHECK(c.t == 2);
    CHECK(c.post);
  }
  CHECK(redDraws == 1);

  // Self samples itself: a cycle, reported; its opacity keeps the authored value.
  CHECK(selfError.find("cycle") != std::string::npos);
  const sc::RLayer* self = layer(snap, "self");
  REQUIRE(self != nullptr);
  CHECK(self->opacity == Approx(1));
  bool reported = false;
  for (const doc::ExprRuntimeError& e : errors) reported = reported || (e.node == "self" && e.prop == "opacity");
  CHECK(reported);
}

TEST_CASE("sampleImage draws the layer alone, untransformed, at its own size", "[scene][sampleImage]") {
  const auto parsed = premation::js::parse(kProject);
  REQUIRE(parsed.has_value());
  doc::Document d;
  doc::EditorView view;
  (void)doc::restore_document(d, view, *parsed, {});
  doc::ExprCache cache;
  const doc::DocExprEnv env(d, view, cache);
  sc::BuildContext ctx{d, view, env, cache, nullptr, {}};
  sc::layer_pixels_context(ctx, "red", true);
  const sc::LayerPixelsFrame lf = sc::build_layer_pixels_frame(ctx, "comp_root", "red", 0, sc::ViewSpec{});

  // Its box (Transform width × height), the layer space fromComp maps into.
  CHECK(lf.width == 200);
  CHECK(lf.height == 100);
  CHECK(lf.boxWidth == 200);
  CHECK(lf.boxHeight == 100);
  CHECK(lf.scale == 1);
  // The layer's box fills the surface: centred on the comp's centre, 1 px per layer unit.
  CHECK(lf.view.centerX == 960);
  CHECK(lf.view.centerY == 540);
  CHECK(lf.view.zoom == Approx(1));
  CHECK_FALSE(lf.view.clipToComp);
  // Only Red draws, with none of the comp's transform on it.
  const sc::Snapshot snap = sc::build_snapshot(ctx, sc::snapshot_comp_of(d, "comp_root"), 0, std::nullopt);
  REQUIRE(snap.layers.size() == 1);
  CHECK(snap.layers.front().id == "red");
  CHECK(snap.layers.front().rotation == 0);
  CHECK(snap.layers.front().scaleX == 1);
  CHECK(snap.layers.front().x == 960);
}
