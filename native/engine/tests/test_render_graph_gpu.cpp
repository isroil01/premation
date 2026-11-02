// The render graph on a real Dawn device (D2): a FrameScene renders to the
// expected pixels, transient targets are pooled across frames, and bind groups
// are cache hits from the second frame on (the dynamic-offset uniform arena).
// Skipped when the machine has no GPU adapter.
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <initializer_list>
#include <numbers>
#include <string>
#include <utility>
#include <vector>

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

TEST_CASE("E4/P8b: a moved layer's stroke follows it — its distance field is rebuilt for the new placement") {
  // Under P8b the chain's content key leaves the layer's whole-pixel place out
  // (a layer that only moves reuses its chain), but a distance field is of the
  // BUFFER. Keyed by content alone, the second frame of a drag read the field
  // built where the layer WAS and drew the stroke there: a stroked text layer's
  // outline fell behind the fill as it was dragged (2026-10-19).
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  renderer->set_effect_fields(true);
  auto file = solid_scene(0, 0, 1);
  file.view.css_width = 256;
  file.view.css_height = 160;
  file.view.camera_center_x = 128;
  file.view.camera_center_y = 80;
  file.scene.width = 256;
  file.scene.height = 160;
  file.scene.renderables[0].model_matrix = {32, 0, 0, 0, 24, 0, 100, 60, 1};
  file.scene.renderables[0].bounds = {100, 60, 32, 24};
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
  const auto px = [&](std::uint32_t x, std::uint32_t y, std::size_t c) { return frame.rgba.at((std::size_t{y} * 256 + x) * 4 + c); };
  // The band sits outside the left edge (x = 100): 96–100.
  CHECK(px(98, 72, 0) > 200);
  CHECK(px(110, 72, 2) > 200);
  // The layer moves 3 px right (a whole pixel: the chain's buffer placement
  // changes while the translation-free content key holds).
  file.scene.renderables[0].model_matrix[6] += 3;
  file.scene.renderables[0].bounds.x += 3;
  FrameStats s2;
  REQUIRE(renderer->render(file, &frame, s2, err));
  CHECK(s2.gpuError.empty());
  CHECK(s2.effects.sdfReused == 0);
  CHECK(s2.effects.sdfBuilt == 1);
  // The band moved with the fill: 99–103 now, and nothing where it was.
  CHECK(px(101, 72, 0) > 200);
  CHECK(px(97, 72, 0) < 20);
  CHECK(px(113, 72, 2) > 200);
}

TEST_CASE("P8: a static layer's effect chain runs once; moving it or changing a parameter runs it again") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  auto file = solid_scene(0, 0, 1);
  api::RenderEffect blur;
  blur.type = "gaussian-blur";
  blur.params.push_back(num_param("radiusPx", 6));
  file.scene.renderables[0].effects.push_back(blur);
  Frame first;
  FrameStats s1;
  REQUIRE(renderer->render(file, &first, s1, err));
  CHECK(s1.gpuError.empty());
  CHECK(s1.effects.layerChainsReused == 0);
  // The same frame again: its key held for two frames, the result is kept…
  Frame again;
  FrameStats s2;
  REQUIRE(renderer->render(file, &again, s2, err));
  CHECK(s2.effects.layerChainsReused == 0);
  CHECK(again.rgba == first.rgba);
  // … and from the third on the chain's result is a copy, pixel for pixel.
  FrameStats s2b;
  REQUIRE(renderer->render(file, &again, s2b, err));
  CHECK(s2b.effects.layerChainsReused == 1);
  CHECK(again.rgba == first.rgba);
  // A parameter changed: the chain runs (a different blur).
  file.scene.renderables[0].effects[0].params[0].number = 2;
  Frame sharper;
  FrameStats s3;
  REQUIRE(renderer->render(file, &sharper, s3, err));
  CHECK(s3.effects.layerChainsReused == 0);
  CHECK(sharper.rgba != first.rgba);
  // Moved: the chain runs on the new placement (in this 64×48 view the blur's
  // reach leaves the frame, so P8b cannot move a kept result — see below).
  file.scene.renderables[0].model_matrix[6] += 3;
  Frame moved;
  FrameStats s4;
  REQUIRE(renderer->render(file, &moved, s4, err));
  CHECK(s4.effects.layerChainsReused == 0);
  CHECK(moved.rgba != sharper.rgba);
}

TEST_CASE("P8b: a layer that only moves by whole pixels reuses its effect chain, pixel for pixel a fresh render") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  auto file = solid_scene(0, 0.5, 1);
  file.view.css_width = 256;
  file.view.css_height = 160;
  file.view.camera_center_x = 128;
  file.view.camera_center_y = 80;
  file.scene.width = 256;
  file.scene.height = 160;
  file.scene.renderables[0].model_matrix = {32, 0, 0, 0, 24, 0, 100, 60, 1};
  file.scene.renderables[0].bounds = {100, 60, 32, 24};
  api::RenderEffect blur;
  blur.type = "gaussian-blur";
  blur.params.push_back(num_param("radiusPx", 4));
  file.scene.renderables[0].effects.push_back(blur);
  Frame f;
  std::vector<std::uint8_t> firstRgba;
  for (int i = 0; i < 3; ++i) {
    FrameStats s;
    REQUIRE(renderer->render(file, &f, s, err));
    CHECK(s.gpuError.empty());
    if (i == 0) firstRgba = f.rgba;
    CHECK(f.rgba == firstRgba);  // the kept copy is exact (frame 3 reuses it)
  }
  // A fresh renderer — no kept results — at the same placement.
  const auto fresh = [&]() {
    std::string e;
    auto other = SceneRenderer::create({}, e);
    Frame out;
    FrameStats s;
    REQUIRE(other->render(file, &out, s, e));
    return out.rgba;
  };
  // A whole-pixel move is a moved copy; a move to another sub-pixel phase runs
  // the chain there (the input is drawn at the layer's own phase — never a
  // resampled result, which softened every effected layer on a fraction).
  for (const auto& [dx, reused] : {std::pair{7.0, 1U}, std::pair{2.5, 0U}, std::pair{-11.25, 0U}}) {
    file.scene.renderables[0].model_matrix[6] += dx;
    file.scene.renderables[0].bounds.x += dx;
    Frame moved;
    FrameStats s;
    REQUIRE(renderer->render(file, &moved, s, err));
    CHECK(s.effects.layerChainsReused == reused);
    CHECK(moved.rgba == fresh());  // texel for texel the frame a fresh render draws
  }
  // Held a frame at the new phase (kept), then moved by whole pixels: a moved copy.
  {
    Frame held;
    FrameStats sh;
    REQUIRE(renderer->render(file, &held, sh, err));
    file.scene.renderables[0].model_matrix[6] += 4;
    file.scene.renderables[0].bounds.x += 4;
    Frame moved;
    FrameStats s;
    REQUIRE(renderer->render(file, &moved, s, err));
    CHECK(s.effects.layerChainsReused == 1);
    CHECK(moved.rgba == fresh());
  }
  // Moved until the blur's reach leaves the frame: the chain's buffer holds the
  // layer where its whole reach fits, so the kept result still moves there —
  // and draws what a fresh render draws. (Phase .25, the one kept above.)
  file.scene.renderables[0].model_matrix[6] = 2.25;
  file.scene.renderables[0].bounds.x = 2.25;
  Frame edge;
  FrameStats se;
  REQUIRE(renderer->render(file, &edge, se, err));
  CHECK(se.effects.layerChainsReused == 1);
  CHECK(edge.rgba == fresh());
}

