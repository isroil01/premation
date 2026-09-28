// B4 round 5, slice C (ENGINE_API.md §15.14): getTextLayout.glyphs over the
// scene port's TextMeasurer with the render-tests harness fonts — the cases
// src/core/engine/__tests__/b4Round5Text.test.ts pins on the TypeScript engine
// (one box per grapheme, line breaks counted but not boxed, lines stacked,
// boxes tiling each line, alignment at the box edges).

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <algorithm>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "docio.hpp"
#include "json.hpp"
#include "model.hpp"
#include "raster/canvas.hpp"
#include "raster/fonts.hpp"
#include "text_measure.hpp"
#include "text_query.hpp"

namespace doc = premation::doc;
namespace sc = premation::scene;
namespace raster = premation::raster;
using Catch::Matchers::WithinAbs;

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

/// A document with one text layer `t` (Arial, 48 px) saying `content`, aligned `align`.
std::unique_ptr<doc::Document> text_doc(const std::string& content, const std::string& align) {
  std::string escaped;
  for (const char c : content) {
    if (c == '\n') escaped += "\\n";
    else escaped.push_back(c);
  }
  const std::string json = std::string(R"json({"version":"1.9.0","scene":{"version":"1.0.0","nodes":[
    {"id":"comp_root","name":"C","parent":null,"children":["t"],"visible":true,"locked":false,
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[{"id":"comp_root_meta","type":"group","props":{"__kind":"group"}}]},
    {"id":"t","name":"t","parent":"comp_root","children":[],"visible":true,"locked":false,
     "transform":{"position":{"x":0,"y":0},"rotation":0,"scale":{"x":1,"y":1}},
     "components":[
       {"id":"t_t","type":"Transform","props":{"__kind":"text","x":320,"y":180,"rotation":0,"scaleX":100,"scaleY":100}},
       {"id":"t_s","type":"Style","props":{"opacity":100,"fill":"#ffffff"}},
       {"id":"t_x","type":"Text","props":{"content":")json") + escaped + R"json(","fontSize":48,"fontFamily":"Arial","fontWeight":"400","align":")json" + align + R"json("}}]}]},
  "animation":{"tracks":{},"data":{},"expressions":{}},
  "comps":{"comp_root":{"id":"comp_root","name":"C","width":640,"height":360,"fps":30,"durationSeconds":10,"background":"#101014"}}
})json";
  const auto parsed = premation::js::parse(json);
  REQUIRE(parsed.has_value());
  auto d = std::make_unique<doc::Document>();
  doc::EditorView view;
  (void)doc::restore_document(*d, view, *parsed, {});
  return d;
}

premation::api::TextLayout layout_of(const std::string& content, const std::string& align) {
  raster::CanvasOptions opts;
  opts.fonts = &harness_fonts();
  const auto m = sc::make_canvas_measurer(opts);
  const auto d = text_doc(content, align);
  const doc::Node* n = d->node("t");
  REQUIRE(n != nullptr);
  return sc::text_layout_of(*m, *n, nullptr);
}

}  // namespace

TEST_CASE("getTextLayout.glyphs: one box per grapheme, line breaks counted not boxed; lines stack and tile", "[b4r5][text]") {
  const auto l = layout_of("AB\nC\xF0\x9F\x91\x8D\xF0\x9F\x8F\xBD" "D", "center");
  std::vector<std::pair<unsigned, unsigned>> idx;
  for (const auto& g : l.glyphs) idx.emplace_back(g.index, g.line);
  CHECK(idx == std::vector<std::pair<unsigned, unsigned>>{{0, 0}, {1, 0}, {3, 1}, {4, 1}, {5, 1}});
  for (const auto& g : l.glyphs) {
    CHECK_THAT(g.advance, WithinAbs(g.box.width, 1e-9));
    CHECK(g.box.width > 0);
    CHECK(g.box.height > 0);
    CHECK(g.baseline > g.box.y);
    CHECK(g.baseline < g.box.y + g.box.height);
  }
  std::vector<premation::api::GlyphBox> line0;
  std::vector<premation::api::GlyphBox> line1;
  for (const auto& g : l.glyphs) (g.line == 0 ? line0 : line1).push_back(g);
  CHECK(line1.front().baseline > line0.front().baseline);
  double widest = 0;
  for (const auto* line : {&line0, &line1}) {
    for (std::size_t i = 1; i < line->size(); ++i) {
      CHECK_THAT((*line)[i].box.x, WithinAbs((*line)[i - 1].box.x + (*line)[i - 1].box.width, 1e-9));
    }
    const double left = line->front().box.x;
    const double right = line->back().box.x + line->back().box.width;
    CHECK_THAT(left + right, WithinAbs(0, 1e-6));  // centred: the line straddles the origin
    widest = std::max(widest, right - left);
  }
  CHECK_THAT(widest, WithinAbs(l.box.width, 1e-6));
}

TEST_CASE("getTextLayout.glyphs: left / right alignment start the lines at the box edges", "[b4r5][text]") {
  const auto left = layout_of("Wide line\nx", "left");
  const auto* lx = &left.glyphs.back();
  CHECK(lx->line == 1);
  CHECK_THAT(lx->box.x, WithinAbs(left.box.x, 1e-6));
  const auto right = layout_of("Wide line\nx", "right");
  const auto& last = right.glyphs.back();
  CHECK_THAT(last.box.x + last.box.width, WithinAbs(right.box.x + right.box.width, 1e-6));
}
