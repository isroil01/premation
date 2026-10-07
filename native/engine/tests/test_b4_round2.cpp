// B4 round 2 (ENGINE_API.md §15.12): the queries and commands that replaced
// the UI's reads around the API — capturePreset, the keyframe / effect
// clipboards, getTextLayout / getLayerBounds on a session with no scene
// systems injected (document-only answers). Semantics are the TypeScript
// engine's (src/core/engine/__tests__/queries.test.ts pins the same cases).

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <optional>
#include <string>
#include <type_traits>
#include <variant>
#include <vector>

#include "core/json.hpp"
#include "core/overlay_geometry.hpp"
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
  REQUIRE(is_ok(h.run(cmd(api::ApplyPreset{{layer}, "Fade In", 2 * kSec, {}}))));
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

TEST_CASE("getMemberKeyframes: the stored member tracks with their owning property", "[b4r2][members]") {
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
  REQUIRE(is_ok(h.run(cmd(a))));
  const auto all = query<api::MemberTracks>(h, qry(api::GetMemberKeyframes{layer, {}, std::nullopt}));
  const auto x = std::find_if(all.tracks.begin(), all.tracks.end(), [](const api::MemberTrack& t) { return t.member == "x"; });
  REQUIRE(x != all.tracks.end());
  CHECK(x->path == "transform/position");
  CHECK(x->index == 0);
  CHECK(x->count == 2);
  const js::Json keys = parse_or_fail(x->keyframes);
  REQUIRE(keys.arr().size() == 2);
  CHECK(keys.arr()[1].at("t").num() == Approx(1));
  CHECK(keys.arr()[1].at("value").num() == Approx(300));
  const auto only = query<api::MemberTracks>(h, qry(api::GetMemberKeyframes{layer, {"y"}, std::nullopt}));
  REQUIRE(only.tracks.size() == 1);
  CHECK(only.tracks[0].index == 1);
}

TEST_CASE("setOverlayGeometry: every frame of the viewport is preceded by its geometry", "[b4r2][overlay]") {
  Harness h;
  (void)h.hello();
  const auto layer = make_layer(h, "comp_root", api::LayerKind::shape);
  api::AddKeyframes a;
  for (const auto& [t, x] : std::vector<std::pair<api::Time, double>>{{0, 100}, {kSec, 300}}) {
    api::KeyframeInsert k;
    k.prop = {layer, "transform/position"};
    k.time = t;
    k.value = vec2(x, 200);
    a.keys.push_back(std::move(k));
  }
  REQUIRE(is_ok(h.run(cmd(a))));
  api::SetViewport v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  api::SetOverlayGeometry sub;
  sub.viewport = 1;
  sub.layers = {layer, "nope"};
  sub.kinds = {api::OverlayKind::transform, api::OverlayKind::bounds, api::OverlayKind::motion_path};
  REQUIRE(is_ok(h.run(cmd(sub))));
  h.release_all();
  h.frameMsgs.clear();
  REQUIRE(is_ok(h.run(cmd(api::Seek{kSec / 2}))));
  h.advance(std::chrono::milliseconds(40));
  // The geometry, complete (`last`), then the FrameReady of the same frame.
  std::vector<api::FrameGeometry> parts;
  std::optional<api::FrameReady> ready;
  for (const auto& m : h.frameMsgs) {
    if (const auto* g = std::get_if<api::FrameGeometry>(&m.v)) {
      REQUIRE_FALSE(ready.has_value());
      parts.push_back(*g);
    }
    if (const auto* f = std::get_if<api::FrameReady>(&m.v); f != nullptr && !ready) ready = *f;
  }
  REQUIRE(ready.has_value());
  REQUIRE_FALSE(parts.empty());
  CHECK(parts.back().last);
  CHECK(parts.back().frame == ready->frame);
  std::vector<double> matrix;
  std::vector<double> path;
  std::vector<double> keys;
  std::vector<double> now;
  for (const auto& p : parts) {
    for (const auto& g : p.layers) {
      REQUIRE(g.layer == layer);  // "nope" is skipped
      matrix.insert(matrix.end(), g.matrix.begin(), g.matrix.end());
      path.insert(path.end(), g.path.begin(), g.path.end());
      keys.insert(keys.end(), g.path_keys.begin(), g.path_keys.end());
      now.insert(now.end(), g.path_now.begin(), g.path_now.end());
    }
  }
  REQUIRE(matrix.size() == 16);
  CHECK(matrix[12] == Approx(200));  // halfway between the keys, at the frame's time
  REQUIRE(keys.size() == 16);        // two keys × (t, x, y, z, inX, inY, outX, outY)
  CHECK(keys[1] == Approx(100));
  CHECK(std::isnan(keys[4]));        // the first key has no in-handle
  CHECK(keys[9] == Approx(300));
  CHECK(std::isnan(keys[14]));       // the last key has no out-handle
  REQUIRE(path.size() % 4 == 0);
  CHECK(path.size() / 4 <= doc::kOverlayPathPoints);
  REQUIRE(now.size() == 4);
  CHECK(now[0] == Approx(200));
  // The frame's time on the keyframe axis: halfway between the two keys' times.
  CHECK(now[3] == Approx((keys[0] + keys[8]) / 2));

  // Unsubscribe: frames carry no geometry.
  sub.layers.clear();
  REQUIRE(is_ok(h.run(cmd(sub))));
  h.release_all();
  h.frameMsgs.clear();
  REQUIRE(is_ok(h.run(cmd(api::Seek{kSec}))));
  h.advance(std::chrono::milliseconds(40));
  for (const auto& m : h.frameMsgs) CHECK_FALSE(std::holds_alternative<api::FrameGeometry>(m.v));
}