TEST_CASE("P8b: while playing, a layer drifting by fractions of a pixel reuses its effect chain through the fraction") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  auto file = solid_scene(0, 0.5, 1);
  file.view.css_width = 256;
  file.view.css_height = 160;
  file.view.camera_center_x = 128;
  file.view.camera_center_y = 80;
  file.scene.width = 256;
  file.scene.height = 160;
  file.scene.renderables[0].model_matrix = {32, 0, 0, 0, 24, 0, 100, 60, 1};
  file.scene.renderables[0].bounds = {100, 60, 32, 24};
  api::RenderEffect blur;
  blur.type = "gaussian-blur";
  blur.params.push_back(num_param("radiusPx", 4));
  file.scene.renderables[0].effects.push_back(blur);
  const auto fresh = [&]() {
    std::string e;
    auto other = SceneRenderer::create({}, e);
    Frame out;
    FrameStats s;
    REQUIRE(other->render(file, &out, s, e));
    return out.rgba;
  };
  const auto maxDiff = [](const std::vector<std::uint8_t>& a, const std::vector<std::uint8_t>& b) {
    REQUIRE(a.size() == b.size());
    int worst = 0;
    for (std::size_t i = 0; i < a.size(); ++i) worst = std::max(worst, std::abs(int{a[i]} - int{b[i]}));
    return worst;
  };
  renderer->set_playing(true);
  // Three frames, the layer 0.3 px further each time (ending on a fraction, so
  // the paused frame below cannot be a whole-pixel copy): the first runs the
  // chain, the second keeps it (the whole-pixel key held), the third is the
  // kept result composited through the fraction — close to a fresh render
  // (one bilinear resample of a blurred solid), never far from it.
  const unsigned expectReused[3] = {0U, 0U, 1U};
  for (int i = 0; i < 3; ++i) {
    file.scene.renderables[0].model_matrix[6] += 0.3;
    file.scene.renderables[0].bounds.x += 0.3;
    Frame f;
    FrameStats s;
    REQUIRE(renderer->render(file, &f, s, err));
    CHECK(s.gpuError.empty());
    CHECK(s.effects.layerChainsReused == expectReused[i]);
    CHECK(maxDiff(f.rgba, fresh()) <= 24);
  }
  // Paused on a fraction: drawn at its own phase again — exact, pixel for pixel a fresh render.
  renderer->set_playing(false);
  Frame paused;
  FrameStats sp;
  REQUIRE(renderer->render(file, &paused, sp, err));
  CHECK(sp.effects.layerChainsReused == 0);
  CHECK(paused.rgba == fresh());
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

TEST_CASE("gradient-ramp lands its authored sRGB stops in the linear chain (one display encode)") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  const auto ramp = [](double r0, double g0, double b0, double r1, double g1, double b1) {
    api::RenderEffect e;
    e.type = "gradient-ramp";
    e.params.push_back(color_param("colorA", r0, g0, b0, 1));
    e.params.push_back(color_param("colorB", r1, g1, b1, 1));
    e.params.push_back(num_param("angle", 90));
    e.params.push_back(num_param("blend", 1));
    return e;
  };
  Frame frame;
  FrameStats s;
  const auto px = [&](std::uint32_t x, std::uint32_t y, std::size_t c) {
    return static_cast<int>(frame.rgba.at((std::size_t{y} * 64 + x) * 4 + c));
  };
  // A flat ramp of the design system's deep navy (#02081b) over a white solid:
  // the frame shows #02081b. Written raw into the linear buffer, the stop was
  // display-encoded a second time and came out (22, 50, 91).
  auto flat = solid_scene(1, 1, 1);
  flat.scene.renderables[0].effects = {ramp(2 / 255.0, 8 / 255.0, 27 / 255.0, 2 / 255.0, 8 / 255.0, 27 / 255.0)};
  REQUIRE(renderer->render(flat, &frame, s, err));
  CHECK(s.gpuError.empty());
  CHECK(std::abs(px(32, 24, 0) - 2) <= 1);
  CHECK(std::abs(px(32, 24, 1) - 8) <= 1);
  CHECK(std::abs(px(32, 24, 2) - 27) <= 1);
  // Red → blue top to bottom over the rect (rows 12..36): the stops blend in sRGB,
  // as the Canvas2D ramp does, so the row at t blends to (1 − t, 0, t) on screen.
  auto rb = solid_scene(1, 1, 1);
  rb.scene.renderables[0].effects = {ramp(1, 0, 0, 0, 0, 1)};
  REQUIRE(renderer->render(rb, &frame, s, err));
  for (const std::uint32_t y : {14U, 24U, 34U}) {
    const double t = (y + 0.5 - 12) / 24;
    CHECK(std::abs(px(32, y, 0) - static_cast<int>(std::lround((1 - t) * 255))) <= 3);
    CHECK(px(32, y, 1) <= 1);
    CHECK(std::abs(px(32, y, 2) - static_cast<int>(std::lround(t * 255))) <= 3);
  }
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

namespace {

api::RenderEffect fx_entry(std::string type, std::vector<api::RenderEffectParam> params) {
  api::RenderEffect e;
  e.type = std::move(type);
  e.params = std::move(params);
  return e;
}

api::RenderEffectParam nums_param(std::string name, std::vector<double> v) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = api::RenderParamKind::numbers;
  p.numbers = std::move(v);
  return p;
}

api::Renderable fx_rect(std::string id, double x, double y, double w, double h, api::Color c,
                        std::vector<api::RenderEffect> effects) {
  api::Renderable r;
  r.id = std::move(id);
  r.kind = api::RenderableKind::rect;
  r.model_matrix = {w, 0, 0, 0, h, 0, x, y, 1};
  r.bounds = {x, y, w, h};
  r.opacity = 1;
  r.color = c;
  r.effects = std::move(effects);
  return r;
}

