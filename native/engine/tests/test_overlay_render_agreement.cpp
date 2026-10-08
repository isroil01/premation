// The overlay geometry push draws its 3D gizmos and cages from the overlay
// maths (core/worldxf.cpp through core/overlay_geometry.cpp); the frame is
// drawn from the scene builder's (scene/threed_port.cpp). The two must place a
// 3D layer in the same spot, or the gizmo floats off the layer it moves.
//
// Here: a 3D layer under a 2D null whose Position is keyed. The renderer lifts
// the null's ANIMATED world (the walk's world2d); the overlay used to lift the
// null's static geometry, so mid-move it left the layer where the null was
// authored.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <string>
#include <vector>

#include "core/overlay_geometry.hpp"
#include "docexpr.hpp"
#include "docio.hpp"
#include "json.hpp"
#include "native_scene.hpp"

namespace sc = premation::scene;
namespace doc = premation::doc;
namespace js = premation::js;
namespace api = premation::api;
using Catch::Approx;

namespace {

constexpr api::Time kSec = 705'600'000;

// `rig`: a 2D null keyed x 0 → 2000 over 2 s (linear). `card`: a 3D solid on it.
// `mid`: a 3D null on it, and `deep`: a 3D solid on `mid` — a chain where the 2D
// link sits ABOVE a 3D one.
constexpr std::string_view kProject = R"({"version":"1.9.0","scene":{"version":"1.0.0","nodes":[
  {"id":"comp_root","name":"Composition 1","parent":null,"children":["rig"],"transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},"visible":true,"locked":false,"components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
  {"id":"rig","name":"rig","parent":"comp_root","children":["card","mid"],"transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},"visible":true,"locked":false,"components":[
    {"id":"rig_t","type":"Transform","props":{"__kind":"null","x":0,"y":0,"rotation":0}}]},
  {"id":"card","name":"card","parent":"rig","children":[],"transform":{"position":{"x":100,"y":540},"rotation":0,"scale":{"x":1,"y":1}},"visible":true,"locked":false,"components":[
    {"id":"card_t","type":"Transform","props":{"__kind":"shape","x":100,"y":540,"rotation":0,"width":200,"height":120,"shapeType":"rect","z":0}},
    {"id":"card_s","type":"Style","props":{"opacity":100,"fill":"#ff8800"}}]},
  {"id":"mid","name":"mid","parent":"rig","children":["deep"],"transform":{"position":{"x":300,"y":200},"rotation":0,"scale":{"x":1,"y":1}},"visible":true,"locked":false,"components":[
    {"id":"mid_t","type":"Transform","props":{"__kind":"null","x":300,"y":200,"rotation":0,"z":150}}]},
  {"id":"deep","name":"deep","parent":"mid","children":[],"transform":{"position":{"x":-50,"y":40},"rotation":0,"scale":{"x":1,"y":1}},"visible":true,"locked":false,"components":[
    {"id":"deep_t","type":"Transform","props":{"__kind":"shape","x":-50,"y":40,"rotation":0,"width":160,"height":90,"shapeType":"rect","z":0}},
    {"id":"deep_s","type":"Style","props":{"opacity":100,"fill":"#2288ff"}}]}]},
  "animation":{"tracks":{"rig":{"x":{"nodeId":"rig","prop":"x","keyframes":[{"t":0,"value":0,"easing":"linear"},{"t":2,"value":2000,"easing":"linear"}]}}},"expressions":{}},
  "comps":{"comp_root":{"id":"comp_root","name":"comp_root","width":1920,"height":1080,"fps":30,"durationSeconds":10,"background":"#000000"}},
  "motionBlur":{"enabled":false,"shutterAngle":180,"shutterPhase":-90,"samples":8,"adaptiveSampleLimit":128},
  "colorManagement":{"workingSpace":"srgb-linear","displayTransform":"srgb","bitDepth":16},"projectItems":{"folders":[],"footage":{}},
  "openTabs":{"tabOrder":["tab1"],"activeTabId":"tab1","tabs":{"tab1":{"id":"tab1","compositionId":"comp_root","breadcrumbPath":["comp_root"],"title":"comp_root","time":0,"frame":0}}}})";

using Vec3 = std::array<double, 3>;

/// The layer's origin (its centre: anchor 0) in world space, from the renderer's quad model. The model maps the
/// unit quad onto the layer's pixel frame (threed_frame.cpp model3d_for: no padding, no anchor here), so the
/// origin is the quad's centre.
Vec3 render_origin(const std::vector<double>& m) {
  return {m[0] * 0.5 + m[4] * 0.5 + m[12], m[1] * 0.5 + m[5] * 0.5 + m[13], m[2] * 0.5 + m[6] * 0.5 + m[14]};
}

}  // namespace

TEST_CASE("overlay maths and the renderer agree on a 3D layer under a keyed 2D parent", "[overlay][threed]") {
  const auto json = js::parse(kProject);
  REQUIRE(json.has_value());
  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  (void)doc::restore_document(d, view, json.value(), {});
  doc::DocExprEnv env(d, view, cache);

  doc::OverlaySubscription sub;
  sub.viewport = 1;
  sub.layers = {"card", "deep"};
  sub.kinds = {api::OverlayKind::transform};
  const doc::PCtx pc{.d = d, .view = view, .expr = env, .cache = cache};

  for (const double seconds : {0.0, 1.0, 1.5}) {
    INFO("t = " << seconds << " s");
    const auto layers = doc::overlay_geometry(pc, nullptr, sub, static_cast<api::Time>(seconds * static_cast<double>(kSec)));
    REQUIRE(layers.size() == 2);

    const sc::BuildContext ctx{d, view, env, cache, nullptr, {}};
    const sc::NativeFrame f = sc::build_native_frame(ctx, "comp_root", seconds, sc::export_view(1920, 1080, 1920, 1080), false);
    for (const auto& e : f.errors) {
      INFO(e.layerId << ": " << e.message);
      CHECK((e.layerId != "card" && e.layerId != "deep"));
    }
    const double rigX = 1000 * seconds;  // the null's keyed x (linear, 0 → 2000 over 2 s)
    for (const auto& g : layers) {
      INFO(g.layer);
      REQUIRE(g.matrix.size() == 16);
      const api::Renderable* r = nullptr;
      for (const api::Renderable& x : f.file.scene.renderables) {
        if (x.id == g.layer) r = &x;
      }
      REQUIRE(r != nullptr);
      REQUIRE(r->three_d.has_value());
      const std::vector<double>& model = r->three_d.value().model;
      REQUIRE(model.size() == 16);
      const Vec3 drawn = render_origin(model);
      // The overlay's layer → world 4x4 takes the layer's origin to the same world point the frame drew it at.
      CHECK(g.matrix[12] == Approx(drawn[0]).margin(1e-3));
      CHECK(g.matrix[13] == Approx(drawn[1]).margin(1e-3));
      CHECK(g.matrix[14] == Approx(drawn[2]).margin(1e-3));
      // ... and that point moved with the null.
      if (g.layer == "card") {
        CHECK(g.matrix[12] == Approx(rigX + 100));
        CHECK(g.matrix[13] == Approx(540));
        CHECK(g.matrix[14] == Approx(0).margin(1e-9));
      } else {
        CHECK(g.matrix[12] == Approx(rigX + 300 - 50));
        CHECK(g.matrix[13] == Approx(240));
        CHECK(g.matrix[14] == Approx(150));
      }
    }
  }
}
