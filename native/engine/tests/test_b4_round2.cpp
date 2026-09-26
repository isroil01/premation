// B4 round 2 (ENGINE_API.md §15.12): the queries and commands that replaced
// the UI's reads around the API — capturePreset, the keyframe / effect
// clipboards, getTextLayout / getLayerBounds on a session with no scene
// systems injected (document-only answers). Semantics are the TypeScript
// engine's (src/core/engine/__tests__/queries.test.ts pins the same cases).

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <string>
#include <vector>

#include "core/json.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;
using Catch::Approx;

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

api::LayerId make_layer(Harness& h, const api::ItemId& comp, api::LayerKind kind = api::LayerKind::solid) {
  api::CreateLayer c;
  c.comp = comp;
  c.kind = kind;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_layer(r);
}

template <class T>
T query(Harness& h, api::Query q) {
  const auto r = h.ask(std::move(q));
  REQUIRE(is_ok(r));
  return std::get<T>(std::get<api::QueryResult>(r.outcome.v).v);
}

js::Json parse_or_fail(const std::string& s) {
  auto j = js::parse(s);
  REQUIRE(j.has_value());
  return *j;
}

}  // namespace

TEST_CASE("capturePreset: an applied preset captures back rebased to 0 in its own units", "[b4r2][presets]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  REQUIRE(is_ok(h.run(cmd(api::ApplyPreset{{layer}, "Fade In", 2 * kSec}))));
  const auto cap = query<api::CapturedPreset>(h, qry(api::CapturePreset{layer}));
  REQUIRE_FALSE(cap.empty);
  const js::Json body = parse_or_fail(cap.preset);
  const js::Json& tracks = body.at("tracks");
  REQUIRE(tracks.is_array());
  REQUIRE(tracks.arr().size() == 1);
  const js::Json& t = tracks.arr()[0];
  CHECK(t.at("prop").str() == "opacity");
  CHECK(t.at("unit").str() == "abs");
  const js::Json& keys = t.at("keyframes");
  REQUIRE(keys.arr().size() == 2);
  CHECK(keys.arr()[0].at("t").num() == Approx(0));
  CHECK(keys.arr()[1].at("t").num() == Approx(0.5));
  CHECK(keys.arr()[0].at("value").num() == Approx(0));
  CHECK(keys.arr()[1].at("value").num() == Approx(100));
}

TEST_CASE("capturePreset: position keys leave pixels as comp fractions; an empty layer says so", "[b4r2][presets]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  const auto bare = make_layer(h, comp);
  api::AddKeyframes a;
  for (const auto& [t, x] : std::vector<std::pair<api::Time, double>>{{kSec, 480}, {2 * kSec, 960}}) {
    api::KeyframeInsert k;
    k.prop = {layer, "transform/position"};
    k.time = t;
    k.value = vec2(x, 540);
    a.keys.push_back(std::move(k));
  }
  REQUIRE(is_ok(h.run(cmd(a))));
  const js::Json body = parse_or_fail(query<api::CapturedPreset>(h, qry(api::CapturePreset{layer})).preset);
  const js::Json* x = nullptr;
  for (const js::Json& t : body.at("tracks").arr()) {
    if (t.at("prop").str() == "x") x = &t;
  }
  REQUIRE(x != nullptr);
  CHECK(x->at("unit").str() == "compW");
  CHECK(x->at("keyframes").arr()[0].at("t").num() == Approx(0));
  CHECK(x->at("keyframes").arr()[1].at("t").num() == Approx(1));
  CHECK(x->at("keyframes").arr()[0].at("value").num() == Approx(0.25));
  CHECK(x->at("keyframes").arr()[1].at("value").num() == Approx(0.5));

  const auto empty = query<api::CapturedPreset>(h, qry(api::CapturePreset{bare}));
  CHECK(empty.empty);
  CHECK(empty.preset == "{}");
  const auto missing = h.ask(qry(api::CapturePreset{"nope"}));
  CHECK_FALSE(is_ok(missing));
}