/// Small layers far apart on a 256 × 192 frame, each with a stack the grow
/// bounds measure — and one whose stack ends in an entry they do not.
api::RenderFrameFile bounded_fx_scene() {
  api::RenderFrameFile f = solid_scene(0, 0, 0);
  f.view.css_width = 256;
  f.view.css_height = 192;
  f.view.camera_center_x = 128;
  f.view.camera_center_y = 96;
  f.scene.width = 256;
  f.scene.height = 192;
  f.scene.background = api::Color{0.1, 0.1, 0.12, 1};
  f.scene.renderables.clear();
  auto& list = f.scene.renderables;
  list.push_back(fx_rect("blur", 20, 20, 24, 24, {1, 0.2, 0.1, 1}, {fx_entry("gaussian-blur", {num_param("radiusPx", 4)})}));
  list.push_back(fx_rect("shadow", 150, 30, 30, 20, {0.2, 0.9, 0.3, 1},
                         {fx_entry("drop-shadow", {num_param("radiusPx", 6), num_param("spreadPx", 2), num_param("offsetX", 12),
                                                   num_param("offsetY", 9), color_param("color", 0, 0, 0, 0.7)}),
                          fx_entry("gaussian-blur", {num_param("radiusPx", 2)})}));
  list.push_back(fx_rect("glow", 40, 130, 20, 20, {0.9, 0.9, 0.2, 1},
                         {fx_entry("glow", {num_param("radiusPx", 8), num_param("spreadPx", 3), color_param("color", 1, 0.5, 0, 0.9)})}));
  // Motion blur: the chain's input is both samples.
  api::Renderable moving = fx_rect("moving", 200, 140, 26, 26, {0.3, 0.4, 1, 1},
                                   {fx_entry("stroke", {num_param("widthPx", 3), color_param("color", 1, 1, 1, 1)}),
                                    fx_entry("sharpen", {num_param("amount", 0.5)})});
  for (const double x : {200.0, 215.0}) {
    api::RenderMotionSample s;
    s.model_matrix = {26, 0, 0, 0, 26, 0, x, 140, 1};
    s.opacity = 1;
    moving.motion_samples.push_back(s);
  }
  list.push_back(moving);
  // Past the right edge: the scissor is clamped to the frame.
  list.push_back(fx_rect("edge", 240, 100, 30, 30, {1, 1, 1, 1}, {fx_entry("blur", {num_param("radiusPx", 5)})}));
  list.push_back(fx_rect("inner", 100, 90, 24, 24, {0.8, 0.2, 0.8, 1},
                         {fx_entry("fill-opacity", {num_param("amount", 0.5)}),
                          fx_entry("inner-shadow", {nums_param("p", {3, 3, 0.8, 0, 0, 0, 0, 0, 24, 24, 0, 0}), num_param("sigmaPx", 4)}),
                          fx_entry("stroke", {num_param("widthPx", 2), color_param("color", 0, 1, 1, 1)})}));
  list.push_back(fx_rect("deep", 120, 150, 16, 16, {1, 0.6, 0.6, 1},
                         {fx_entry("deep-glow", {num_param("radiusPx", 10), num_param("octaves", 3), num_param("gain", 1.5),
                                                 nums_param("chroma", {1, 1, 1}), nums_param("aspect", {1, 1}),
                                                 nums_param("tint", {1, 1, 1})})}));
  // Vignette's reach is not measured: the chain runs full frame from it on.
  list.push_back(fx_rect("unknown", 60, 60, 20, 20, {0.5, 1, 1, 1},
                         {fx_entry("gaussian-blur", {num_param("radiusPx", 3)}),
                          fx_entry("vignette", {num_param("amount", 0.5), num_param("feather", 0.5), num_param("roundness", 1),
                                                num_param("cx", 0.5), num_param("cy", 0.5), num_param("aspect", 1)})}));
  return f;
}

}  // namespace

TEST_CASE("grow bounds: a chain scissored to each layer's reach draws the same pixels as the full-frame chain") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  const auto file = bounded_fx_scene();
  for (const bool fields : {false, true}) {
    CAPTURE(fields);
    renderer->set_effect_fields(fields);
    renderer->set_effect_bounds(true);
    Frame bounded;
    FrameStats sb;
    REQUIRE(renderer->render(file, &bounded, sb, err));
    CHECK(sb.gpuError.empty());
    renderer->set_effect_bounds(false);
    Frame full;
    FrameStats sf;
    REQUIRE(renderer->render(file, &full, sf, err));
    CHECK(sf.gpuError.empty());
    // Every measured entry ran scissored, the vignette too (it scales the
    // input texel, so it reaches no further); nothing bounded without bounds.
    CHECK(sb.effects.bounded == 13);
    CHECK(sb.effects.fullFrame == 0);
    CHECK(sf.effects.bounded == 0);
    CHECK(sf.effects.fullFrame == 13);
    REQUIRE(bounded.width == full.width);
    REQUIRE(bounded.height == full.height);
    std::size_t differing = 0;
    for (std::size_t i = 0; i < full.rgba.size(); ++i) differing += bounded.rgba[i] != full.rgba[i] ? 1 : 0;
    CHECK(differing == 0);
    // The effects did draw (the scene is not just its background).
    const auto px = [&](std::uint32_t x, std::uint32_t y, std::size_t c) { return full.rgba.at((std::size_t{y} * 256 + x) * 4 + c); };
    CHECK(px(32, 32, 0) > 150);   // the blurred red square's centre
    CHECK(px(250, 115, 0) > 150);  // the edge layer, on screen
  }
  renderer->set_effect_bounds(true);
}

TEST_CASE("a texture over the device's 2D limit skips its layer, not the frame") {
  // 2026-10-08: a 10000 % text layer rasterised 16384 px wide on a device made
  // with the WebGPU default 8192 limit; Dawn's error texture failed the frame's
  // whole command buffer and every layer came back transparent.
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  const std::uint32_t limit = renderer->device().max_texture_dimension();
  // The device asks for the adapter's 2D size, up to the rasters' 16384 (device_limits.hpp).
  CHECK(limit >= 8192);
  CHECK(limit <= 16384);
  WARN("maxTextureDimension2D " << limit);

  auto file = solid_scene(1, 0.5, 0);
  const std::uint32_t w = limit + 1;
  api::RenderBlob blob;
  blob.hash = "hash:huge";
  blob.width = w;
  blob.height = 1;
  blob.format = api::RenderTextureFormat::rgba8unorm;
  blob.pixels.assign(std::size_t{w} * 4, 255);
  file.blobs.push_back(std::move(blob));
  api::RenderTextureRef ref;
  ref.key = "text:huge";
  ref.hash = "hash:huge";
  ref.ready = true;
  file.textures.push_back(ref);
  api::Renderable huge;
  huge.id = "huge";
  huge.kind = api::RenderableKind::image;
  huge.model_matrix = {64, 0, 0, 0, 48, 0, 0, 0, 1};  // covers the frame
  huge.bounds = {0, 0, 64, 48};
  huge.opacity = 1;
  huge.texture_key = "text:huge";
  file.scene.renderables.push_back(huge);

  const std::uint64_t refusedBefore = renderer->device().stats().texturesRefused;
  Frame frame;
  FrameStats s;
  REQUIRE(renderer->render(file, &frame, s, err));
  CHECK(s.gpuError.empty());
  CHECK(renderer->device().stats().texturesRefused == refusedBefore + 1);
  const auto px = [&](std::uint32_t x, std::uint32_t y, std::size_t c) { return frame.rgba.at((std::size_t{y} * 64 + x) * 4 + c); };
  // The rest of the frame is drawn: the orange rect and the black background, opaque.
  CHECK(px(32, 24, 0) == 255);
  CHECK(std::abs(static_cast<int>(px(32, 24, 1)) - 128) <= 1);
  CHECK(px(32, 24, 3) == 255);
  CHECK(px(2, 2, 0) == 0);
  CHECK(px(2, 2, 3) == 255);
}

// ── E1 / E2 / E3 (docs/PROGRAM_3D_PERF_UX.md) ─────────────────────────────