TEST_CASE("setOverlayGeometry transform: the layer's own transform rides with the matrix (block 3, `local`)", "[b4r2][overlay]") {
  Harness h;
  (void)h.hello();
  const auto layer = make_layer(h, "comp_root", api::LayerKind::shape);
  api::SetProperty anchor;
  anchor.prop = {layer, "transform/anchorPoint"};
  anchor.value = vec2(10, -20);
  REQUIRE(is_ok(h.run(cmd(anchor))));
  api::AddKeyframes a;
  for (const auto& [t, x] : std::vector<std::pair<api::Time, double>>{{0, 100}, {kSec, 300}}) {
    api::KeyframeInsert k;
    k.prop = {layer, "transform/position"};
    k.time = t;
    k.value = vec2(x, 200);
    a.keys.push_back(std::move(k));
  }
  REQUIRE(is_ok(h.run(cmd(a))));
  api::SetViewport v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  api::SetOverlayGeometry sub;
  sub.viewport = 1;
  sub.layers = {layer};
  sub.kinds = {api::OverlayKind::transform};
  REQUIRE(is_ok(h.run(cmd(sub))));
  h.release_all();
  h.frameMsgs.clear();
  REQUIRE(is_ok(h.run(cmd(api::Seek{kSec / 2}))));
  h.advance(std::chrono::milliseconds(40));
  std::vector<double> local;
  std::vector<double> matrix;
  for (const auto& m : h.frameMsgs) {
    if (const auto* g = std::get_if<api::FrameGeometry>(&m.v)) {
      for (const auto& r : g->layers) {
        local.insert(local.end(), r.local.begin(), r.local.end());
        matrix.insert(matrix.end(), r.matrix.begin(), r.matrix.end());
      }
    }
  }
  REQUIRE(local.size() == 9);
  CHECK(local[0] == Approx(200));  // x at the frame (keyed)
  CHECK(local[1] == Approx(200));
  CHECK(local[4] == Approx(1));    // scale as a multiplier
  CHECK(local[5] == Approx(1));
  CHECK(local[6] == Approx(10));   // the anchor the 2D matrix leaves out
  CHECK(local[7] == Approx(-20));
  REQUIRE(matrix.size() == 16);
  CHECK(matrix[12] == Approx(200));  // the 2D chain: position, no anchor term
}

