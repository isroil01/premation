// D2w: polygon-clipping (scene/polygon_clipping.cpp) against the npm library the
// TypeScript's live Merge Paths run — every ring of every result equal,
// coordinate for coordinate (tests/data/polygon_clipping_parity.json, written by
// src/core/scene/polygonClippingCrossEngine.test.ts).
#include <catch2/catch_test_macros.hpp>

#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>

#include "json.hpp"
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

pc::OpType op_of(const std::string& s) {
  if (s == "union") return pc::OpType::union_;
  if (s == "intersection") return pc::OpType::intersection;
  if (s == "xor") return pc::OpType::xor_;
  return pc::OpType::difference;
}

}  // namespace

TEST_CASE("polygon-clipping: the C++ port returns the library's rings exactly", "[scene][polygon-clipping][parity]") {
  std::ifstream in(std::string(PREMATION_ENGINE_TEST_DATA) + "/polygon_clipping_parity.json", std::ios::binary);
  REQUIRE(in.good());
  std::stringstream ss;
  ss << in.rdbuf();
  const auto fx = js::parse(ss.str());
  REQUIRE(fx.has_value());
  std::size_t equal = 0;
  const js::Json::Array& cases = fx->at("cases").arr();
  for (const js::Json& c : cases) {
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
    if (c.at("error").is_string()) {
      CHECK_FALSE(error.empty());
      continue;
    }
    INFO("error: " << error);
    REQUIRE(error.empty());
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
  CHECK(equal == cases.size());
}
