// E3 raster module on Skia: Canvas2D semantics, fonts + shaping, replay.
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdio>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <utility>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "raster/canvas.hpp"
#include "raster/canvas_replay.hpp"
#include "raster/font_catalog.hpp"
#include "raster/fonts.hpp"
#include "raster/optical_kerning.hpp"
#include "raster/raster_source.hpp"
#include "raster/svg_render.hpp"

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

TEST_CASE("fonts: a variable face draws weights on its wght axis, not by embolden", "[raster][fonts]") {
  // The app's shipped Inter (resources/fonts): one variable file, registered at 400.
  const auto inter = std::filesystem::path(PREMATION_RASTER_FONTS).parent_path() / "../../../../resources/fonts/Inter-opsz-wght.ttf";
  std::ifstream in(inter, std::ios::binary);
  REQUIRE(in);
  const std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  FontSet fonts{FontOptions{}};
  FaceInfo info;
  info.family = "Inter";
  info.file = "Inter-opsz-wght.ttf";
  std::string err;
  REQUIRE(fonts.add_face(info, bytes, err));
  const auto axis = [](const ShapedText& s, const char* tag) -> float {
    const std::uint32_t t = (static_cast<std::uint32_t>(tag[0]) << 24U) | (static_cast<std::uint32_t>(tag[1]) << 16U) |
                            (static_cast<std::uint32_t>(tag[2]) << 8U) | static_cast<std::uint32_t>(tag[3]);
    for (const AxisValue& a : s.axes) {
      if (a.tag == t) return a.value;
    }
    return -1;
  };
  ShapeRequest r;
  r.font = *css::parse_font("400 56px Inter");
  const ShapedText regular = fonts.shape("Motion", r);
  r.font = *css::parse_font("700 56px Inter");
  const ShapedText bold = fonts.shape("Motion", r);
  REQUIRE_FALSE(bold.glyphs.empty());
  CHECK_FALSE(bold.glyphs.front().fakeBold);
  CHECK(axis(regular, "wght") == 400);
  CHECK(axis(bold, "wght") == 700);
  CHECK(bold.width > regular.width);  // the Bold instance's own, wider advances
  // Optical size follows the font size, clamped to the axis (Inter: 14–32).
  CHECK(axis(bold, "opsz") == 32);
  r.font = *css::parse_font("700 20px Inter");
  CHECK(axis(fonts.shape("Motion", r), "opsz") == 20);
  // An explicit axis in font-variation-settings wins.
  r.variations = "'wght' 300";
  CHECK(axis(fonts.shape("Motion", r), "wght") == 300);
}

TEST_CASE("fonts: both glyph backends DRAW a variable face's weights (thin < regular < bold < black)", "[raster][fonts]") {
  // The app runs Windows with the platform backend (Chromium's profile); a face
  // made from memory there drew every weight at its default instance, with a
  // faux-bold smear from 600 up — 100 looked like 400, 700 like 900.
  const auto inter = std::filesystem::path(PREMATION_RASTER_FONTS).parent_path() / "../../../../resources/fonts/Inter-opsz-wght.ttf";
  std::ifstream in(inter, std::ios::binary);
  REQUIRE(in);
  const std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  for (const bool platform : {false, true}) {
    FontSet fonts{platform ? FontOptions::chromium_windows() : FontOptions{}};
    FaceInfo info;
    info.family = "Inter";
    info.file = "Inter-opsz-wght.ttf";
    std::string err;
    REQUIRE(fonts.add_face(info, bytes, err));
    CanvasOptions co;
    co.fonts = &fonts;
    const auto ink = [&co](int weight) {
      auto c = Canvas2D::make(520, 120, co);
      c->setFillStyle(color("#000000"));
      REQUIRE(c->setFont(std::to_string(weight) + " 64px Inter"));
      c->fillText("Weight", 10, 84);
      const std::vector<std::uint8_t> px = c->pixels();
      std::size_t n = 0;
      for (std::size_t i = 3; i < px.size(); i += 4) n += px[i] > 127 ? 1U : 0U;
      return static_cast<double>(n);
    };
    INFO((platform ? "platform" : "freetype") << " backend");
    const double thin = ink(100);
    const double regular = ink(400);
    const double bold = ink(700);
    const double black = ink(900);
    CHECK(thin < regular * 0.75);
    CHECK(bold > regular * 1.2);
    CHECK(black > bold * 1.05);
  }
}

