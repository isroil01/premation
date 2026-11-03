// Plugin SDK 1.2 — the frame hook (plugins/scene_finish.cpp) over a real
// document: the golden scene render-tests/scenes/plugin-particles-orbit.json
// (the `particles` sample on a comp-sized solid, the comp camera orbiting it).
//
//   S3  the chain entry carries the LAYER's time (start offset) and layer_start;
//   S1  checkout_time samples are evaluated off the document — the camera and
//       the params at each requested time, sub-frame exact, the same values a
//       frame built at that time carries — and travel in the entry;
//   S2  the shutter reaches the effect, and a USES_SHUTTER effect's layer is
//       not supersampled through it;
//   S4  a COMP_SPACE effect's reach grows its layer's buffer.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>

#include "docexpr.hpp"
#include "docio.hpp"
#include "fx_wire.hpp"
#include "cpu_render.hpp"
#include "host.hpp"
#include "json.hpp"
#include "model.hpp"
#include "native_effects.hpp"
#include "native_scene.hpp"
#include "scene_eval.hpp"
#include "scene_finish.hpp"
#include "timeline.hpp"

namespace pl = premation::plugins;
namespace doc = premation::doc;
namespace sc = premation::scene;
namespace api = premation::api;
namespace fs = std::filesystem;
using premation::js::Json;

namespace {

constexpr const char* kParticles = "com.premation.samples.particles";
constexpr double kFlicks = PR_TIME_SCALE;

Json scene_json(const char* name = "plugin-particles-orbit.json") {
  std::ifstream f(fs::path(PREMATION_GOLDEN_SCENES) / name, std::ios::binary);
  std::stringstream ss;
  ss << f.rdbuf();
  auto j = premation::js::parse(ss.str());
  REQUIRE(j.has_value());
  return *j;
}

Json* find_node(Json& doc, std::string_view id) {
  for (Json& n : doc.find_mut("scene")->find_mut("nodes")->arr_mut()) {
    if (n.at("id").str() == id) return &n;
  }
  return nullptr;
}

Json& fx_props(Json& node) {
  for (Json& c : node.find_mut("components")->arr_mut()) {
    if (c.at("type").str() == "fx") return *c.find_mut("props");
  }
  FAIL("no fx component");
  return node;
}

Json keys(std::initializer_list<std::pair<double, double>> list) {
  Json::Array a;
  for (const auto& [t, v] : list) {
    Json k = Json::object();
    k.set("t", Json::number(t));
    k.set("value", Json::number(v));
    a.push_back(std::move(k));
  }
  return Json::array(std::move(a));
}

void add_track(Json& doc, const std::string& node, const std::string& prop, Json keyframes) {
  Json& tracks = *doc.find_mut("animation")->find_mut("tracks");
  if (tracks.at(node).is_undefined()) tracks.set(node, Json::object());
  Json t = Json::object();
  t.set("nodeId", Json::string(node));
  t.set("prop", Json::string(prop));
  t.set("keyframes", std::move(keyframes));
  tracks.find_mut(node)->set(prop, std::move(t));
}

struct Fixture {
  explicit Fixture(Json document) {
    pl::HostOptions o;
    o.searchPaths = {fs::path(PREMATION_PLUGIN_BUNDLES)};
    o.threads = 2;
    o.onHang = [](const std::string&, std::string_view) { FAIL("unexpected hang"); };
    host = std::make_unique<pl::PluginHost>(std::move(o));  // registers the effects before the document opens
    (void)host->scan();
    REQUIRE(host->effect(kParticles) != nullptr);
    (void)doc::restore_document(d, view, document, {});
    env = std::make_unique<doc::DocExprEnv>(d, view, cache);
  }

  struct Built {
    api::Renderable solid;
    api::RenderEffect entry;
  };
  Built frame(double t, bool motionBlur = false, std::string_view id = "solid") {
    const sc::BuildContext ctx{d, view, *env, cache, nullptr, {}};
    const sc::ViewSpec vs = sc::export_view(480, 360, 480, 360);
    sc::NativeFrame nf = sc::build_native_frame(ctx, "comp_root", t, vs, motionBlur);
    pl::finish_native_frame(ctx, "comp_root", t, vs, motionBlur, nf, host.get());
    const api::Renderable* r = pl::find_renderable_in(nf.file.scene.renderables, id);
    REQUIRE(r != nullptr);
    Built b;
    b.solid = *r;
    for (const api::RenderEffect& e : r->effects) {
      if (e.type == pl::kNativeFxType) b.entry = e;
    }
    REQUIRE(b.entry.type == pl::kNativeFxType);
    return b;
  }
  /// The frame's layerErrors after the hook (the plugin stage only).
  std::vector<sc::LayerError> plugin_errors(double t) {
    const sc::BuildContext ctx{d, view, *env, cache, nullptr, {}};
    const sc::ViewSpec vs = sc::export_view(480, 360, 480, 360);
    sc::NativeFrame nf = sc::build_native_frame(ctx, "comp_root", t, vs, false);
    pl::finish_native_frame(ctx, "comp_root", t, vs, false, nf, host.get());
    std::vector<sc::LayerError> out;
    for (sc::LayerError& e : nf.errors) {
      if (e.stage == "plugin") out.push_back(std::move(e));
    }
    return out;
  }
  pl::RenderInputs decode(const api::RenderEffect& e) const {
    pl::RenderInputs in;
    pl::decode_native_fx(e, *host->effect(kParticles), in);
    return in;
  }

  std::unique_ptr<pl::PluginHost> host;
  doc::Document d;
  doc::EditorView view;
  doc::ExprCache cache;
  std::unique_ptr<doc::DocExprEnv> env;
};

double num(const api::RenderEffect& e, std::string_view name) {
  for (const auto& p : e.params) {
    if (p.name == name) return p.number;
  }
  return NAN;
}

std::int64_t flicks(double s) { return static_cast<std::int64_t>(std::llround(s * kFlicks)); }

}  // namespace

