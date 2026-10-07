// E4: the GPU route for layers the TypeScript bakes (effects_port.hpp
// gpu_effect_route / extract_gpu_route_effects) and the GPU Vegas' contour
// texture (effects/contour_texture.hpp). GPU-free: what the scene builder
// decides and writes; the pixels are the render graph's (engine_gpu_tests).
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <string>
#include <string_view>
#include <vector>

#include "catalog_data.hpp"
#include "contour_texture.hpp"
#include "effects_port.hpp"
#include "lut_port.hpp"
#include "json.hpp"
#include "native_scene.hpp"

namespace sc = premation::scene;
namespace js = premation::js;
namespace api = premation::api;
namespace fx = premation::effects;

namespace {

js::Json effect(std::string_view jsonText) {
  auto v = js::parse(jsonText);
  REQUIRE(v.has_value());
  return *v;
}

sc::RLayer shape_layer() {
  sc::RLayer l;
  l.id = "L";
  l.kind = sc::LayerKind::shape;
  l.width = 200;
  l.height = 100;
  l.primitive = "path";
  return l;
}

const api::RenderEffectParam* param(const api::RenderEffect& e, std::string_view name) {
  for (const auto& p : e.params) {
    if (p.name == name) return &p;
  }
  return nullptr;
}

}  // namespace

TEST_CASE("gpu route: fill opacity alone bakes in the TS rule, and routes to the chain", "[scene][e4]") {
  sc::RLayer l = shape_layer();
  l.fillOpacity = 0.4;
  l.effects.push_back(effect(R"({"id":"a","type":"inner-shadow","params":{"opacity":80,"softness":6,"distance":4}})"));
  CHECK(sc::layer_is_baked(l));
  CHECK(sc::gpu_effect_route_blocker(l) == nullptr);
  REQUIRE(sc::gpu_effect_route(l));

  l.gpuEffects = true;
  CHECK_FALSE(sc::layer_is_baked(l));  // one flag moves every bake-dependent choice
  const auto chain = sc::extract_gpu_route_effects(l);
  REQUIRE(chain.size() == 2);
  CHECK(chain[0].type == "fill-opacity");
  const auto* amount = param(chain[0], "amount");
  REQUIRE(amount != nullptr);
  CHECK(std::abs(amount->number - 0.4) < 1e-12);
  CHECK(chain[1].type == "inner-shadow");
}

TEST_CASE("gpu route: effect opacity and a scoped mask ride on the effect's one entry", "[scene][e4]") {
  sc::RLayer l = shape_layer();
  l.mask = effect(R"({"paths":[{"id":"m1","mode":"add","closed":true,"points":[]}]})");
  l.effects.push_back(effect(R"({"id":"a","type":"stroke","opacity":50,"maskId":"m1","params":{"width":6,"opacity":100}})"));
  REQUIRE(sc::gpu_effect_route(l));
  l.gpuEffects = true;
  const auto chain = sc::extract_gpu_route_effects(l);
  REQUIRE(chain.size() == 1);
  CHECK(chain[0].type == "stroke");
  const auto* op = param(chain[0], "effectOpacity");
  REQUIRE(op != nullptr);
  CHECK(std::abs(op->number - 0.5) < 1e-12);
  const auto* scope = param(chain[0], "scopeMaskKey");
  REQUIRE(scope != nullptr);
  CHECK(scope->text == sc::scope_mask_key("L", "m1"));
  const auto masks = sc::gpu_route_scope_masks(l);
  REQUIRE(masks.size() == 1);
  CHECK(masks[0].first == "fxmask:L:m1");
  CHECK(masks[0].second.at("paths").arr().at(0).at("mode").str() == "add");
}

TEST_CASE("gpu route: a fully faded unscoped effect is dropped, as applyEffectChain skips it", "[scene][e4]") {
  sc::RLayer l = shape_layer();
  // Stroke opacity is blended on the GPU, so it does not bake by itself. Fill
  // opacity is what puts the layer on the route; the faded stroke is then skipped.
  l.fillOpacity = 0.4;
  l.effects.push_back(effect(R"({"id":"a","type":"stroke","opacity":0,"params":{"width":6,"opacity":100}})"));
  REQUIRE(sc::gpu_effect_route(l));
  l.gpuEffects = true;
  const auto chain = sc::extract_gpu_route_effects(l);
  REQUIRE(chain.size() == 1);
  CHECK(chain[0].type == "fill-opacity");
}

