// D2w: polygon-clipping (scene/polygon_clipping.cpp) against the npm library the
// TypeScript's live Merge Paths run — every ring of every result equal,
// coordinate for coordinate (tests/data/polygon_clipping_parity.json, frozen
// from the TypeScript engine's polygonClippingCrossEngine.test.ts).
// PARITY_REBLESS=1 writes the C++ answers instead (parity_rebless.hpp).
#include <catch2/catch_test_macros.hpp>

#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "json.hpp"
#include "parity_rebless.hpp"
#include "polygon_clipping.hpp"

namespace js = premation::js;
namespace pc = premation::scene::pc;

namespace {

pc::MultiPolygon multi_of(const js::Json& j) {
  pc::MultiPolygon m;
  for (const js::Json& poly : j.arr()) {
    pc::Polygon p;
    for (const js::Json& ring : poly.arr()) {
      pc::Ring r;
      for (const js::Json& pt : ring.arr()) r.push_back({pt.arr()[0].num(), pt.arr()[1].num()});
      p.push_back(std::move(r));
    }
    m.push_back(std::move(p));
  }
  return m;
}

/// A result as the fixture stores it: [[[[x, y], …], …], …].
js::Json json_of(const pc::MultiPolygon& m) {
  js::Json::Array polys;
  for (const pc::Polygon& poly : m) {
    js::Json::Array rings;
    for (const pc::Ring& ring : poly) {
      js::Json::Array pts;
      for (const pc::Pair& pt : ring) pts.push_back(premation::test::json_numbers(pt));
      rings.push_back(js::Json::array(std::move(pts)));
    }
    polys.push_back(js::Json::array(std::move(rings)));
  }
  return js::Json::array(std::move(polys));
}

pc::OpType op_of(const std::string& s) {
  if (s == "union") return pc::OpType::union_;
  if (s == "intersection") return pc::OpType::intersection;
  if (s == "xor") return pc::OpType::xor_;
  return pc::OpType::difference;
}

}  // namespace

TEST_CASE("polygon-clipping: the C++ port returns the library's rings exactly", "[scene][polygon-clipping][parity]") {
  premation::test::JsonFixture fx("polygon_clipping_parity.json");
  REQUIRE(fx.ok());
  std::size_t equal = 0;
  js::Json::Array& cases = fx.root().find_mut("cases")->arr_mut();
  for (js::Json& c : cases) {
    INFO(c.at("name").str());
    std::vector<pc::MultiPolygon> clipping;
    for (const js::Json& g : c.at("clipping").arr()) clipping.push_back(multi_of(g));
    std::string error;
    pc::MultiPolygon got;
    try {
      got = pc::run(op_of(c.at("op").str()), multi_of(c.at("subject")), clipping);
    } catch (const std::runtime_error& e) {
      error = e.what();
    }
    if (!error.empty()) {
      // The refusal itself is the answer; its wording is the C++ port's own, so
      // compare mode only requires that the library refused too.
      if (fx.reblessing()) {
        c.set("result", js::Json::null());
        c.set("error", js::Json::string(error));
      } else {
        INFO("error: " << error);
        CHECK(c.at("error").is_string());
      }
      continue;
    }
    CHECK(fx.answer(c, "error", js::Json::null()));
    if (!fx.reblessing()) {
      REQUIRE(c.at("result").is_array());
      const pc::MultiPolygon want = multi_of(c.at("result"));
      REQUIRE(got.size() == want.size());
      bool same = true;
      for (std::size_t p = 0; p < want.size() && same; ++p) {
        same = got[p].size() == want[p].size();
        for (std::size_t r = 0; r < want[p].size() && same; ++r) {
          same = got[p][r].size() == want[p][r].size();
          for (std::size_t k = 0; k < want[p][r].size() && same; ++k) same = got[p][r][k] == want[p][r][k];
          if (!same) INFO("polygon " << p << " ring " << r << ": got " << got[p][r].size() << " points, want " << want[p][r].size());
        }
      }
      CHECK(same);
      if (same) ++equal;
    }
    CHECK(fx.answer(c, "result", json_of(got)));
  }
  if (!fx.reblessing()) CHECK(equal == cases.size());
  REQUIRE(fx.finish());
}
