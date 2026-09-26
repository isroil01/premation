// styledSurfaceFill parity (tests/data/styled_surface_parity.json, frozen from
// the TypeScript engine's styledSurfaceCrossEngine.test.ts): the extrusion wall
// colour under Colour / Gradient Overlay styles, string for string.
// PARITY_REBLESS=1 writes the C++ answers instead (parity_rebless.hpp).
#include <catch2/catch_test_macros.hpp>

#include <string>

#include "json.hpp"
#include "parity_rebless.hpp"
#include "styled_surface.hpp"

using premation::js::Json;

TEST_CASE("styled surface fill parity: extrusion walls under overlay styles", "[scene][styles][parity]") {
  premation::test::JsonFixture fx("styled_surface_parity.json");
  REQUIRE(fx.ok());
  auto& rows = fx.root().find_mut("rows")->arr_mut();
  REQUIRE(rows.size() >= 60);
  for (Json& row : rows) {
    INFO(row.at("base").str());
    CHECK(fx.answer(row, "fill", Json::string(premation::scene::styled_surface_fill(row.at("styles"), row.at("base").str()))));
  }
  REQUIRE(fx.finish());
}