TEST_CASE("gpu route: a colour grade and a LUT run after fill opacity", "[scene][e4]") {
  sc::RLayer l = shape_layer();
  l.fillOpacity = 0.9;
  SECTION("a colour matrix") {
    l.effects.push_back(effect(R"({"id":"a","type":"brightness","params":{"brightness":150}})"));
    REQUIRE(sc::gpu_effect_route(l));
    l.gpuEffects = true;
    const auto chain = sc::extract_gpu_route_effects(l);
    REQUIRE(chain.size() == 2);
    CHECK(chain[0].type == "fill-opacity");
    CHECK(chain[1].type == "color-matrix");
    const auto* m = param(chain[1], "m");
    REQUIRE(m != nullptr);
    CHECK(m->numbers.size() == 9);
  }
  SECTION("a per-channel LUT") {
    l.effects.push_back(effect(R"({"id":"a","type":"levels","params":{}})"));
    REQUIRE(sc::gpu_effect_route(l));
    l.gpuEffects = true;
    const auto chain = sc::extract_gpu_route_effects(l);
    REQUIRE(chain.size() == 2);
    CHECK(chain[0].type == "fill-opacity");
    CHECK(chain[1].type == "channel-lut");
    const auto* key = param(chain[1], "lutKey");
    REQUIRE(key != nullptr);
    CHECK(key->text == sc::channel_lut_key("L", 0));
  }
}

TEST_CASE("gpu route: plexus, an empty scribble and a write-on brush stamp on the GPU", "[scene][e4]") {
  sc::RLayer l = shape_layer();
  l.fillOpacity = 0.9;
  SECTION("plexus") {
    l.effects.push_back(effect(R"({"id":"a","type":"plexus","params":{"pointCount":4,"maxDistance":0,"pointSize":3}})"));
    REQUIRE(sc::gpu_effect_route(l));
    l.gpuEffects = true;
    const auto chain = sc::extract_gpu_route_effects(l);
    REQUIRE(chain.size() == 2);
    CHECK(chain[0].type == "fill-opacity");
    CHECK(chain[1].type == "stamp-field");
    const auto* n = param(chain[1], "instances");
    REQUIRE(n != nullptr);
    CHECK(n->number == 4);
  }
  SECTION("scribble with no mask draws nothing, so only fill opacity remains") {
    l.effects.push_back(effect(R"({"id":"a","type":"scribble","params":{}})"));
    REQUIRE(sc::gpu_effect_route(l));
    l.gpuEffects = true;
    const auto chain = sc::extract_gpu_route_effects(l);
    REQUIRE(chain.size() == 1);
    CHECK(chain[0].type == "fill-opacity");
  }
  SECTION("write-on brush") {
    l.effects.push_back(effect(R"({"id":"a","type":"write-on","params":{"writeOnMode":0,"brushSize":8}})"));
    REQUIRE(sc::gpu_effect_route(l));
    l.gpuEffects = true;
    const auto chain = sc::extract_gpu_route_effects(l);
    REQUIRE(chain.size() == 2);
    CHECK(chain[1].type == "stamp-field");
    const auto* n = param(chain[1], "instances");
    REQUIRE(n != nullptr);
    CHECK(n->number == 1);
  }
}