TEST_CASE("SDK 1.2 S3: the effect gets its layer's time", "[plugins][finish]") {
  Fixture f(scene_json());
  // At first the layer starts with the comp: layer time = comp time.
  pl::RenderInputs in = f.decode(f.frame(1.0).entry);
  CHECK(in.compTime == flicks(1.0));
  CHECK(in.layerTime == flicks(1.0));
  CHECK(in.layerStart == 0);
  CHECK(in.compW == 480);
  CHECK(in.compH == 360);
  CHECK_FALSE(in.layer3d);

  // Slide the layer to start at frame 15 (0.5 s): at comp 1 s it is 0.5 s into its own time.
  REQUIRE(doc::tl_ensure(f.d, "comp_root"));  // the layers' bars (the golden document carries none)
  bool moved = false;
  for (doc::Bar& b : f.d.timeline_mut("comp_root").bars) {
    if (b.sourceId && *b.sourceId == "solid") {
      b.clip.start = 15;
      moved = true;
    }
  }
  REQUIRE(moved);
  in = f.decode(f.frame(1.0).entry);
  CHECK(in.compTime == flicks(1.0));
  CHECK(in.layerTime == flicks(0.5));
  CHECK(in.layerStart == flicks(0.5));
}

TEST_CASE("SDK 1.4 L2: a plugin layer type's layer reaches the frame with its own generator, sized as the layer",
          "[plugins][finish][layertype]") {
  // The layer createLayer kind=generator makes (handlers_layers.cpp): a solid with a transparent
  // fill, fx.pluginLayer, and the type's generator as its effect `layer`.
  Json document = scene_json();
  Json* node = find_node(document, "solid");
  REQUIRE(node != nullptr);
  for (Json& c : node->find_mut("components")->arr_mut()) {
    if (c.at("type").str() == "Style") c.find_mut("props")->set("fill", Json::string("rgba(0,0,0,0)"));
  }
  Json& fx = fx_props(*node);
  Json fill = Json::object();
  fill.set("type", Json::string("solid"));
  fill.set("color", Json::string("rgba(0,0,0,0)"));
  fx.set("solid", Json::boolean(true));
  fx.set("fill", std::move(fill));
  fx.set("pluginLayer", Json::string("com.premation.samples.chartlayer:bars"));
  Json own = Json::object();
  own.set("id", Json::string("layer"));
  own.set("type", Json::string("com.premation.samples.chartlayer.bars"));
  Json params = Json::object();
  params.set("p4", Json::number(25));
  own.set("params", std::move(params));
  own.set("layerType", Json::boolean(true));
  Json::Array effects;
  effects.push_back(std::move(own));
  fx.set("effects", Json::array(std::move(effects)));

  Fixture f(std::move(document));
  const pl::EffectSpec* bars = f.host->effect("com.premation.samples.chartlayer.bars");
  REQUIRE(bars != nullptr);
  const Fixture::Built b = f.frame(0.5);
  // A transparent solid is not culled: its chain runs, and the generator draws it.
  const auto match = std::ranges::find_if(b.entry.params, [](const api::RenderEffectParam& p) { return p.name == "matchName"; });
  REQUIRE(match != b.entry.params.end());
  CHECK(match->text == "com.premation.samples.chartlayer.bars");
  pl::RenderInputs in;
  pl::decode_native_fx(b.entry, *bars, in);
  CHECK(in.instance == "solid/layer");
  CHECK(in.layerW == 480);
  CHECK(in.layerH == 360);
  const int slot = pl::param_slot(*bars, 4);
  REQUIRE(slot >= 0);
  CHECK(in.values.at(static_cast<std::size_t>(slot)).v[0] == 25);
  CHECK(f.plugin_errors(0.5).empty());
}

TEST_CASE("SDK 1.4 T: a simulation's state travels with the frame; the document's keyframes drive its steps",
          "[plugins][finish][sim]") {
  Json document = scene_json();
  Json* node = find_node(document, "solid");
  REQUIRE(node != nullptr);
  Json bounce = Json::object();
  bounce.set("id", Json::string("fx"));
  bounce.set("type", Json::string("com.premation.samples.bounce"));
  bounce.set("params", Json::object());
  Json::Array effects;
  effects.push_back(std::move(bounce));
  fx_props(*node).set("effects", Json::array(std::move(effects)));

  struct S {
    double x, y, vx, vy;
  };
  const auto state_at = [](Fixture& f, double t) {
    const Fixture::Built b = f.frame(t);
    const auto it = std::ranges::find_if(b.entry.params, [](const api::RenderEffectParam& p) { return p.name == "simState"; });
    REQUIRE(it != b.entry.params.end());
    const auto bytes = doc::native_unbase64(it->text);
    REQUIRE(bytes.has_value());
    REQUIRE(bytes->size() >= sizeof(S));
    S s{};
    std::memcpy(&s, bytes->data(), sizeof(S));
    return s;
  };

  Json keyed = document;  // the same, with Gravity keyed 900 → -900 from 1 s to 1.1 s
  {
    Fixture f(std::move(document));
    const S late = state_at(f, 2.0);
    const auto steps = f.host->sim_stats().steps;
    const S early = state_at(f, 0.5);  // scrubbing back: kept, no step
    CHECK(f.host->sim_stats().steps == steps);
    CHECK(early.y != late.y);
    CHECK(f.plugin_errors(2.0).empty());

    add_track(keyed, "solid", "effect.fx.p1", keys({{1.0, 900}, {1.1, -900}}));
    Fixture g(std::move(keyed));
    const S gEarly = state_at(g, 0.5);
    const S gLate = state_at(g, 2.0);
    CHECK(gEarly.y == early.y);  // before the keyframes nothing changed
    CHECK(gLate.y != late.y);    // after them, gravity points up
  }
}

