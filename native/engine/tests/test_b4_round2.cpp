// B4 round 2 (ENGINE_API.md §15.12): the queries and commands that replaced
// the UI's reads around the API — capturePreset, the keyframe / effect
// clipboards, getTextLayout / getLayerBounds on a session with no scene
// systems injected (document-only answers). Semantics are the TypeScript
// engine's (src/core/engine/__tests__/queries.test.ts pins the same cases).

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <string>
#include <type_traits>
#include <variant>
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

/// The query's typed answer (by visit: several queries share a result type, e.g. KeyframeSets).
template <class T>
T query(Harness& h, api::Query q) {
  const auto r = h.ask(std::move(q));
  REQUIRE(is_ok(r));
  return std::visit(
      [](const auto& x) -> T {
        if constexpr (std::is_same_v<std::decay_t<decltype(x)>, T>) {
          return x;
        } else {
          FAIL("unexpected query result type");
          return T{};
        }
      },
      std::get<api::QueryResult>(r.outcome.v).v);
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

TEST_CASE("getLayerBounds: the drawn box in layer and comp space follows the keyed position", "[b4r2][bounds]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp, api::LayerKind::shape);
  api::AddKeyframes a;
  for (const auto& [t, x] : std::vector<std::pair<api::Time, double>>{{0, 100}, {kSec, 300}}) {
    api::KeyframeInsert k;
    k.prop = {layer, "transform/position"};
    k.time = t;
    k.value = vec2(x, 200);
    a.keys.push_back(std::move(k));
  }
  REQUIRE(is_ok(h.run(cmd(a))));
  const auto at = [&](api::Time t, api::BoundsSpace space) {
    api::GetLayerBounds q;
    q.layers = {layer};
    q.time = t;
    q.space = space;
    const auto list = query<api::LayerBoundsList>(h, qry(q));
    REQUIRE(list.bounds.size() == 1);
    return list.bounds[0];
  };
  const auto local = at(0, api::BoundsSpace::layer);
  REQUIRE(local.corners.size() == 8);
  CHECK(local.bounds.x == Approx(-local.bounds.width / 2));
  const auto c1 = at(kSec, api::BoundsSpace::comp);
  CHECK(c1.bounds.x + c1.bounds.width / 2 == Approx(300));
  CHECK(c1.bounds.y + c1.bounds.height / 2 == Approx(200));
  CHECK(c1.bounds.width == Approx(local.bounds.width));

  api::GetLayerBounds vp;
  vp.layers = {layer};
  vp.space = api::BoundsSpace::viewport;
  CHECK_FALSE(is_ok(h.ask(qry(vp))));
}

TEST_CASE("getTextLayout / getLayerBounds on text: unsupported without fonts; not a text layer is invalid", "[b4r2][text]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto text = make_layer(h, comp, api::LayerKind::text);
  const auto solid = make_layer(h, comp);
  api::GetTextLayout q;
  q.layer = text;
  const auto r = h.ask(qry(q));
  REQUIRE_FALSE(is_ok(r));
  CHECK(std::get<api::EngineError>(r.outcome.v).code == api::ErrorCode::unsupported);
  q.layer = solid;
  const auto bad = h.ask(qry(q));
  REQUIRE_FALSE(is_ok(bad));
  CHECK(std::get<api::EngineError>(bad.outcome.v).code == api::ErrorCode::invalid_argument);
  api::GetLayerBounds b;
  b.layers = {text};
  b.space = api::BoundsSpace::layer;
  const auto rb = h.ask(qry(b));
  REQUIRE_FALSE(is_ok(rb));
  CHECK(std::get<api::EngineError>(rb.outcome.v).code == api::ErrorCode::unsupported);
}

TEST_CASE("copyKeyframes: whole keys per property in time order; unknown ids skipped", "[b4r2][clipboard]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  api::AddKeyframes a;
  for (const auto& [t, x] : std::vector<std::pair<api::Time, double>>{{0, 100}, {kSec, 300}}) {
    api::KeyframeInsert k;
    k.prop = {layer, "transform/position"};
    k.time = t;
    k.value = vec2(x, 200);
    a.keys.push_back(std::move(k));
  }
  const auto ids = result_as<api::KeyframeIds>(h.run(cmd(a))).ids;
  REQUIRE(ids.size() == 2);
  const auto clip = query<api::KeyframeSets>(h, qry(api::CopyKeyframes{{ids[1], "nope", ids[0]}}));
  REQUIRE(clip.sets.size() == 1);
  CHECK(clip.sets[0].prop.path == "transform/position");
  REQUIRE(clip.sets[0].keyframes.size() == 2);
  CHECK(clip.sets[0].keyframes[0].id == ids[0]);
  CHECK(clip.sets[0].keyframes[1].time == kSec);
  CHECK(query<api::KeyframeSets>(h, qry(api::CopyKeyframes{{"nope"}})).sets.empty());
}

TEST_CASE("copyEffects: the capture pasteEffects takes, equal until the effect changes", "[b4r2][clipboard]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  api::AddEffect add;
  add.layers = {layer};
  add.effect = "glow";
  const auto added = result_as<api::GroupList>(h.run(cmd(add)));
  REQUIRE(added.groups.size() == 1);
  const std::string path = added.groups[0];
  const auto one = query<api::CopiedEffects>(h, qry(api::CopyEffects{layer, {path, "effects/nope"}}));
  REQUIRE(one.paths == std::vector<std::string>{path});
  const js::Json cap = parse_or_fail(one.effects);
  REQUIRE(cap.arr().size() == 1);
  CHECK(cap.arr()[0].at("effect").at("type").str() == "glow");
  CHECK(cap.arr()[0].at("tracks").obj().empty());
  CHECK(query<api::CopiedEffects>(h, qry(api::CopyEffects{layer, {path}})).effects == one.effects);
  api::SetAnimated anim;
  anim.prop = {layer, path + "/radius"};
  anim.animated = true;
  REQUIRE(is_ok(h.run(cmd(anim))));
  const js::Json keyed = parse_or_fail(query<api::CopiedEffects>(h, qry(api::CopyEffects{layer, {}})).effects);
  REQUIRE(keyed.arr().size() == 1);
  CHECK(keyed.arr()[0].at("tracks").has("radius"));
}

TEST_CASE("getSvgDocument / LayerInfo.svg: none for an ordinary layer; getCryptomatte unsupported (no EXR decode)", "[b4r2][svg]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  const auto doc = query<api::SvgDocument>(h, qry(api::GetSvgDocument{layer}));
  CHECK(doc.role == api::SvgRole::none);
  CHECK(doc.capabilities == "{}");
  const auto layers = query<api::LayerDetails>(h, qry(api::GetLayers{{layer}}));
  REQUIRE(layers.layers.size() == 1);
  CHECK(layers.layers[0].svg == api::SvgRole::none);
  const auto crypto = h.ask(qry(api::GetCryptomatte{comp}));
  REQUIRE_FALSE(is_ok(crypto));
  CHECK(std::get<api::EngineError>(crypto.outcome.v).code == api::ErrorCode::unsupported);
  const auto missing = h.ask(qry(api::GetCryptomatte{"nope"}));
  REQUIRE_FALSE(is_ok(missing));
  CHECK(std::get<api::EngineError>(missing.outcome.v).code == api::ErrorCode::not_found);
}