TEST_CASE("gpu route: what the chain cannot express keeps the CPU bake", "[scene][e4]") {
  sc::RLayer l = shape_layer();
  l.fillOpacity = 0.5;
  SECTION("a CSS opacity effect (no matrix and no chain entry)") {
    l.effects.push_back(effect(R"({"id":"a","type":"opacity","params":{"amount":50}})"));
  }
  SECTION("a drawn effect on a layer whose mask shapes it") {
    l.mask = effect(R"({"paths":[{"id":"m1","mode":"add","closed":true,"points":[{"x":0,"y":0},{"x":10,"y":0},{"x":0,"y":10}]}]})");
    l.effects.push_back(effect(R"({"id":"a","type":"numbers","params":{}})"));
  }
  SECTION("Scribble that has a mask path to fill") {
    l.mask = effect(R"({"paths":[{"id":"m1","closed":true,"points":[{"x":0,"y":0},{"x":10,"y":0},{"x":0,"y":10}]}]})");
    l.effects.push_back(effect(R"({"id":"a","type":"scribble","params":{}})"));
  }
  SECTION("Vegas behind another effect (its contours are the raw content's)") {
    l.effects.push_back(effect(R"({"id":"a","type":"stroke","params":{"width":4}})"));
    l.effects.push_back(effect(R"({"id":"b","type":"vegas","params":{}})"));
  }
  CHECK(sc::layer_is_baked(l));
  CHECK(sc::gpu_effect_route_blocker(l) != nullptr);
  CHECK_FALSE(sc::gpu_effect_route(l));
}

TEST_CASE("gpu route round 2: drawn effects land as overlays, CC RepeTile is the identity", "[scene][e4]") {
  sc::RLayer l = shape_layer();
  l.fillOpacity = 0.5;
  // Mode-None paths (the ones Path Stroke / Scribble follow) do not shape the layer.
  l.mask = effect(R"({"paths":[{"id":"m1","mode":"none","closed":true,"points":[{"x":0,"y":0},{"x":10,"y":0},{"x":0,"y":10}]}]})");
  l.effects.push_back(effect(R"({"id":"a","type":"numbers","params":{"value":7}})"));
  l.effects.push_back(effect(R"({"id":"b","type":"lightning","params":{"composite":4}})"));
  l.effects.push_back(effect(R"({"id":"c","type":"path-stroke","params":{"paintStyle":2,"pathMaskId":"m1"}})"));
  l.effects.push_back(effect(R"({"id":"d","type":"cc-repetile","params":{"expandLeft":40}})"));
  l.effects.push_back(effect(R"({"id":"e","type":"audio-waveform","params":{"composite":1},"opacity":50})"));
  CHECK(sc::layer_is_baked(l));
  CHECK(sc::gpu_effect_route_blocker(l) == nullptr);
  REQUIRE(sc::gpu_effect_route(l));
  l.gpuEffects = true;
  const auto chain = sc::extract_gpu_route_effects(l);
  // fill-opacity, numbers, lightning, path-stroke, (repetile: nothing), waveform
  REQUIRE(chain.size() == 5);
  CHECK(chain[0].type == "fill-opacity");
  const std::vector<double> modes{0, 4, 12, 1};
  for (std::size_t i = 1; i < chain.size(); ++i) {
    INFO(i);
    CHECK(chain[i].type == "fx-overlay");
    const auto* key = param(chain[i], "overlayKey");
    REQUIRE(key != nullptr);
    CHECK(key->text == "fxdraw:L:" + std::to_string(i - 1));
    const auto* mode = param(chain[i], "mode");
    REQUIRE(mode != nullptr);
    CHECK(mode->number == modes[i - 1]);
  }
  const auto* faded = param(chain[4], "effectOpacity");  // the waveform's effect opacity blends back
  REQUIRE(faded != nullptr);
  CHECK(faded->number == 0.5);
  const auto requests = sc::gpu_overlay_requests(l);
  REQUIRE(requests.size() == 4);
  CHECK(requests[2].first == "fxdraw:L:2");
  CHECK(requests[2].second.at("type").str() == "path-stroke");
}

TEST_CASE("gpu route: Lightning in Multiply lands as a multiply overlay", "[scene][e4]") {
  sc::RLayer l = shape_layer();
  l.fillOpacity = 0.5;
  l.effects.push_back(effect(R"({"id":"a","type":"lightning","params":{"composite":3}})"));
  CHECK(sc::gpu_effect_route_blocker(l) == nullptr);
  REQUIRE(sc::gpu_effect_route(l));
  l.gpuEffects = true;
  const auto chain = sc::extract_gpu_route_effects(l);
  REQUIRE(chain.size() == 2);
  CHECK(chain[1].type == "fx-overlay");
  const auto* mode = param(chain[1], "mode");
  REQUIRE(mode != nullptr);
  CHECK(mode->number == 3);
}