TEST_CASE("fonts: small caps synthesize on a face without smcp (capitals at 0.7×), the feature draws them when present", "[raster][fonts][smallcaps]") {
  // Audit 2026-10-18: the Character panel's Small Caps did nothing on Inter
  // (the default font): the shaper only asked for the `smcp` feature, which
  // Inter's shipped file has no glyphs for. Blink and After Effects synthesize.
  const auto inter = std::filesystem::path(PREMATION_RASTER_FONTS).parent_path() / "../../../../resources/fonts/Inter-opsz-wght.ttf";
  std::ifstream in(inter, std::ios::binary);
  REQUIRE(in);
  const std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  FontSet fonts{FontOptions{}};
  FaceInfo info;
  info.family = "Inter";
  info.file = "Inter-opsz-wght.ttf";
  std::string err;
  REQUIRE(fonts.add_face(info, bytes, err));
  ShapeRequest plain;
  plain.font = *css::parse_font("400 100px Inter");
  ShapeRequest small = plain;
  small.font.smallCaps = true;
  const ShapedText capital = fonts.shape("A", plain);
  const ShapedText lower = fonts.shape("a", plain);
  const ShapedText synth = fonts.shape("a", small);
  REQUIRE(capital.glyphs.size() == 1);
  REQUIRE(synth.glyphs.size() == 1);
  // The lowercase letter became the capital's glyph, drawn at 0.7 of the size.
  CHECK(synth.glyphs.front().id == capital.glyphs.front().id);
  CHECK(synth.glyphs.front().id != lower.glyphs.front().id);
  CHECK(synth.glyphs.front().sizeScale == 0.7);
  CHECK(std::fabs(synth.width - capital.width * 0.7) < 0.5);
  // Its ink is the capital's at 0.7 (AE's Preferences ▸ Type small-caps size),
  // shorter than the full capital — and, in Inter, about the x-height: Inter's
  // x-height is 0.53 em, its cap height 0.73.
  CHECK(std::fabs(-synth.inkTop - (-capital.inkTop) * 0.7) < 1.5);
  CHECK(-synth.inkTop < -capital.inkTop);
  CHECK(-lower.inkTop < -capital.inkTop);
  // A capital and punctuation are left alone.
  const ShapedText mixed = fonts.shape("A.", small);
  REQUIRE(mixed.glyphs.size() == 2);
  CHECK(mixed.glyphs[0].sizeScale == 1.0);
  CHECK(mixed.glyphs[1].sizeScale == 1.0);
  // Through the canvas: `small-caps` in the font shorthand draws more ink for
  // "abc" than the lowercase run (capitals, even at 0.7×, carry more ink).
  CanvasOptions co;
  co.fonts = &fonts;
  const auto ink = [&co](const char* font) {
    auto c = Canvas2D::make(400, 120, co);
    c->setFillStyle(color("#000000"));
    REQUIRE(c->setFont(font));
    c->fillText("hamburg", 10, 84);
    const std::vector<std::uint8_t> px = c->pixels();
    std::size_t n = 0;
    for (std::size_t i = 3; i < px.size(); i += 4) n += px[i] > 127 ? 1U : 0U;
    return static_cast<double>(n);
  };
  CHECK(ink("small-caps 400 64px Inter") != ink("400 64px Inter"));
}

