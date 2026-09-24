// E4 × E3 canvas-drawn effects (effects/canvas_effects.cpp) against
// canvas2dEffects.ts: the C++ on a recording Canvas2D must issue the TS's
// Canvas2D program op for op (tests/data/canvas_effects_parity.json, written by
// src/core/effects/canvasEffectsCrossEngine.test.ts).
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>

#include "effects/canvas_effects.hpp"
#include "raster/json.hpp"
#include "raster/paint_common.hpp"
#include "recording_canvas.hpp"

using namespace premation;
using raster::json::Value;

TEST_CASE("canvas effects: the C++ issues canvas2dEffects.ts's Canvas2D program", "[effects][canvas]") {
  std::ifstream in(std::string(PREMATION_ENGINE_TEST_DATA) + "/canvas_effects_parity.json", std::ios::binary);
  std::stringstream ss;
  ss << in.rdbuf();
  Value fx;
  std::string err;
  REQUIRE(raster::json::parse(ss.str(), fx, err));

  int exact = 0;
  std::size_t opsTotal = 0;
  std::size_t opsSame = 0;
  for (const auto& c : fx["cases"].items()) {
    INFO(c["type"].str());
    const double w = c["w"].num();
    const double h = c["h"].num();
    auto rec = std::make_shared<raster::test::Recording>();
    raster::test::RecordingCanvas oc(rec, static_cast<std::uint32_t>(w), static_cast<std::uint32_t>(h));
    oc.setFillStyle(*raster::color_style("#3366cc"));
    oc.fillRect(w / 4, h / 4, w / 2, h / 2);
    REQUIRE(effects::run_canvas_effect(c["type"].str(), c["params"], oc, w, h));

    const auto& want = c["ops"].items();
    const auto& got = rec->ops;
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
      std::printf("  %s: first difference at op %zu of %zu (C++ issued %zu)\n    TS : %s\n    C++: %s\n", c["type"].str().c_str(), i,
                  want.size(), got.size(), i < want.size() ? want[i].str().c_str() : "(end)", i < got.size() ? got[i].c_str() : "(end)");
    }
    CHECK(got.size() == want.size());
    CHECK(same == want.size());
  }
  std::printf("canvas effects vs canvas2dEffects.ts: %d/%zu cases op-for-op, %zu/%zu ops identical (%zu effects ported)\n", exact,
              fx["cases"].size(), opsSame, opsTotal, effects::ported_canvas_effects().size());
  CHECK_FALSE(effects::run_canvas_effect("not-an-effect", fx, *std::make_unique<raster::test::RecordingCanvas>(
                                                                  std::make_shared<raster::test::Recording>(), 1, 1), 1, 1));
}
