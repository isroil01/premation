// The render graph on a real Dawn device (D2): a FrameScene renders to the
// expected pixels, transient targets are pooled across frames, and bind groups
// are cache hits from the second frame on (the dynamic-offset uniform arena).
// Skipped when the machine has no GPU adapter.
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <string>

#include "scene_renderer.hpp"

using namespace premation::rg;

namespace {

api::RenderFrameFile solid_scene(double r, double g, double b) {
  api::RenderFrameFile f;
  f.format_version = 1;
  f.scene_id = "unit";
  f.view.css_width = 64;
  f.view.css_height = 48;
  f.view.device_pixel_ratio = 1;
  f.view.camera_center_x = 32;
  f.view.camera_center_y = 24;
  f.view.camera_zoom = 1;
  f.view.bit_depth = 16;
  f.view.float16_textures = true;
  f.view.surface_format = api::RenderTextureFormat::bgra8unorm;
  f.scene.width = 64;
  f.scene.height = 48;
  f.scene.background = api::Color{0, 0, 0, 1};
  f.scene.has_effects = true;
  api::Renderable rect;
  rect.id = "rect";
  rect.kind = api::RenderableKind::rect;
  // Unit quad → (16,12)-(48,36).
  rect.model_matrix = {32, 0, 0, 0, 24, 0, 16, 12, 1};
  rect.bounds = {16, 12, 32, 24};
  rect.opacity = 1;
  rect.color = api::Color{r, g, b, 1};
  f.scene.renderables.push_back(rect);
  return f;
}

}  // namespace

TEST_CASE("render graph draws a FrameScene and pools targets + bind groups across frames") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) {
    WARN("no GPU adapter: " << err);
    return;
  }
  const auto file = solid_scene(1, 0.5, 0);
  Frame frame;
  FrameStats s1;
  REQUIRE(renderer->render(file, &frame, s1, err));
  CHECK(s1.gpuError.empty());
  CHECK(s1.diagnostics.empty());
  REQUIRE(frame.width == 64);
  REQUIRE(frame.height == 48);
  const auto px = [&](std::uint32_t x, std::uint32_t y, std::size_t c) { return frame.rgba.at((std::size_t{y} * 64 + x) * 4 + c); };
  // Inside: sRGB (255, 128, 0) — linear intermediates, encoded by the scene blit.
  CHECK(px(32, 24, 0) == 255);
  CHECK(std::abs(static_cast<int>(px(32, 24, 1)) - 128) <= 1);
  CHECK(px(32, 24, 2) == 0);
  CHECK(px(32, 24, 3) == 255);
  // Outside: the black comp background.
  CHECK(px(2, 2, 0) == 0);
  CHECK(px(2, 2, 3) == 255);

  const DeviceStats after1 = renderer->device().stats();
  FrameStats s2;
  REQUIRE(renderer->render(file, &frame, s2, err));
  const DeviceStats after2 = renderer->device().stats();
  // Same viewport: every graph target is a pool hit, no new pipeline, and every
  // draw's bind group is reused.
  CHECK(after2.targetMisses == after1.targetMisses);
  CHECK(after2.targetHits > after1.targetHits);
  CHECK(after2.pipelinesCreated == after1.pipelinesCreated);
  CHECK(after2.bindGroupMisses == after1.bindGroupMisses);
  CHECK(after2.bindGroupHits > after1.bindGroupHits);
  CHECK(after2.gpuBytes == after1.gpuBytes);
}

TEST_CASE("a resize reallocates the graph's targets at the new size") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  auto file = solid_scene(0, 0, 1);
  Frame frame;
  FrameStats s;
  REQUIRE(renderer->render(file, &frame, s, err));
  const auto before = renderer->device().stats();
  file.view.css_width = 128;
  REQUIRE(renderer->render(file, &frame, s, err));
  const auto after = renderer->device().stats();
  CHECK(frame.width == 128);
  CHECK(after.targetMisses > before.targetMisses);
}

namespace {

api::RenderEffectParam num_param(std::string name, double v) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = api::RenderParamKind::number;
  p.number = v;
  return p;
}

api::RenderEffectParam color_param(std::string name, double r, double g, double b, double a) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = api::RenderParamKind::color;
  p.numbers = {r, g, b, a};
  return p;
}

}  // namespace