#if defined(_WIN32)
TEST_CASE("fonts: a system family's simulated obliques do not shadow its real italic", "[raster][fonts][system]") {
  // Audit 2026-10-18: DirectWrite lists "Arial Normal Oblique" (arial.ttf +
  // an italic simulation) beside the real Arial Italic; registered as an
  // italic face with the upright file's bytes it won the match and every
  // system italic drew upright. Faces take their style from the file now and
  // each file registers once.
  FontSet fonts{FontOptions{}};
  const std::size_t added = fonts.add_system_family("Arial");
  if (added == 0) {
    WARN("Arial is not installed; skipping");
    return;
  }
  // Regular, Italic, Bold, Bold Italic (and Arial Black's file when the
  // family lists it) — never the three simulated obliques on top.
  CHECK(added <= 5);
  const auto upright = fonts.glyph_outline("A", *css::parse_font("400 56px Arial"));
  const auto italic = fonts.glyph_outline("A", *css::parse_font("italic 400 56px Arial"));
  REQUIRE(upright.has_value());
  REQUIRE(italic.has_value());
  REQUIRE_FALSE(upright->contours.empty());
  REQUIRE_FALSE(italic->contours.empty());
  // Arial Italic's A is a different outline from Arial's (its stem leans).
  const auto& u = upright->contours.front().front();
  const auto& i = italic->contours.front().front();
  CHECK((u.x0 != i.x0 || u.y0 != i.y0 || upright->contours.front().size() != italic->contours.front().size()));
  // And the glyphs come out of different faces.
  ShapeRequest ru;
  ru.font = *css::parse_font("400 56px Arial");
  ShapeRequest ri;
  ri.font = *css::parse_font("italic 400 56px Arial");
  const ShapedText su = fonts.shape("A", ru);
  const ShapedText si = fonts.shape("A", ri);
  REQUIRE(su.glyphs.size() == 1);
  REQUIRE(si.glyphs.size() == 1);
  CHECK(su.glyphs.front().face != si.glyphs.front().face);
  CHECK_FALSE(si.glyphs.front().fakeItalic);
}
#endif

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

TEST_CASE("I4: a tapered stroke on a rounded rect keeps its corners", "[raster][vector][i4]") {
  // A 100 × 100 rounded rect (radius 40), no fill, a 12 px stroke tapered to
  // 20 % at both ends: the profiled ribbon used to be built from a SQUARE
  // outline (pathOps rectOutline was not ported), which painted the corners.
  const std::string spec = R"({"kind":"path","width":100,"height":100,"primitive":"rect","cornerRadius":40,"fill":"transparent",
    "stroke":{"color":"#000000","width":12,"opacity":1,"align":"center",
              "taper":{"startLength":50,"endLength":50,"startWidth":0.2,"endWidth":0.2,"startEase":0,"endEase":0,"lengthUnits":"percent"}},
    "__baked":false})";
  const RasterOutput o = draw_raster_source(RasterKind::path, spec, 1, 0, {});
  REQUIRE(o.ok);
  REQUIRE(o.width == 200);  // tier 1 × supersample 2
  REQUIRE(o.height == 200);
  CHECK(o.unsupported.empty());  // no "profiled stroke on a rounded rect" fallback any more
  const auto alpha = [&](std::uint32_t x, std::uint32_t y) { return px(o.rgba, 200, x, y)[3]; };
  // The square corner is empty: the ribbon turned with the arc.
  CHECK(alpha(2, 2) == 0);
  CHECK(alpha(197, 2) == 0);
  CHECK(alpha(2, 197) == 0);
  CHECK(alpha(197, 197) == 0);
  // The arc itself is painted (the top-left corner's 45° point: centre (40,40), r 40 → (11.7, 11.7) × 2).
  CHECK(alpha(23, 23) > 0);
  CHECK(alpha(176, 23) > 0);
  // The straight edges keep their (tapered) ribbon.
  CHECK(alpha(1, 100) > 0);
  CHECK(alpha(198, 100) > 0);
}

TEST_CASE("blur cost: per-glyph animator blur on a paragraph and on a wordmark", "[.bench][raster][blur]") {
  // Hidden ([.bench]): the per-glyph Blur an animator paints (text_paint.cpp
  // drawItemInner sets one filter per glyph). Prints the cost per glyph so a
  // change to Canvas2D's blur layer can be measured: 2026-10-27 launch film,
  // a 150-glyph paragraph at blur 6 and a 6-glyph 180 px wordmark at blur 14.
  CanvasOptions co;
  co.fonts = &harness_fonts();
  const auto run = [&co](const char* label, std::uint32_t w, std::uint32_t h, double fontPx, double blur, const std::string& text,
                         bool readFrequently, bool fast) {
    auto c = Canvas2D::make(w, h, co);
    c->set_will_read_frequently(readFrequently);
    c->setFillStyle(color("#1f1e1d"));
    REQUIRE(c->setFont(std::to_string(static_cast<int>(fontPx)) + "px Arial"));
    const auto t0 = std::chrono::steady_clock::now();
    double x = 20;
    double y = fontPx * 1.2;
    for (const char ch : text) {
      c->save();
      c->setFilter(fast ? css::Filter::fast_blur(blur) : css::Filter{blur});
      const std::string g(1, ch);
      c->fillText(g, x, y);
      c->restore();
      x += fontPx * 0.55;
      if (x > static_cast<double>(w) - fontPx) {
        x = 20;
        y += fontPx * 1.4;
      }
    }
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    std::printf("[blur] %s %ux%u font %.0f blur %.0f glyphs %zu readFrequently %d fast %d: %.1f ms total, %.2f ms/glyph\n", label, w, h,
                fontPx, blur, text.size(), readFrequently ? 1 : 0, fast ? 1 : 0, ms, ms / static_cast<double>(text.size()));
    const std::vector<std::uint8_t> px = c->pixels();
    std::size_t ink = 0;
    for (std::size_t i = 3; i < px.size(); i += 4) ink += px[i] > 0 ? 1U : 0U;
    CHECK(ink > 0);
  };
  const std::string para =
      "Heres a 24-second plan: open on the spark, show the work in motion, then land the name. Three beats, one idea clarity now.";
  run("paragraph", 1920, 1080, 34, 6, para, false, false);
  run("paragraph", 1920, 1080, 34, 6, para, false, true);
  run("wordmark", 1920, 1080, 180, 14, "Claude", false, false);
  run("wordmark", 1920, 1080, 180, 14, "Claude", false, true);
  run("paragraph", 1920, 1080, 34, 2, para, false, false);
  run("paragraph", 1920, 1080, 34, 2, para, false, true);
}

