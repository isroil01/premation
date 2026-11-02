// The effect chain's grow bounds (render_graph/fx_bounds.hpp): where a layer's
// content lands in texels, and how far each chain entry reaches from there —
// the numbers the chain scissors its passes to. The GPU half (a bounded chain
// draws the same pixels as an unbounded one) is test_render_graph_gpu.cpp.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <initializer_list>
#include <limits>
#include <string>
#include <utility>

#include "fx_bounds.hpp"

using namespace premation::rg;
using Catch::Approx;

namespace {

/// ViewportState::from's view-projection: css w × h at dpr 1 around (cx, cy).
Mat3 view_projection(double w, double h, double cx, double cy, double zoom) {
  return mul(ortho(-w / 2, w / 2, h / 2, -h / 2), mul(scaling(zoom, zoom), translation(-cx, -cy)));
}

api::RenderEffect entry(std::string type, std::initializer_list<std::pair<const char*, double>> nums) {
  api::RenderEffect e;
  e.type = std::move(type);
  for (const auto& [name, v] : nums) {
    api::RenderEffectParam p;
    p.name = name;
    p.kind = api::RenderParamKind::number;
    p.number = v;
    e.params.push_back(std::move(p));
  }
  return e;
}

api::RenderEffectParam numbers(std::string name, std::vector<double> v) {
  api::RenderEffectParam p;
  p.name = std::move(name);
  p.kind = api::RenderParamKind::numbers;
  p.numbers = std::move(v);
  return p;
}

void check_box(const PxBox& b, double x0, double y0, double x1, double y1) {
  CHECK(b.x0 == Approx(x0));
  CHECK(b.y0 == Approx(y0));
  CHECK(b.x1 == Approx(x1));
  CHECK(b.y1 == Approx(y1));
}

constexpr PxBox kIn{100, 100, 200, 150};
constexpr FxBoundsView kView{1, 1};

}  // namespace

TEST_CASE("content_box: the quad under the model and every motion sample, in whole texels plus one") {
  const Mat3 vp = view_projection(64, 64, 32, 32, 1);  // world = texels
  api::Renderable r;
  r.model_matrix = {32, 0, 0, 0, 24, 0, 16, 12, 1};  // unit quad → (16,12)-(48,36)
  const auto box = content_box(r, vp, 64, 64);
  REQUIRE(box);
  check_box(*box, 15, 11, 49, 37);

  api::RenderMotionSample s;
  s.model_matrix = {32, 0, 0, 0, 24, 0, 26, 12, 1};  // 10 texels to the right
  r.motion_samples.push_back(s);
  const auto blurred = content_box(r, vp, 64, 64);
  REQUIRE(blurred);
  check_box(*blurred, 15, 11, 59, 37);

  // Zoom 2 about the centre: (16..58, 12..36) doubles about (32, 32) to (0..84, -8..40).
  const auto zoomed = content_box(r, view_projection(64, 64, 32, 32, 2), 64, 64);
  REQUIRE(zoomed);
  check_box(*zoomed, -1, -9, 85, 41);
}

TEST_CASE("content_box: no bound for a deformed mesh or a quad projected through infinity") {
  const Mat3 vp = view_projection(64, 64, 32, 32, 1);
  api::Renderable mesh;
  mesh.model_matrix = {32, 0, 0, 0, 24, 0, 16, 12, 1};
  mesh.deformed_mesh = api::RenderDeformedMesh{};
  CHECK_FALSE(content_box(mesh, vp, 64, 64));

  api::Renderable pinned;
  pinned.model_matrix = {32, 0, -2, 0, 24, 0, 16, 12, 1};  // w = 1 - 2u: the right edge is behind the eye
  CHECK_FALSE(content_box(pinned, vp, 64, 64));

  api::Renderable broken;
  broken.model_matrix = {std::numeric_limits<double>::quiet_NaN(), 0, 0, 0, 1, 0, 0, 0, 1};
  CHECK_FALSE(content_box(broken, vp, 64, 64));
}

