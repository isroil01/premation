// E3 raster module on Skia: Canvas2D semantics, fonts + shaping, replay.
#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cmath>
#include <string>

#include "raster/canvas.hpp"
#include "raster/canvas_replay.hpp"
#include "raster/fonts.hpp"
#include "raster/optical_kerning.hpp"
#include "raster/raster_source.hpp"

using namespace premation::raster;

namespace {

std::array<std::uint8_t, 4> px(const std::vector<std::uint8_t>& rgba, std::uint32_t w, std::uint32_t x, std::uint32_t y) {
  const std::size_t i = (static_cast<std::size_t>(y) * w + x) * 4;
  return {rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]};
}

Style color(const char* s) {
  Style st;
  st.color = *css::parse_color(s);
  return st;
}

const FontSet& harness_fonts() {
  static const FontSet* fonts = [] {
    static FontSet f{FontOptions{}};
    std::string err;
    REQUIRE(f.load_manifest(PREMATION_RASTER_FONTS, err));
    return &f;
  }();
  return *fonts;
}

}  // namespace

TEST_CASE("canvas: fills, transforms and premultiplied output", "[raster][canvas]") {
  const auto c = Canvas2D::make(20, 10, {});
  c->setFillStyle(color("rgba(255, 0, 0, 0.5)"));
  c->scale(2, 2);
  c->fillRect(0, 0, 5, 5);
  const auto rgba = c->pixels();
  const auto in = px(rgba, 20, 3, 3);
  CHECK(in[0] == 128);  // premultiplied: 255 × 128/255
  CHECK(in[3] == 128);
  CHECK(px(rgba, 20, 12, 3)[3] == 0);
  CHECK(c->getTransform().a == 2);
}

TEST_CASE("canvas: save/restore, clip, composite and path in user space", "[raster][canvas]") {
  const auto c = Canvas2D::make(10, 10, {});
  c->save();
  c->beginPath();
  c->rect(0, 0, 5, 10);
  c->clip(FillRule::nonzero);
  c->setFillStyle(color("#00ff00"));
  c->fillRect(0, 0, 10, 10);
  c->restore();
  auto rgba = c->pixels();
  CHECK(px(rgba, 10, 2, 5)[1] == 255);
  CHECK(px(rgba, 10, 7, 5)[3] == 0);
  // destination-in over a smaller rect clears everything outside it (full-canvas op).
  REQUIRE(c->setGlobalCompositeOperation("destination-in"));
  c->fillRect(0, 0, 2, 10);
  rgba = c->pixels();
  CHECK(px(rgba, 10, 1, 5)[3] == 255);
  CHECK(px(rgba, 10, 3, 5)[3] == 0);
  CHECK_FALSE(c->setGlobalCompositeOperation("bogus"));
  CHECK(c->globalCompositeOperation() == "destination-in");
}

TEST_CASE("canvas: gradients interpolate between their stops", "[raster][canvas]") {
  const auto c = Canvas2D::make(100, 1, {});
  auto g = std::make_shared<Gradient>();
  g->kind = Gradient::Kind::linear;
  g->p[0] = 0;
  g->p[2] = 100;
  g->add_stop(1, *css::parse_color("#ffffff"));
  g->add_stop(0, *css::parse_color("#000000"));
  Style s;
  s.kind = Style::Kind::gradient;
  s.gradient = g;
  c->setFillStyle(s);
  c->fillRect(0, 0, 100, 1);
  const auto rgba = c->pixels();
  CHECK(px(rgba, 100, 0, 0)[0] < 5);
  CHECK(px(rgba, 100, 99, 0)[0] > 250);
  CHECK(std::abs(static_cast<int>(px(rgba, 100, 50, 0)[0]) - 128) <= 3);
}

TEST_CASE("fonts: harness faces load (woff2) and shape with CSS matching", "[raster][fonts]") {
  const FontSet& fonts = harness_fonts();
  REQUIRE(fonts.face_count() == 5);
  ShapeRequest r;
  r.font = *css::parse_font("600 56px \"Arial\", Inter, system-ui, sans-serif");
  const ShapedText s = fonts.shape("Motion", r);
  REQUIRE(s.glyphs.size() == 6);
  // Recorded from Chromium's canvas in the render-tests harness (Arimo Bold,
  // weight 600 → the 700 face): measureText("Motion").width.
  CHECK(s.width == 183.4765625);
  // Arabic falls back to the Noto subset registered under the same family.
  ShapeRequest ar;
  ar.font = *css::parse_font("400 30px Arial");
  ar.rtl = true;
  const ShapedText a = fonts.shape("\xD9\x85\xD8\xB1\xD8\xAD\xD8\xA8\xD8\xA7", ar);  // مرحبا
  REQUIRE_FALSE(a.glyphs.empty());
  CHECK(a.glyphs.front().face == 2);
}

TEST_CASE("replay: a recorded call log draws on canvas 0", "[raster][replay]") {
  const std::string ops = R"([[0,"canvas",8,8],[0,"set","fillStyle","#ff0000"],[0,"call","fillRect",2,2,4,4],
    [0,"grad",0,"linear",0,0,8,0],[-1,"stop",0,0,"#000"],[-1,"stop",0,1,"#fff"],[0,"call","bogus"]])";
  const ReplayResult r = replay_canvas_ops(ops, {});
  REQUIRE(r.ok);
  CHECK(r.width == 8);
  CHECK(px(r.rgba, 8, 3, 3)[0] == 255);
  CHECK(px(r.rgba, 8, 0, 0)[3] == 0);
  REQUIRE(r.unsupported.size() == 1);
  CHECK(r.unsupported[0] == "call bogus");
}

TEST_CASE("vector painter: a rect layer with a solid fill", "[raster][vector]") {
  const std::string spec = R"({"kind":"path","width":10,"height":6,"fill":"#0000ff","primitive":"rect","__baked":false})";
  const RasterOutput o = draw_raster_source(RasterKind::path, spec, 1, 0, {});
  REQUIRE(o.ok);
  CHECK(o.width == 20);  // tier 1 × supersample 2
  CHECK(o.height == 12);
  CHECK(px(o.rgba, 20, 10, 6)[2] == 255);
  CHECK(o.unsupported.empty());
}

TEST_CASE("optical kerning: outline and raster profiles tighten AV, leave nn alone", "[raster][fonts][optical]") {
  const FontSet& fonts = harness_fonts();
  // The unhinted outline in font units, y up (openType.ts's OUTLINE source).
  const auto a = fonts.glyph_outline("A", *css::parse_font("600 128px Arial"));
  REQUIRE(a.has_value());
  CHECK(a->unitsPerEm == 2048);
  CHECK(a->advance > 1000);
  CHECK_FALSE(fonts.glyph_outline("AV", *css::parse_font("600 128px Arial")).has_value());
  CanvasOptions opts;
  opts.fonts = &fonts;
  const std::string css = "600 128px \"Arial\", Inter, system-ui, sans-serif";
  for (const auto source : {OpticalKerner::Source::raster, OpticalKerner::Source::outline}) {
    OpticalKerner k(opts, source);
    // opticalKerning.ts is tuned on Arial's outlines: AV about -0.074 em (Arimo
    // is metric-compatible), while nn / HH move by under 0.01 em.
    const double av = k.kern_px(css, "A", 100, css, "V", 100) / 100;
    CHECK(av < -0.05);
    CHECK(av > -0.1);
    CHECK(std::fabs(k.kern_px(css, "n", 100, css, "n", 100) / 100) < 0.01);
    CHECK(std::fabs(k.kern_px(css, "H", 100, css, "H", 100) / 100) < 0.01);
  }
}
