// Write-on brush trail parity (tests/data/write_on_trail_parity.json, written by
// src/core/effects/writeOnTrailCrossEngine.test.ts): resolveWriteOnTrail's dab
// history — the sampler replays the TypeScript's recorded answers, so the port
// must ask for the same (prop, t) pairs in the same order and build the same
// xy / size / attr / filled, float for float.
#include <catch2/catch_test_macros.hpp>

#include <cstddef>
#include <fstream>
#include <set>
#include <sstream>
#include <string>

#include "json.hpp"
#include "write_on_trail.hpp"

namespace sc = premation::scene;
using premation::js::Json;

namespace {

void check_array(const Json& want, const std::vector<double>& got) {
  REQUIRE(want.arr().size() == got.size());
  for (std::size_t i = 0; i < got.size(); ++i) CHECK(got[i] == want.arr()[i].num());
}

}  // namespace

TEST_CASE("write-on trail parity: the dab history equals the editor's", "[scene][writeon][parity]") {
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/write_on_trail_parity.json", std::ios::binary);
  if (!f.good()) {
    WARN("write_on_trail_parity.json not generated yet (GEN_NATIVE_WRITEON=1 npx jest writeOnTrailCrossEngine)");
    return;
  }
  std::stringstream ss;
  ss << f.rdbuf();
  const auto fixture = premation::js::parse(ss.str());
  REQUIRE(fixture.has_value());
  bool anyFilled = false;
  for (const Json& row : fixture->at("rows").arr()) {
    INFO(row.at("name").str());
    std::set<std::string, std::less<>> animated;
    for (const Json& a : row.at("animated").arr()) animated.insert(a.str());
    const Json& samples = row.at("samples");
    std::size_t next = 0;
    const sc::TrailSample sample = [&](std::string_view prop, double t) -> std::optional<double> {
      REQUIRE(next < samples.arr().size());
      const Json& s = samples.arr()[next++];
      CHECK(s.arr()[0].str() == prop);
      CHECK(s.arr()[1].num() == t);
      if (s.arr()[2].is_number()) return s.arr()[2].num();
      return std::nullopt;
    };
    const sc::TrailIsAnimated isAnimated = [&](std::string_view prop) { return animated.contains(prop); };
    const std::optional<double> earliest =
        row.at("earliest").is_number() ? std::optional<double>(row.at("earliest").num()) : std::nullopt;
    const sc::WriteOnTrail trail =
        sc::resolve_write_on_trail(row.at("id").str(), row.at("params"), row.at("t").num(), sample, isAnimated, earliest);
    CHECK(next == samples.arr().size());
    const Json& want = row.at("trail");
    check_array(want.at("xy"), trail.xy);
    check_array(want.at("size"), trail.size);
    check_array(want.at("attr"), trail.attr);
    CHECK(trail.filled == want.at("filled").b());
    anyFilled = anyFilled || trail.filled;
  }
  CHECK(anyFilled);
}