TEST_CASE("SDK 1.2 S1: checkout_time samples are evaluated off the document", "[plugins][finish]") {
  Json document = scene_json();
  // Velocity keyed 100 → 200 over the first second: a sample must carry ITS time's value.
  add_track(document, "solid", "effect.fx.p3", keys({{0, 100}, {1, 200}}));
  Fixture f(std::move(document));
  const double t = 0.5;
  const Fixture::Built b = f.frame(t);
  const pl::RenderInputs in = f.decode(b.entry);
  // Trail Length 3: the three frames before this one, everything sampled.
  REQUIRE(in.samples.size() == 3);
  const std::int64_t step = flicks(1.0 / 30);
  for (std::size_t i = 0; i < 3; ++i) {
    const pl::TimeSample& s = in.samples[i];
    INFO("sample " << i);
    CHECK(s.time == in.layerTime - static_cast<std::int64_t>(3 - i) * step);
    CHECK(s.what == PR_SAMPLE_ALL);
    // The same values a frame built at that time carries — camera and params.
    const pl::RenderInputs at = f.decode(f.frame(static_cast<double>(s.time) / kFlicks).entry);
    REQUIRE(s.camera.has_value());
    REQUIRE(at.camera.has_value());
    CHECK(s.camera->hasCamera);
    for (std::size_t k = 0; k < 16; ++k) {
      CHECK(std::abs(s.camera->view.at(k) - at.camera->view.at(k)) < 1e-6 * std::max(1.0, std::abs(at.camera->view.at(k))));
      CHECK(std::abs(s.camera->projection.at(k) - at.camera->projection.at(k)) < 1e-6 * std::max(1.0, std::abs(at.camera->projection.at(k))));
    }
    REQUIRE(s.values.size() == at.values.size());
    CHECK(std::abs(s.values[2].v[0] - at.values[2].v[0]) < 1e-9);  // p3 (Velocity)
  }
  // The camera orbits: the samples are not the frame's camera.
  REQUIRE(in.camera.has_value());
  CHECK(std::abs(in.samples[0].camera->view[12] - in.camera->view[12]) > 1);
  // Velocity at t - 3 frames: 100 + 100 × (0.5 − 0.1).
  CHECK(std::abs(in.samples[0].values[2].v[0] - 140) < 1e-6);
  CHECK(std::abs(in.values[2].v[0] - 150) < 1e-6);

  SECTION("between frames (a shutter), the time is exact, not the nearest frame") {
    // Comp motion blur on, the layer's switch on: the shutter's sub-frame times come back.
    Json mbDoc = scene_json();
    add_track(mbDoc, "solid", "effect.fx.p3", keys({{0, 100}, {1, 200}}));
    mbDoc.find_mut("motionBlur")->set("enabled", Json::boolean(true));
    fx_props(*find_node(mbDoc, "solid")).set("motionBlur", Json::boolean(true));
    Fixture g(std::move(mbDoc));
    const pl::RenderInputs mb = g.decode(g.frame(t, true).entry);
    CHECK(mb.motionBlur);
    CHECK(mb.shutterAngle == 180);
    CHECK(mb.shutterPhase == -90);
    // 8 shutter samples (the comp's), the frame's own time among none of them, plus the trail.
    REQUIRE(mb.samples.size() == 3 + 8);
    bool between = false;
    for (const pl::TimeSample& s : mb.samples) {
      if (s.time % step == 0) continue;
      between = true;
      const double expect = 100 + 100 * (static_cast<double>(s.time) / kFlicks);
      CHECK(std::abs(s.values[2].v[0] - expect) < 1e-6);
    }
    CHECK(between);
  }
}

TEST_CASE("SDK 1.2 S2: a USES_SHUTTER effect's layer is not supersampled through it", "[plugins][finish]") {
  Json document = scene_json();
  document.find_mut("motionBlur")->set("enabled", Json::boolean(true));
  fx_props(*find_node(document, "solid")).set("motionBlur", Json::boolean(true));
  // The solid moves fast: the comp's motion blur would draw it at 8 shutter samples.
  add_track(document, "solid", "x", keys({{0, 0}, {1, 480}}));
  Fixture f(std::move(document));
  const Fixture::Built blurred = f.frame(0.5, true);
  CHECK(num(blurred.entry, "mb") == 1);
  CHECK(blurred.solid.motion_samples.empty());  // particles blurs itself (PR_OUT_FLAG_USES_SHUTTER)
  // The viewer's motion blur off: the effect is told so.
  CHECK(num(f.frame(0.5, false).entry, "mb") == 0);
}

TEST_CASE("SDK 1.2 S4: a COMP_SPACE effect reaches the comp", "[plugins][finish]") {
  Fixture f(scene_json());
  CHECK(std::abs(num(f.frame(0).entry, "reachPx") - std::hypot(480.0, 360.0)) < 1e-9);
}