namespace {

/// A depth-eligible 3D rect: unit quad under a column-major 4×4 model at (x, y) of w × h.
api::Renderable rect3d(std::string id, double x, double y, double w, double h, double r, double g, double b) {
  api::Renderable q;
  q.id = std::move(id);
  q.kind = api::RenderableKind::rect;
  q.model_matrix = {w, 0, 0, 0, h, 0, x, y, 1};
  q.bounds = {x, y, w, h};
  q.opacity = 1;
  q.color = api::Color{r, g, b, 1};
  api::RenderThreeD td;
  td.model = {w, 0, 0, 0, 0, h, 0, 0, 0, 0, 1, 0, x, y, 0, 1};
  q.three_d = td;
  return q;
}

/// solid_scene's view with an identity (orthographic) 3D camera: a 3D layer lands where a 2D one would.
api::RenderFrameFile threed_scene() {
  api::RenderFrameFile f = solid_scene(0, 0, 1);
  f.scene.renderables.clear();
  api::RenderCamera3D cam;
  cam.view = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
  cam.projection = cam.view;
  f.scene.camera3d = cam;
  return f;
}

api::RenderEffect blur_fx(double radius) {
  api::RenderEffect blur;
  blur.type = "gaussian-blur";
  blur.params.push_back(num_param("radiusPx", radius));
  return blur;
}

}  // namespace

TEST_CASE("E1: a 3D surface's effect chain is kept across frames and reused when only the camera moves, pixel for pixel") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  renderer->set_effect_layer_buffers(true);  // the engine's path: layer-sized chain buffers
  auto file = threed_scene();
  file.scene.renderables.push_back(rect3d("a", 16, 12, 24, 16, 0, 0.5, 1));
  file.scene.renderables[0].effects.push_back(blur_fx(3));
  Frame first;
  FrameStats s1;
  REQUIRE(renderer->render(file, &first, s1, err));
  CHECK(s1.gpuError.empty());
  CHECK(s1.effects.layerChainsReused == 0);
  // The blur reached outside the rect: the chain ran in a buffer with a margin.
  const auto px = [&](const Frame& f, std::uint32_t x, std::uint32_t y, std::size_t c) { return f.rgba.at((std::size_t{y} * 64 + x) * 4 + c); };
  CHECK(px(first, 14, 20, 2) > 0);
  CHECK(px(first, 2, 2, 2) == 0);
  Frame again;
  FrameStats s2;
  REQUIRE(renderer->render(file, &again, s2, err));
  CHECK(s2.effects.layerChainsReused == 0);  // the key held: kept this frame
  CHECK(again.rgba == first.rgba);
  FrameStats s3;
  REQUIRE(renderer->render(file, &again, s3, err));
  CHECK(s3.effects.layerChainsReused == 1);  // a copy of the kept result
  CHECK(again.rgba == first.rgba);
  // A fresh renderer — no kept results — for the same frame.
  const auto fresh = [&]() {
    std::string e;
    auto other = SceneRenderer::create({}, e);
    other->set_effect_layer_buffers(true);
    Frame out;
    FrameStats s;
    REQUIRE(other->render(file, &out, s, e));
    return out.rgba;
  };
  // The camera moves (the layer slides 5 px): the chain is in layer space, so
  // the kept result is reused — and draws what a fresh render draws.
  file.scene.camera3d->view[12] = 5;
  Frame moved;
  FrameStats s4;
  REQUIRE(renderer->render(file, &moved, s4, err));
  CHECK(s4.effects.layerChainsReused == 1);
  CHECK(moved.rgba != first.rgba);
  CHECK(moved.rgba == fresh());
  // A parameter changed: the chain runs again.
  file.scene.renderables[0].effects[0].params[0].number = 1;
  Frame sharper;
  FrameStats s5;
  REQUIRE(renderer->render(file, &sharper, s5, err));
  CHECK(s5.effects.layerChainsReused == 0);
  CHECK(sharper.rgba != moved.rgba);
  CHECK(sharper.rgba == fresh());
}

TEST_CASE("E2: effect-bearing 3D layers add only their chain's passes to a run — the group pass is never split") {
  // The second frame's pass count (the first pays one-off texture preparation),
  // for a run of three 3D layers with none / one / all three carrying a blur.
  const auto passes_with = [](std::size_t withBlur) -> std::uint64_t {
    std::string err;
    auto renderer = SceneRenderer::create({}, err);
    if (!renderer) return 0;
    renderer->set_effect_layer_buffers(true);
    auto file = threed_scene();
    file.scene.renderables.push_back(rect3d("a", 4, 4, 16, 12, 1, 0, 0));
    file.scene.renderables.push_back(rect3d("b", 24, 10, 16, 12, 0, 1, 0));
    file.scene.renderables.push_back(rect3d("c", 44, 20, 16, 12, 0, 0, 1));
    for (std::size_t i = 0; i < withBlur; ++i) file.scene.renderables[i].effects.push_back(blur_fx(2));
    Frame f;
    FrameStats s;
    REQUIRE(renderer->render(file, &f, s, err));
    const std::uint64_t before = renderer->device().stats().passes;
    REQUIRE(renderer->render(file, &f, s, err));
    CHECK(s.gpuError.empty());
    return renderer->device().stats().passes - before;
  };
  const std::uint64_t p0 = passes_with(0);
  if (p0 == 0) return;  // no adapter
  const std::uint64_t p1 = passes_with(1);
  const std::uint64_t p3 = passes_with(3);
  CHECK(p1 > p0);
  // Each effect layer costs its content draw + its chain, and nothing else: no
  // flush / resolve of the MSAA group target per layer.
  CHECK(p3 - p0 == 3 * (p1 - p0));
}

TEST_CASE("E3: graph targets are allocated on demand and a slot-size change keeps the other size's targets warm") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  auto file = solid_scene(0, 0, 1);
  Frame frame;
  FrameStats s;
  REQUIRE(renderer->render(file, &frame, s, err));
  // A comp without precomps never allocates the precomp MSAA pairs; the scene colour is there.
  TargetPixels tp;
  std::string e2;
  CHECK_FALSE(renderer->read_target("precomp-target-0", tp, e2));
  CHECK(renderer->read_target("scene-color", tp, e2));
  REQUIRE(renderer->render(file, &frame, s, err));
  const std::uint64_t atA = renderer->device().stats().targetMisses;
  // Half the slot width: new targets.
  file.view.css_width = 32;
  REQUIRE(renderer->render(file, &frame, s, err));
  REQUIRE(renderer->render(file, &frame, s, err));
  const std::uint64_t atB = renderer->device().stats().targetMisses;
  CHECK(atB > atA);
  // Back to the first size: every target is a pool hit.
  file.view.css_width = 64;
  REQUIRE(renderer->render(file, &frame, s, err));
  CHECK(renderer->device().stats().targetMisses == atB);
  // The other size stays warm past the pool's 120-frame idle collection.
  file.view.css_width = 32;
  for (int i = 0; i < 200; ++i) REQUIRE(renderer->render(file, nullptr, s, err));
  const std::uint64_t afterIdle = renderer->device().stats().targetMisses;
  file.view.css_width = 64;
  REQUIRE(renderer->render(file, &frame, s, err));
  CHECK(renderer->device().stats().targetMisses == afterIdle);
  CHECK(frame.width == 64);
}

