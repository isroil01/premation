// Write-on brush trail parity (tests/data/write_on_trail_parity.json, frozen
// from the TypeScript engine's writeOnTrailCrossEngine.test.ts):
// resolveWriteOnTrail's dab history — the sampler replays the TypeScript's
// recorded answers, so the port must ask for the same (prop, t) pairs in the
// same order and build the same xy / size / attr / filled, float for float.
// PARITY_REBLESS=1 writes the C++ answers instead (parity_rebless.hpp): the
// trail and the (prop, t) pairs the port asks for, each answered by the TS
// test's closed-form `answer(prop, t)` (ported below, fdlibm sin), so the
// recorded samples stay self-consistent.
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstddef>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "json.hpp"
#include "jsmath.hpp"
#include "parity_rebless.hpp"
#include "write_on_trail.hpp"

namespace sc = premation::scene;
using premation::js::Json;

namespace {

/// A number as JSON.stringify writes it: NaN (and ±Infinity) become null.
Json json_number(double v) { return std::isfinite(v) ? Json::number(v) : Json::null(); }

Json json_array(const std::vector<double>& v) {
  Json::Array a;
  for (const double x : v) a.push_back(json_number(x));
  return Json::array(std::move(a));
}

/// writeOnTrailCrossEngine.test.ts `answer(prop, t)`: the sampler's value for a
/// (prop, t) pair (props are ASCII, so charCodeAt is the byte).
double ts_answer(std::string_view prop, double t) {
  double h = 0;
  for (const char c : prop) h = std::fmod(h * 31 + static_cast<double>(static_cast<unsigned char>(c)), 997);
  if (prop.ends_with("_r") || prop.ends_with("_g") || prop.ends_with("_b")) return 0.5 + 0.8 * motion::js::sin(t * 5 + h);
  return 100 * motion::js::sin(t * 2.3 + h) + 7 * t;
}

}  // namespace

TEST_CASE("write-on trail parity: the dab history equals the editor's", "[scene][writeon][parity]") {
  premation::test::JsonFixture fx("write_on_trail_parity.json");
  REQUIRE(fx.ok());
  bool anyFilled = false;
  for (Json& row : fx.root().find_mut("rows")->arr_mut()) {
    INFO(row.at("name").str());
    std::set<std::string, std::less<>> animated;
    for (const Json& a : row.at("animated").arr()) animated.insert(a.str());
    // The TS case's `silent` props (their track yields nothing) are not stored:
    // they are the props the recording answered with null.
    std::set<std::string, std::less<>> silent;
    for (const Json& s : row.at("samples").arr()) {
      if (s.arr()[2].is_null()) silent.insert(s.arr()[0].str());
    }
    const Json::Array recorded = row.at("samples").arr();
    Json::Array asked;
    std::size_t next = 0;
    const sc::TrailSample sample = [&](std::string_view prop, double t) -> std::optional<double> {
      std::optional<double> v;
      if (fx.reblessing()) {
        if (!silent.contains(prop)) v = ts_answer(prop, t);
      } else {
        REQUIRE(next < recorded.size());
        const Json::Array& s = recorded[next++].arr();
        CHECK(s[0].str() == prop);
        CHECK(s[1].num() == t);
        if (s[2].is_number()) {
          v = s[2].num();
          // The port of `answer` reproduces the recording (so a re-bless keeps it).
          CHECK(ts_answer(prop, t) == *v);
        }
      }
      Json::Array entry;
      entry.push_back(Json::string(std::string(prop)));
      entry.push_back(Json::number(t));
      entry.push_back(v ? Json::number(*v) : Json::null());
      asked.push_back(Json::array(std::move(entry)));
      return v;
    };
    const sc::TrailIsAnimated isAnimated = [&](std::string_view prop) { return animated.contains(prop); };
    const std::optional<double> earliest =
        row.at("earliest").is_number() ? std::optional<double>(row.at("earliest").num()) : std::nullopt;
    const sc::WriteOnTrail trail =
        sc::resolve_write_on_trail(row.at("id").str(), row.at("params"), row.at("t").num(), sample, isAnimated, earliest);
    if (!fx.reblessing()) CHECK(next == recorded.size());
    CHECK(fx.answer(row, "samples", Json::array(std::move(asked))));
    Json& want = *row.find_mut("trail");
    CHECK(fx.answer(want, "xy", json_array(trail.xy)));
    CHECK(fx.answer(want, "size", json_array(trail.size)));
    CHECK(fx.answer(want, "attr", json_array(trail.attr)));
    CHECK(fx.answer(want, "filled", Json::boolean(trail.filled)));
    anyFilled = anyFilled || trail.filled;
  }
  CHECK(anyFilled);
  REQUIRE(fx.finish());
}