TEST_CASE("fx_reach: blurs reach their last tap — 3.5 sigma plus one tap spacing, plus two") {
  // 3.5 sigma since S4 (docs/PROGRAM_PERFORMANCE.md); the 30-texel floor went with the
  // shader's 30-tap minimum (2026-11-01): radius 10 reaches 35 + 1 + 2.
  const auto g = fx_reach(entry("gaussian-blur", {{"radiusPx", 10}}), kIn, kView);
  REQUIRE(g);
  check_box(g->out, 62, 62, 238, 188);
  check_box(g->passes, 62, 62, 238, 188);

  // Radius 40: taps 40 × 2.5 / 30 apart, the last under 140 + 3.33 out.
  const double r40 = 140 + 40 * 2.5 / 30 + 2;
  const auto wide = fx_reach(entry("blur", {{"radiusPx", 40}}), kIn, kView);
  REQUIRE(wide);
  check_box(wide->out, 100 - r40, 100 - r40, 200 + r40, 150 + r40);

  // dims 1 = horizontal only, 2 = vertical only. Fast Box Blur is a box of half-width
  // radiusPx (its last texel by its fraction, one more), `iterations` times, plus two.
  const auto h = fx_reach(entry("fast-box-blur", {{"radiusPx", 40}, {"dims", 1}}), kIn, kView);
  REQUIRE(h);
  check_box(h->out, 100 - 43, 100, 200 + 43, 150);
  const auto h3 = fx_reach(entry("fast-box-blur", {{"radiusPx", 10.5}, {"iterations", 3}}), kIn, kView);
  REQUIRE(h3);
  check_box(h3->out, 100 - 38, 100 - 38, 200 + 38, 150 + 38);
  const auto v = fx_reach(entry("gaussian-blur", {{"radiusPx", 40}, {"dims", 2}}), kIn, kView);
  REQUIRE(v);
  check_box(v->out, 100, 100 - r40, 200, 150 + r40);

  // No radius: blur.wgsl samples the centre only.
  const auto none = fx_reach(entry("gaussian-blur", {{"radiusPx", 0}}), kIn, kView);
  REQUIRE(none);
  check_box(none->out, 100, 100, 200, 150);
}

TEST_CASE("fx_reach: a glow adds its spread and its wide pass (2.2 x the radius)") {
  // radius 10 → rPx 11.5 ≥ 6: the narrow pass reaches 3.5 × 11.5 + 1 + 2, and the
  // wide pass blurs that again by √(25.3² − 11.5²) with its taps kGlowWideSpacing (3)
  // times further apart: 3.5 σ' + σ' × 2.5 / 30 × 3 + 2 more.
  const double wideSigma = std::sqrt(25.3 * 25.3 - 11.5 * 11.5);
  const double r = (3.5 * 11.5 + 1 + 2) + (3.5 * wideSigma + wideSigma * 2.5 / 30 * 3 + 2);
  const auto g = fx_reach(entry("glow", {{"radiusPx", 10}}), kIn, kView);
  REQUIRE(g);
  check_box(g->out, 100 - r, 100 - r, 200 + r, 150 + r);
  // A spread dilates first (spread + 1 + 2).
  const auto spread = fx_reach(entry("glow", {{"radiusPx", 10}, {"spreadPx", 4}}), kIn, kView);
  REQUIRE(spread);
  check_box(spread->out, 100 - r - 7, 100 - r - 7, 200 + r + 7, 150 + r + 7);
  // A small glow has no wide pass: rPx 4.6 reaches 16.1 + 1 + 2.
  const auto small = fx_reach(entry("glow", {{"radiusPx", 4}}), kIn, kView);
  REQUIRE(small);
  check_box(small->out, 80.9, 80.9, 219.1, 169.1);
}

TEST_CASE("fx_reach: a drop shadow reaches its offset plus its softness, on its side") {
  const auto s = fx_reach(entry("drop-shadow", {{"radiusPx", 5}, {"offsetX", 10}, {"offsetY", 0}}), kIn, kView);
  REQUIRE(s);
  // The blurred silhouette (±20.5) moved 10 right and sampled ±1, with the contents.
  check_box(s->out, 100 - 11.5, 100 - 21.5, 200 + 31.5, 150 + 21.5);
  // The unmoved silhouette is drawn too.
  check_box(s->passes, 100 - 20.5, 100 - 21.5, 200 + 31.5, 150 + 21.5);

  // The radius and the offset are layer px: at 2 texels a px (a 200 % layer, or zoom 2) both
  // double — the softness reaches 3.5 × 10 + 1 + 2.
  const auto zoomed = fx_reach(entry("drop-shadow", {{"radiusPx", 5}, {"offsetX", 10}}), kIn, FxBoundsView{2, 2});
  REQUIRE(zoomed);
  CHECK(zoomed->out.x1 == Approx(200 + 38 + 20 + 1));

  // A shadow far below: the contents stay inside, the shadow's own box is added.
  const auto far = fx_reach(entry("drop-shadow", {{"offsetY", 500}}), kIn, kView);
  REQUIRE(far);
  check_box(far->out, 99, 100, 201, 651);
}