// ── E5 / E8 (docs/PROGRAM_3D_PERF_UX.md) ─────────────────────────────────────

namespace {

/// A point light with a shadow map (as the comp's key light carries it).
api::RenderLight3D shadow_light(double x, double y) {
  api::RenderLight3D l;
  l.type = api::RenderLightType::point;
  l.color = {1, 1, 1};
  l.gain = 1;
  l.x = x;
  l.y = y;
  l.z = -300;
  l.radius = 2000;
  l.aim_x = 0;
  l.aim_y = 0;
  l.aim_z = 1;
  l.falloff_mode = 0;
  l.falloff_distance = 0;
  l.shadow_map = true;
  l.shadow_map_size = 256;
  l.shadow_darkness = 1;
  l.shadow_softness = 1;
  return l;
}

/// Two shadow lights, a caster, a lit reflector, SSAO on.
api::RenderFrameFile lit_scene() {
  api::RenderFrameFile file = threed_scene();
  file.scene.lights3d.push_back(shadow_light(10, 6));
  file.scene.lights3d.push_back(shadow_light(54, 40));
  api::Renderable a = rect3d("a", 8, 6, 20, 14, 1, 0, 0);
  a.three_d->casts_shadow = true;
  api::Renderable b = rect3d("b", 30, 22, 26, 18, 0, 0.5, 1);
  b.three_d->casts_shadow = true;
  api::RenderShade3D sh;
  sh.specular = 0.5;
  sh.shininess = 20;
  sh.reflection_intensity = 1;
  sh.layer_reflections = true;
  b.three_d->shade = sh;
  api::RenderSsao ao;
  ao.enabled = true;
  ao.radius = 20;
  ao.intensity = 1;
  ao.quality = api::RenderSsaoQuality::half;
  file.scene.ssao = ao;
  file.scene.renderables.push_back(a);
  file.scene.renderables.push_back(b);
  return file;
}

}  // namespace

TEST_CASE("E5: a static lit scene builds its shadow maps, SSAO and reflections once; the next frame reuses them; a run split reuses within the frame") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  auto file = lit_scene();
  Frame f1;
  FrameStats s1;
  REQUIRE(renderer->render(file, &f1, s1, err));
  CHECK(s1.gpuError.empty());
  CHECK(s1.effects.shadowMapsBuilt == 2);
  CHECK(s1.effects.shadowMapsReused == 0);
  CHECK(s1.effects.ssaoBuilt == 1);
  CHECK(s1.effects.ssaoReused == 0);
  CHECK(s1.effects.reflectionsBuilt == 1);
  CHECK(s1.effects.reflectionsReused == 0);
  // Frame 2 of a static scene: nothing rebuilt, the same pixels.
  Frame f2;
  FrameStats s2;
  REQUIRE(renderer->render(file, &f2, s2, err));
  CHECK(s2.effects.shadowMapsBuilt == 0);
  CHECK(s2.effects.shadowMapsReused == 2);
  CHECK(s2.effects.ssaoBuilt == 0);
  CHECK(s2.effects.ssaoReused == 1);
  CHECK(s2.effects.reflectionsBuilt == 0);
  CHECK(s2.effects.reflectionsReused == 1);
  CHECK(f2.rgba == f1.rgba);
  // The caster moves: the maps, the AO and the mirror are built again (and differ).
  file.scene.renderables[0].three_d->model[12] += 3;
  file.scene.renderables[0].model_matrix[6] += 3;
  Frame f3;
  FrameStats s3;
  REQUIRE(renderer->render(file, &f3, s3, err));
  CHECK(s3.effects.shadowMapsBuilt == 2);
  CHECK(s3.effects.ssaoBuilt == 1);
  CHECK(s3.effects.reflectionsBuilt == 1);
  CHECK(f3.rgba != f1.rgba);
  // A 2D layer between the two 3D layers splits the frame into two runs: the
  // shadow maps are built by the first run and served to the second.
  auto split = lit_scene();
  api::Renderable flat = solid_scene(0, 1, 0).scene.renderables[0];
  flat.id = "flat";
  split.scene.renderables.insert(split.scene.renderables.begin() + 1, flat);
  std::string e2;
  auto other = SceneRenderer::create({}, e2);
  REQUIRE(other);
  Frame fs;
  FrameStats ss;
  REQUIRE(other->render(split, &fs, ss, e2));
  CHECK(ss.gpuError.empty());
  CHECK(ss.effects.shadowMapsBuilt == 2);
  CHECK(ss.effects.shadowMapsReused == 2);
}

TEST_CASE("E8: the ground grid draws into a frame that asks for it, against the scene, and into no other") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  auto file = threed_scene();
  file.scene.renderables.push_back(rect3d("a", 24, 8, 16, 12, 1, 1, 1));
  // A view tilted 60° about X (through the origin), its depth compressed into
  // [0, 1]: a horizontal floor plane is seen in perspective-free foreshortening.
  const double c = std::cos(60.0 * std::numbers::pi / 180);
  const double sn = std::sin(60.0 * std::numbers::pi / 180);
  file.scene.camera3d->view = {1, 0, 0, 0, 0, c, 0.001 * sn, 0, 0, -sn, 0.001 * c, 0, 0, 0, 0.5, 1};
  Frame plain;
  FrameStats sp;
  REQUIRE(renderer->render(file, &plain, sp, err));
  CHECK(sp.gpuError.empty());
  api::RenderGroundGrid gg;
  gg.y = 48;
  gg.center_x = 32;
  gg.center_z = 0;
  file.scene.ground_grid = gg;
  Frame grid;
  FrameStats sg;
  REQUIRE(renderer->render(file, &grid, sg, err));
  CHECK(sg.gpuError.empty());
  const auto px = [](const Frame& f, std::uint32_t x, std::uint32_t y, std::size_t ch) { return f.rgba.at((std::size_t{y} * 64 + x) * 4 + ch); };
  // The floor's centre lands at (32, 48·cos 60° = 24): both axes cross there — drawn.
  CHECK(grid.rgba != plain.rgba);
  CHECK(px(grid, 32, 24, 0) + px(grid, 32, 24, 1) + px(grid, 32, 24, 2) > px(plain, 32, 24, 0) + px(plain, 32, 24, 1) + px(plain, 32, 24, 2));
  // Outside the floor's extent (8 cells of the nice step 2 → x ∈ [16, 48]): untouched.
  for (const std::size_t ch : {0U, 1U, 2U, 3U}) CHECK(px(grid, 2, 46, ch) == px(plain, 2, 46, ch));
  // The layer in front keeps its own pixels: the grid is depth-tested, not painted over it.
  for (const std::size_t ch : {0U, 1U, 2U}) CHECK(px(grid, 32, 7, ch) == px(plain, 32, 7, ch));
  // A frame without the flag (an export, a thumbnail) is the plain frame again.
  file.scene.ground_grid.reset();
  Frame again;
  FrameStats sa;
  REQUIRE(renderer->render(file, &again, sa, err));
  CHECK(again.rgba == plain.rgba);
}