TEST_CASE("SDK 1.2 S6: PR_SAMPLE_SCENE_DEPTH carries the 3D layers and the camera at each sub-time", "[plugins][finish][sdk12]") {
  // The model3d occlusion scene: a 3D wall, an orbiting camera (x keyed 320 → 160 over 1 s).
  // The wall slides too, and motion blur is on: model3d (Motion Blur + Composite with Scene Depth)
  // checks out the depth at its shutter's sub-times.
  Json document = scene_json("plugin-model3d-occlusion.json");
  document.find_mut("motionBlur")->set("enabled", Json::boolean(true));
  fx_props(*find_node(document, "solid")).set("motionBlur", Json::boolean(true));
  add_track(document, "wall", "x", keys({{0, 150}, {1, 450}}));
  Fixture f(std::move(document));
  const pl::EffectSpec* spec = f.host->effect("com.premation.samples.model3d");
  REQUIRE(spec != nullptr);
  const double t = 0.5;
  const Fixture::Built b = f.frame(t, true);
  pl::RenderInputs in;
  pl::decode_native_fx(b.entry, *spec, in);
  REQUIRE(in.motionBlur);
  REQUIRE_FALSE(in.samples.empty());
  // The frame's wall, for the motion each sub-time adds.
  const sc::BuildContext ctx{f.d, f.view, *f.env, f.cache, nullptr, {}};
  sc::NativeFrame nf = sc::build_native_frame(ctx, "comp_root", t, sc::export_view(480, 360, 480, 360), true);
  const api::Renderable* wall = pl::find_renderable_in(nf.file.scene.renderables, "wall");
  REQUIRE(wall != nullptr);
  REQUIRE(wall->three_d.has_value());
  const double frameX = wall->three_d->model.at(12);
  for (const pl::TimeSample& s : in.samples) {
    INFO("sample at " << static_cast<double>(s.time) / kFlicks);
    CHECK((s.what & PR_SAMPLE_SCENE_DEPTH) != 0);
    REQUIRE(s.depth.has_value());
    // The wall, moved by what its x track adds between the frame and the sample (300 px/s).
    const auto it = std::ranges::find_if(s.depth->models, [](const auto& m) { return m.first == "wall"; });
    REQUIRE(it != s.depth->models.end());
    const double dt = static_cast<double>(s.time) / kFlicks - t;
    CHECK(std::abs(it->second.at(12) - (frameX + 300 * dt)) < 1e-3);
    // The camera at that time (it moves too): not the frame's.
    REQUIRE(s.depth->camera.has_value());
    REQUIRE(in.camera.has_value());
    // (the wire carries view and projection: the eye moves with x, keyed 320 -> 160 over 1 s)
    double moved = 0;
    for (std::size_t k = 0; k < 16; ++k) moved = std::max(moved, std::abs(s.depth->camera->view.at(k) - in.camera->view.at(k)));
    CHECK(moved > 1e-6);
    // The model's own layer is drawn by the effect, never into its depth: its id may be listed
    // (the pass excludes it), but nothing else of the comp is missing.
    CHECK(s.depth->models.size() >= 1);
  }
}

TEST_CASE("SDK get_layer_transform: layer px -> world, the same in the render and the overlay, on the drawn corners",
          "[plugins][finish][layer-transform]") {
  // model3d's Transform Layer (LAYER param p7) names a 3D layer (turned, anchor moved) or a 2D one
  // (scaled, rotated, anchor moved). pr_host.h: the matrix maps LAYER px — (0, 0) the top-left,
  // (w, h) the bottom-right of the layer as drawn — to comp world px.
  Json document = scene_json("plugin-model3d-occlusion.json");
  for (Json& c : find_node(document, "wall")->find_mut("components")->arr_mut()) {
    if (c.at("type").str() != "Transform") continue;
    c.find_mut("props")->set("anchorX", Json::number(20));
    c.find_mut("props")->set("anchorY", Json::number(-30));
    c.find_mut("props")->set("rotationX", Json::number(-15));
  }
  {
    Json flat = *find_node(document, "wall");
    flat.set("id", Json::string("flat"));
    flat.set("name", Json::string("Flat"));
    Json comps = Json::array();
    Json t = Json::object();
    t.set("id", Json::string("flat_t"));
    t.set("type", Json::string("Transform"));
    Json props = Json::object();
    props.set("__kind", Json::string("shape"));
    props.set("shapeType", Json::string("rect"));
    props.set("x", Json::number(330));
    props.set("y", Json::number(110));
    props.set("width", Json::number(80));
    props.set("height", Json::number(40));
    props.set("rotation", Json::number(30));
    props.set("scaleX", Json::number(1.5));
    props.set("scaleY", Json::number(0.75));
    props.set("anchorX", Json::number(10));
    props.set("anchorY", Json::number(-5));
    t.set("props", std::move(props));
    comps.arr_mut().push_back(std::move(t));
    for (const Json& c : find_node(document, "wall")->at("components").arr()) {
      if (c.at("type").str() == "Style") comps.arr_mut().push_back(c);
    }
    flat.set("components", std::move(comps));
    document.find_mut("scene")->find_mut("nodes")->arr_mut().push_back(std::move(flat));
    Json* root = find_node(document, "comp_root");
    root->find_mut("children")->arr_mut().push_back(Json::string("flat"));
  }
  for (const char* target : {"wall", "flat"}) {
    INFO("Transform Layer = " << target);
    Json d = document;
    for (Json& c : find_node(d, "solid")->find_mut("components")->arr_mut()) {
      if (c.at("type").str() == "fx") c.find_mut("props")->find_mut("effects")->arr_mut()[0].find_mut("params")->set("p7", Json::string(target));
    }
    Fixture f(std::move(d));
    const pl::EffectSpec* spec = f.host->effect("com.premation.samples.model3d");
    REQUIRE(spec != nullptr);
    const int slot = [&] {
      for (std::size_t i = 0; i < spec->params.size(); ++i) {
        if (spec->params[i].id == 7) return static_cast<int>(i);
      }
      return -1;
    }();
    REQUIRE(slot >= 0);
    const double t = 0.25;
    // The render path: the chain entry finish_native_frame writes.
    pl::RenderInputs in;
    pl::decode_native_fx(f.frame(t).entry, *spec, in);
    REQUIRE(in.layerMatrices.size() > static_cast<std::size_t>(slot));
    REQUIRE(in.layerMatrices[static_cast<std::size_t>(slot)].has_value());
    const std::array<double, 16> render = *in.layerMatrices[static_cast<std::size_t>(slot)];
    // The overlay path: what DRAW_OVERLAY's request carries.
    doc::NativeActionRequest req;
    req.layer = "solid";
    req.type = spec->matchName;
    req.params = Json::object();
    req.params.set("p7", Json::string(target));
    req.timeSeconds = t;
    pl::overlay_scene(doc::SpaceCtx{f.d, f.view, *f.env, f.cache}, *spec, req);
    REQUIRE(req.scene.has_value());
    REQUIRE(req.scene->matrices.size() == 1);
    const std::vector<double>& overlay = req.scene->matrices[0].second;
    REQUIRE(overlay.size() == 16);
    for (std::size_t k = 0; k < 16; ++k) CHECK(std::abs(render.at(k) - overlay[k]) < 1e-9 * std::max(1.0, std::abs(overlay[k])));
    // Layer px (0, 0) and (w, h) land on the corners the frame draws: the renderable's unit quad.
    const sc::BuildContext ctx{f.d, f.view, *f.env, f.cache, nullptr, {}};
    sc::NativeFrame nf = sc::build_native_frame(ctx, "comp_root", t, sc::export_view(480, 360, 480, 360), false);
    const api::Renderable* r = pl::find_renderable_in(nf.file.scene.renderables, target);
    REQUIRE(r != nullptr);
    const double w = std::string_view(target) == "wall" ? 150 : 80;
    const double h = std::string_view(target) == "wall" ? 300 : 40;
    const auto apply = [](const auto& m, double x, double y) {
      return std::array<double, 3>{m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13], m[2] * x + m[6] * y + m[14]};
    };
    std::array<std::array<double, 3>, 2> drawn{};
    if (r->three_d) {
      const auto& m = r->three_d->model;
      drawn = {apply(m, 0, 0), apply(m, 1, 1)};
    } else {
      const auto& m = r->model_matrix;  // Mat3, column-major: the unit quad onto the comp
      drawn = {std::array<double, 3>{m[6], m[7], 0}, std::array<double, 3>{m[0] + m[3] + m[6], m[1] + m[4] + m[7], 0}};
    }
    CHECK((r->three_d.has_value()) == (std::string_view(target) == "wall"));
    const std::array<std::array<double, 3>, 2> mapped{apply(render, 0, 0), apply(render, w, h)};
    for (std::size_t c = 0; c < 2; ++c) {
      INFO("corner " << c << " mapped " << mapped[c][0] << "," << mapped[c][1] << "," << mapped[c][2] << " drawn " << drawn[c][0] << ","
                     << drawn[c][1] << "," << drawn[c][2]);
      for (std::size_t k = 0; k < 3; ++k) CHECK(std::abs(mapped[c][k] - drawn[c][k]) < 1e-3);
    }
  }
}

