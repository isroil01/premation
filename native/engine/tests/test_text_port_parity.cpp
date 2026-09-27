// Cross-engine text animator / text path parity (tests/data/text_animator_parity.json,
// frozen from the TypeScript engine's textAnimatorsCrossEngine.test.ts): the
// C++ port of resolveAnimators + evaluateTextAnimators (text_port.cpp) gives
// the editor's GlyphTransform[] member for member, number for number;
// flattenMaskPath gives the same polyline. PARITY_REBLESS=1 writes the C++
// answers instead (parity_rebless.hpp).
#include <catch2/catch_test_macros.hpp>

#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "json.hpp"
#include "parity_rebless.hpp"
#include "text_measure.hpp"
#include "text_port.hpp"

namespace sc = premation::scene;
using premation::js::Json;
using premation::test::JsonFixture;

namespace {

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

/// `cc` with its object members in `ts`'s order (members `ts` lacks last, in
/// their own order), recursively — so a re-bless keeps the TS writer's layout.
Json ordered_like(const Json& ts, const Json& cc) {
  if (cc.is_array()) {
    Json::Array out;
    const Json::Array& a = cc.arr();
    for (std::size_t i = 0; i < a.size(); ++i) {
      out.push_back(ts.is_array() && i < ts.arr().size() ? ordered_like(ts.arr()[i], a[i]) : a[i]);
    }
    return Json::array(std::move(out));
  }
  if (!cc.is_object()) return cc;
  Json out = Json::object();
  if (ts.is_object()) {
    for (const auto& m : ts.obj()) {
      if (const Json* v = cc.find(m.key)) out.set(m.key, ordered_like(m.value, *v));
    }
  }
  for (const auto& m : cc.obj()) {
    if (!out.has(m.key)) out.set(m.key, m.value);
  }
  return out;
}

/// holder[key] against the C++ `cc` (check_same), or, re-blessing, `cc` stored there.
void answer_same(JsonFixture& fx, Json& holder, std::string_view key, const Json& cc, const std::string& where) {
  if (fx.reblessing()) {
    holder.set(key, ordered_like(holder.at(key), cc));
    return;
  }
  check_same(holder.at(key), cc, where);
}

}  // namespace

TEST_CASE("text animator parity: per-glyph transforms equal the editor's", "[scene][text][parity]") {
  JsonFixture fx("text_animator_parity.json");
  REQUIRE(fx.ok());
  auto& cases = fx.root().find_mut("cases")->arr_mut();
  REQUIRE(cases.size() >= 15);
  for (Json& c : cases) {
    const std::string name = c.at("name").str();
    std::vector<std::pair<std::string, double>> vals;
    for (const Json& kv : c.at("values").arr()) vals.emplace_back(kv.arr()[0].str(), kv.arr()[1].num());
    const sc::Values a(std::move(vals));
    const auto resolved = sc::resolve_text_animators_json(c.at("animators"), a);
    std::string why;
    const Json glyphs = sc::evaluate_text_animators(c.at("text").str(), resolved, c.at("time").num(), &why);
    INFO(name);
    REQUIRE(why.empty());
    answer_same(fx, c, "glyphs", glyphs, name);
  }
  REQUIRE(fx.finish());
}

TEST_CASE("text path parity: masks flatten to the editor's polyline", "[scene][text][parity]") {
  // Shares text_animator_parity.json with the case above: this one answers the masks' "flat".
  JsonFixture fx("text_animator_parity.json");
  REQUIRE(fx.ok());
  for (Json& m : fx.root().find_mut("masks")->arr_mut()) {
    const Json flat = sc::flatten_mask_path(m.at("mask"));
    Json& want = *m.find_mut("flat");
    answer_same(fx, want, "pts", flat.at("pts"), m.at("mask").at("id").str());
    CHECK(fx.answer(want, "closed", Json::boolean(flat.at("closed").b())));
  }
  REQUIRE(fx.finish());
}

// textExtras.ts softBreakLines over the CJK wraps of cjk_wrap_parity.json
// (src/core/text/cjkWrapCrossEngine.test.ts): inserted breaks and replaced
// spaces are soft, the paragraphs' own newlines hard.
TEST_CASE("text: soft break lines of an inserting (CJK) wrap equal the editor's", "[scene][text][cjk]") {
  std::ifstream f(std::string(PREMATION_ENGINE_TEST_DATA) + "/cjk_wrap_parity.json", std::ios::binary);
  if (!f.good()) {
    WARN("cjk_wrap_parity.json not generated yet (GEN_NATIVE_CJKWRAP=1 npx jest cjkWrapCrossEngine)");
    return;
  }
  std::stringstream ss;
  ss << f.rdbuf();
  const auto fixture = premation::js::parse(ss.str());
  REQUIRE(fixture.has_value());
  for (const Json& row : fixture->at("rows").arr()) {
    INFO(row.at("text").str());
    std::vector<int> want;
    for (const Json& n : row.at("softBreakLines").arr()) want.push_back(static_cast<int>(n.num()));
    CHECK(sc::soft_break_lines(row.at("text").str(), row.at("wrapped").str()) == want);
  }
  // Same length (spaces replaced) and a wrap never shorter than its text.
  CHECK(sc::soft_break_lines("ab cd ef", "ab\ncd ef") == std::vector<int>{0});
  CHECK(sc::soft_break_lines("ab\ncd", "ab\ncd").empty());
  CHECK(sc::soft_break_lines("abcd", "ab").empty());
}
