// B4 round 3 (ENGINE_API.md §15.13): the queries that took the last UI reads
// of the expression editor — evaluateExpression with a `member` and with a
// Source Text draft. Semantics are the TypeScript engine's
// (src/core/engine/__tests__/queries.test.ts pins the same cases).

#include <catch2/catch_test_macros.hpp>

#include <string>
#include <type_traits>
#include <variant>
#include <vector>

#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;

namespace {

constexpr api::Time kSec = 705'600'000;

api::ItemId make_comp(Harness& h) {
  api::CreateComposition c;
  c.settings.name = "Test";
  c.settings.width = 1920;
  c.settings.height = 1080;
  c.settings.frame_rate = api::Rational{30, 1};
  c.settings.duration = 10 * kSec;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_item(r);
}

api::LayerId make_layer(Harness& h, const api::ItemId& comp, api::LayerKind kind) {
  api::CreateLayer c;
  c.comp = comp;
  c.kind = kind;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_layer(r);
}

api::ExpressionEvaluation evaluate(Harness& h, api::EvaluateExpression q) {
  const auto r = h.ask(qry(std::move(q)));
  REQUIRE(is_ok(r));
  const auto& qr = std::get<api::QueryResult>(r.outcome.v).v;
  REQUIRE(std::holds_alternative<api::ExpressionEvaluation>(qr));
  return std::get<api::ExpressionEvaluation>(qr);
}

double scalar_of(const std::optional<api::Value>& v) {
  REQUIRE(v.has_value());
  REQUIRE(v->kind() == doc::VK::scalar);
  return doc::get<doc::VK::scalar>(*v);
}

}  // namespace

TEST_CASE("evaluateExpression: `member` drives that dimension with its own value", "[b4r3][expression]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp, api::LayerKind::solid);
  api::SetProperty sp;
  sp.prop = {layer, "transform/position"};
  sp.value = vec2(200, 150);
  REQUIRE(is_ok(h.run(cmd(sp))));

  api::EvaluateExpression q;
  q.prop = {layer, "transform/position"};
  q.time = kSec / 2;
  q.source = "value + 1";
  CHECK(scalar_of(evaluate(h, q).value) == 201);
  q.member = 1;
  CHECK(scalar_of(evaluate(h, q).value) == 151);
  q.member = 5;
  const auto bad = h.ask(qry(q));
  REQUIRE_FALSE(is_ok(bad));
  CHECK(std::get<api::EngineError>(bad.outcome.v).code == api::ErrorCode::out_of_range);
}

TEST_CASE("evaluateExpression on Source Text: the draft's text and style keys, never stored", "[b4r3][expression]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto text = make_layer(h, comp, api::LayerKind::text);
  api::EvaluateExpression q;
  q.prop = {text, "text/sourceText"};
  q.source = "value.style.setFontSize(20).setFillColor([1, 0, 0], 0, 2).setBaselineShift(4, 1, 1)";
  const auto e = evaluate(h, q);
  CHECK_FALSE(e.value.has_value());
  CHECK(e.diagnostics.empty());
  REQUIRE(e.text.has_value());
  CHECK(e.text->style_keys == std::vector<std::string>{"fontSize"});
  CHECK(e.text->ranges == 2);
  CHECK(e.text->range_keys == std::vector<std::string>{"fill", "baselineShift"});

  q.source = "value + \"!\"";
  const auto bang = evaluate(h, q);
  REQUIRE(bang.text.has_value());
  CHECK(bang.text->text.back() == '!');

  q.source = "nope(";
  const auto broken = evaluate(h, q);
  CHECK_FALSE(broken.text.has_value());
  CHECK(broken.diagnostics.size() == 1);

  // Nothing was stored: the layer still has no expression on Source Text.
  api::GetPropertyTree t;
  t.layer = text;
  t.path = "text/sourceText";
  const auto r = h.ask(qry(t));
  REQUIRE(is_ok(r));
  const auto& tree = std::get<api::PropertyTree>(std::get<api::QueryResult>(r.outcome.v).v);
  REQUIRE_FALSE(tree.nodes.empty());
  CHECK(tree.nodes.front().expression.empty());
}

TEST_CASE("getSearchFacts: effect match names in stack order and every expression, per layer", "[b4r3][search]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto a = make_layer(h, comp, api::LayerKind::solid);
  const auto b = make_layer(h, comp, api::LayerKind::solid);
  for (const char* type : {"glow", "blur", "glow"}) {
    api::AddEffect add;
    add.layers = {a};
    add.effect = type;
    REQUIRE(is_ok(h.run(cmd(add))));
  }
  api::SetExpression e;
  e.prop = {a, "transform/opacity"};
  e.source = "wiggle(1, 5)";
  e.enabled = false;
  REQUIRE(is_ok(h.run(cmd(e))));

  const auto facts = [&](std::vector<api::LayerId> layers) {
    api::GetSearchFacts q;
    q.layers = std::move(layers);
    const auto r = h.ask(qry(q));
    REQUIRE(is_ok(r));
    return std::get<api::SearchFactsList>(std::get<api::QueryResult>(r.outcome.v).v);
  };
  const auto all = facts({});
  REQUIRE(all.layers.size() == 2);
  const auto& fa = all.layers[0].layer == a ? all.layers[0] : all.layers[1];
  CHECK(fa.effects == std::vector<std::string>{"glow", "blur", "glow"});
  CHECK(fa.expressions == std::vector<std::string>{"wiggle(1, 5)"});
  const auto one = facts({b, "nope"});
  REQUIRE(one.layers.size() == 1);
  CHECK(one.layers[0].layer == b);
  CHECK(one.layers[0].effects.empty());
  CHECK(one.layers[0].expressions.empty());
}