TEST_CASE("a COLOR param stored as something other than a colour renders its default and is reported once",
          "[plugins][finish]") {
  for (const char* bad : {"array", "malformed"}) {
    Json document = scene_json();
    Json& props = fx_props(*find_node(document, "solid"));
    Json& params = *props.find_mut("effects")->arr_mut().at(0).find_mut("params");
    if (std::string_view(bad) == "array") {
      Json::Array a;
      for (int i = 0; i < 4; ++i) a.push_back(Json::number(1));
      params.set("p8", Json::array(std::move(a)));  // what the model3d goldens once stored
    } else {
      params.set("p8", Json::string("#12345"));
    }
    Fixture f(std::move(document));
    // The declared default (particles: Color {1, 0.85, 0.4}) reaches the plugin, not white.
    const pl::RenderInputs in = f.decode(f.frame(0.5).entry);
    const auto& specs = f.host->effect(kParticles)->params;
    std::size_t color = specs.size();
    for (std::size_t i = 0; i < specs.size(); ++i) {
      if (specs[i].key == "p8") color = i;
    }
    REQUIRE(color < in.values.size());
    INFO(bad);
    CHECK(in.values.at(color).v.at(0) > 0.99);
    CHECK(in.values.at(color).v.at(2) < 0.5);
    const auto errors = f.plugin_errors(0.5);
    REQUIRE(errors.size() == 1);
    CHECK(errors[0].layerId == "solid");
    CHECK(errors[0].message.find("'Color' is not a colour") != std::string::npos);
  }
  // A document colour: no error.
  Fixture ok(scene_json());
  CHECK(ok.plugin_errors(0.5).empty());
}