TEST_CASE("gpu route: an unbaked layer is left alone", "[scene][e4]") {
  sc::RLayer l = shape_layer();
  l.effects.push_back(effect(R"({"id":"a","type":"drop-shadow","params":{}})"));
  CHECK_FALSE(sc::layer_is_baked(l));
  CHECK_FALSE(sc::gpu_effect_route(l));
  std::vector<sc::RLayer> layers{l};
  CHECK(sc::mark_gpu_effect_layers(layers) == 0);
  CHECK_FALSE(layers[0].gpuEffects);
}

TEST_CASE("gpu route: marking walks precomps", "[scene][e4]") {
  sc::RLayer inner = shape_layer();
  inner.fillOpacity = 0.3;
  sc::RLayer outer = shape_layer();
  outer.id = "P";
  outer.precompLayers = std::vector<sc::RLayer>{inner};
  std::vector<sc::RLayer> layers{outer};
  CHECK(sc::mark_gpu_effect_layers(layers) == 1);
  CHECK(layers[0].precompLayers->at(0).gpuEffects);
  CHECK_FALSE(layers[0].gpuEffects);
}

TEST_CASE("contour texture: a square's contour, one float per texel", "[effects][e4]") {
  constexpr std::uint32_t w = 16;
  constexpr std::uint32_t h = 12;
  std::vector<std::uint8_t> px(static_cast<std::size_t>(w) * h * 4, 0);
  for (std::uint32_t y = 3; y < 9; ++y) {
    for (std::uint32_t x = 4; x < 12; ++x) px[(static_cast<std::size_t>(y) * w + x) * 4 + 3] = 255;
  }
  const fx::ContourTexture t = fx::pack_alpha_contours(px, w, h, 128, 2);
  REQUIRE(t.contours == 1);
  REQUIRE(t.vertices >= 4);
  CHECK(t.width == fx::kContourTexWidth);
  CHECK(t.rgba.size() == static_cast<std::size_t>(t.width) * t.height * 4);
  CHECK(fx::contour_float(t, 0) == static_cast<float>(t.vertices));
  CHECK(fx::contour_float(t, 1) == 1.0F);
  CHECK(fx::contour_float(t, 2) == static_cast<float>(w));
  CHECK(fx::contour_float(t, 3) == static_cast<float>(h));
  CHECK(fx::contour_float(t, 4) == 2.0F);
  // The loop runs along the ½-crossings: an 8 × 6 box, perimeter ≈ 28 (corners cut).
  const float total = fx::contour_float(t, fx::kContourHeaderFloats + 2);
  CHECK(total > 24.0F);
  CHECK(total < 29.0F);
  // Vertices sit on the box edge, in raster px from the corner.
  const std::uint32_t v0 = fx::kContourHeaderFloats + 4;
  const float x = fx::contour_float(t, v0);
  const float y = fx::contour_float(t, v0 + 1);
  CHECK(x >= 3.5F);
  CHECK(x <= 12.5F);
  CHECK(y >= 2.5F);
  CHECK(y <= 9.5F);
  CHECK(fx::contour_float(t, v0 + 2) == 0.0F);  // the first vertex's arc
}

TEST_CASE("contour texture: empty alpha packs a header only", "[effects][e4]") {
  const std::vector<std::uint8_t> px(8 * 8 * 4, 0);
  const fx::ContourTexture t = fx::pack_alpha_contours(px, 8, 8, 128, 1);
  CHECK(t.vertices == 0);
  CHECK(t.contours == 0);
  CHECK(t.height == 1);
  CHECK(fx::contour_float(t, 0) == 0.0F);
}