namespace {

/// A precomp layer `id` over the whole 64×48 comp of solid_scene, holding `child`
/// (a collapsed-transform instance: the child is already in comp space).
api::Renderable precomp_layer(const std::string& id, api::Renderable child, double opacity) {
  api::Renderable pc;
  pc.id = id;
  pc.kind = api::RenderableKind::image;
  pc.model_matrix = {64, 0, 0, 0, 48, 0, 0, 0, 1};
  pc.bounds = {0, 0, 64, 48};
  pc.opacity = opacity;
  pc.texture_key = "precomp:" + id;
  pc.precomp = api::RenderPrecompFrame{};
  pc.precomp_children.push_back(std::move(child));
  return pc;
}

}  // namespace

TEST_CASE("precomp cache: a static nested precomp is drawn once, then composited from its kept image, pixel for pixel") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  auto file = solid_scene(1, 0.5, 0);
  const api::Renderable rect = file.scene.renderables[0];
  file.scene.renderables[0] = precomp_layer("outer", precomp_layer("inner", rect, 0.5), 0.75);
  std::vector<std::uint8_t> firstRgba;
  for (int i = 0; i < 3; ++i) {
    Frame f;
    FrameStats s;
    REQUIRE(renderer->render(file, &f, s, err));
    CHECK(s.gpuError.empty());
    CHECK(s.diagnostics.empty());
    CHECK(s.effects.precompsInline == 0);
    if (i == 0) {
      // Both levels drawn (and kept: seen for the first time).
      CHECK(s.effects.precompsRendered == 2);
      CHECK(s.effects.precompsCached == 0);
      firstRgba = f.rgba;
    } else {
      // The outer precomp's kept image: its subtree (the inner one too) is not visited.
      CHECK(s.effects.precompsRendered == 0);
      CHECK(s.effects.precompsCached == 1);
      CHECK(f.rgba == firstRgba);
    }
  }
  // The comp is not just the background: the nested rect is there.
  CHECK(firstRgba.at((std::size_t{24} * 64 + 32) * 4) > 0);

  // The inner rect changes: both levels are drawn again, with the new colour.
  file.scene.renderables[0].precomp_children[0].precomp_children[0].color = api::Color{0, 0.5, 1, 1};
  Frame changed;
  FrameStats sc;
  REQUIRE(renderer->render(file, &changed, sc, err));
  CHECK(sc.effects.precompsRendered == 2);
  CHECK(sc.effects.precompsCached == 0);
  CHECK(changed.rgba != firstRgba);
  // A key that changed since last frame (animated) is not kept; held for a frame it is.
  Frame held;
  FrameStats sh;
  REQUIRE(renderer->render(file, &held, sh, err));
  CHECK(sh.effects.precompsRendered == 2);
  CHECK(held.rgba == changed.rgba);
  Frame after;
  FrameStats sa;
  REQUIRE(renderer->render(file, &after, sa, err));
  CHECK(sa.effects.precompsRendered == 0);
  CHECK(sa.effects.precompsCached == 1);
  CHECK(after.rgba == changed.rgba);

  // A fresh renderer (nothing kept) draws the same frame.
  auto other = SceneRenderer::create({}, err);
  REQUIRE(other);
  Frame fresh;
  FrameStats sf;
  REQUIRE(other->render(file, &fresh, sf, err));
  CHECK(fresh.rgba == after.rgba);
}

TEST_CASE("precomp targets: eight nested precomps each render into an isolated target of their own") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  auto file = solid_scene(1, 0.5, 0);
  api::Renderable nested = file.scene.renderables[0];
  for (int i = 7; i >= 0; --i) nested = precomp_layer("p" + std::to_string(i), std::move(nested), 0.9);
  file.scene.renderables[0] = std::move(nested);
  Frame frame;
  FrameStats s;
  REQUIRE(renderer->render(file, &frame, s, err));
  CHECK(s.gpuError.empty());
  CHECK(s.diagnostics.empty());
  CHECK(s.effects.precompsRendered == 8);
  CHECK(s.effects.precompsInline == 0);
  // The deepest level's own target (past the four declared slots) was allocated and drawn.
  TargetPixels tp;
  std::string e2;
  CHECK(renderer->read_target("precomp-target-7", tp, e2));
  CHECK_FALSE(renderer->read_target("precomp-target-8", tp, e2));
  // 0.9⁸ of the orange rect over black: lit, but well under full red.
  const auto red = frame.rgba.at((std::size_t{24} * 64 + 32) * 4);
  CHECK(red > 100);
  CHECK(red < 250);
  // Static: the next frame is the outermost precomp's kept image.
  Frame again;
  FrameStats s2;
  REQUIRE(renderer->render(file, &again, s2, err));
  CHECK(s2.effects.precompsRendered == 0);
  CHECK(s2.effects.precompsCached == 1);
  CHECK(again.rgba == frame.rgba);
}

// ── Stream D: liquid & glass (2026-11-02) ─────────────────────────────────────

namespace {

api::RenderEffectParam flag_param(std::string name, bool v) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = api::RenderParamKind::flag;
  p.number = v ? 1 : 0;
  return p;
}

api::RenderEffectParam text_param(std::string name, std::string v) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = api::RenderParamKind::text;
  p.text = std::move(v);
  return p;
}

/// A 64 x 1 raster under `key`: the left half white, the right half transparent
/// (one texel a frame column, so the bilinear mask sample is whole away from x = 32).
void add_half_mask(api::RenderFrameFile& f, const std::string& key) {
  api::RenderBlob blob;
  blob.hash = "hash:" + key;
  blob.width = 64;
  blob.height = 1;
  blob.format = api::RenderTextureFormat::rgba8unorm;
  blob.pixels.assign(64 * 4, 0);
  for (std::size_t x = 0; x < 32; ++x) {
    for (std::size_t c = 0; c < 4; ++c) blob.pixels[x * 4 + c] = 255;
  }
  f.blobs.push_back(std::move(blob));
  api::RenderTextureRef ref;
  ref.key = key;
  ref.hash = "hash:" + key;
  ref.ready = true;
  f.textures.push_back(ref);
}

/// An adjustment layer over the whole 64 x 48 frame whose colour matrix paints everything red.
api::Renderable red_adjustment() {
  api::Renderable a;
  a.id = "adj";
  a.kind = api::RenderableKind::group;
  a.model_matrix = {64, 0, 0, 0, 48, 0, 0, 0, 1};
  a.bounds = {0, 0, 64, 48};
  a.opacity = 1;
  api::RenderColorMatrix cm;
  cm.m = {0, 0, 0, 0, 0, 0, 0, 0, 0};
  cm.offset = {1, 0, 0};
  api::RenderAdjustment adj;
  adj.color_matrix = cm;
  a.adjustment = adj;
  return a;
}

/// A red rect at (x, y) of w x h on top of the scene.
api::Renderable red_rect(double x, double y, double w, double h) {
  api::Renderable q;
  q.id = "top";
  q.kind = api::RenderableKind::rect;
  q.model_matrix = {w, 0, 0, 0, h, 0, x, y, 1};
  q.bounds = {x, y, w, h};
  q.opacity = 1;
  q.color = api::Color{1, 0, 0, 1};
  return q;
}

