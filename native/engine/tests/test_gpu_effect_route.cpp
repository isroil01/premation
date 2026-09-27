// E4: the GPU route for layers the TypeScript bakes (effects_port.hpp
// gpu_effect_route / extract_gpu_route_effects) and the GPU Vegas' contour
// texture (effects/contour_texture.hpp). GPU-free: what the scene builder
// decides and writes; the pixels are the render graph's (engine_gpu_tests).
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <string>
#include <string_view>
#include <vector>

#include "contour_texture.hpp"
#include "effects_port.hpp"
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
  l.effects.push_back(effect(R"({"id":"a","type":"stroke","opacity":0,"params":{"width":6,"opacity":100}})"));
  REQUIRE(sc::gpu_effect_route(l));
  l.gpuEffects = true;
  CHECK(sc::extract_gpu_route_effects(l).empty());
}

TEST_CASE("gpu route: what the chain cannot express keeps the CPU bake", "[scene][e4]") {
  sc::RLayer l = shape_layer();
  l.fillOpacity = 0.5;
  SECTION("an interleaved per-channel LUT") {
    l.effects.push_back(effect(R"({"id":"a","type":"levels","params":{}})"));
  }
  SECTION("a Canvas2D-only effect the GPU does not draw") {
    l.effects.push_back(effect(R"({"id":"a","type":"plexus","params":{}})"));
  }
  SECTION("Vegas behind another effect (its contours are the raw content's)") {
    l.effects.push_back(effect(R"({"id":"a","type":"stroke","params":{"width":4}})"));
    l.effects.push_back(effect(R"({"id":"b","type":"vegas","params":{}})"));
  }
  CHECK(sc::layer_is_baked(l));
  CHECK(sc::gpu_effect_route_blocker(l) != nullptr);
  CHECK_FALSE(sc::gpu_effect_route(l));
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
