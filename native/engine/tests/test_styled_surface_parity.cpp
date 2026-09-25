// styledSurfaceFill parity (tests/data/styled_surface_parity.json, written by
// src/core/effects/styledSurfaceCrossEngine.test.ts): the extrusion wall
// colour under Colour / Gradient Overlay styles, string for string.
#include <catch2/catch_test_macros.hpp>

#include <fstream>
#include <sstream>
#include <string>

#include "json.hpp"
#include "styled_surface.hpp"

TEST_CASE("styled surface fill parity: extrusion walls under overlay styles", "[scene][styles][parity]") {
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/styled_surface_parity.json", std::ios::binary);
  REQUIRE(f.good());
  std::stringstream ss;
  ss << f.rdbuf();
  const auto fixture = premation::js::parse(ss.str());
  REQUIRE(fixture.has_value());
  const auto& rows = fixture->at("rows").arr();
  REQUIRE(rows.size() >= 60);
  for (const auto& row : rows) {
    INFO(row.at("base").str());
    CHECK(premation::scene::styled_surface_fill(row.at("styles"), row.at("base").str()) == row.at("fill").str());
  }
}