struct Px {
  const Frame& f;
  [[nodiscard]] int at(std::uint32_t x, std::uint32_t y, std::size_t c) const {
    return f.rgba.at((std::size_t{y} * f.width + x) * 4 + c);
  }
};

}  // namespace

TEST_CASE("stream D L1: an adjustment layer is scoped by its mask and faded by its opacity against the untouched frame") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  auto file = solid_scene(0, 0, 1);  // the blue rect (16,12)-(48,36) over black
  file.scene.renderables.push_back(red_adjustment());

  // Opaque, unmasked: the whole frame goes red (as before stream D).
  Frame full;
  FrameStats s0;
  REQUIRE(renderer->render(file, &full, s0, err));
  CHECK(s0.gpuError.empty());
  CHECK(s0.diagnostics.empty());
  const Px pf{full};
  CHECK(pf.at(32, 24, 0) > 200);
  CHECK(pf.at(32, 24, 2) < 40);
  CHECK(pf.at(2, 2, 0) > 200);

  // At 50 %: a mix of the red and the blue rect; the background a half red.
  file.scene.renderables[1].opacity = 0.5;
  Frame half;
  FrameStats s1;
  REQUIRE(renderer->render(file, &half, s1, err));
  CHECK(s1.diagnostics.empty());
  const Px ph{half};
  CHECK(ph.at(32, 24, 0) > 80);
  CHECK(ph.at(32, 24, 0) < 180);
  CHECK(ph.at(32, 24, 2) > 80);
  CHECK(ph.at(32, 24, 2) < 180);
  CHECK(ph.at(2, 2, 0) > 80);
  CHECK(ph.at(2, 2, 0) < 180);

  // Masked to the left half, opaque: the right half of the frame is untouched.
  file.scene.renderables[1].opacity = 1;
  file.scene.renderables[1].mask_texture_key = "mask:adj";
  add_half_mask(file, "mask:adj");
  Frame masked;
  FrameStats s2;
  REQUIRE(renderer->render(file, &masked, s2, err));
  CHECK(s2.diagnostics.empty());
  const Px pm{masked};
  CHECK(pm.at(20, 24, 0) > 200);  // inside the mask: red
  CHECK(pm.at(20, 24, 2) < 40);
  CHECK(pm.at(44, 24, 0) == 0);   // outside: the blue rect as it was
  CHECK(pm.at(44, 24, 2) == 255);
  CHECK(pm.at(60, 40, 0) == 0);   // outside, background: black, opaque
  CHECK(pm.at(60, 40, 3) == 255);

  // At 0 % the frame is left alone entirely.
  file.scene.renderables[1].opacity = 0;
  Frame none;
  FrameStats s3;
  REQUIRE(renderer->render(file, &none, s3, err));
  const Px pn{none};
  CHECK(pn.at(20, 24, 0) == 0);
  CHECK(pn.at(20, 24, 2) == 255);
}

TEST_CASE("stream D L2/L5: Displacement Map with Source: Backdrop draws the scene under the layer through its silhouette") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  auto file = solid_scene(0, 0, 1);
  api::Renderable top = red_rect(24, 18, 16, 12);
  api::RenderEffect d;
  d.type = "displacement-map";
  d.params.push_back(num_param("maxH", 0));
  d.params.push_back(num_param("maxV", 0));
  d.params.push_back(num_param("hChannel", 10));  // Off
  d.params.push_back(num_param("vChannel", 10));
  d.params.push_back(num_param("mapMode", 0));
  d.params.push_back(num_param("edge", 0));
  d.params.push_back(flag_param("expand", false));
  d.params.push_back(num_param("lw", 16));
  d.params.push_back(num_param("lh", 12));
  top.effects.push_back(d);
  file.scene.renderables.push_back(top);

  // Source: This Layer (no flag) — the red rect, moved by nothing.
  Frame own;
  FrameStats s0;
  REQUIRE(renderer->render(file, &own, s0, err));
  CHECK(s0.gpuError.empty());
  CHECK(s0.diagnostics.empty());
  const Px po{own};
  CHECK(po.at(32, 24, 0) == 255);
  CHECK(po.at(32, 24, 2) == 0);

  // Source: Backdrop — the blue rect under it shows through the red rect's silhouette.
  file.scene.renderables[1].effects[0].params.push_back(flag_param("readsBackdrop", true));
  Frame back;
  FrameStats s1;
  REQUIRE(renderer->render(file, &back, s1, err));
  CHECK(s1.diagnostics.empty());
  CHECK(s1.effects.layerChainsReused == 0);
  const Px pb{back};
  CHECK(pb.at(32, 24, 0) == 0);
  CHECK(pb.at(32, 24, 2) == 255);
  CHECK(pb.at(20, 24, 2) == 255);  // beside the red rect: the blue rect as before
  CHECK(pb.at(2, 2, 3) == 255);
  // Never kept across frames (the backdrop may change): the chain runs again.
  Frame again;
  FrameStats s2;
  REQUIRE(renderer->render(file, &again, s2, err));
  CHECK(s2.effects.layerChainsReused == 0);
  CHECK(again.rgba == back.rgba);
}

TEST_CASE("stream D L2: the fx-graph's BACKDROP slot is the scene under the layer when the entry reads the backdrop") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  auto file = solid_scene(0, 0, 0.25);
  Frame alone;
  FrameStats sa;
  REQUIRE(renderer->render(file, &alone, sa, err));
  // The rect colour is display-encoded (the first test: 0.5 -> 128): 0.25 -> 64.
  const int blueAlone = Px{alone}.at(32, 24, 2);
  CHECK(blueAlone > 50);
  CHECK(blueAlone < 80);

  // A copy of BACKDROP into A, added over the scene: the blue doubles in linear
  // light (2 x 0.0508 -> display ~0.35, about 89).
  api::Renderable top = red_rect(24, 18, 16, 12);
  top.blend = api::RenderBlendMode::add;
  api::RenderEffect g;
  g.type = "fx-graph";
  g.params.push_back(text_param("fxType", "test-backdrop"));
  g.params.push_back(text_param("mats", "fxx-copy"));
  g.params.push_back(nums_param("g", {0, 0, 1, 31, -1, -1, -1, 0, 0, 0}));
  g.params.push_back(num_param("out", 1));
  g.params.push_back(num_param("lw", 16));
  g.params.push_back(num_param("lh", 12));
  top.effects.push_back(g);
  file.scene.renderables.push_back(top);

  // Without the flag the slot reads transparent black: nothing is added.
  Frame blank;
  FrameStats s0;
  REQUIRE(renderer->render(file, &blank, s0, err));
  CHECK(s0.diagnostics.empty());
  CHECK(Px{blank}.at(32, 24, 2) == blueAlone);

  file.scene.renderables[1].effects[0].params.push_back(flag_param("readsBackdrop", true));
  Frame doubled;
  FrameStats s1;
  REQUIRE(renderer->render(file, &doubled, s1, err));
  CHECK(s1.gpuError.empty());
  CHECK(s1.diagnostics.empty());
  const Px pd{doubled};
  CHECK(pd.at(32, 24, 2) > blueAlone + 15);
  CHECK(pd.at(32, 24, 0) == 0);
  CHECK(pd.at(2, 2, 0) == 0);  // black + black
  CHECK(pd.at(2, 2, 3) == 255);
}