TEST_CASE("pack_frame_geometry: long paths split under the frame channel's payload cap and merge back", "[b4r2][overlay]") {
  api::OverlayLayerGeometry g;
  g.layer = "layer_with_a_long_path";
  g.matrix.assign(16, 1.0);
  for (int i = 0; i < 2000; ++i) g.path_frames.push_back(static_cast<double>(i));
  const auto msgs = doc::pack_frame_geometry(1, 2, 3, 4, 5, {g});
  REQUIRE(msgs.size() > 1);
  CHECK(msgs.back().last);
  std::vector<double> merged;
  for (const auto& m : msgs) {
    CHECK((m.last == (&m == &msgs.back())));
    std::vector<std::uint8_t> bytes;
    frames::encode(frames::Message{.v = m}, bytes);
    CHECK(bytes.size() <= frames::kMaxPayload);
    for (const auto& r : m.layers) merged.insert(merged.end(), r.path_frames.begin(), r.path_frames.end());
  }
  CHECK(merged == g.path_frames);
  const auto none = doc::pack_frame_geometry(1, 2, 3, 4, 5, {});
  REQUIRE(none.size() == 1);
  CHECK(none[0].last);
  CHECK(none[0].layers.empty());
}

TEST_CASE("setMemberKeyframes: writes one member apart from its siblings; '[]' removes; undoable", "[block3][members]") {
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
  REQUIRE(is_ok(h.run(cmd(a))));
  const auto member = [&](const std::string& name) -> std::optional<js::Json> {
    const auto r = query<api::MemberTracks>(h, qry(api::GetMemberKeyframes{layer, {name}, std::nullopt}));
    if (r.tracks.empty()) return std::nullopt;
    return parse_or_fail(r.tracks[0].keyframes);
  };
  const std::string yBefore = js::stringify(*member("y"));
  const std::string xBefore = js::stringify(*member("x"));

  api::SetMemberKeyframes set;
  set.layer = layer;
  set.tracks.push_back({"x", R"([{"t":2,"value":5},{"t":0,"value":1,"easing":"easeOut","si":3},{"t":2,"value":7}])"});
  REQUIRE(is_ok(h.run(cmd(set))));
  const js::Json x = *member("x");
  REQUIRE(x.arr().size() == 2);
  CHECK(x.arr()[0].at("t").num() == Approx(0));
  CHECK(x.arr()[0].at("value").num() == Approx(1));
  CHECK(x.arr()[0].at("easing").str() == "easeOut");
  CHECK(x.arr()[0].at("si").num() == Approx(3));
  CHECK(x.arr()[1].at("value").num() == Approx(7));
  CHECK(js::stringify(*member("y")) == yBefore);
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  CHECK(js::stringify(*member("x")) == xBefore);

  set.tracks = {{"x", "[]"}, {"opacity", R"([{"t":0,"value":0,"id":"k1"},{"t":1,"value":100,"id":"k1"}])"}};
  REQUIRE(is_ok(h.run(cmd(set))));
  CHECK_FALSE(member("x").has_value());
  const js::Json o = *member("opacity");
  REQUIRE(o.arr().size() == 2);
  CHECK(o.arr()[0].at("id").str() == "k1");
  CHECK(o.arr()[1].at("id").str() != "k1");

  for (const char* bad : {"nope", "{}", R"([{"t":"a","value":1}])", R"([{"t":0}])"}) {
    set.tracks = {{"x", bad}};
    const auto r = h.run(cmd(set));
    REQUIRE_FALSE(is_ok(r));
    CHECK(std::get<api::EngineError>(r.outcome.v).code == api::ErrorCode::invalid_argument);
  }
  set.layer = "nope";
  set.tracks.clear();
  CHECK_FALSE(is_ok(h.run(cmd(set))));
}