TEST_CASE("gpu route: a faded / scoped effect of several entries stays on the GPU as one blend span", "[scene][e4][span]") {
  // Every registered effect at its new-instance params, faded to 40 %: those
  // whose GPU chain writes more than one entry carry `blendSpan` on the first.
  std::size_t spans = 0;
  std::size_t anyEntry = 0;
  for (const auto& def : premation::doc::registry().effects) {
    sc::RLayer l = shape_layer();
    js::Json e = js::Json::object();
    e.set("id", js::Json::string("e1"));
    e.set("type", js::Json::string(def.type));
    e.set("opacity", js::Json::number(40));
    js::Json params = def.newInstanceParams ? *def.newInstanceParams : js::Json::object();
    // Every number at its default or, when that is 0, a quarter of its range (so passes that need a nonzero amount run).
    for (const auto& pd : def.params) {
      if (pd.type != "number" || !params.at(pd.key).is_undefined()) continue;
      const double d = pd.def.is_number() ? pd.def.num() : 0;
      const double lo = pd.min.value_or(0);
      const double hi = pd.max.value_or(100);
      params.set(pd.key, js::Json::number(d != 0 ? d : lo + (hi - lo) / 4));
    }
    e.set("params", params);
    l.effects.push_back(e);
    l.gpuEffects = true;
    const auto chain = sc::extract_gpu_route_effects(l);
    if (!chain.empty()) ++anyEntry;
    if (chain.size() < 2) continue;
    ++spans;
    const auto* span = param(chain[0], "blendSpan");
    REQUIRE(span != nullptr);
    CHECK(static_cast<std::size_t>(span->number) == chain.size());
    const auto* op = param(chain[0], "effectOpacity");
    REQUIRE(op != nullptr);
    CHECK(std::abs(op->number - 0.4) < 1e-12);
    l.gpuEffects = false;
    const char* why = sc::gpu_effect_route_blocker(l);
    INFO(def.type << ": " << (why != nullptr ? why : "routed"));
    CHECK((why == nullptr || std::string_view(why) != "a faded / scoped effect with several chain entries"));
  }
  CHECK(anyEntry > 150);  // the registry is exercised (198 of 206 today)
  CHECK(spans <= anyEntry);
}

TEST_CASE("gpu route: a faded effect the TS GPU chain cannot blend (a colour grade) routes and blends in the chain", "[scene][e4][span]") {
  sc::RLayer l = shape_layer();
  l.effects.push_back(effect(R"({"id":"a","type":"brightness","opacity":40,"params":{"amount":150}})"));
  CHECK(sc::layer_is_baked(l));
  CHECK(sc::gpu_effect_route_blocker(l) == nullptr);
  l.gpuEffects = true;
  const auto chain = sc::extract_gpu_route_effects(l);
  REQUIRE(chain.size() == 1);
  CHECK(chain[0].type == "color-matrix");
  const auto* op = param(chain[0], "effectOpacity");
  REQUIRE(op != nullptr);
  CHECK(std::abs(op->number - 0.4) < 1e-12);
}