TEST_CASE("stream D L3: the goo passes build and the blurred, thresholded blob reaches past the input, shaded, nowhere else") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  renderer->set_effect_fields(true);
  auto file = solid_scene(0, 0, 1);
  api::RenderEffect g;
  g.type = "fx-graph";
  g.params.push_back(text_param("fxType", "goo"));
  g.params.push_back(text_param("mats", "fxx-goo-shape,fxx-goo-shade"));
  const double lx = std::cos(-std::numbers::pi / 4) * std::cos(0.9);
  const double ly = std::sin(-std::numbers::pi / 4) * std::cos(0.9);
  const double lz = std::sin(0.9);
  g.params.push_back(nums_param("g", {// blur sigma 6 along x (IN -> X1) and y (X1 -> X0)
                                      1, 6, 5, 0, -1, -1, -1, 0, 0, 0,  //
                                      2, 6, 4, 5, -1, -1, -1, 0, 0, 0,  //
                                      // the shape: threshold 0.25, softness 0.2, tint
                                      0, 0, 1, 4, 0, -1, -1, 0, 0, 2, 0.25, 0.2, 1, 0, 0.03, 0.55, 1, 0,  //
                                      // its distance field to 10 px, then the shading
                                      4, 10, 5, 1, -1, -1, -1, 0, 0, 0,  //
                                      0, 1, 2, 1, 5, -1, -1, 0, 0, 3, 8, 0.5, 40, 0.2, lx, ly, lz, 0.85, 1, 1, 1, 0}));
  g.params.push_back(num_param("out", 2));
  g.params.push_back(num_param("lw", 32));
  g.params.push_back(num_param("lh", 24));
  g.params.push_back(num_param("reachPx", 24));
  g.params.push_back(flag_param("reachMeasured", true));
  file.scene.renderables[0].effects.push_back(g);
  Frame frame;
  FrameStats s;
  REQUIRE(renderer->render(file, &frame, s, err));
  CHECK(s.gpuError.empty());
  CHECK(s.diagnostics.empty());
  const Px px{frame};
  // Inside: the tinted blob, lit.
  CHECK(px.at(32, 24, 2) > 100);
  CHECK(px.at(32, 24, 3) == 255);
  // Three px outside the rect's left edge (16): the blurred alpha (sigma 6) is
  // over the threshold there — the blob grew.
  CHECK(px.at(13, 24, 2) > 20);
  // Far outside: nothing (the reach is bounded).
  CHECK(px.at(2, 2, 0) == 0);
  CHECK(px.at(2, 2, 2) == 0);
  CHECK(px.at(2, 2, 3) == 255);
}

TEST_CASE("stream D L4: liquid glass builds and shades its dome; the original glass path is untouched") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  auto file = solid_scene(0, 0, 1);
  api::Renderable panel = red_rect(20, 14, 24, 20);
  panel.id = "panel";
  panel.color = api::Color{1, 1, 1, 1};
  api::RenderGlass g;
  g.refraction = 10;
  g.edge_width = 3;
  g.aberration = 2;
  g.saturation = 1;
  g.tint = api::Color{1, 1, 1, 1};
  g.tint_opacity = 0.1;
  g.rim = api::Color{1, 1, 1, 1};
  g.rim_opacity = 0.3;
  g.rim_width = 4;
  g.rim_angle = 5.5;
  g.specular_angle = 5.5;
  g.specular_intensity = 0.3;
  g.specular_falloff = 8;
  g.grain = 0;
  g.ior = 1.5;
  g.thickness = 8;
  panel.glass = g;
  file.scene.renderables.push_back(panel);

  Frame edge;
  FrameStats s0;
  REQUIRE(renderer->render(file, &edge, s0, err));
  CHECK(s0.gpuError.empty());
  CHECK(s0.diagnostics.empty());

  file.scene.renderables[1].glass->bump_source = 1;  // the dome
  file.scene.renderables[1].glass->caustic = 0.5;
  file.scene.renderables[1].glass->fresnel = 0.3;
  Frame dome;
  FrameStats s1;
  REQUIRE(renderer->render(file, &dome, s1, err));
  CHECK(s1.gpuError.empty());
  CHECK(s1.diagnostics.empty());
  const Px pd{dome};
  CHECK(pd.at(32, 24, 3) == 255);
  // The panel is lit differently from the alpha-edge glass somewhere inside it; outside it nothing changed.
  int differ = 0;
  for (std::uint32_t y = 14; y < 34; ++y) {
    for (std::uint32_t x = 20; x < 44; ++x) {
      for (std::size_t c = 0; c < 3; ++c) differ += Px{edge}.at(x, y, c) != pd.at(x, y, c) ? 1 : 0;
    }
  }
  CHECK(differ > 0);
  CHECK(Px{edge}.at(2, 2, 0) == pd.at(2, 2, 0));
  CHECK(Px{edge}.at(10, 24, 2) == pd.at(10, 24, 2));

  // The luminance surface, and a bump layer that does not exist (falls back to the luminance).
  file.scene.renderables[1].glass->bump_source = 2;
  Frame luma;
  FrameStats s2;
  REQUIRE(renderer->render(file, &luma, s2, err));
  CHECK(s2.diagnostics.empty());
  file.scene.renderables[1].glass->bump_source = 3;
  file.scene.renderables[1].glass->bump_layer_id = "nobody";
  Frame missing;
  FrameStats s3;
  REQUIRE(renderer->render(file, &missing, s3, err));
  CHECK(s3.diagnostics.empty());
  CHECK(missing.rgba == luma.rgba);
}

TEST_CASE("stream D L5: a Displacement Map entry with only an amount renders as the full AE row at Red / Green, both axes") {
  std::string err;
  auto renderer = SceneRenderer::create({}, err);
  if (!renderer) return;
  auto file = solid_scene(0.2, 0.6, 1);
  api::RenderEffect legacy;
  legacy.type = "displacement-map";
  legacy.params.push_back(num_param("amount", 6));
  legacy.params.push_back(num_param("lw", 32));
  legacy.params.push_back(num_param("lh", 24));
  file.scene.renderables[0].effects.push_back(legacy);
  Frame a;
  FrameStats sa;
  REQUIRE(renderer->render(file, &a, sa, err));
  CHECK(sa.diagnostics.empty());

  api::RenderEffect full;
  full.type = "displacement-map";
  for (const auto& [k, v] : std::initializer_list<std::pair<const char*, double>>{
           {"amount", 6}, {"maxH", 6}, {"maxV", 6}, {"hChannel", 0}, {"vChannel", 1}, {"mapMode", 0}, {"edge", 0}, {"lw", 32}, {"lh", 24}}) {
    full.params.push_back(num_param(k, v));
  }
  full.params.push_back(flag_param("expand", true));
  file.scene.renderables[0].effects[0] = full;
  Frame b;
  FrameStats sb;
  REQUIRE(renderer->render(file, &b, sb, err));
  CHECK(sb.diagnostics.empty());
  CHECK(a.rgba == b.rgba);
}