TEST_CASE("fx_reach: deep glow adds the 16-tap reach of every octave") {
  // radius 32, 3 octaves: deltas 8, √192, √768 → steps 2, 4, 7 → 16 × 13 = 208 (one octave: 128).
  const auto d = fx_reach(entry("deep-glow", {{"radiusPx", 32}, {"octaves", 3}}), kIn, kView);
  REQUIRE(d);
  check_box(d->out, 100 - 210, 100 - 210, 200 + 210, 150 + 210);
  // An aspect stretches one axis (steps 4, 7, 14 → 400).
  api::RenderEffect wide = entry("deep-glow", {{"radiusPx", 32}, {"octaves", 3}});
  wide.params.push_back(numbers("aspect", {2, 1}));
  const auto w = fx_reach(wide, kIn, kView);
  REQUIRE(w);
  check_box(w->out, 100 - 402, 100 - 210, 200 + 402, 150 + 210);
}

TEST_CASE("fx_reach: strokes, sharpen, inner styles and per-texel entries") {
  const auto stroke = fx_reach(entry("stroke", {{"widthPx", 4}}), kIn, kView);
  REQUIRE(stroke);
  check_box(stroke->out, 93, 93, 207, 157);
  const auto sharpen = fx_reach(entry("sharpen", {{"amount", 0.5}}), kIn, kView);
  REQUIRE(sharpen);
  check_box(sharpen->out, 97, 97, 203, 153);
  // An inner style blurs a copy (its passes reach) but lights only the layer's alpha.
  const auto inner = fx_reach(entry("inner-shadow", {{"sigmaPx", 8}}), kIn, kView);
  REQUIRE(inner);
  check_box(inner->passes, 69, 69, 231, 181);
  check_box(inner->out, 100, 100, 200, 150);
  for (const char* t : {"fill-opacity", "color-matrix", "channel-lut", "fill", "noise", "gradient-ramp", "fractal-noise"}) {
    const auto r = fx_reach(entry(t, {}), kIn, kView);
    REQUIRE(r);
    check_box(r->out, 100, 100, 200, 150);
  }
  // The layer-box passes smear inside the layer's box only (the input texel
  // comes back unchanged outside it), whatever their length or amount.
  for (const auto& e : {entry("directional-blur", {{"length", 400}, {"steps", 64}, {"lw", 100}, {"lh", 50}}),
                        entry("radial-blur", {{"amount", 90}, {"steps", 64}, {"lw", 100}, {"lh", 50}}),
                        entry("wave-warp", {{"height", 300}, {"k", 0.1}, {"lw", 100}, {"lh", 50}}),
                        entry("turbulent-displace", {{"amount", 500}}), entry("vignette", {{"amount", -1}})}) {
    const auto r = fx_reach(e, kIn, kView);
    REQUIRE(r);
    check_box(r->out, 100, 100, 200, 150);
    check_box(r->passes, 100, 100, 200, 150);
  }
}

TEST_CASE("fx_reach: unknown reach — unlisted entries and non-finite params") {
  for (const char* t : {"displacement-map", "transform", "plugin", "native-plugin", "fx-overlay",
                        "stamp-field", "vegas", "checkerboard", "motion-tile", "lens-flare"}) {
    CHECK_FALSE(fx_reach(entry(t, {}), kIn, kView));
  }
  CHECK_FALSE(fx_reach(entry("gaussian-blur", {{"radiusPx", std::numeric_limits<double>::quiet_NaN()}}), kIn, kView));
  CHECK_FALSE(fx_reach(entry("glow", {{"radiusPx", std::numeric_limits<double>::infinity()}}), kIn, kView));
  CHECK_FALSE(fx_reach(entry("deep-glow", {{"radiusPx", 8}, {"octaves", 1e9}}), kIn, kView));
}

TEST_CASE("fx_reach: a reach never shrinks the region, and the passes cover the result") {
  for (const auto& e : {entry("blur", {{"radiusPx", 3}}), entry("glow", {{"radiusPx", 30}, {"spreadPx", 2}}),
                        entry("drop-shadow", {{"radiusPx", 12}, {"offsetX", -40}, {"offsetY", 25}, {"spreadPx", 3}}),
                        entry("deep-glow", {{"radiusPx", 20}, {"octaves", 4}}), entry("stroke", {{"widthPx", -3}}),
                        entry("bevel", {{"sigmaPx", 2}}), entry("gaussian-blur", {{"radiusPx", 7}, {"dims", 1}})}) {
    const auto r = fx_reach(e, kIn, kView);
    REQUIRE(r);
    CHECK(r->out.x0 <= kIn.x0);
    CHECK(r->out.y0 <= kIn.y0);
    CHECK(r->out.x1 >= kIn.x1);
    CHECK(r->out.y1 >= kIn.y1);
    CHECK(r->passes.x0 <= r->out.x0);
    CHECK(r->passes.y0 <= r->out.y0);
    CHECK(r->passes.x1 >= r->out.x1);
    CHECK(r->passes.y1 >= r->out.y1);
  }
}

