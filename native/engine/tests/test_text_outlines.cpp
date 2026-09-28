// convertLayer's font outlines (scene/text_outlines.cpp) against the PAINTED
// text: the font's own Béziers must land where the painter draws the glyphs —
// their bounds equal the trace of the painted text (effect_handoff
// traced_text_of, the 4x trace) within a trace's sub-pixel error — and a
// variable weight / sampled axis reaches the outline instance.

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <algorithm>
#include <limits>
#include <string>

#include "canvas.hpp"
#include "effect_handoff.hpp"
#include "fonts.hpp"
#include "model.hpp"
#include "text_measure.hpp"
#include "text_outlines.hpp"

using namespace premation;
using namespace premation::scene;
using Catch::Matchers::WithinAbs;
using js::Json;

namespace {

const raster::FontSet& harness_fonts() {
  static const raster::FontSet* fonts = [] {
    static raster::FontSet f{raster::FontOptions{}};
    std::string err;
    REQUIRE(f.load_manifest(PREMATION_RASTER_FONTS, err));
    return &f;
  }();
  return *fonts;
}

struct Box {
  double l = std::numeric_limits<double>::infinity(), t = l, r = -l, b = -l;
  void add(double x, double y) {
    l = std::min(l, x);
    r = std::max(r, x);
    t = std::min(t, y);
    b = std::max(b, y);
  }
};

/// Anchors only (the glyph extremes of TrueType / CFF outlines sit on anchors).
Box bounds(const std::vector<mesh::BezRun>& runs) {
  Box bx;
  for (const auto& r : runs) {
    for (const auto& p : r.points) bx.add(p.x, p.y);
  }
  return bx;
}

doc::Node text_node(const std::string& content, const std::string& weight) {
  doc::Node n;
  n.id = "t1";
  n.name = "T";
  Json t = Json::object();
  t.set("__kind", Json::string("text"));
  t.set("x", Json::number(0));
  t.set("y", Json::number(0));
  Json c = Json::object();
  c.set("content", Json::string(content));
  c.set("fontSize", Json::number(96));
  c.set("fontFamily", Json::string("Arimo"));
  c.set("fontWeight", Json::string(weight));
  n.components = {doc::Component{"t1_t", "Transform", std::move(t)}, doc::Component{"t1_c", "Text", std::move(c)}};
  return n;
}

}  // namespace

TEST_CASE("text outlines: the font's Béziers coincide with the painted text", "[text][outlines]") {
  const raster::FontSet& fonts = harness_fonts();
  raster::CanvasOptions opts;
  opts.fonts = &fonts;
  const auto measurer = make_canvas_measurer(opts);
  for (const std::string content : {"OK", "Hog", "way", "Hog\nway"}) {
    const doc::Node n = text_node(content, "400");
    const auto style = read_measured_text_style(n, {});
    REQUIRE(style.has_value());
    const auto font = font_outline_runs(fonts, *style, font_variations_of(n, *style, {}));
    REQUIRE(font.has_value());
    std::string why;
    const auto traced = traced_text_of(n, *measurer, {}, why);
    REQUIRE(traced.has_value());
    const Box f = bounds(font->runs);
    const Box t = bounds(*traced->runs);
    INFO(content << ": font " << f.l << "," << f.t << " " << f.r << "," << f.b << "  trace " << t.l << "," << t.t << " " << t.r
                 << "," << t.b);
    // The trace is of a 4x raster smoothed at 0.55: ~1 px at 1x. Multi-line
    // text: the painter lays each line out glyph by glyph (text_layout.cpp)
    // and lands a few px off the kerned, centred line fontOutlines.ts (and so
    // this port) draws — the TS has the same offset; only the vertical stack
    // and the width are compared there.
    const bool multi = content.find('\n') != std::string::npos;
    CHECK_THAT(f.r - f.l, WithinAbs(t.r - t.l, 1.25));
    if (!multi) {
      CHECK_THAT(f.l, WithinAbs(t.l, 1.25));
      CHECK_THAT(f.r, WithinAbs(t.r, 1.25));
    }
    CHECK_THAT(f.t, WithinAbs(t.t, 1.25));
    CHECK_THAT(f.b, WithinAbs(t.b, 1.25));
    // "O" and "o" / "g" have counters: more runs than letters with none.
    CHECK(font->runs.size() >= 3);
  }
}

TEST_CASE("text outlines: the painter-only styles are left to the trace; variations", "[text][outlines]") {
  Json spec = Json::object();
  spec.set("text", Json::string("A\nB"));
  CHECK_FALSE(wants_painted_layout(spec));
  spec.set("align", Json::string("left"));
  CHECK(wants_painted_layout(spec));
  Json plain = Json::object();
  plain.set("text", Json::string("A"));
  plain.set("textStrokeWidth", Json::number(2));
  CHECK(wants_painted_layout(plain));

  const doc::Node n = text_node("A", "400");
  const auto style = read_measured_text_style(n, {{"fontWeight", 700}});
  REQUIRE(style.has_value());
  CHECK(font_variations_of(n, *style, {{"fontWeight", 700}, {"text.axis.opsz", 24}}) == "'wght' 700, 'opsz' 24");
  // A heavier weight draws wider stems: the bold outline is wider than the regular one.
  const raster::FontSet& fonts = harness_fonts();
  const auto regular = font_outline_runs(fonts, *read_measured_text_style(n, {}), "");
  const auto bold = font_outline_runs(fonts, *style, font_variations_of(n, *style, {}));
  REQUIRE(regular.has_value());
  REQUIRE(bold.has_value());
  CHECK(bounds(bold->runs).r - bounds(bold->runs).l > bounds(regular->runs).r - bounds(regular->runs).l);
}
