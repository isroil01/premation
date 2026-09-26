// E3 paint strokes (paint_raster.cpp) against paintRaster.ts: the C++ port on
// a recording Canvas2D must issue the TS's Canvas2D program op for op
// (tests/data/paint_raster_parity.json, frozen from the TypeScript engine's
// paintRasterCrossEngine.test.ts; PARITY_REBLESS=1 writes the C++ answers
// instead (parity_rebless.hpp)).
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdio>
#include <memory>
#include <string>

#include "json.hpp"
#include "parity_rebless.hpp"
#include "raster/json.hpp"
#include "raster/paint_common.hpp"
#include "raster/paint_raster.hpp"
#include "recording_canvas.hpp"

using namespace premation::raster;
namespace js = premation::js;

TEST_CASE("paint strokes: the C++ drawPaint issues paintRaster.ts's Canvas2D program", "[raster][paint][parity]") {
  premation::test::JsonFixture fx("paint_raster_parity.json");
  REQUIRE(fx.ok());
  int casesExact = 0;
  std::size_t opsTotal = 0;
  std::size_t opsSame = 0;
  js::Json::Array& cases = fx.root().find_mut("cases")->arr_mut();
  for (js::Json& c : cases) {
    const std::string name = c.at("name").str();
    INFO(name);
    // drawPaint reads raster::json; JSON.stringify's numbers parse back bit-identical.
    json::Value paint;
    std::string err;
    REQUIRE(json::parse(js::stringify(c.at("paint")), paint, err));
    auto rec = std::make_shared<test::Recording>();
    const double w = c.at("w").num();
    const double h = c.at("h").num();
    const double ss = c.at("ss").num();
    test::RecordingCanvas root(rec, static_cast<std::uint32_t>(w), static_cast<std::uint32_t>(h));
    root.scale(ss, ss);
    root.translate(w / ss / 2, h / ss / 2);
    root.setFillStyle(*color_style("#3366cc"));
    root.fillRect(-30, -20, 60, 40);
    draw_paint(root, paint);

    const auto& got = rec->ops;
    js::Json::Array gotOps;
    for (const std::string& op : got) gotOps.push_back(js::Json::string(op));
    if (!fx.reblessing()) {
      const js::Json::Array& want = c.at("ops").arr();
      std::size_t same = 0;
      std::size_t firstDiff = want.size();
      for (std::size_t i = 0; i < std::min(want.size(), got.size()); ++i) {
        if (want[i].str() == got[i]) ++same;
        else if (firstDiff == want.size()) firstDiff = i;
      }
      opsTotal += want.size();
      opsSame += same;
      if (firstDiff < want.size() || got.size() != want.size()) {
        const std::size_t i = std::min(firstDiff, std::min(want.size(), got.size()));
        std::printf("  %s: first difference at op %zu of %zu (C++ issued %zu)\n    TS : %s\n    C++: %s\n", name.c_str(), i,
                    want.size(), got.size(), i < want.size() ? want[i].str().c_str() : "(end)", i < got.size() ? got[i].c_str() : "(end)");
      } else {
        ++casesExact;
      }
    }
    CHECK(fx.answer(c, "ops", js::Json::array(std::move(gotOps))));
  }
  std::printf("paint strokes vs paintRaster.ts: %d/%zu cases op-for-op, %zu/%zu ops identical\n", casesExact, cases.size(), opsSame,
              opsTotal);
  REQUIRE(fx.finish());
}

TEST_CASE("paint strokes: dabs and trim", "[raster][paint]") {
  json::Value stroke;
  std::string err;
  REQUIRE(json::parse(R"({"id":"a","points":[{"x":0,"y":0},{"x":10,"y":0}],"size":4,"opacity":1,"hardness":1,"mode":"paint","spacing":0.5})",
                      stroke, err));
  const auto dabs = stroke_dabs(stroke);
  // One dab every 2 px from 0 to 10, and the last at the end: 0 2 4 6 8 10.
  REQUIRE(dabs.size() == 6);
  CHECK(dabs.back().x == 10);
  CHECK(dabs[1].x == 2);
  const auto trimmed = trim_polyline({{0, 0}, {10, 0}, {10, 10}}, 0.25, 0.75);
  REQUIRE(trimmed);
  REQUIRE(trimmed->size() == 3);
  CHECK(trimmed->front().x == 5);
  CHECK(trimmed->back().y == 5);
  CHECK_FALSE(trim_polyline({{0, 0}, {1, 1}}, 0.5, 0.5));
}