TEST_CASE("SDK 1.2 S3: in a nested comp, comp_time and layer_start are that comp's", "[plugins][finish]") {
  // The particles solid moved into comp "inner"; the top comp shows it through a sealed
  // instance "pc" that starts at 0.5 s and is stretched to 200 %.
  Json document = scene_json();
  Json innerRec = Json::object();
  innerRec.set("id", Json::string("inner"));
  innerRec.set("name", Json::string("inner"));
  innerRec.set("width", Json::number(480));
  innerRec.set("height", Json::number(360));
  innerRec.set("fps", Json::number(30));
  innerRec.set("durationSeconds", Json::number(10));
  innerRec.set("background", Json::string("#000000"));
  document.find_mut("comps")->set("inner", std::move(innerRec));
  document.find_mut("comps")->find_mut("comp_root")->set("durationSeconds", Json::number(10));
  auto& nodes = document.find_mut("scene")->find_mut("nodes")->arr_mut();
  for (Json& n : nodes) {
    if (n.at("id").str() == "comp_root") {
      Json::Array kids;
      kids.push_back(Json::string("pc"));
      kids.push_back(Json::string("cam"));
      n.set("children", Json::array(std::move(kids)));
    }
    if (n.at("id").str() == "solid") n.set("parent", Json::string("inner"));
  }
  const auto component = [](const char* id, const char* type, Json props) {
    Json c = Json::object();
    c.set("id", Json::string(id));
    c.set("type", Json::string(type));
    c.set("props", std::move(props));
    return c;
  };
  const auto node = [](const char* id, std::optional<const char*> parent, std::vector<const char*> children, Json::Array comps) {
    Json n = Json::object();
    n.set("id", Json::string(id));
    n.set("name", Json::string(id));
    n.set("parent", parent ? Json::string(*parent) : Json::null());
    Json::Array kids;
    for (const char* k : children) kids.push_back(Json::string(k));
    n.set("children", Json::array(std::move(kids)));
    n.set("visible", Json::boolean(true));
    n.set("locked", Json::boolean(false));
    n.set("components", Json::array(std::move(comps)));
    return n;
  };
  {
    Json meta = Json::object();
    meta.set("__kind", Json::string("group"));
    Json::Array comps;
    comps.push_back(component("inner_meta", "group", std::move(meta)));
    nodes.push_back(node("inner", std::nullopt, {"solid"}, std::move(comps)));
  }
  {
    Json t = Json::object();
    t.set("__kind", Json::string("comp"));
    t.set("x", Json::number(240));
    t.set("y", Json::number(180));
    t.set("rotation", Json::number(0));
    t.set("width", Json::number(480));
    t.set("height", Json::number(360));
    Json st = Json::object();
    st.set("opacity", Json::number(100));
    Json fx = Json::object();
    fx.set("precomp", Json::boolean(true));
    fx.set("__compRef", Json::string("inner"));
    Json time = Json::object();
    time.set("stretch", Json::number(200));
    fx.set("time", std::move(time));
    Json::Array comps;
    comps.push_back(component("pc_t", "Transform", std::move(t)));
    comps.push_back(component("pc_s", "Style", std::move(st)));
    comps.push_back(component("pc_fx", "fx", std::move(fx)));
    nodes.push_back(node("pc", "comp_root", {}, std::move(comps)));
  }
  Fixture f(std::move(document));
  REQUIRE(doc::tl_ensure(f.d, "comp_root"));
  REQUIRE(doc::tl_ensure(f.d, "inner"));
  int moved = 0;
  for (doc::Bar& b : f.d.timeline_mut("comp_root").bars) {
    if (b.sourceId && *b.sourceId == "pc") {
      b.clip.start = 15;  // the instance starts at 0.5 s
      ++moved;
    }
  }
  for (doc::Bar& b : f.d.timeline_mut("inner").bars) {
    if (b.sourceId && *b.sourceId == "solid") {
      b.clip.start = 3;  // the layer starts 0.1 s into its comp
      ++moved;
    }
  }
  REQUIRE(moved == 2);

  // Top 1.5 s: the instance is 1.0 s in at half speed — inner 0.5 s; the layer 0.4 s into its time.
  const Fixture::Built b = f.frame(1.5, false, "pc::solid");
  const pl::RenderInputs in = f.decode(b.entry);
  CHECK(in.compTime == flicks(0.5));
  CHECK(in.layerTime == flicks(0.4));
  CHECK(in.layerStart == flicks(0.1));

  // checkout_time at layer times maps back to the TOP comp: one layer frame = two top frames.
  REQUIRE(in.samples.size() == 3);
  const std::int64_t step = flicks(1.0 / 30);
  for (std::size_t i = 0; i < 3; ++i) {
    const pl::TimeSample& s = in.samples[i];
    INFO("sample " << i);
    CHECK(s.time == in.layerTime - static_cast<std::int64_t>(3 - i) * step);
    const double top = 1.5 - (2.0 * static_cast<double>(3 - i)) / 30;
    const pl::RenderInputs at = f.decode(f.frame(top, false, "pc::solid").entry);
    REQUIRE(s.camera.has_value());
    REQUIRE(at.camera.has_value());
    for (std::size_t k = 0; k < 16; ++k) {
      CHECK(std::abs(s.camera->view.at(k) - at.camera->view.at(k)) < 1e-6 * std::max(1.0, std::abs(at.camera->view.at(k))));
    }
  }
}