TEST_CASE("blur: the fast per-glyph blur stays close to the shader algorithm", "[raster][blur]") {
  // css::Filter::fast_blur (three box passes on 8-bit pixels) stands in for
  // the accelerated canvas's shader blur on per-glyph animator blurs. The two
  // are different Gaussian approximations; this pins how far apart they are
  // so a change to either shows up here, not as a surprise in a film.
  CanvasOptions co;
  co.fonts = &harness_fonts();
  const auto draw = [&co](double fontPx, double blur, bool fast) {
    auto c = Canvas2D::make(640, 320, co);
    c->setFillStyle(color("#1f1e1d"));
    REQUIRE(c->setFont(std::to_string(static_cast<int>(fontPx)) + "px Arial"));
    double x = 20;
    for (const char ch : std::string("Claude")) {
      c->save();
      c->setFilter(fast ? css::Filter::fast_blur(blur) : css::Filter{blur});
      c->fillText(std::string(1, ch), x, fontPx * 1.2);
      c->restore();
      x += fontPx * 0.55;
    }
    return c->pixels();
  };
  for (const auto& [fontPx, blur] : {std::pair{34.0, 6.0}, std::pair{90.0, 14.0}, std::pair{34.0, 2.0}, std::pair{34.0, 3.0}, std::pair{34.0, 4.0}, std::pair{34.0, 5.0}}) {
    const std::vector<std::uint8_t> exact = draw(fontPx, blur, false);
    const std::vector<std::uint8_t> fast = draw(fontPx, blur, true);
    REQUIRE(exact.size() == fast.size());
    int maxDiff = 0;
    std::size_t over4 = 0;
    std::size_t inked = 0;
    for (std::size_t i = 3; i < exact.size(); i += 4) {
      const int d = std::abs(static_cast<int>(exact[i]) - static_cast<int>(fast[i]));
      maxDiff = std::max(maxDiff, d);
      over4 += d > 4 ? 1U : 0U;
      inked += exact[i] > 0 || fast[i] > 0 ? 1U : 0U;
    }
    const double share = inked == 0 ? 0 : static_cast<double>(over4) / static_cast<double>(inked);
    INFO("font " << fontPx << " blur " << blur << ": max alpha diff " << maxDiff << ", " << share * 100 << " % of inked px off by > 4");
    std::printf("[blur] fast vs exact font %.0f blur %.0f: max alpha diff %d, %.2f %% of inked px off by > 4/255\n", fontPx, blur,
                maxDiff, share * 100);
    // Measured 2026-10-27: σ 2 max 14 (37 % of inked px > 4/255), σ 3 max 10,
    // σ 4–5 max 8 (5 %), σ ≥ 6 max 6 (< 0.5 %): edge alpha only, in motion.
    CHECK(maxDiff <= 16);
    if (blur >= 4) CHECK(share < 0.08);
    if (blur >= 6) CHECK(share < 0.01);
  }
}

namespace {
float wght_of(const ShapedText& s) {
  for (const AxisValue& a : s.axes) {
    if (a.tag == 0x77676874U) return a.value;  // 'wght'
  }
  return -1;
}
}  // namespace

