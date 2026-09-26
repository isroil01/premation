// E4 × E3 canvas-drawn effects (effects/canvas_effects.cpp) against
// canvas2dEffects.ts: the C++ on a recording Canvas2D must issue the TS's
// Canvas2D program op for op (tests/data/canvas_effects_parity.json, frozen
// from the TypeScript engine's canvasEffectsCrossEngine.test.ts;
// PARITY_REBLESS=1 writes the C++ answers instead (parity_rebless.hpp)).
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdio>
#include <memory>
#include <string>

#include "effects/canvas_effects.hpp"
#include "json.hpp"
#include "parity_rebless.hpp"
#include "raster/json.hpp"
#include "raster/paint_common.hpp"
#include "recording_canvas.hpp"

using namespace premation;
using raster::json::Value;

TEST_CASE("canvas effects: the C++ issues canvas2dEffects.ts's Canvas2D program", "[effects][canvas][parity]") {
  test::JsonFixture fx("canvas_effects_parity.json");
  REQUIRE(fx.ok());

  int exact = 0;
  std::size_t opsTotal = 0;
  std::size_t opsSame = 0;
  js::Json::Array& cases = fx.root().find_mut("cases")->arr_mut();
  for (js::Json& c : cases) {
    const std::string type = c.at("type").str();
    INFO(type);
    const double w = c.at("w").num();
    const double h = c.at("h").num();
    // The effect runner reads raster::json; JSON.stringify's numbers parse back bit-identical.
    Value params;
    std::string err;
    REQUIRE(raster::json::parse(js::stringify(c.at("params")), params, err));
    auto rec = std::make_shared<raster::test::Recording>();
    raster::test::RecordingCanvas oc(rec, static_cast<std::uint32_t>(w), static_cast<std::uint32_t>(h));
    oc.setFillStyle(*raster::color_style("#3366cc"));
    oc.fillRect(w / 4, h / 4, w / 2, h / 2);
    REQUIRE(effects::run_canvas_effect(type, params, oc, w, h));

    const auto& got = rec->ops;
    js::Json::Array gotOps;
    for (const std::string& op : got) gotOps.push_back(js::Json::string(op));
    if (!fx.reblessing()) {
      const js::Json::Array& want = c.at("ops").arr();
      std::size_t same = 0;
      std::size_t first = want.size();
      for (std::size_t i = 0; i < std::min(want.size(), got.size()); ++i) {
        if (want[i].str() == got[i]) ++same;
        else if (first == want.size()) first = i;
      }
      opsTotal += want.size();
      opsSame += same;
      if (same == want.size() && got.size() == want.size()) {
        ++exact;
      } else {
        const std::size_t i = std::min(first, std::min(want.size(), got.size()));
        std::printf("  %s: first difference at op %zu of %zu (C++ issued %zu)\n    TS : %s\n    C++: %s\n", type.c_str(), i,
                    want.size(), got.size(), i < want.size() ? want[i].str().c_str() : "(end)", i < got.size() ? got[i].c_str() : "(end)");
      }
    }
    CHECK(fx.answer(c, "ops", js::Json::array(std::move(gotOps))));
  }
  std::printf("canvas effects vs canvas2dEffects.ts: %d/%zu cases op-for-op, %zu/%zu ops identical (%zu effects ported)\n", exact,
              cases.size(), opsSame, opsTotal, effects::ported_canvas_effects().size());
  CHECK_FALSE(effects::run_canvas_effect("not-an-effect", Value::make_object(), *std::make_unique<raster::test::RecordingCanvas>(
                                                                                     std::make_shared<raster::test::Recording>(), 1, 1), 1, 1));
  REQUIRE(fx.finish());
}