TEST_CASE("SDK 1.2 S6: a collapsed precomp's 3D layers are posed at each sub-time by their instance's motion too",
          "[plugins][finish][sdk12]") {
  // The model3d occlusion scene with its 3D wall moved into comp "inner", shown through a
  // COLLAPSED 3D instance "pc" whose x is keyed 240 -> 540 over 1 s; the wall itself does not move.
  Json document = scene_json("plugin-model3d-occlusion.json");
  document.find_mut("motionBlur")->set("enabled", Json::boolean(true));
  fx_props(*find_node(document, "solid")).set("motionBlur", Json::boolean(true));
  Json innerRec = Json::object();
  innerRec.set("id", Json::string("inner"));
  innerRec.set("name", Json::string("inner"));
  innerRec.set("width", Json::number(480));
  innerRec.set("height", Json::number(360));
  innerRec.set("fps", Json::number(30));
  innerRec.set("durationSeconds", Json::number(2));
  innerRec.set("background", Json::string("#000000"));
  document.find_mut("comps")->set("inner", std::move(innerRec));
  auto& nodes = document.find_mut("scene")->find_mut("nodes")->arr_mut();
  for (Json& n : nodes) {
    if (n.at("id").str() == "comp_root") {
      Json::Array kids;
      for (const char* k : {"pc", "solid", "cam", "key", "fill"}) kids.push_back(Json::string(k));
      n.set("children", Json::array(std::move(kids)));
    }
    if (n.at("id").str() == "wall") n.set("parent", Json::string("inner"));
  }
  const auto component = [](const char* id, const char* type, Json props) {
    Json c = Json::object();
    c.set("id", Json::string(id));
    c.set("type", Json::string(type));
    c.set("props", std::move(props));
    return c;
  };
  const auto node = [](const char* id, const Json& parent, const char* child, Json::Array comps) {
    Json n = Json::object();
    n.set("id", Json::string(id));
    n.set("name", Json::string(id));
    n.set("parent", parent);
    Json::Array kids;
    if (child != nullptr) kids.push_back(Json::string(child));
    n.set("children", Json::array(std::move(kids)));
    n.set("visible", Json::boolean(true));
    n.set("locked", Json::boolean(false));
    n.set("components", Json::array(std::move(comps)));
    return n;
  };
  {
    Json meta = Json::object();
    meta.set("__kind", Json::string("group"));
    Json::Array comps;
    comps.push_back(component("inner_meta", "group", std::move(meta)));
    nodes.push_back(node("inner", Json::null(), "wall", std::move(comps)));
  }
  {
    Json t = Json::object();
    t.set("__kind", Json::string("comp"));
    t.set("x", Json::number(240));
    t.set("y", Json::number(180));
    t.set("z", Json::number(0));
    t.set("rotation", Json::number(0));
    t.set("width", Json::number(480));
    t.set("height", Json::number(360));
    Json st = Json::object();
    st.set("opacity", Json::number(100));
    Json fx = Json::object();
    fx.set("precomp", Json::boolean(true));
    fx.set("__compRef", Json::string("inner"));
    fx.set("collapseTransforms", Json::boolean(true));
    Json::Array comps;
    comps.push_back(component("pc_t", "Transform", std::move(t)));
    comps.push_back(component("pc_s", "Style", std::move(st)));
    comps.push_back(component("pc_fx", "fx", std::move(fx)));
    nodes.push_back(node("pc", Json::string("comp_root"), nullptr, std::move(comps)));
  }
  add_track(document, "pc", "x", keys({{0, 240}, {1, 540}}));
  Fixture f(std::move(document));
  const pl::EffectSpec* spec = f.host->effect("com.premation.samples.model3d");
  REQUIRE(spec != nullptr);
  const double t = 0.5;
  const Fixture::Built b = f.frame(t, true);
  pl::RenderInputs in;
  pl::decode_native_fx(b.entry, *spec, in);
  REQUIRE(in.motionBlur);
  REQUIRE_FALSE(in.samples.empty());
  const sc::BuildContext ctx{f.d, f.view, *f.env, f.cache, nullptr, {}};
  const auto model_at = [&](double seconds) {
    const doc::TlSubFrameScope subFrame;
    sc::NativeFrame nf = sc::build_native_frame(ctx, "comp_root", seconds, sc::export_view(480, 360, 480, 360), false);
    const api::Renderable* wall = pl::find_renderable_in(nf.file.scene.renderables, "pc::wall");
    REQUIRE(wall != nullptr);
    REQUIRE(wall->three_d.has_value());
    return wall->three_d->model;
  };
  const std::vector<double> frameModel = model_at(t);
  for (const pl::TimeSample& s : in.samples) {
    const double at = static_cast<double>(s.time) / kFlicks;
    INFO("sample at " << at);
    REQUIRE(s.depth.has_value());
    const auto it = std::ranges::find_if(s.depth->models, [](const auto& m) { return m.first == "pc::wall"; });
    REQUIRE(it != s.depth->models.end());  // before: not posed (the document cannot place a collapsed copy)
    const std::vector<double> truth = model_at(at);
    for (std::size_t k = 0; k < 16; ++k) CHECK(std::abs(it->second.at(k) - truth.at(k)) < 1e-6 * std::max(1.0, std::abs(truth.at(k))));
    // The instance moved it: 300 px/s along x from the frame's pose.
    CHECK(std::abs((it->second.at(12) - frameModel.at(12)) - 300 * (at - t)) < 1e-3);
  }
}

namespace {
Json effect_json(const char* id, const char* type, Json params = Json::object()) {
  Json e = Json::object();
  e.set("id", Json::string(id));
  e.set("type", Json::string(type));
  e.set("params", std::move(params));
  return e;
}

const api::RenderEffect* entry_of(const api::Renderable& r, std::string_view matchName) {
  for (const api::RenderEffect& e : r.effects) {
    if (e.type != pl::kNativeFxType) continue;
    for (const api::RenderEffectParam& p : e.params) {
      if (p.name == "matchName" && p.text == matchName) return &e;
    }
  }
  return nullptr;
}

const api::RenderEffectParam* param_named(const api::RenderEffect& e, std::string_view name) {
  for (const api::RenderEffectParam& p : e.params) {
    if (p.name == name) return &p;
  }
  return nullptr;
}
}  // namespace

TEST_CASE("SDK 1.4 E3: a keyframed gradient reaches the frame blended, by the plugin's interpolator when the key names one",
          "[plugins][finish][compound]") {
  Json document = scene_json();
  Json* node = find_node(document, "solid");
  REQUIRE(node != nullptr);
  Json::Array effects;
  effects.push_back(effect_json("fx", "com.premation.samples.grademap"));
  fx_props(*node).set("effects", Json::array(std::move(effects)));
  const auto stops = [](double pos) {
    return *premation::js::parse("[[" + std::to_string(pos) + ",0,0,0,1],[1,1,1,1,1]]");
  };
  Json k0 = Json::object();
  k0.set("t", Json::number(0));
  k0.set("value", stops(0));
  Json k1 = Json::object();
  k1.set("t", Json::number(1));
  k1.set("value", stops(0.5));
  Json track = Json::object();
  track.set("nodeId", Json::string("solid"));
  track.set("prop", Json::string("effect.fx.p3"));
  track.set("kind", Json::string("numbers"));
  track.set("keyframes", Json::array({k0, k1}));
  Json data = Json::object();
  Json forNode = Json::object();
  forNode.set("effect.fx.p3", track);
  data.set("solid", std::move(forNode));
  Json eased = document;
  document.find_mut("animation")->set("data", data);
  // The same, with the first key eased by mathfns' smoothblend.
  Json withInterp = data;
  Json& keys0 = *withInterp.find_mut("solid")->find_mut("effect.fx.p3")->find_mut("keyframes");
  keys0.arr_mut()[0].set("interp", Json::string("com.premation.samples.mathfns:smoothblend"));
  eased.find_mut("animation")->set("data", withInterp);

  const auto first_stop = [](Fixture& f, double t) {
    const Fixture::Built b = f.frame(t);
    pl::RenderInputs in;
    pl::decode_native_fx(b.entry, *f.host->effect("com.premation.samples.grademap"), in);
    const pl::EffectSpec& spec = *f.host->effect("com.premation.samples.grademap");
    for (std::size_t i = 0; i < spec.params.size(); ++i) {
      if (spec.params[i].key == "p3") return in.values.at(i).gradient.at(0);
    }
    FAIL("no p3");
    return 0.0;
  };
  {
    Fixture f(std::move(document));
    CHECK(std::abs(first_stop(f, 0.25) - 0.125) < 1e-9);  // linear: a quarter of the way to 0.5
    CHECK(std::abs(first_stop(f, 2.0) - 0.5) < 1e-9);
  }
  {
    Fixture g(std::move(eased));
    g.host->publish_expression_functions();
    CHECK(std::abs(first_stop(g, 0.25) - 0.5 * 0.15625) < 1e-9);  // smoothstep(0.25)
  }
}