TEST_CASE("fonts: a family name ending in a weight word splits into family + weight", "[raster][fonts]") {
  const auto split = [](std::string_view f) { return split_weight_variant(f); };
  REQUIRE(split("Segoe UI Semibold"));
  CHECK(split("Segoe UI Semibold")->family == "Segoe UI");
  CHECK(split("Segoe UI Semibold")->weight == 600);
  CHECK(split("Arial Black")->weight == 900);
  CHECK(split("Montserrat Extra Light")->family == "Montserrat");
  CHECK(split("Montserrat Extra Light")->weight == 200);
  CHECK(split("Bahnschrift Light Condensed")->family == "Bahnschrift Condensed");
  CHECK(split("Bahnschrift Light Condensed")->weight == 300);
  CHECK_FALSE(split("Bold"));  // a weight word alone is no family
  CHECK_FALSE(split("Inter"));
  CHECK_FALSE(split("Segoe UI"));
}

TEST_CASE("fonts: a variable face held at one weight draws it whatever weight is asked", "[raster][fonts]") {
  const auto inter = std::filesystem::path(PREMATION_RASTER_FONTS).parent_path() / "../../../../resources/fonts/Inter-opsz-wght.ttf";
  std::ifstream in(inter, std::ios::binary);
  REQUIRE(in);
  const std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  FontSet fonts{FontOptions{}};
  FaceInfo info;
  info.family = "Inter Light";
  info.file = "Inter-opsz-wght.ttf";
  info.pinWeight = 300;
  std::string err;
  REQUIRE(fonts.add_face(info, bytes, err));
  ShapeRequest r;
  r.font = *css::parse_font("400 56px \"Inter Light\"");
  CHECK(wght_of(fonts.shape("Motion", r)) == 300);
  r.font = *css::parse_font("700 56px \"Inter Light\"");
  const ShapedText bold = fonts.shape("Motion", r);
  CHECK(wght_of(bold) == 300);
  REQUIRE_FALSE(bold.glyphs.empty());
  CHECK(bold.glyphs.front().fakeBold);  // bold asked of a Light face synthesizes, as for a static Light
}

#if defined(_WIN32)
TEST_CASE("fonts: Windows GDI face names (Segoe UI Semibold, Arial Black) resolve to their weight", "[raster][fonts]") {
  // A user's SVG with font-family 'Segoe UI Semibold' drew in Times New Roman:
  // DirectWrite lists that face only under "Segoe UI" (user report 2026-11-03).
  FontSet fonts{FontOptions::chromium_windows()};
  if (fonts.add_system_family("Segoe UI") == 0) SKIP("Segoe UI is not installed");
  CHECK(fonts.add_system_family("Segoe UI Semibold") > 0);
  CHECK(fonts.add_system_family("Segoe UI Light") > 0);
  CHECK(fonts.add_system_family("Arial Black") > 0);
  CHECK(fonts.add_system_family("Premation Nonexistent Bold") == 0);
  ShapeRequest r;
  const auto width = [&](const char* family) {
    r.font = *css::parse_font(std::string("400 56px \"") + family + "\"");
    return fonts.shape("Motion Design", r).width;
  };
  const double regular = width("Segoe UI");
  CHECK(width("Segoe UI Semibold") > regular);
  CHECK(width("Segoe UI Light") < regular);
  if (fonts.add_system_family("Bahnschrift Light") > 0) {  // a variable face, held at 300
    r.font = *css::parse_font("400 56px \"Bahnschrift Light\"");
    CHECK(wght_of(fonts.shape("Motion", r)) == 300);
  }
  // Through the SVG painter on the OS fonts: the GDI name draws exactly what
  // the base family at that weight draws, not the serif fallback.
  const auto svgText = [](const std::string& font) {
    const std::string markup = "<svg xmlns='http://www.w3.org/2000/svg' width='320' height='80'><text x='8' y='60' font-size='48' " +
                               font + ">Premation</text></svg>";
    const RasterOutput out = svg::rasterize_svg(markup, svg::RasterizeOptions{});
    REQUIRE(out.ok);
    return out.rgba;
  };
  const auto gdi = svgText("font-family=\"'Segoe UI Semibold'\"");
  CHECK(gdi == svgText("font-family='Segoe UI' font-weight='600'"));
  CHECK(gdi != svgText("font-family='serif'"));
}
#endif
