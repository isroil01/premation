// Cross-engine text animator / text path parity (tests/data/text_animator_parity.json,
// written by src/core/text/textAnimatorsCrossEngine.test.ts): the C++ port of
// resolveAnimators + evaluateTextAnimators (text_port.cpp) gives the editor's
// GlyphTransform[] member for member, number for number; flattenMaskPath gives
// the same polyline.
#include <catch2/catch_test_macros.hpp>

#include <fstream>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "json.hpp"
#include "text_port.hpp"

namespace sc = premation::scene;
using premation::js::Json;

namespace {

Json load() {
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/text_animator_parity.json", std::ios::binary);
  REQUIRE(f.good());
  std::stringstream ss;
  ss << f.rdbuf();
  auto j = premation::js::parse(ss.str());
  REQUIRE(j.has_value());
  return *j;
}

void check_same(const Json& ts, const Json& cc, const std::string& where) {
  INFO(where);
  REQUIRE(ts.kind() == cc.kind());
  if (ts.is_number()) {
    CHECK(ts.num() == cc.num());
  } else if (ts.is_string()) {
    CHECK(ts.str() == cc.str());
  } else if (ts.is_bool()) {
    CHECK(ts.b() == cc.b());
  } else if (ts.is_array()) {
    REQUIRE(ts.arr().size() == cc.arr().size());
    for (std::size_t i = 0; i < ts.arr().size(); ++i) check_same(ts.arr()[i], cc.arr()[i], where + "[" + std::to_string(i) + "]");
  } else if (ts.is_object()) {
    for (const auto& m : ts.obj()) {
      REQUIRE(cc.has(m.key));
      check_same(m.value, cc.at(m.key), where + "." + m.key);
    }
    for (const auto& m : cc.obj()) {
      INFO(where + "." + m.key + " is extra");
      CHECK(ts.has(m.key));
    }
  }
}

}  // namespace

TEST_CASE("text animator parity: per-glyph transforms equal the editor's", "[scene][text][parity]") {
  const Json fixture = load();
  const auto& cases = fixture.at("cases").arr();
  REQUIRE(cases.size() >= 15);
  for (const Json& c : cases) {
    const std::string name = c.at("name").str();
    std::vector<std::pair<std::string, double>> vals;
    for (const Json& kv : c.at("values").arr()) vals.emplace_back(kv.arr()[0].str(), kv.arr()[1].num());
    const sc::Values a(std::move(vals));
    const auto resolved = sc::resolve_text_animators_json(c.at("animators"), a);
    std::string why;
    const Json glyphs = sc::evaluate_text_animators(c.at("text").str(), resolved, c.at("time").num(), &why);
    INFO(name);
    REQUIRE(why.empty());
    check_same(c.at("glyphs"), glyphs, name);
  }
}

TEST_CASE("text path parity: masks flatten to the editor's polyline", "[scene][text][parity]") {
  const Json fixture = load();
  for (const Json& m : fixture.at("masks").arr()) {
    const Json flat = sc::flatten_mask_path(m.at("mask"));
    check_same(m.at("flat").at("pts"), flat.at("pts"), m.at("mask").at("id").str());
    CHECK(flat.at("closed").b() == m.at("flat").at("closed").b());
  }
}