TEST_CASE("gpu route (AE parity 5.3): Lumetri's pixel stage, Ultra spill and Keylight's views run as float passes", "[scene][e4][ae5]") {
  sc::RLayer l = shape_layer();
  SECTION("Lumetri saturation / vignette: its LUT, then lumetri-grade") {
    l.effects.push_back(effect(R"({"id":"a","type":"lumetri","params":{"saturation":150,"vignetteAmount":-40}})"));
    REQUIRE(sc::gpu_effect_route(l));
    l.gpuEffects = true;
    const auto chain = sc::extract_gpu_route_effects(l);
    REQUIRE(chain.size() == 2);
    CHECK(chain[0].type == "channel-lut");
    CHECK(chain[1].type == "lumetri-grade");
    const auto* sat = param(chain[1], "sat");
    REQUIRE(sat != nullptr);
    CHECK(std::abs(sat->number - 1.5) < 1e-12);
    const auto* amount = param(chain[1], "vAmount");
    REQUIRE(amount != nullptr);
    CHECK(std::abs(amount->number + 0.4) < 1e-12);
  }
  SECTION("Advanced Spill Suppressor, Ultra") {
    l.effects.push_back(effect(R"({"id":"a","type":"advanced-spill-suppressor","params":{"method":1,"keyColor":"#0000ff","suppression":80}})"));
    REQUIRE(sc::gpu_effect_route(l));
    l.gpuEffects = true;
    const auto chain = sc::extract_gpu_route_effects(l);
    REQUIRE(chain.size() == 1);
    CHECK(chain[0].type == "advanced-spill");
    CHECK(param(chain[0], "primary")->number == 2);
    CHECK(std::abs(param(chain[0], "suppression")->number - 0.8) < 1e-12);
  }
  SECTION("Keylight Screen Matte: the key, then matte-view") {
    l.effects.push_back(effect(R"({"id":"a","type":"keylight","params":{"view":2}})"));
    REQUIRE(sc::gpu_effect_route(l));
    l.gpuEffects = true;
    const auto chain = sc::extract_gpu_route_effects(l);
    REQUIRE(chain.size() == 2);
    CHECK(chain[0].type == "keylight");
    CHECK(chain[1].type == "matte-view");
    CHECK(param(chain[1], "view")->number == 2);
  }
  SECTION("Keylight Source: nothing to draw") {
    l.effects.push_back(effect(R"({"id":"a","type":"keylight","params":{"view":1}})"));
    REQUIRE(sc::gpu_effect_route(l));
    l.gpuEffects = true;
    CHECK(sc::extract_gpu_route_effects(l).empty());
  }
}

namespace {

/// The route's chain for a one-effect layer (asserting it routes).
std::vector<api::RenderEffect> routed(sc::RLayer& l) {
  CHECK(sc::layer_is_baked(l));
  INFO((sc::gpu_effect_route_blocker(l) != nullptr ? sc::gpu_effect_route_blocker(l) : ""));
  REQUIRE(sc::gpu_effect_route(l));
  l.gpuEffects = true;
  return sc::extract_gpu_route_effects(l);
}

double num(const api::RenderEffect& e, std::string_view name) {
  const auto* p = param(e, name);
  REQUIRE(p != nullptr);
  return p->number;
}

bool has_data(const sc::RLayer& l, std::string_view key, std::size_t floats) {
  for (const auto& [k, v] : sc::gpu_route_data_textures(l)) {
    if (k == key) return v.size() == floats;
  }
  return false;
}

}  // namespace

TEST_CASE("gpu route (AE parity 5.3): every keying / grade / deformation pass that baked now draws on the GPU", "[scene][e4][ae5]") {
  sc::RLayer l = shape_layer();
  SECTION("Lumetri Hue vs Saturation: the curve tables ride in a data texture") {
    l.effects.push_back(effect(R"({"id":"a","type":"lumetri","params":{"hueVsSat":[[0,128],[128,40],[255,128]]}})"));
    const auto chain = routed(l);
    REQUIRE(chain.size() == 2);
    CHECK(chain[0].type == "channel-lut");
    CHECK(chain[1].type == "lumetri-grade");
    CHECK(num(chain[1], "cSat") == 1);
    CHECK(num(chain[1], "cHue") == 0);
    CHECK(chain[1].params.back().text == "fxdata:L:a");
    CHECK(has_data(l, "fxdata:L:a", 1024));
  }
  SECTION("Levels alpha: its LUT, then alpha-levels") {
    l.effects.push_back(effect(R"({"id":"a","type":"levels","params":{"alphaInputBlack":20,"alphaGamma":2}})"));
    const auto chain = routed(l);
    REQUIRE(chain.size() == 2);
    CHECK(chain[1].type == "alpha-levels");
    CHECK(num(chain[1], "inBlack") == 20);
    CHECK(std::abs(num(chain[1], "invGamma") - 0.5) < 1e-12);
  }
  SECTION("Hue/Saturation Colorize: hue-sat-ranges instead of the matrix") {
    l.effects.push_back(effect(R"({"id":"a","type":"hue-saturation","params":{"colorize":true,"colorizeHue":200}})"));
    const auto chain = routed(l);
    REQUIRE(chain.size() == 1);
    CHECK(chain[0].type == "hue-sat-ranges");
    CHECK(num(chain[0], "colorize") == 1);
    CHECK(num(chain[0], "ch") == 200);
    CHECK(num(chain[0], "r2c") == 120);
  }
  SECTION("Advanced Spill Suppressor, Standard: the vote flag") {
    l.effects.push_back(effect(R"({"id":"a","type":"advanced-spill-suppressor","params":{"method":0,"suppression":80}})"));
    const auto chain = routed(l);
    REQUIRE(chain.size() == 1);
    CHECK(chain[0].type == "advanced-spill");
    CHECK(num(chain[0], "standard") == 1);
  }
  SECTION("Keylight Intermediate Result: keylight-ex") {
    l.effects.push_back(effect(R"({"id":"a","type":"keylight","params":{"view":4}})"));
    const auto chain = routed(l);
    REQUIRE(chain.size() == 1);
    CHECK(chain[0].type == "keylight-ex");
    CHECK(num(chain[0], "intermediate") == 1);
  }
  SECTION("Keylight with clip rollback, pre-blur and an inside mask, viewed as Status") {
    l.mask = effect(R"({"paths":[{"id":"m1","mode":"add","closed":true,"points":[{"x":0,"y":0},{"x":10,"y":0},{"x":0,"y":10}]}]})");
    l.effects.push_back(effect(R"({"id":"a","type":"keylight","params":{"clipRollback":4,"screenPreBlur":2,"insideMaskId":"m1","view":3}})"));
    const auto chain = routed(l);
    REQUIRE(chain.size() == 2);
    CHECK(chain[0].type == "keylight-ex");
    CHECK(num(chain[0], "rollbackPx") == 4);
    CHECK(num(chain[0], "preBlurPx") == 2);
    CHECK(chain[1].type == "matte-view");
    const auto masks = sc::gpu_route_scope_masks(l);
    REQUIRE(masks.size() == 1);
    CHECK(masks[0].first == "fxmask:L:m1");
  }
  SECTION("Key Cleaner, Remove Grain, Refine Soft Matte") {
    l.effects.push_back(effect(R"({"id":"a","type":"key-cleaner","params":{"edgeRadius":6,"strength":100,"alphaContrast":150}})"));
    l.effects.push_back(effect(R"({"id":"b","type":"remove-grain","params":{"noiseReduction":50,"radius":3,"passes":2}})"));
    l.effects.push_back(effect(R"({"id":"c","type":"refine-soft-matte","params":{"edgeRadius":10}})"));
    const auto chain = routed(l);
    REQUIRE(chain.size() == 3);
    CHECK(chain[0].type == "key-cleaner");
    CHECK(std::abs(num(chain[0], "contrast") - 1.5) < 1e-12);
    CHECK(chain[1].type == "remove-grain");
    CHECK(num(chain[1], "passes") == 2);
    CHECK(chain[2].type == "refine-matte");
    CHECK(num(chain[2], "radius") == 10);
    CHECK(num(chain[2], "eps") == 2e-3);
  }
  SECTION("Mesh Warp 2 x 1 with a moved vertex: field-warp over its mesh") {
    l.effects.push_back(effect(R"({"id":"a","type":"mesh-warp","params":{"rows":1,"columns":2,"meshOffsets":[0,0,5,0,0,0,0,0,0,0,0,0]}})"));
    const auto chain = routed(l);
    REQUIRE(chain.size() == 1);
    CHECK(chain[0].type == "field-warp");
    CHECK(num(chain[0], "cols") == 2);
    CHECK(num(chain[0], "rows") == 1);
    CHECK(has_data(l, "fxdata:L:a", 12));
  }
  SECTION("Reshape between two masks: the spline in a data texture") {
    l.effects.push_back(effect(R"({"id":"a","type":"reshape","params":{"percent":50,"elasticity":3,"sourceMaskIndex":0,"destinationMaskIndex":1,
      "maskPathsMeta":[4,1,1,0,4,1,1,0],"maskPathsXY":[40,20,80,20,80,60,40,60, 100,20,140,20,140,60,100,60]}})"));
    const auto chain = routed(l);
    REQUIRE(chain.size() == 1);
    CHECK(chain[0].type == "reshape-tps");
    CHECK(num(chain[0], "scale") == 200);
    CHECK(has_data(l, "fxdata:L:a", 1 + 40 * 2 + 43 * 2));
  }
}