TEST_CASE("scissor_of: whole texels, clamped to the buffer") {
  CHECK(scissor_of({-5.5, 3.2, 70.1, 10}, 64, 64) == std::array<std::uint32_t, 4>{0, 3, 64, 7});
  CHECK(scissor_of({10.5, 20.5, 30.5, 40.5}, 64, 64) == std::array<std::uint32_t, 4>{10, 20, 21, 21});
  // Off the buffer: an empty scissor (nothing of the chain is visible).
  CHECK(scissor_of({100, 100, 120, 120}, 64, 64) == std::array<std::uint32_t, 4>{64, 64, 0, 0});
  constexpr double kInf = std::numeric_limits<double>::infinity();
  CHECK(scissor_of({-kInf, -kInf, kInf, kInf}, 64, 48) == std::array<std::uint32_t, 4>{0, 0, 64, 48});
  const double nan = std::numeric_limits<double>::quiet_NaN();
  CHECK(scissor_of({nan, nan, nan, nan}, 64, 48) == std::array<std::uint32_t, 4>{0, 0, 0, 0});
}

// ── Stream D (2026-11-02): reaches in layer px through the input box ────────

TEST_CASE("fx_reach: a measured fx-graph reach converts layer px to texels through the input box") {
  // kIn is 100 x 50 texels; a 100 x 50 layer is 1 texel a px: 10 px + 2 slack.
  const auto measured = fx_reach(entry("fx-graph", {{"reachPx", 10}, {"lw", 100}, {"lh", 50}, {"reachMeasured", 1}}), kIn, kView);
  REQUIRE(measured);
  check_box(measured->out, 88, 88, 212, 162);
  check_box(measured->passes, 88, 88, 212, 162);
  // A 50 x 50 layer drawn 100 texels wide is 2 texels a px on x (the larger ratio wins on both axes: exact or larger).
  const auto scaled = fx_reach(entry("fx-graph", {{"reachPx", 10}, {"lw", 50}, {"lh", 50}, {"reachMeasured", 1}}), kIn, kView);
  REQUIRE(scaled);
  check_box(scaled->out, 78, 78, 222, 172);
  // Unmeasured (no flag) or without the layer size: unknown, as before.
  CHECK_FALSE(fx_reach(entry("fx-graph", {{"reachPx", 10}, {"lw", 100}, {"lh", 50}}), kIn, kView));
  CHECK_FALSE(fx_reach(entry("fx-graph", {{"reachPx", 10}, {"reachMeasured", 1}}), kIn, kView));
  // reachPx 0 stays per-pixel.
  const auto zero = fx_reach(entry("fx-graph", {{"reachPx", 0}, {"reachMeasured", 1}}), kIn, kView);
  REQUIRE(zero);
  check_box(zero->out, 100, 100, 200, 150);
}

TEST_CASE("fx_reach: a Displacement Map reaches its max per axis in layer px; Expand Output off clips to the input") {
  // A 50 x 25 layer in the 100 x 50 box: 2 texels a px; 5 px and 3 px of displacement.
  const auto d = fx_reach(entry("displacement-map", {{"maxH", 5}, {"maxV", 3}, {"lw", 50}, {"lh", 25}}), kIn, kView);
  REQUIRE(d);
  check_box(d->out, 88, 92, 212, 158);
  check_box(d->passes, 88, 92, 212, 158);
  const auto clipped = fx_reach(entry("displacement-map", {{"maxH", 5}, {"maxV", 3}, {"lw", 50}, {"lh", 25}, {"expand", 0}}), kIn, kView);
  REQUIRE(clipped);
  check_box(clipped->out, 100, 100, 200, 150);
  // Negative maxima reach as far.
  const auto neg = fx_reach(entry("displacement-map", {{"maxH", -5}, {"maxV", -3}, {"lw", 50}, {"lh", 25}}), kIn, kView);
  REQUIRE(neg);
  check_box(neg->out, 88, 92, 212, 158);
  // An entry without the layer size (an older producer) is still unknown.
  CHECK_FALSE(fx_reach(entry("displacement-map", {{"amount", 5}}), kIn, kView));
}