TEST_CASE("E4: a distance-field stroke lands outside the shape and its field is kept across frames") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  renderer->set_effect_fields(true);
  auto file = solid_scene(0, 0, 1);
  api::RenderEffect stroke;
  stroke.type = "stroke";
  stroke.params.push_back(num_param("widthPx", 4));
  stroke.params.push_back(color_param("color", 1, 0, 0, 1));
  file.scene.renderables[0].effects.push_back(stroke);
  Frame frame;
  FrameStats s1;
  REQUIRE(renderer->render(file, &frame, s1, err));
  CHECK(s1.gpuError.empty());
  CHECK(s1.effects.sdfBuilt == 1);
  CHECK(s1.effects.gpuEntries == 1);
  const auto px = [&](std::uint32_t x, std::uint32_t y, std::size_t c) { return frame.rgba.at((std::size_t{y} * 64 + x) * 4 + c); };
  // 2 px outside the rect's left edge (x = 16): the red band; the rect stays blue.
  CHECK(px(14, 24, 0) > 200);
  CHECK(px(14, 24, 2) < 40);
  CHECK(px(32, 24, 2) > 200);
  CHECK(px(4, 24, 0) < 20);  // beyond the width: the background
  // Only the stroke's width moves: the content (and its field) does not.
  file.scene.renderables[0].effects[0].params[0].number = 6;
  FrameStats s2;
  REQUIRE(renderer->render(file, &frame, s2, err));
  CHECK(s2.effects.sdfReused == 1);
  CHECK(s2.effects.sdfBuilt == 0);
  CHECK(px(11, 24, 0) > 200);
}

TEST_CASE("E4: fill opacity fades the contents and shapes the stroke by the silhouette") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  renderer->set_effect_fields(true);
  auto file = solid_scene(0, 0, 1);
  api::RenderEffect fade;
  fade.type = "fill-opacity";
  fade.params.push_back(num_param("amount", 0));
  api::RenderEffect stroke;
  stroke.type = "stroke";
  stroke.params.push_back(num_param("widthPx", 4));
  stroke.params.push_back(color_param("color", 1, 0, 0, 1));
  file.scene.renderables[0].effects = {fade, stroke};
  Frame frame;
  FrameStats s;
  REQUIRE(renderer->render(file, &frame, s, err));
  CHECK(s.gpuError.empty());
  const auto px = [&](std::uint32_t x, std::uint32_t y, std::size_t c) { return frame.rgba.at((std::size_t{y} * 64 + x) * 4 + c); };
  CHECK(px(32, 24, 2) < 20);   // fill 0: the contents are gone (black background shows)
  CHECK(px(14, 24, 0) > 200);  // the outside stroke is still drawn at full strength
}

TEST_CASE("E4: a faded effect of several chain entries blends back once over its input (blendSpan)") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  auto file = solid_scene(0, 0, 1);
  // Two entries of ONE effect at 50 %: red, then green over it. applyEffectChain
  // blends the effect's final output (green) back over the input (blue) once:
  // half green, half blue — not a quarter-green / three-eighths-red chain of
  // per-entry blends.
  api::RenderEffect red;
  red.type = "fill";
  red.params.push_back(color_param("color", 1, 0, 0, 1));
  red.params.push_back(num_param("effectOpacity", 0.5));
  red.params.push_back(num_param("blendSpan", 2));
  api::RenderEffect green;
  green.type = "fill";
  green.params.push_back(color_param("color", 0, 1, 0, 1));
  file.scene.renderables[0].effects = {red, green};
  Frame frame;
  FrameStats s;
  REQUIRE(renderer->render(file, &frame, s, err));
  CHECK(s.gpuError.empty());
  CHECK(s.effects.blendSpans == 1);
  const auto px = [&](std::uint32_t x, std::uint32_t y, std::size_t c) { return frame.rgba.at((std::size_t{y} * 64 + x) * 4 + c); };
  // The reference: ONE fill entry (green) at 50 % — the per-entry blend the chain already had.
  auto one = solid_scene(0, 0, 1);
  api::RenderEffect g1 = green;
  g1.params.push_back(num_param("effectOpacity", 0.5));
  one.scene.renderables[0].effects = {g1};
  Frame ref;
  FrameStats s1;
  REQUIRE(renderer->render(one, &ref, s1, err));
  const auto rp = [&](std::size_t c) { return static_cast<int>(ref.rgba.at((std::size_t{24} * 64 + 32) * 4 + c)); };
  CHECK(px(32, 24, 0) < 20);
  for (std::size_t c = 0; c < 3; ++c) CHECK(std::abs(static_cast<int>(px(32, 24, c)) - rp(c)) <= 1);
}