TEST_CASE("SDK 1.4 C: a controller's published channel reaches its readers in the same frame; a cycle is refused",
          "[plugins][finish][channels]") {
  Json document = scene_json();
  Json* node = find_node(document, "solid");
  REQUIRE(node != nullptr);
  Json cparams = Json::object();
  cparams.set("p1", Json::number(80));  // Strength
  cparams.set("p2", Json::number(0));   // Rate: a constant 0.5 × strength
  Json::Array effects;
  effects.push_back(effect_json("follow", "com.premation.samples.channels.follower"));  // reads before it in the stack
  effects.push_back(effect_json("ctrl", "com.premation.samples.channels.controller", cparams));
  fx_props(*node).set("effects", Json::array(std::move(effects)));
  Json cyclic = document;
  {
    Fixture f(std::move(document));
    const Fixture::Built b = f.frame(1.0);
    const api::RenderEffect* follower = entry_of(b.solid, "com.premation.samples.channels.follower");
    REQUIRE(follower != nullptr);
    const api::RenderEffectParam* pulse = param_named(*follower, "ch.pulse");
    REQUIRE(pulse != nullptr);
    REQUIRE(pulse->numbers.size() == 3);
    CHECK(std::abs(pulse->numbers[0] - 0.4) < 1e-12);
    CHECK(pulse->numbers[1] == 0.8);
    // The controller itself reads nothing: no channels on its entry.
    const api::RenderEffect* ctrl = entry_of(b.solid, "com.premation.samples.channels.controller");
    REQUIRE(ctrl != nullptr);
    CHECK(param_named(*ctrl, "ch.pulse") == nullptr);
    CHECK(f.plugin_errors(1.0).empty());
    // Decoded, the follower's render inputs carry it (read_channel answers from them).
    pl::RenderInputs in;
    pl::decode_native_fx(*follower, *f.host->effect("com.premation.samples.channels.follower"), in);
    REQUIRE(in.channels.contains("pulse"));
    CHECK(in.channels.at("pulse")[1] == 0.8);
  }
  {
    Json* n2 = find_node(cyclic, "solid");
    Json::Array loop;
    loop.push_back(effect_json("ping", "com.premation.samples.channels.ping"));
    loop.push_back(effect_json("pong", "com.premation.samples.channels.pong"));
    fx_props(*n2).set("effects", Json::array(std::move(loop)));
    Fixture g(std::move(cyclic));
    const std::vector<sc::LayerError> errors = g.plugin_errors(1.0);
    REQUIRE(errors.size() == 2);
    for (const sc::LayerError& e : errors) CHECK(e.message.find("cycle") != std::string::npos);
  }
}

TEST_CASE("SDK 1.4 D: a plugin's mesh and light join the comp's 3D scene", "[plugins][finish][scene3d]") {
  Json document = scene_json("plugin-model3d-occlusion.json");
  Json* node = find_node(document, "solid");
  REQUIRE(node != nullptr);
  // A 3D layer (z set), drawing Mesh Cube instead of the model.
  for (Json& c : node->find_mut("components")->arr_mut()) {
    if (c.at("type").str() == "Transform") c.find_mut("props")->set("z", Json::number(0));
  }
  Json::Array effects;
  effects.push_back(effect_json("fx", "com.premation.samples.meshgen"));
  fx_props(*node).set("effects", Json::array(std::move(effects)));
  Fixture f(std::move(document));
  const sc::BuildContext ctx{f.d, f.view, *f.env, f.cache, nullptr, {}};
  const sc::ViewSpec vs = sc::export_view(480, 360, 480, 360);
  sc::NativeFrame nf = sc::build_native_frame(ctx, "comp_root", 0.5, vs, false);
  const std::size_t lightsBefore = nf.file.scene.lights3d.size();
  pl::finish_native_frame(ctx, "comp_root", 0.5, vs, false, nf, f.host.get());
  for (const sc::LayerError& e : nf.errors) INFO(e.message);
  const auto& list = nf.file.scene.renderables;
  const auto at = std::ranges::find_if(list, [](const api::Renderable& r) { return r.id == "solid::plugin-mesh-0"; });
  REQUIRE(at != list.end());
  // Right after its layer, on the 3D path, with the plugin's material.
  REQUIRE(at != list.begin());
  CHECK(std::prev(at)->id == "solid");
  const api::Renderable& mesh = *at;
  REQUIRE(mesh.extruded_mesh.has_value());
  CHECK(mesh.extruded_mesh->vertices.size() == std::size_t{24} * 8 * 4);
  CHECK(mesh.extruded_mesh->indices.size() == std::size_t{36} * 4);
  REQUIRE(mesh.three_d.has_value());
  REQUIRE(mesh.three_d->model.size() == 16);
  CHECK(mesh.three_d->casts_shadow == std::optional<bool>(true));
  REQUIRE(mesh.three_d->shade.has_value());
  CHECK(std::abs(*mesh.three_d->shade->metal - 0.3) < 1e-9);
  // Placed by the layer: its centre (layer px 240, 180) lands where the layer's centre is in the comp.
  const std::vector<double>& m = mesh.three_d->model;
  CHECK(std::abs((m[0] * 240) + (m[4] * 180) + m[12] - 240) < 1e-6);
  CHECK(std::abs((m[1] * 240) + (m[5] * 180) + m[13] - 180) < 1e-6);
  // Its light joins the comp's lights.
  CHECK(nf.file.scene.lights3d.size() == lightsBefore + 1);
  CHECK(nf.file.scene.lights3d.back().type == api::RenderLightType::point);
}
