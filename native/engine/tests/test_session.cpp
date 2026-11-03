// The document core as a black box: requests in, responses/events/frames out.
// Semantics are the TypeScript LocalEngine's (crossEngine.test.ts replays the
// same requests into both engines); these tests pin the engine-level
// contracts on their own, fast, without Node: history exactness, batches,
// gestures, events-before-response, every command answering, the catalog,
// expressions, the clock and determinism.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <set>
#include <thread>

#include "core/catalog_data.hpp"
#include "core/frame_keys.hpp"
#include "core/props.hpp"
#include "core/ptree.hpp"
#include "core/timeline.hpp"
#include "invariants.hpp"
#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;
using Catch::Approx;

namespace {

constexpr api::Time kSec = 705'600'000;

api::ItemId make_comp(Harness& h, std::uint32_t num = 30) {
  api::CreateComposition c;
  c.settings.name = "Test";
  c.settings.width = 1920;
  c.settings.height = 1080;
  c.settings.frame_rate = api::Rational{num, 1};
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
  return result_as<T>(std::get<api::QueryResult>(r.outcome.v));
}

api::Value value_of(Harness& h, const api::LayerId& layer, const std::string& path, api::Time t, bool evaluated = true) {
  api::GetPropertyValues q;
  q.props = {api::PropRef{layer, path}};
  q.time = t;
  q.evaluated = evaluated;
  return query<api::PropertyValues>(h, qry(q)).values.at(0).value;
}

api::Response set_prop(Harness& h, const api::LayerId& layer, const std::string& path, api::Value v,
                       std::optional<api::Time> t = std::nullopt) {
  api::SetProperty s;
  s.prop = {layer, path};
  s.value = std::move(v);
  s.time = t;
  return h.run(cmd(s));
}

api::Response add_key(Harness& h, const api::LayerId& layer, const std::string& path, api::Time t, api::Value v,
                      std::optional<api::Easing> easing = std::nullopt) {
  api::AddKeyframes a;
  api::KeyframeInsert k;
  k.prop = {layer, path};
  k.time = t;
  k.value = std::move(v);
  k.easing = easing;
  a.keys.push_back(std::move(k));
  return h.run(cmd(a));
}

template <class E>
std::vector<E> events_of(const std::vector<api::Event>& ev) {
  std::vector<E> out;
  for (const auto& e : ev) {
    if (const auto* x = std::get_if<E>(&e.v)) out.push_back(*x);
  }
  return out;
}

api::HistoryState history(Harness& h) { return query<api::HistoryState>(h, qry(api::GetHistory{})); }

double scalar_of(const api::Value& v) { return std::get<double>(v.v); }
api::Vec2 vec2_of(const api::Value& v) { return std::get<api::Vec2>(v.v); }

}  // namespace

TEST_CASE("session: handshake", "[session]") {
  SECTION("welcome carries the version and revision") {
    Harness h;
    const api::Welcome w = h.hello();
    REQUIRE(w.engine == "premation-engine");
    REQUIRE(w.protocol_major == api::kProtocolMajor);
    REQUIRE(w.revision == 0);
    REQUIRE(std::find(w.capabilities.begin(), w.capabilities.end(), "frames.channel") != w.capabilities.end());
  }
  SECTION("frame routes are offered only when the sink has them") {
    // The simulated sink has neither shared slots nor a pixel stream: asking
    // for both gets neither (the GPU sink offers frames.copy when fd 5 is open).
    Harness h;
    const api::Welcome w = h.hello(api::kProtocolMajor, {"frames.sharedTexture", "frames.copy"});
    REQUIRE(std::find(w.capabilities.begin(), w.capabilities.end(), "frames.sharedTexture") == w.capabilities.end());
    REQUIRE(std::find(w.capabilities.begin(), w.capabilities.end(), "frames.copy") == w.capabilities.end());
  }
  SECTION("a different major is refused with Goodbye{versionMismatch}") {
    Harness h;
    (void)h.hello(api::kProtocolMajor + 1);
    REQUIRE(h.session.finished());
    REQUIRE(std::get<api::Goodbye>(h.messages.back().v).reason == api::GoodbyeReason::version_mismatch);
  }
  SECTION("a request before Hello closes with protocolError") {
    Harness h;
    (void)h.run(cmd(api::Undo{}));
    REQUIRE(h.session.finished());
    REQUIRE(std::get<api::Goodbye>(h.messages.back().v).reason == api::GoodbyeReason::protocol_error);
  }
  SECTION("garbage before Hello closes with protocolError") {
    Harness h;
    const std::vector<std::uint8_t> junk = {0xFF, 0x01, 0x02};
    h.session.on_frame(junk, h.now);
    REQUIRE(h.session.finished());
  }
}

TEST_CASE("session: a new session is New Project: comp_root, revision 0, empty history", "[session]") {
  Harness h;
  (void)h.hello();
  const auto doc = query<api::DocumentSnapshot>(h, qry(api::GetDocument{false, false}));
  REQUIRE(doc.revision == 0);
  REQUIRE(doc.comps.size() == 1);
  REQUIRE(doc.comps[0].id == "comp_root");
  REQUIRE(doc.comps[0].settings.width == 1920);
  REQUIRE(doc.layers.empty());
  REQUIRE(history(h).entries.empty());
  std::string why;
  REQUIRE(document_consistent(h.session.document(), why));
}

TEST_CASE("session: create, edit, events, revisions", "[session]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  REQUIRE(h.session.revision() == 1);
  const std::size_t mark = h.messages.size();
  const auto layer = make_layer(h, comp);
  REQUIRE(h.session.revision() == 2);

  const auto batches = h.batches_since(mark);
  REQUIRE(batches.size() == 1);  // ONE batch per request (§8.1)
  REQUIRE(batches[0].from_revision == 1);
  REQUIRE(batches[0].to_revision == 2);
  const auto ev = batches[0].events;
  REQUIRE(events_of<api::LayersChangedEvent>(ev).at(0).layers.at(0).id == layer);
  REQUIRE(events_of<api::LayerOrderChangedEvent>(ev).at(0).layers == std::vector<api::LayerId>{layer});
  REQUIRE_FALSE(events_of<api::PropertiesChangedEvent>(ev).empty());
  REQUIRE(events_of<api::HistoryChangedEvent>(ev).at(0).undo_label == "New Solid Layer");
  // Events arrive BEFORE the response, so an awaiting client sees its mirror updated.
  REQUIRE(h.messages[mark].kind() == api::EngineMessage::Kind::events);

  REQUIRE(is_ok(set_prop(h, layer, "transform/position", vec2(100, 50))));
  REQUIRE(vec2_of(value_of(h, layer, "transform/position", 0)) == api::Vec2{100, 50});

  SECTION("type mismatch, unknown path, unknown layer change nothing") {
    const auto rev = h.session.revision();
    const DocState before = state_of(h.session.document());
    REQUIRE(is_error(set_prop(h, layer, "transform/position", scalar(1)), api::ErrorCode::type_mismatch));
    REQUIRE(is_error(set_prop(h, layer, "transform/nope", scalar(1)), api::ErrorCode::not_found));
    REQUIRE(is_error(set_prop(h, "layer_999", "transform/opacity", scalar(1)), api::ErrorCode::not_found));
    REQUIRE(h.session.revision() == rev);
    REQUIRE(state_of(h.session.document()) == before);
  }
  SECTION("setting the same value is not an edit") {
    const auto rev = h.session.revision();
    const auto entries = history(h).entries.size();
    REQUIRE(is_ok(set_prop(h, layer, "transform/position", vec2(100, 50))));
    REQUIRE(h.session.revision() == rev);
    REQUIRE(history(h).entries.size() == entries);
  }
  SECTION("baseRevision conflict") {
    api::SetProperty s;
    s.prop = {layer, "transform/rotation"};
    s.value = scalar(10);
    REQUIRE(is_error(h.run(cmd(s), h.session.revision() - 1), api::ErrorCode::conflict));
    REQUIRE(is_ok(h.run(cmd(s), h.session.revision())));
  }
}

TEST_CASE("session: keyframes interpolate on the keyframe axis", "[session][eval]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  REQUIRE(is_ok(add_key(h, layer, "transform/position", 0, vec2(0, 0), api::Easing::linear)));
  REQUIRE(is_ok(add_key(h, layer, "transform/position", 1 * kSec, vec2(100, 200), api::Easing::linear)));
  const auto mid = vec2_of(value_of(h, layer, "transform/position", kSec / 2));
  REQUIRE(mid.x == Approx(50.0));
  REQUIRE(mid.y == Approx(100.0));
  REQUIRE(vec2_of(value_of(h, layer, "transform/position", 3 * kSec)) == api::Vec2{100, 200});

  SECTION("an animated property refuses a static write; a timed write upserts a key") {
    REQUIRE(is_error(set_prop(h, layer, "transform/position", vec2(1, 1)), api::ErrorCode::animated));
    REQUIRE(is_ok(set_prop(h, layer, "transform/position", vec2(7, 7), kSec)));
    REQUIRE(vec2_of(value_of(h, layer, "transform/position", kSec)) == api::Vec2{7, 7});
  }
  SECTION("hold easing holds until the next key") {
    REQUIRE(is_ok(add_key(h, layer, "transform/rotation", 0, scalar(0), api::Easing::hold)));
    REQUIRE(is_ok(add_key(h, layer, "transform/rotation", kSec, scalar(90))));
    REQUIRE(scalar_of(value_of(h, layer, "transform/rotation", kSec - kSec / 30)) == 0.0);
    REQUIRE(scalar_of(value_of(h, layer, "transform/rotation", kSec)) == 90.0);
  }
  SECTION("the stopwatch off keeps the value at its time; keepStatic keeps the value stored under the keys") {
    REQUIRE(is_ok(set_prop(h, layer, "transform/opacity", scalar(40))));
    REQUIRE(is_ok(add_key(h, layer, "transform/opacity", 0, scalar(10), api::Easing::linear)));
    REQUIRE(is_ok(add_key(h, layer, "transform/opacity", kSec, scalar(90), api::Easing::linear)));
    api::SetAnimated off;
    off.prop = {layer, "transform/opacity"};
    off.animated = false;
    off.time = kSec / 2;
    off.keep_static = true;
    REQUIRE(is_ok(h.run(cmd(off))));
    REQUIRE(scalar_of(value_of(h, layer, "transform/opacity", 0)) == 40.0);
    REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
    off.keep_static.reset();
    REQUIRE(is_ok(h.run(cmd(off))));
    REQUIRE(scalar_of(value_of(h, layer, "transform/opacity", 0)) == Approx(50.0));
  }
  SECTION("keyframe ids are stable and minted k<n>") {
    api::GetKeyframes q;
    q.props = {api::PropRef{layer, "transform/position"}};
    const auto sets = query<api::KeyframeSets>(h, qry(q)).sets;
    REQUIRE(sets.at(0).keyframes.size() == 2);
    for (const auto& k : sets[0].keyframes) REQUIRE(k.id.rfind('k', 0) == 0);
  }
}

TEST_CASE("session: expressions evaluate through motion_expr", "[session][eval]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  api::SetExpression e;
  e.prop = {layer, "transform/rotation"};
  e.source = "time * 30";
  e.enabled = true;
  REQUIRE(is_ok(h.run(cmd(e))));
  REQUIRE(scalar_of(value_of(h, layer, "transform/rotation", kSec)) == Approx(30.0));
  REQUIRE(scalar_of(value_of(h, layer, "transform/rotation", 2 * kSec)) == Approx(60.0));
  // evaluated=false is the pre-expression value.
  REQUIRE(scalar_of(value_of(h, layer, "transform/rotation", kSec, false)) == 0.0);
  api::SetExpressionEnabled off;
  off.props = {api::PropRef{layer, "transform/rotation"}};
  off.enabled = false;
  REQUIRE(is_ok(h.run(cmd(off))));
  REQUIRE(scalar_of(value_of(h, layer, "transform/rotation", kSec)) == 0.0);
}

TEST_CASE("session: every layer kind has a property tree whose values all read", "[session][catalog]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  api::ImportFiles imp;
  imp.files = {api::ImportFile{"C:/m/clip.mp4", false, {}, {}, false, {}}};
  const auto clip = result_as<api::ItemList>(h.run(cmd(imp))).items.at(0);
  std::size_t props = 0;
  for (const auto kind : {api::LayerKind::null, api::LayerKind::solid, api::LayerKind::shape, api::LayerKind::rectangle,
                          api::LayerKind::ellipse, api::LayerKind::polygon, api::LayerKind::path, api::LayerKind::text,
                          api::LayerKind::camera, api::LayerKind::light, api::LayerKind::group, api::LayerKind::particle,
                          api::LayerKind::model3d, api::LayerKind::adjustment, api::LayerKind::video}) {
    api::CreateLayer c;
    c.comp = comp;
    c.kind = kind;
    if (kind == api::LayerKind::video) c.source = clip;
    const auto r = h.run(cmd(c));
    INFO("kind " << static_cast<int>(kind));
    REQUIRE(is_ok(r));
    const auto layer = result_layer(r);
    api::GetPropertyTree t;
    t.layer = layer;
    const auto tree = query<api::PropertyTree>(h, qry(t));
    REQUIRE_FALSE(tree.nodes.empty());
    api::GetPropertyValues q;
    q.time = kSec / 2;
    q.evaluated = true;
    for (const auto& n : tree.nodes) {
      if (n.kind == api::PropertyKind::property) q.props.push_back(api::PropRef{layer, n.path});
    }
    REQUIRE(query<api::PropertyValues>(h, qry(q)).values.size() == q.props.size());
    props += q.props.size();
  }
  REQUIRE(props > 150);
}

TEST_CASE("session: undo and redo restore the document exactly", "[session][history]") {
  Harness h;
  (void)h.hello();
  const DocState start = state_of(h.session.document());
  const auto comp = make_comp(h);
  const auto a = make_layer(h, comp);
  const auto b = make_layer(h, comp, api::LayerKind::text);
  REQUIRE(is_ok(set_prop(h, a, "transform/rotation", scalar(45))));
  REQUIRE(is_ok(add_key(h, b, "transform/opacity", 0, scalar(0))));
  REQUIRE(is_ok(add_key(h, b, "transform/opacity", kSec, scalar(100))));
  api::AddEffect fx;
  fx.layers = {a};
  fx.effect = "gaussian-blur";
  REQUIRE(is_ok(h.run(cmd(fx))));
  api::SetParent p;
  p.layers = {b};
  p.parent = a;
  p.keep_world_transform = true;
  REQUIRE(is_ok(h.run(cmd(p))));
  api::DeleteLayers del;
  del.layers = {a};
  REQUIRE(is_ok(h.run(cmd(del))));
  const DocState end = state_of(h.session.document());

  const auto rev = h.session.revision();
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  REQUIRE(h.session.revision() == rev + 1);  // undo is a revision too
  REQUIRE(h.session.document().node(a) != nullptr);

  while (history(h).position > 0) REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  INFO(first_difference(state_of(h.session.document()), start));
  REQUIRE(state_of(h.session.document()) == start);
  REQUIRE(is_error(h.run(cmd(api::Undo{})), api::ErrorCode::nothing_to_undo));

  while (history(h).can_redo) REQUIRE(is_ok(h.run(cmd(api::Redo{}))));
  INFO(first_difference(state_of(h.session.document()), end));
  REQUIRE(state_of(h.session.document()) == end);

  SECTION("jumpToHistory is one revision and lands on the same state") {
    const auto r0 = h.session.revision();
    api::JumpToHistory j;
    j.position = 0;
    REQUIRE(is_ok(h.run(cmd(j))));
    REQUIRE(h.session.revision() == r0 + 1);
    REQUIRE(state_of(h.session.document()) == start);
  }
  SECTION("a new layer never reuses an id") {
    const auto c = make_layer(h, comp);
    REQUIRE(c != a);
    REQUIRE(c != b);
  }
}

TEST_CASE("session: a failed batch changes nothing; a good batch is one entry", "[session][history]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  const auto rev = h.session.revision();
  const DocState before = state_of(h.session.document());

  api::SetProperty ok1;
  ok1.prop = {layer, "transform/rotation"};
  ok1.value = scalar(30);
  api::SetProperty bad;
  bad.prop = {layer, "transform/rotation"};
  bad.value = doc::v_color(1, 0, 0, 1);  // a vec2 would be read leniently (its x), as the TS does
  const auto r = h.batch("Twist", {cmd(ok1), cmd(bad)});
  REQUIRE(is_error(r, api::ErrorCode::type_mismatch));
  REQUIRE(std::get<api::EngineError>(r.outcome.v).command_index == 1U);
  REQUIRE(h.session.revision() == rev);
  REQUIRE(state_of(h.session.document()) == before);

  api::SetProperty ok2 = ok1;
  ok2.prop.path = "transform/opacity";
  ok2.value = scalar(50);
  REQUIRE(is_ok(h.batch("Twist", {cmd(ok1), cmd(ok2)})));
  REQUIRE(h.session.revision() == rev + 1);
  REQUIRE(history(h).entries.back().label == "Twist");
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  REQUIRE(state_of(h.session.document()) == before);

  SECTION("controls cannot be batched") {
    REQUIRE(is_error(h.batch("x", {cmd(api::Pause{})}), api::ErrorCode::invalid_argument));
  }
}

TEST_CASE("session: a gesture is one entry; cancel restores", "[session][history]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  const auto entriesBefore = history(h).entries.size();
  const DocState before = state_of(h.session.document());

  auto begin = [&](const char* label) {
    const auto r = h.run(cmd(api::BeginGesture{label}));
    REQUIRE(is_ok(r));
    return result_as<api::GestureRef>(r).gesture;
  };
  const auto g = begin("Move");
  for (int i = 1; i <= 60; ++i) REQUIRE(is_ok(set_prop(h, layer, "transform/position", vec2(i, i))));
  REQUIRE(is_error(h.run(cmd(api::Undo{})), api::ErrorCode::gesture_open));
  REQUIRE(is_ok(h.run(cmd(api::EndGesture{g, true}))));
  const auto hist = history(h);
  REQUIRE(hist.entries.size() == entriesBefore + 1);
  REQUIRE(hist.entries.back().label == "Move");
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  REQUIRE(state_of(h.session.document()) == before);

  const auto g2 = begin("Drag");
  REQUIRE(is_ok(set_prop(h, layer, "transform/rotation", scalar(12))));
  REQUIRE(is_ok(h.run(cmd(api::EndGesture{g2, false}))));
  REQUIRE(state_of(h.session.document()) == before);
  REQUIRE(is_error(h.run(cmd(api::EndGesture{g2, true})), api::ErrorCode::no_gesture));
}

namespace {

/// Default-construct alternative I of the command union and send it.
template <std::size_t I>
void send_default(Harness& h, std::set<std::string>& unsupported) {
  api::Command c;
  c.v.template emplace<I>();
  const auto r = h.run(c);
  if (is_error(r, api::ErrorCode::unsupported)) unsupported.insert(doc::registry().commandNames.at(static_cast<std::uint32_t>(c.kind())));
}

template <std::size_t... I>
void send_all(Harness& h, std::set<std::string>& unsupported, std::index_sequence<I...> /*unused*/) {
  (send_default<I>(h, unsupported), ...);
}

}  // namespace

TEST_CASE("session: every command answers; only what the TS engine refuses is unsupported", "[session]") {
  Harness h;
  (void)h.hello();
  (void)make_layer(h, "comp_root");
  std::set<std::string> unsupported;
  send_all(h, unsupported, std::make_index_sequence<std::variant_size_v<decltype(api::Command{}.v)>>{});
  // layers.ts answers these three `unsupported` (engine-evaluated conversions
  // the TS engine does not implement either); the transport/viewport/render
  // controls that need the GPU process answer on the frame channel instead.
  const std::set<std::string> tsRefuses = {"convertLayer", "separateLayer", "autoTrace",
                                           // B4 round 8: the polygon-boolean probe is the conversion geometry's
                                           "createLiveMerge",
                                           // a non-.motion path: .aep import is the editor's importer (misc.ts)
                                           "importProject"};
  for (const auto& u : unsupported) {
    INFO("unsupported: " << u);
    std::string kind;
    for (const auto& [id, name] : doc::registry().commandNames) {
      if (name == u) kind = doc::registry().commandKinds.at(id);
    }
    REQUIRE((tsRefuses.contains(u) || kind != "edit"));
  }
  std::string why;
  REQUIRE(document_consistent(h.session.document(), why));
}

TEST_CASE("session: an undecodable request is answered with its seq", "[session]") {
  Harness h;
  (void)h.hello();
  // EngineMessage{ request{ seq=42, body = <garbage field> } }
  const std::vector<std::uint8_t> bytes = {0x1A, 0x05, 0x08, 0x2A, 0x12, 0x01, 0xFF};
  REQUIRE(peek_request_seq(bytes) == std::optional<api::Seq>(42));
  h.session.on_frame(bytes, h.now);
  const auto& last = std::get<api::Response>(h.messages.back().v);
  REQUIRE(last.seq == 42);
  REQUIRE(last.outcome.kind() == api::Outcome::Kind::error);
  REQUIRE_FALSE(h.session.finished());
}

TEST_CASE("session: the clock emits frames at comp fps and drops rather than drifts", "[session][transport]") {
  Harness h(64);
  (void)h.hello();
  const auto comp = make_comp(h, 30);
  (void)make_layer(h, comp);
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  api::SetViewport v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  const std::size_t base = h.sink.submitted();
  REQUIRE(base >= 1);  // the viewport opening renders the current frame

  REQUIRE(is_ok(h.run(cmd(api::Play{1.0, api::PlayRange::all, {}, false, false, {}, false}))));
  REQUIRE(h.session.playing());
  // 1 s of 1 ms ticks → 30 frames (+ the one play renders at once).
  for (int i = 0; i < 1000; ++i) {
    h.release_all();
    h.advance(std::chrono::milliseconds(1));
  }
  REQUIRE(h.sink.submitted() - base == 31);
  REQUIRE(h.session.time() == 30 * (kSec / 30));

  SECTION("a late clock skips frames and counts them") {
    h.advance(std::chrono::milliseconds(500));  // one tick, 15 frames due
    const auto ready = h.frames_ready();
    REQUIRE(h.session.time() == 45 * (kSec / 30));
    REQUIRE(ready.back().frame == 45);
    REQUIRE(ready.back().dropped == 14);
  }
  SECTION("pause stops the clock; seek renders the new time") {
    REQUIRE(is_ok(h.run(cmd(api::Pause{false}))));
    const auto n = h.sink.submitted();
    h.advance(std::chrono::seconds(1));
    REQUIRE(h.sink.submitted() == n);
    h.release_all();
    REQUIRE(is_ok(h.run(cmd(api::Seek{2 * kSec, api::SeekMode::exact}))));
    REQUIRE(h.sink.submitted() == n + 1);
    REQUIRE(h.frames_ready().back().time == 2 * kSec);
  }
  SECTION("loop wraps, once stops at the last frame") {
    h.advance(std::chrono::seconds(10));  // past the 10 s end
    REQUIRE(h.session.playing());         // loop is the default
    REQUIRE(h.session.time() < 10 * kSec);
    REQUIRE(is_ok(h.run(cmd(api::SetLoop{api::LoopMode::once}))));
    REQUIRE(is_ok(h.run(cmd(api::Seek{9 * kSec, api::SeekMode::exact}))));
    h.advance(std::chrono::seconds(2));
    REQUIRE_FALSE(h.session.playing());
    REQUIRE(h.session.time() == 299 * (kSec / 30));
  }
}

TEST_CASE("session: playback builds no frame a pending job would supersede", "[session][transport][p3]") {
  Harness h;  // 3 slots
  (void)h.hello();
  const auto comp = make_comp(h, 30);
  (void)make_layer(h, comp);
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  api::SetViewport v;
  v.viewport = 1;
  v.width = 320;
  v.height = 180;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  h.release_all();
  const std::size_t base = h.sink.submitted();
  REQUIRE(is_ok(h.run(cmd(api::Play{1.0, api::PlayRange::all, {}, false, false, {}, false}))));
  // A host that holds every slot for a second: three frames fill the ring, a
  // fourth waits as the pending job, and every later tick builds nothing.
  for (int i = 0; i < 1000; ++i) h.advance(std::chrono::milliseconds(1));
  REQUIRE(h.sink.submitted() - base == 4);
  REQUIRE(h.session.time() == 30 * (kSec / 30));

  // The slots come back: the pending frame draws, and the next clock frame is
  // built again, carrying every frame the viewport skipped as dropped.
  h.release_all();
  h.advance(std::chrono::milliseconds(34));
  h.release_all();
  const auto ready = h.frames_ready();
  REQUIRE(h.sink.submitted() - base == 5);
  REQUIRE(ready.back().frame == 31);
  std::uint32_t dropped = 0;
  for (const auto& r : ready) dropped += r.dropped;
  REQUIRE(dropped >= 26);
}

TEST_CASE("session: a looping play that dropped frames stores the range at the wrap, then plays it", "[session][transport][p9]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h, 30);
  (void)make_layer(h, comp);
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  api::SetViewport v;
  v.viewport = 1;
  v.width = 320;
  v.height = 180;
  v.device_pixel_ratio = 1;
  REQUIRE(is_ok(h.run(cmd(v))));
  h.release_all();
  api::Play play;
  play.rate = 1;
  play.range = api::PlayRange::custom;
  play.custom = api::TimeRange{0, 10 * (kSec / 30)};
  REQUIRE(is_ok(h.run(cmd(play))));
  // A slow first pass: one late tick skips frames.
  h.release_all();
  h.advance(std::chrono::milliseconds(150));
  h.release_all();
  // Run to just before the wrap (10 frames ≈ 333 ms), then 1 ms ticks across it.
  for (int i = 0; i < 175; ++i) {
    h.release_all();
    h.advance(std::chrono::milliseconds(1));
  }
  const std::size_t mark = h.frames_ready().size();
  for (int i = 0; i < 25; ++i) {
    h.release_all();
    h.advance(std::chrono::milliseconds(1));
  }
  const auto ready = h.frames_ready();
  std::vector<std::int64_t> frames;
  for (std::size_t i = mark; i < ready.size(); ++i) frames.push_back(ready[i].frame);
  // 25 ms of real-time play is at most one frame; a fill stores one per tick.
  REQUIRE(frames.size() >= 8);
  for (std::size_t i = 1; i < frames.size() && frames[i] != 0; ++i) REQUIRE(frames[i] == frames[i - 1] + 1);
  REQUIRE(h.session.playing());
}

TEST_CASE("session: a play-once that dropped frames makes the next Play store the range first", "[session][transport][p9]") {
  Harness h(64);
  (void)h.hello();
  const auto comp = make_comp(h, 30);
  (void)make_layer(h, comp);
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  api::SetViewport v;
  v.viewport = 1;
  v.width = 320;
  v.height = 180;
  v.device_pixel_ratio = 1;
  REQUIRE(is_ok(h.run(cmd(v))));
  REQUIRE(is_ok(h.run(cmd(api::SetLoop{api::LoopMode::once}))));
  h.release_all();
  api::Play play;
  play.rate = 1;
  play.range = api::PlayRange::custom;
  play.custom = api::TimeRange{0, 10 * (kSec / 30)};
  REQUIRE(is_ok(h.run(cmd(play))));
  // A slow pass: one late tick skips frames, then the play runs out.
  h.release_all();
  h.advance(std::chrono::milliseconds(150));
  for (int i = 0; i < 400; ++i) {
    h.release_all();
    h.advance(std::chrono::milliseconds(1));
  }
  REQUIRE_FALSE(h.session.playing());

  // The next Play stores frames 0..9 one per tick (no clock), then plays from 0.
  const std::size_t mark = h.frames_ready().size();
  REQUIRE(is_ok(h.run(cmd(play))));
  for (int i = 0; i < 12; ++i) {
    h.release_all();
    h.advance(std::chrono::milliseconds(1));
  }
  const auto ready = h.frames_ready();
  std::vector<std::int64_t> frames;
  for (std::size_t i = mark; i < ready.size(); ++i) frames.push_back(ready[i].frame);
  REQUIRE(frames.size() >= 11);
  for (std::int64_t f = 0; f < 10; ++f) REQUIRE(frames[static_cast<std::size_t>(f)] == f);
  REQUIRE(frames[10] == 0);
  REQUIRE(h.session.playing());
  // The pass out of the cache drops nothing and stops on the last frame.
  for (int i = 0; i < 500; ++i) {
    h.release_all();
    h.advance(std::chrono::milliseconds(1));
  }
  REQUIRE_FALSE(h.session.playing());
  const auto after = h.frames_ready();
  std::uint32_t dropped = 0;
  for (std::size_t i = mark + 10; i < after.size(); ++i) dropped += after[i].dropped;
  REQUIRE(dropped == 0);

  // A third Play, with no drops behind it, plays at once.
  const std::size_t mark2 = h.frames_ready().size();
  REQUIRE(is_ok(h.run(cmd(play))));
  h.release_all();
  h.advance(std::chrono::milliseconds(1));
  const auto third = h.frames_ready();
  REQUIRE(third.size() > mark2);
  REQUIRE(h.session.playing());
  REQUIRE(third[mark2].frame == 0);
  h.release_all();
  h.advance(std::chrono::milliseconds(34));
  REQUIRE(h.frames_ready().back().frame == 1);
}

TEST_CASE("session: cacheFirst stores every frame of the range, then plays it", "[session][transport][d4]") {
  Harness h(64);
  (void)h.hello();
  const auto comp = make_comp(h, 30);
  (void)make_layer(h, comp);
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  api::SetViewport v;
  v.viewport = 1;
  v.width = 320;
  v.height = 180;
  v.device_pixel_ratio = 1;
  REQUIRE(is_ok(h.run(cmd(v))));
  REQUIRE(is_ok(h.run(cmd(api::SetLoop{api::LoopMode::once}))));

  api::Play play;
  play.rate = 1;
  play.range = api::PlayRange::custom;
  play.custom = api::TimeRange{0, 5 * (kSec / 30)};
  play.cache_first = true;
  const auto before = h.frames_ready().size();
  REQUIRE(is_ok(h.run(cmd(play))));
  // The play request's tick stores frame 0. Further ticks store the rest, then start the clock.
  for (int i = 0; i < 8; ++i) {
    h.release_all();
    h.advance(std::chrono::milliseconds(1));
  }
  const auto ready = h.frames_ready();
  std::vector<std::int64_t> frames;
  for (std::size_t i = before; i < ready.size(); ++i) frames.push_back(ready[i].frame);
  REQUIRE(frames.size() >= 6);
  REQUIRE(frames[0] == 0);
  REQUIRE(frames[1] == 1);
  REQUIRE(frames[2] == 2);
  REQUIRE(frames[3] == 3);
  REQUIRE(frames[4] == 4);
  REQUIRE(frames[5] == 0);  // playback starts on the first stored frame
  for (std::size_t i = before; i < before + 5; ++i) REQUIRE(ready[i].dropped == 0);

  for (int i = 0; i < 250; ++i) {
    h.release_all();
    h.advance(std::chrono::milliseconds(1));
  }
  REQUIRE_FALSE(h.session.playing());
  const auto after = h.frames_ready();
  std::uint32_t dropped = 0;
  for (std::size_t i = before + 5; i < after.size(); ++i) dropped += after[i].dropped;
  REQUIRE(dropped == 0);
  REQUIRE(h.session.time() == 4 * (kSec / 30));
}

TEST_CASE("session: cacheOnly stores the range, then stops with the playhead where it was", "[session][transport][d4]") {
  Harness h(64);
  (void)h.hello();
  const auto comp = make_comp(h, 30);
  (void)make_layer(h, comp);
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  api::SetViewport v;
  v.viewport = 1;
  v.width = 320;
  v.height = 180;
  v.device_pixel_ratio = 1;
  REQUIRE(is_ok(h.run(cmd(v))));
  api::Seek seek;
  seek.time = 2 * (kSec / 30);
  REQUIRE(is_ok(h.run(cmd(seek))));

  api::Play play;
  play.rate = 1;
  play.range = api::PlayRange::custom;
  play.custom = api::TimeRange{0, 5 * (kSec / 30)};
  play.cache_first = true;
  play.cache_only = true;
  const auto before = h.frames_ready().size();
  REQUIRE(is_ok(h.run(cmd(play))));
  for (int i = 0; i < 40; ++i) {
    h.release_all();
    h.advance(std::chrono::milliseconds(1));
  }
  REQUIRE_FALSE(h.session.playing());
  const auto ready = h.frames_ready();
  std::vector<std::int64_t> frames;
  for (std::size_t i = before; i < ready.size(); ++i) frames.push_back(ready[i].frame);
  // Frames 0..4 stored in order, then the frame the playhead was on — and nothing played.
  REQUIRE(frames.size() == 6);
  for (std::int64_t i = 0; i < 5; ++i) REQUIRE(frames[static_cast<std::size_t>(i)] == i);
  REQUIRE(frames[5] == 2);
  REQUIRE(h.session.time() == 2 * (kSec / 30));

  // A seek during the fill ends it: no playback follows.
  REQUIRE(is_ok(h.run(cmd(play))));
  h.release_all();
  h.advance(std::chrono::milliseconds(1));
  seek.time = 1 * (kSec / 30);
  REQUIRE(is_ok(h.run(cmd(seek))));
  REQUIRE_FALSE(h.session.playing());
  REQUIRE(h.session.time() == 1 * (kSec / 30));
}

TEST_CASE("session: a full ring drops frames and never blocks; stale releases are ignored", "[session][frames]") {
  Harness h(3);
  (void)h.hello();
  const auto layer = make_layer(h, "comp_root");
  api::SetViewport v;
  v.viewport = 1;
  v.width = 320;
  v.height = 180;
  v.device_pixel_ratio = 2.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  REQUIRE(h.sink.config().width == 640);
  REQUIRE(is_ok(h.run(cmd(api::Play{1.0, api::PlayRange::all, {}, false, false, {}, false}))));
  h.advance(std::chrono::seconds(1));  // nobody releases
  for (int i = 0; i < 10; ++i) h.advance(std::chrono::milliseconds(40));
  REQUIRE(h.frames_ready().size() == 3);  // the ring, and not one more
  // The core kept going: edits still apply and answer immediately.
  REQUIRE(is_ok(set_prop(h, layer, "transform/rotation", scalar(5))));
  h.sink.release(99, 0);  // another generation: ignored
  REQUIRE(h.frames_ready().size() == 3);
  const auto first = h.frames_ready().front();
  h.sink.release(first.generation, first.slot);
  const auto after = h.frames_ready();
  REQUIRE(after.size() == 4);
  REQUIRE(after.back().dropped > 0);
  REQUIRE(after.back().slot == first.slot);
}

TEST_CASE("session: every viewport is its own surface with its own ring", "[session][frames][viewports]") {
  Harness h(3);
  (void)h.hello();
  (void)make_layer(h, "comp_root");
  const auto viewport = [](std::uint32_t id, std::uint32_t w, std::uint32_t hgt) {
    api::SetViewport v;
    v.viewport = id;
    v.width = w;
    v.height = hgt;
    v.device_pixel_ratio = 1.0;
    return v;
  };
  REQUIRE(is_ok(h.run(cmd(viewport(1, 320, 180)))));
  REQUIRE(is_ok(h.run(cmd(viewport(257, 200, 100)))));  // a pop-out window's viewport
  REQUIRE(h.sink.config(1).width == 320);
  REQUIRE(h.sink.config(257).width == 200);
  std::vector<api::FrameSlots> rings;
  for (const auto& m : h.frameMsgs) {
    if (const auto* s = std::get_if<api::FrameSlots>(&m.v)) rings.push_back(*s);
  }
  REQUIRE(rings.size() == 2);
  REQUIRE(rings[0].viewport == 1);
  REQUIRE(rings[1].viewport == 257);
  REQUIRE(rings[0].generation != rings[1].generation);  // a release names its ring
  // An edit renders every open viewport, each at its own size.
  const std::size_t before = h.frames_ready().size();
  REQUIRE(is_ok(h.run(cmd(viewport(1, 320, 180)))));  // unchanged: still a frame
  const auto frames = h.frames_ready();
  REQUIRE(frames.size() >= before + 2);
  bool saw1 = false;
  bool saw257 = false;
  for (const auto& f : frames) {
    if (f.viewport == 1) saw1 = f.width == 320 && f.generation == rings[0].generation;
    if (f.viewport == 257) saw257 = f.width == 200 && f.generation == rings[1].generation;
  }
  REQUIRE(saw1);
  REQUIRE(saw257);
  // Closing one leaves the other: an empty ring for 257, frames for 1 only.
  REQUIRE(is_ok(h.run(cmd(api::CloseViewport{257}))));
  const auto& last = h.frameMsgs.back();
  const auto* closed = std::get_if<api::FrameSlots>(&last.v);
  REQUIRE(closed != nullptr);
  REQUIRE(closed->viewport == 257);
  REQUIRE(closed->handles.empty());
  h.release_all();
  const std::size_t n = h.frames_ready().size();
  REQUIRE(is_ok(h.run(cmd(viewport(1, 320, 180)))));
  const auto after = h.frames_ready();
  REQUIRE(after.size() > n);
  for (std::size_t i = n; i < after.size(); ++i) REQUIRE(after[i].viewport == 1);
}

TEST_CASE("session: the frame scene follows the document", "[session][eval]") {
  Harness h;
  (void)h.hello();
  const auto layer = make_layer(h, "comp_root");
  api::SetViewport v;
  v.viewport = 1;
  v.width = 1920;
  v.height = 1080;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  REQUIRE(is_ok(set_prop(h, layer, "transform/position", vec2(300, 400))));
  const FrameScene s1 = h.sink.last_scene();
  REQUIRE(s1.quads.size() == 1);
  REQUIRE(is_ok(set_prop(h, layer, "transform/position", vec2(310, 420))));
  const FrameScene s2 = h.sink.last_scene();
  REQUIRE(s2.quads.size() == 1);
  // A move is a pure translation of the quad's affine.
  REQUIRE(s2.quads[0].affine[4] - s1.quads[0].affine[4] == Approx(10.0F));
  REQUIRE(s2.quads[0].affine[5] - s1.quads[0].affine[5] == Approx(20.0F));
  REQUIRE(is_ok(set_prop(h, layer, "transform/opacity", scalar(0))));
  REQUIRE(h.sink.last_scene().quads.empty());
}

TEST_CASE("session: the same request stream produces the same bytes", "[session][determinism]") {
  auto script = [](Harness& h) {
    (void)h.hello();
    const auto comp = make_comp(h);
    const auto layer = make_layer(h, comp);
    (void)add_key(h, layer, "transform/position", 0, vec2(0, 0));
    (void)add_key(h, layer, "transform/position", kSec, vec2(500, 500));
    api::SetExpression e;
    e.prop = {layer, "transform/rotation"};
    e.source = "wiggle(2, 10)";
    e.enabled = true;
    (void)h.run(cmd(e));
    api::SetViewport v;
    v.viewport = 1;
    v.width = 800;
    v.height = 450;
    v.device_pixel_ratio = 1.0;
    (void)h.run(cmd(v));
    (void)h.run(cmd(api::Play{1.0, api::PlayRange::all, {}, false, false, {}, false}));
    for (int i = 0; i < 100; ++i) {
      h.release_all();
      h.advance(std::chrono::milliseconds(7));
    }
    (void)h.ask(qry(api::GetDocument{true, true}));
    (void)h.run(cmd(api::Undo{}));
    (void)h.run(cmd(api::Seek{kSec / 3, api::SeekMode::exact}));
  };
  Harness a;
  Harness b;
  script(a);
  script(b);
  REQUIRE(a.decodeFailures == 0);
  REQUIRE(a.wireLog == b.wireLog);
  REQUIRE(a.frameMsgs == b.frameMsgs);
}

// ── G2: engine-internal correctness (both engines; crossEngine.test.ts replays the same) ──

namespace {

std::vector<api::Time> key_times(Harness& h, const api::LayerId& layer, const std::string& path) {
  api::GetKeyframes q;
  q.props = {api::PropRef{layer, path}};
  const auto sets = query<api::KeyframeSets>(h, qry(q)).sets;
  std::vector<api::Time> out;
  if (!sets.empty()) {
    for (const auto& k : sets.at(0).keyframes) out.push_back(k.time);
  }
  return out;
}

}  // namespace

TEST_CASE("session: gesture ids live in the id state and survive New Project", "[session][history][g2]") {
  Harness h;
  (void)h.hello();
  auto begin = [&] {
    const auto r = h.run(cmd(api::BeginGesture{"g"}));
    REQUIRE(is_ok(r));
    const auto g = result_as<api::GestureRef>(r).gesture;
    REQUIRE(is_ok(h.run(cmd(api::EndGesture{g, true}))));
    return g;
  };
  REQUIRE(begin() == 1U);
  REQUIRE(begin() == 2U);
  REQUIRE(is_ok(h.run(cmd(api::NewProject{}))));
  // A session counter: a gesture id is never reused while the engine lives.
  REQUIRE(begin() == 3U);
}

TEST_CASE("session: a client reconnect (second Hello) commits the gesture the old client left open",
          "[session][history][gesture]") {
  // The editor page reloaded while the engine process lived on: nothing closed
  // stdin, so on_disconnect never ran, and the AI turn's gesture held the one
  // slot. The new page's Hello must settle it (§5.1: COMMIT) or the new page
  // can never edit ("Another edit is still in progress").
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  const auto entriesBefore = history(h).entries.size();
  const DocState before = state_of(h.session.document());

  const auto r = h.run(cmd(api::BeginGesture{"AI: slide the title"}));
  REQUIRE(is_ok(r));
  const auto g = result_as<api::GestureRef>(r).gesture;
  REQUIRE(is_ok(set_prop(h, layer, "transform/position", vec2(40, 40))));
  REQUIRE(h.session.gesture_open());

  // The reloaded page says Hello again on the same pipe and gets a FRESH Welcome
  // (Harness::hello returns the first one ever sent: read the newest here).
  const std::size_t sentBefore = h.messages.size();
  (void)h.hello();
  std::optional<api::Welcome> fresh;
  for (std::size_t i = sentBefore; i < h.messages.size(); ++i) {
    if (h.messages[i].kind() == api::EngineMessage::Kind::welcome) fresh = std::get<api::Welcome>(h.messages[i].v);
  }
  REQUIRE(fresh.has_value());
  REQUIRE(fresh->engine == "premation-engine");
  REQUIRE(fresh->revision == h.session.revision());
  REQUIRE_FALSE(h.session.gesture_open());

  // The old gesture became ONE committed entry: nothing the user saw is lost, and it undoes as one step.
  const auto hist = history(h);
  REQUIRE(hist.entries.size() == entriesBefore + 1);
  REQUIRE(hist.entries.back().label == "AI: slide the title");
  REQUIRE(is_error(h.run(cmd(api::EndGesture{g, true})), api::ErrorCode::no_gesture));

  // The new client can open its own gesture, edit, and close it.
  const auto r2 = h.run(cmd(api::BeginGesture{"Move"}));
  REQUIRE(is_ok(r2));
  const auto g2 = result_as<api::GestureRef>(r2).gesture;
  REQUIRE(g2 != g);
  REQUIRE(is_ok(set_prop(h, layer, "transform/position", vec2(50, 50))));
  REQUIRE(is_ok(h.run(cmd(api::EndGesture{g2, true}))));
  REQUIRE(history(h).entries.size() == entriesBefore + 2);
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  REQUIRE(state_of(h.session.document()) == before);

  // A reconnect with nothing open changes no history.
  (void)h.hello();
  REQUIRE(history(h).entries.size() == entriesBefore + 2);
  REQUIRE(is_ok(h.run(cmd(api::BeginGesture{"again"}))));
  REQUIRE(is_ok(h.run(cmd(api::EndGesture{0, true}))));
}

TEST_CASE("session: applyPreset keys land at the composition time on an offset layer", "[session][g2]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  REQUIRE(is_ok(h.run(cmd(api::MoveLayersInTime{{layer}, kSec, false}))));
  REQUIRE(is_ok(h.run(cmd(api::ApplyPreset{{layer}, "Fade In", 2 * kSec, {}}))));
  REQUIRE(key_times(h, layer, "transform/opacity") == std::vector<api::Time>{2 * kSec, 2 * kSec + kSec / 2});
}

TEST_CASE("session: a key before the layer's in point reads back at its own time, not the in point", "[session][g2]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  REQUIRE(is_ok(add_key(h, layer, "transform/opacity", kSec / 2, scalar(0), api::Easing::linear)));
  REQUIRE(is_ok(add_key(h, layer, "transform/opacity", 2 * kSec, scalar(100), api::Easing::linear)));
  api::SetLayerTiming st;
  st.items = {api::LayerTimingPatch{layer, kSec, std::nullopt, std::nullopt, std::nullopt}};
  REQUIRE(is_ok(h.run(cmd(st))));
  // It evaluates at 0.5 s (the in point shows the interpolated 1/3 of the way)
  // and getKeyframes says so — clamping it to the clip's edge said 1 s.
  REQUIRE(scalar_of(value_of(h, layer, "transform/opacity", kSec)) == Approx(100.0 / 3));
  REQUIRE(key_times(h, layer, "transform/opacity") == std::vector<api::Time>{kSec / 2, 2 * kSec});
}

TEST_CASE("session: a key before the in point of a shifted layer moves by the delta it is given", "[session][g2]") {
  // The layer starts at 1 s and is trimmed to 2 s, so its key at 1.5 s lies
  // outside every clip. Read through the clip and written back through the
  // same clip, it moves by exactly the delta — writing outside the clip
  // without the clip's offset sent it a whole second away.
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  REQUIRE(is_ok(h.run(cmd(api::MoveLayersInTime{{layer}, kSec, false}))));
  REQUIRE(is_ok(add_key(h, layer, "transform/opacity", 3 * kSec / 2, scalar(0), api::Easing::linear)));
  REQUIRE(is_ok(add_key(h, layer, "transform/opacity", 3 * kSec, scalar(100), api::Easing::linear)));
  api::SetLayerTiming st;
  st.items = {api::LayerTimingPatch{layer, 2 * kSec, std::nullopt, std::nullopt, std::nullopt}};
  REQUIRE(is_ok(h.run(cmd(st))));
  REQUIRE(key_times(h, layer, "transform/opacity") == std::vector<api::Time>{3 * kSec / 2, 3 * kSec});
  REQUIRE(scalar_of(value_of(h, layer, "transform/opacity", 2 * kSec)) == Approx(100.0 / 3));
  api::GetKeyframes q;
  q.props = {api::PropRef{layer, "transform/opacity"}};
  const auto keys = query<api::KeyframeSets>(h, qry(q)).sets.at(0).keyframes;
  REQUIRE(is_ok(h.run(cmd(api::MoveKeyframes{{keys.at(0).id}, -kSec / 2}))));
  CHECK(key_times(h, layer, "transform/opacity") == std::vector<api::Time>{kSec, 3 * kSec});
  // Evaluated before the in point on the layer's own time, as in AE.
  CHECK(scalar_of(value_of(h, layer, "transform/opacity", kSec)) == Approx(0.0));
}

TEST_CASE("session: a jump that restores a removed layer AND un-keys it sends the empty list", "[session][events][g2]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_layer(h, comp);
  const auto position = history(h).position;
  REQUIRE(is_ok(add_key(h, layer, "transform/opacity", kSec, scalar(40))));
  REQUIRE(is_ok(h.run(cmd(api::DeleteLayers{{layer}}))));
  const std::size_t from = h.messages.size();
  REQUIRE(is_ok(h.run(cmd(api::JumpToHistory{position}))));
  bool emptied = false;
  for (const auto& e : events_of<api::KeyframesChangedEvent>(h.events_since(from))) {
    for (const auto& s : e.sets) {
      if (s.prop.layer == layer && s.prop.path == "transform/opacity" && s.keyframes.empty()) emptied = true;
    }
  }
  REQUIRE(emptied);
  REQUIRE(key_times(h, layer, "transform/opacity").empty());
}

TEST_CASE("session: a batch creating two compositions undoes both", "[session][history][g2]") {
  Harness h;
  (void)h.hello();
  const DocState before = state_of(h.session.document());
  api::CreateComposition a;
  a.settings.name = "One";
  api::CreateComposition b;
  b.settings.name = "Two";
  REQUIRE(is_ok(h.batch("Two comps", {cmd(a), cmd(b)})));
  REQUIRE(state_of(h.session.document()) != before);
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  REQUIRE(state_of(h.session.document()) == before);
}

// Hidden ([.bench]): where the time of a 10,000-value getPropertyValues goes.
//   engine_tests.exe "[query-bench]"
TEST_CASE("bench: getPropertyValues over 2,000 layers", "[.bench][query-bench]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  std::vector<api::Command> creates;
  for (int i = 0; i < 2000; ++i) {
    api::CreateLayer c;
    c.comp = comp;
    c.kind = i % 2 ? api::LayerKind::solid : api::LayerKind::shape;
    creates.push_back(cmd(c));
  }
  const auto r = h.batch("Build", creates);
  REQUIRE(is_ok(r));
  std::vector<std::string> layers;
  for (const auto& id : h.session.document().nodes().keys()) {
    const auto* n = h.session.document().node(id);
    if (n->parent && *n->parent == comp) layers.push_back(id);
  }
  api::GetPropertyValues q;
  for (const auto& l : layers) {
    for (const char* p : {"transform/anchorPoint", "transform/position", "transform/scale", "transform/rotation", "transform/opacity"}) q.props.push_back({l, p});
  }
  q.evaluated = false;
  using C = std::chrono::steady_clock;
  auto ms = [](C::time_point a) { return std::chrono::duration<double, std::milli>(C::now() - a).count(); };
  auto t0 = C::now();
  REQUIRE(is_ok(h.ask(qry(q))));
  const double query = ms(t0);
  t0 = C::now();
  REQUIRE(is_ok(h.ask(qry(q))));
  const double again = ms(t0);
  t0 = C::now();
  std::size_t n = 0;
  for (const auto& l : layers) n += doc::catalog_for(h.session.document(), l).props.size();
  const double catalogs = ms(t0);
  t0 = C::now();
  for (const auto& l : layers) n += doc::build_static_property_tree(h.session.document(), l).size();
  const double trees = ms(t0);
  std::vector<doc::Catalog> cats;
  for (const auto& l : layers) cats.push_back(doc::catalog_for(h.session.document(), l));
  const char* paths[] = {"transform/anchorPoint", "transform/position", "transform/scale", "transform/rotation", "transform/opacity"};
  t0 = C::now();
  for (std::size_t i = 0; i < layers.size(); ++i) for (const char* pp : paths) n += doc::is_animated(h.session.document(), layers[i], doc::require_binding(cats[i], pp)) ? 1 : 0;
  const double anim = ms(t0);
  t0 = C::now();
  for (std::size_t i = 0; i < layers.size(); ++i) for (const char* pp : paths) n += doc::read_static(h.session.document(), layers[i], doc::require_binding(cats[i], pp)).kind() == api::Value::Kind::none ? 0 : 1;
  const double stat = ms(t0);
  WARN("is_animated x10000 " << anim << " ms; read_static x10000 " << stat << " ms");
  WARN("query " << query << " ms (again at the same revision " << again << " ms); 2000 catalogs " << catalogs << " ms; 2000 static trees " << trees << " ms (" << n << ")");
}

TEST_CASE("session: composition JSON fields are stored, read back, cleared and undone", "[session][comp]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const DocState before = state_of(h.session.document());
  api::SetCompositionSettings s;
  s.comp = comp;
  s.patch.responsive_time = R"({"authoredDurationSec":6,"protectedRegions":[{"start":0,"end":1.5}]})";
  s.patch.template_fields = R"([{"id":"title","label":"Title"}])";
  s.patch.background_paint = R"({"type":"linear","angle":90,"stops":[{"id":"s0","offset":0,"color":"#ff0000"}]})";
  REQUIRE(is_ok(h.run(cmd(s))));
  api::GetComposition q;
  q.comp = comp;
  const auto info = query<api::CompositionDetails>(h, qry(q)).comp.settings;
  REQUIRE(info.responsive_time.has_value());
  CHECK(info.responsive_time->find("authoredDurationSec") != std::string::npos);
  REQUIRE(info.template_fields.has_value());
  CHECK(info.template_fields->find("\"title\"") != std::string::npos);
  REQUIRE(info.background_paint.has_value());
  CHECK(info.background_paint->find("linear") != std::string::npos);

  // Undo of a root-only change restates the settings (the mirror follows it).
  const std::size_t mark = h.messages.size();
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  CHECK(state_of(h.session.document()) == before);
  const auto undone = h.batches_since(mark);
  REQUIRE(undone.size() == 1);
  const auto changed = events_of<api::CompositionChangedEvent>(undone[0].events);
  REQUIRE(changed.size() == 1);
  CHECK_FALSE(changed[0].settings.template_fields.has_value());
  REQUIRE(is_ok(h.run(cmd(api::Redo{}))));

  // A template-fields-only edit restates the settings too.
  const std::size_t mark2 = h.messages.size();
  api::SetCompositionSettings only;
  only.comp = comp;
  only.patch.template_fields = R"([{"id":"body","label":"Body"}])";
  REQUIRE(is_ok(h.run(cmd(only))));
  const auto set = events_of<api::CompositionChangedEvent>(h.batches_since(mark2).at(0).events);
  REQUIRE(set.size() == 1);
  CHECK(set[0].settings.template_fields.value_or("").find("\"body\"") != std::string::npos);

  api::SetCompositionSettings clear;
  clear.comp = comp;
  clear.patch.responsive_time = "";
  clear.patch.template_fields = "";
  clear.patch.background_paint = "";
  REQUIRE(is_ok(h.run(cmd(clear))));
  const auto cleared = query<api::CompositionDetails>(h, qry(q)).comp.settings;
  CHECK_FALSE(cleared.responsive_time.has_value());
  CHECK_FALSE(cleared.template_fields.has_value());
  CHECK_FALSE(cleared.background_paint.has_value());

  api::SetCompositionSettings bad;
  bad.comp = comp;
  bad.patch.template_fields = R"({"not":"an array"})";
  CHECK(is_error(h.run(cmd(bad)), api::ErrorCode::invalid_argument));
}

TEST_CASE("session: motion blur and colour management are undoable document records", "[session][f2]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const DocState before = state_of(h.session.document());

  const std::size_t mark = h.messages.size();
  api::SetMotionBlur mb;
  mb.patch.enabled = false;
  mb.patch.shutter_angle = 800;  // clamped to 720, After Effects' limit
  mb.patch.samples_per_frame = 1;  // clamped to 2
  REQUIRE(is_ok(h.run(cmd(mb))));
  const auto batches = h.batches_since(mark);
  REQUIRE(batches.size() == 1);
  const auto mbe = events_of<api::MotionBlurChangedEvent>(batches[0].events);
  REQUIRE(mbe.size() == 1);
  CHECK(mbe[0].motion_blur.shutter_angle == Approx(720));
  CHECK(mbe[0].motion_blur.samples_per_frame == 2);
  CHECK(mbe[0].motion_blur.enabled == std::optional<bool>(false));
  // Every composition reports the record.
  CHECK_FALSE(events_of<api::CompositionChangedEvent>(batches[0].events).empty());
  api::GetComposition q;
  q.comp = comp;
  CHECK(query<api::CompositionDetails>(h, qry(q)).comp.settings.motion_blur.shutter_angle == Approx(720));

  api::SetColorManagement cm;
  cm.patch.working_space = api::RenderWorkingSpace::aces_cg;
  cm.patch.display_transform = api::RenderDisplayTransform::pq;
  cm.patch.bit_depth = 32;
  REQUIRE(is_ok(h.run(cmd(cm))));
  api::GetDocument gd;
  const auto snap = query<api::DocumentSnapshot>(h, qry(gd));
  CHECK(snap.color_management.working_space == api::RenderWorkingSpace::aces_cg);
  CHECK(snap.color_management.display_transform == api::RenderDisplayTransform::pq);
  CHECK(snap.color_management.bit_depth == 32);
  CHECK(snap.motion_blur.shutter_angle == Approx(720));

  api::SetColorManagement bad;
  bad.patch.bit_depth = 8;
  CHECK(is_error(h.run(cmd(bad)), api::ErrorCode::invalid_argument));

  // The per-comp route writes the same record with the same clamps.
  api::SetCompositionSettings s;
  s.comp = comp;
  s.patch.motion_blur = api::MotionBlurSettings{-5, 900, 64, 500, true};
  REQUIRE(is_ok(h.run(cmd(s))));
  const auto after = query<api::DocumentSnapshot>(h, qry(gd)).motion_blur;
  CHECK(after.shutter_angle == Approx(0));
  CHECK(after.shutter_phase == Approx(360));
  CHECK(after.samples_per_frame == 32);
  CHECK(after.adaptive_sample_limit == 128);

  for (int i = 0; i < 3; ++i) REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  CHECK(state_of(h.session.document()) == before);
}

TEST_CASE("setViewport: each viewport renders its own 3D view, baked into its config", "[session][viewport]") {
  Harness h(64);
  (void)h.hello();
  const auto comp = make_comp(h, 30);
  (void)make_layer(h, comp);
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  api::SetViewport v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  // Absent = the composition's camera.
  CHECK(h.sink.config(1).view == "active");
  CHECK_FALSE(h.sink.config(1).customView.has_value());

  v.view = "top";
  REQUIRE(is_ok(h.run(cmd(v))));
  CHECK(h.sink.config(1).view == "top");

  // A second pane keeps its own view: a custom orbit about a point of interest.
  api::SetViewport v2 = v;
  v2.viewport = 2;
  v2.view = "custom";
  api::CustomView cv;
  cv.yaw = 30;
  cv.pitch = -20;
  cv.distance = 900;
  cv.poi = api::Vec3{100, 50, 0};
  v2.custom_view = cv;
  REQUIRE(is_ok(h.run(cmd(v2))));
  CHECK(h.sink.config(1).view == "top");
  const ViewportConfig c2 = h.sink.config(2);
  CHECK(c2.view == "custom");
  REQUIRE(c2.customView.has_value());
  CHECK(c2.customView->yaw == 30);
  CHECK(c2.customView->pitch == -20);
  CHECK(c2.customView->distance == 900);
  CHECK(c2.customView->poi == std::array<double, 3>{100, 50, 0});

  // '' means the composition's camera too; an orbit sent without view = 'custom' is dropped.
  v2.view = "";
  REQUIRE(is_ok(h.run(cmd(v2))));
  CHECK(h.sink.config(2).view == "active");
  CHECK_FALSE(h.sink.config(2).customView.has_value());
}

TEST_CASE("setViewport: the Layer panel's viewport renders one layer, optionally at a held time", "[session][viewport]") {
  Harness h(64);
  (void)h.hello();
  const auto comp = make_comp(h, 30);
  const auto layer = make_layer(h, comp);
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  api::SetViewport v;
  v.viewport = 3;
  v.width = 200;
  v.height = 100;
  v.device_pixel_ratio = 1.0;
  v.layer = layer;
  v.layer_render_effects = false;
  const std::size_t before = h.sink.submitted();
  REQUIRE(is_ok(h.run(cmd(v))));
  // Rendered (it used to be kept but not rendered), with the layer on its config.
  CHECK(h.sink.submitted() > before);
  const ViewportConfig c = h.sink.config(3);
  CHECK(c.layer == layer);
  CHECK_FALSE(c.layerRenderEffects);
  CHECK_FALSE(c.time.has_value());
  CHECK_FALSE(c.layerSourceTime.has_value());

  // A held time: the frame renders there, not at the clock (still at 0).
  v.time = 15 * (kSec / 30);
  v.layer_source_time = 2 * (kSec / 30);
  REQUIRE(is_ok(h.run(cmd(v))));
  CHECK(h.sink.config(3).time == 15 * (kSec / 30));
  CHECK(h.sink.config(3).layerSourceTime == 2 * (kSec / 30));
  REQUIRE_FALSE(h.frames_ready().empty());
  CHECK(h.frames_ready().back().time == 15 * (kSec / 30));
  CHECK(h.session.time() == 0);

  // A source time without a held time is meaningless and dropped; an unknown layer is refused.
  v.time.reset();
  REQUIRE(is_ok(h.run(cmd(v))));
  CHECK_FALSE(h.sink.config(3).time.has_value());
  CHECK_FALSE(h.sink.config(3).layerSourceTime.has_value());
  v.layer = "nope";
  CHECK_FALSE(is_ok(h.run(cmd(v))));
}

// ── 3D perf program: U1 clipToComp, U3 renderer World key, A2 render stats ──

TEST_CASE("session: setViewport clipToComp reaches the viewport's config (U1 Extended Viewer)", "[session][frames][u1]") {
  Harness h;
  (void)h.hello();
  api::SetViewport v;
  v.viewport = 1;
  v.width = 800;
  v.height = 450;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  CHECK(h.sink.config(1).clipToComp);  // absent = clipped (AE's comp panel)
  v.clip_to_comp = false;
  REQUIRE(is_ok(h.run(cmd(v))));
  CHECK_FALSE(h.sink.config(1).clipToComp);
  v.clip_to_comp = true;
  REQUIRE(is_ok(h.run(cmd(v))));
  CHECK(h.sink.config(1).clipToComp);
}

TEST_CASE("session: the composition World JSON keeps the Renderer block and undoes it (U3)", "[session][comp][u3]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  api::SetCompositionSettings s;
  s.comp = comp;
  s.patch.world = R"({"renderer":{"shadowMapSize":2048,"shadowLightCap":2,"dofQuality":"high","msaa":1},"ssao":{"enabled":true,"radius":40,"intensity":1,"quality":"half"}})";
  REQUIRE(is_ok(h.run(cmd(s))));
  api::GetComposition q;
  q.comp = comp;
  const auto info = query<api::CompositionDetails>(h, qry(q)).comp.settings;
  REQUIRE(info.world.has_value());
  CHECK(info.world->find("\"renderer\"") != std::string::npos);
  CHECK(info.world->find("shadowMapSize") != std::string::npos);
  CHECK(info.world->find("2048") != std::string::npos);
  CHECK(info.world->find("\"dofQuality\"") != std::string::npos);
  CHECK(info.world->find("\"msaa\"") != std::string::npos);
  CHECK(info.world->find("\"ssao\"") != std::string::npos);
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  const auto undone = query<api::CompositionDetails>(h, qry(q)).comp.settings;
  CHECK((!undone.world.has_value() || undone.world->find("renderer") == std::string::npos));
}

TEST_CASE("session: getRenderStats answers the render thread's VRAM and the last slot-size switch (A2)", "[session][stats][a2]") {
  Harness h;
  (void)h.hello();
  RenderCounters c;
  c.vramBytes = 123456789;
  c.decodeMs = 2.5;
  const double nowUs = static_cast<double>(std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::system_clock::now().time_since_epoch()).count()) / 1000.0;
  c.slotSwitchEpochUs = nowUs - 1500000;  // 1.5 s ago
  c.slotSwitchMs = 42;
  h.sink.set_counters(c);
  const auto st = query<api::RenderStats>(h, qry(api::GetRenderStats{}));
  CHECK(st.vram_bytes == 123456789);
  CHECK(st.decode_ms == Approx(2.5));
  REQUIRE(st.last_slot_switch_ago_ms.has_value());
  CHECK(*st.last_slot_switch_ago_ms >= 1400);
  CHECK(*st.last_slot_switch_ago_ms < 60000);
  REQUIRE(st.slot_switch_ms.has_value());
  CHECK(*st.slot_switch_ms == Approx(42));
  // Never switched: the fields are absent, not zero.
  h.sink.set_counters(RenderCounters{});
  const auto none = query<api::RenderStats>(h, qry(api::GetRenderStats{}));
  CHECK(none.vram_bytes == 0);
  CHECK_FALSE(none.last_slot_switch_ago_ms.has_value());
  CHECK_FALSE(none.slot_switch_ms.has_value());
}

// ── cached playback without a build (core/frame_keys.hpp, render/coverage_ledger.hpp) ──

namespace {

/// A frame builder that only counts: the Session draws C2's quads for its frames.
class CountingBuilder final : public FrameBuilder {
 public:
  std::shared_ptr<BuiltFrame> build(const doc::Document& /*d*/, const doc::EditorView& /*view*/, const doc::ExprEnv& /*expr*/,
                                    doc::ExprCache& /*cache*/, std::string_view /*comp*/, api::Time /*time*/,
                                    const ViewportConfig& /*viewport*/, bool /*playing*/,
                                    std::vector<api::LayerError>& /*errors*/) override {
    ++built;
    return nullptr;
  }
  int built = 0;
};

constexpr api::Time kFrame30 = kSec / 30;

/// The cached frames of the active comp as frame indices (getCacheCoverage, 30 fps).
std::vector<std::int64_t> cached_frames(Harness& h) {
  const api::CacheCoverage c = query<api::CacheCoverage>(h, qry(api::GetCacheCoverage{}));
  std::vector<std::int64_t> out;
  for (const api::CacheRange& r : c.ram) {
    for (api::Time t = r.start; t < r.end; t += kFrame30) out.push_back(t / kFrame30);
  }
  return out;
}

bool cached_range(Harness& h, std::int64_t first, std::int64_t end) {
  const std::vector<std::int64_t> frames = cached_frames(h);
  for (std::int64_t f = first; f < end; ++f) {
    if (std::find(frames.begin(), frames.end(), f) == frames.end()) return false;
  }
  return true;
}

bool none_cached(Harness& h, std::int64_t first, std::int64_t end) {
  const std::vector<std::int64_t> frames = cached_frames(h);
  for (std::int64_t f = first; f < end; ++f) {
    if (std::find(frames.begin(), frames.end(), f) != frames.end()) return false;
  }
  return true;
}

/// Plays the custom range [0, seconds) once, a millisecond per tick, releasing every slot.
void play_once(Harness& h, double seconds) {
  REQUIRE(is_ok(h.run(cmd(api::SetLoop{api::LoopMode::once}))));
  api::Play play;
  play.rate = 1;
  play.range = api::PlayRange::custom;
  play.custom = api::TimeRange{0, static_cast<api::Time>(seconds * static_cast<double>(kSec))};
  REQUIRE(is_ok(h.run(cmd(play))));
  const int ticks = static_cast<int>(seconds * 1000) + 100;
  for (int i = 0; i < ticks; ++i) {
    h.release_all();
    h.advance(std::chrono::milliseconds(1));
  }
  REQUIRE_FALSE(h.session.playing());
}

}  // namespace

TEST_CASE("frame keys: the index's layer clock is comp_to_keyframe_time's, bars and stretch included", "[session][cache][keys]") {
  Harness h(64);
  (void)h.hello();
  const auto comp = make_comp(h, 30);
  const api::LayerId plain = make_layer(h, comp);
  const api::LayerId timed = make_layer(h, comp);
  const api::LayerId stretched = make_layer(h, comp);
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  // Keys on every layer (a stretched layer's clock is anchored on its keys' span).
  for (const api::LayerId& l : {plain, timed, stretched}) {
    api::AddKeyframes a;
    for (int k = 0; k < 3; ++k) {
      api::KeyframeInsert ins;
      ins.prop = {l, "transform/position"};
      ins.time = k * kSec;
      ins.value = vec2(100.0 * k, 0);
      ins.easing = api::Easing::linear;
      a.keys.push_back(std::move(ins));
    }
    REQUIRE(is_ok(h.run(cmd(a))));
  }
  api::SetLayerTiming timing;
  api::LayerTimingPatch p;
  p.layer = timed;
  p.in_point = 2 * kSec;
  p.out_point = 7 * kSec;
  p.start_time = kSec / 2;
  timing.items.push_back(p);
  REQUIRE(is_ok(h.run(cmd(timing))));
  api::TimeStretchLayers stretch;
  stretch.layers = {stretched};
  stretch.stretch = 2;  // a factor: the layer plays at half speed
  REQUIRE(is_ok(h.run(cmd(stretch))));

  doc::FrameKeyIndex index;
  REQUIRE(index.rebuild(h.session.document(), h.session.view(), comp, ""));
  REQUIRE(index.indexed());
  REQUIRE(index.frames() == 300);
  for (const api::LayerId& l : {plain, timed, stretched}) {
    for (std::int64_t f = 0; f < 300; f += 7) {
      const std::optional<double> mine = index.layer_time(l, f);
      REQUIRE(mine.has_value());
      const double theirs = doc::comp_to_keyframe_time(h.session.document(), h.session.view(), l, static_cast<double>(f) / 30.0);
      CHECK(*mine == Approx(theirs).margin(1e-9));
    }
  }
  // Keys are content: the same document gives the same keys; another frame another key.
  const std::uint64_t k10 = index.key(10);
  CHECK(k10 != 0);
  CHECK(k10 != index.key(11));
  doc::FrameKeyIndex again;
  REQUIRE(again.rebuild(h.session.document(), h.session.view(), comp, ""));
  CHECK(again.key(10) == k10);
  CHECK(index.key(300) == 0);  // outside the comp
}

TEST_CASE("cached playback: the second pass over a range builds nothing; an edit invalidates its span; undo returns the bars",
          "[session][cache][playback]") {
  Harness h(64);
  CountingBuilder builder;
  h.session.set_frame_builder(&builder);
  (void)h.hello();
  const auto comp = make_comp(h, 30);
  const api::LayerId layer = make_layer(h, comp);
  // 21 keys, one every 0.2 s over 4 s.
  api::AddKeyframes a;
  for (int k = 0; k <= 20; ++k) {
    api::KeyframeInsert ins;
    ins.prop = {layer, "transform/position"};
    ins.time = static_cast<api::Time>(k) * (kSec / 5);
    ins.value = vec2(10.0 * k, 0);
    ins.easing = api::Easing::linear;
    a.keys.push_back(std::move(ins));
  }
  REQUIRE(is_ok(h.run(cmd(a))));
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  // The simulated tiers: a frame's content is its index (the builder draws nothing the test can hash).
  h.sink.contentKeyOf = [](const RenderJob& j) { return std::optional<std::uint64_t>(0x1000 + static_cast<std::uint64_t>(j.frame)); };
  api::SetViewport v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));

  // Pass 1: every frame builds, and the bar fills.
  play_once(h, 4.0);
  const int firstPass = builder.built;
  REQUIRE(firstPass >= 120);
  REQUIRE(cached_range(h, 0, 120));
  REQUIRE(h.sink.counters().cacheServed <= 2);  // frame 0 again after the viewport opened on it

  // Pass 2: every frame is presented from the tiers — not one build.
  REQUIRE(is_ok(h.run(cmd(api::Seek{0, api::SeekMode::exact}))));
  const int afterSeek = builder.built;
  play_once(h, 4.0);
  CHECK(builder.built == afterSeek);
  CHECK(h.sink.counters().cacheServed >= 120);
  CHECK(h.sink.counters().cacheMissed == 0);
  CHECK(cached_range(h, 0, 120));

  // An edit to the key at 2.0 s (frame 60): the frames its segments and the
  // blur reach decide — [44, 76) — leave the bar; the rest stays.
  REQUIRE(is_ok(set_prop(h, layer, "transform/position", vec2(999, 0), 2 * kSec)));
  CHECK(cached_range(h, 0, 44));
  CHECK(none_cached(h, 44, 76));
  CHECK(cached_range(h, 76, 120));

  // Undo: the keys are the content they were, every frame is back without a build.
  const int beforeUndo = builder.built;
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  CHECK(cached_range(h, 0, 120));
  CHECK(builder.built <= beforeUndo + 1);  // the undo's own frame at the playhead, at most

  // Redo, then play through: only the changed span builds.
  REQUIRE(is_ok(h.run(cmd(api::Redo{}))));
  REQUIRE(is_ok(h.run(cmd(api::Seek{0, api::SeekMode::exact}))));
  const int beforeRedoPass = builder.built;
  play_once(h, 4.0);
  CHECK(builder.built - beforeRedoPass <= 34);  // [44, 76) is 32 frames (+ the seek's and play's own)
  CHECK(builder.built - beforeRedoPass >= 30);
  CHECK(cached_range(h, 0, 120));

  SECTION("a frame the tiers lost meanwhile is built again, never shown blank") {
    REQUIRE(is_ok(h.run(cmd(api::Seek{0, api::SeekMode::exact}))));
    h.release_all();
    h.sink.held.erase(0x1000 + 10);  // evicted
    const int before = builder.built;
    const auto frames = h.frames_ready().size();
    REQUIRE(is_ok(h.run(cmd(api::Seek{10 * kFrame30, api::SeekMode::exact}))));
    // The cached job missed; the request's tick took the sink's build request and built the frame.
    CHECK(h.sink.counters().cacheMissed == 1);
    CHECK(builder.built == before + 1);
    REQUIRE(h.frames_ready().size() == frames + 1);
    CHECK(h.frames_ready().back().frame == 10);
    CHECK(cached_range(h, 0, 120));
  }
  h.session.set_frame_builder(nullptr);
}

// ── comp-space cache scopes + idle render-ahead (frame_scene.hpp comp_space_frame, Session::idle_prefetch) ──

TEST_CASE("comp-space frame: the geometry follows the comp, not the pane; views that cannot be copied are slot space",
          "[session][cache][compspace]") {
  ViewportConfig v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.zoom = 1;
  v.devicePixelRatio = 1;
  v.panX = 320;  // the comp centre at the pane centre: the comp fills the pane exactly
  v.panY = 180;
  v.open = true;
  const auto cs = comp_space_frame(v, 640, 360);
  REQUIRE(cs);
  CHECK(cs->width == 640);
  CHECK(cs->height == 360);
  CHECK(cs->slotX == 0);
  CHECK(cs->slotY == 0);
  CHECK(cs->phaseX == 0);
  CHECK(cs->zoom == 1);
  CHECK(cs->dpr == 1);
  // A wider pane, the same camera: the same comp-space frame, landing further right.
  ViewportConfig wide = v;
  wide.width = 800;
  const auto cw = comp_space_frame(wide, 640, 360);
  REQUIRE(cw);
  CHECK(cw->width == cs->width);
  CHECK(cw->slotX == 80);
  CHECK(cw->phaseX == cs->phaseX);
  // A pan by whole pixels keeps the phase; by a third of a pixel it does not (quantised to 1/256).
  ViewportConfig panned = v;
  panned.panX = 300;
  CHECK(comp_space_frame(panned, 640, 360)->phaseX == 0);
  CHECK(comp_space_frame(panned, 640, 360)->slotX == 20);
  panned.panX = 300.3333;
  const auto third = comp_space_frame(panned, 640, 360);
  REQUIRE(third);
  CHECK(third->phaseX != 0);
  CHECK(third->phaseX * 256 == std::round(third->phaseX * 256));
  // A zoom off the power-of-two ladder draws the comp at the next tier up (2 x)
  // and the present scales it into the slot: 1.25 and 1.5 share one frame.
  ViewportConfig zoomed = v;
  zoomed.zoom = 1.25;
  const auto z = comp_space_frame(zoomed, 640, 360);
  REQUIRE(z);
  CHECK(z->width == 1280);
  CHECK(z->zoom == 2);
  CHECK(z->dpr == 1);
  CHECK(z->phaseX == 0);
  CHECK(z->present == 0.625);
  CHECK(z->originX == -80);
  zoomed.zoom = 1.5;
  const auto z15 = comp_space_frame(zoomed, 640, 360);
  REQUIRE(z15);
  CHECK(z15->width == z->width);
  CHECK(z15->zoom == z->zoom);
  CHECK(z15->present == 0.75);
  // On the ladder (2 x) it is the exact copy — and 1280 x 720 is four times the slot: slot space.
  zoomed.zoom = 2;
  CHECK_FALSE(comp_space_frame(zoomed, 640, 360));
  // Fit (zoom <= 0): export_view's camera, the comp centred.
  ViewportConfig fit = v;
  fit.zoom = 0;
  fit.width = 1280;
  fit.height = 360;
  const auto f = comp_space_frame(fit, 640, 360);
  REQUIRE(f);
  CHECK(f->width == 640);
  CHECK(f->slotX == 320);
  CHECK(f->zoom == 1);
  // Preview resolution halves the texture.
  ViewportConfig half = v;
  half.resolution = 0.5;
  const auto hf = comp_space_frame(half, 640, 360);
  REQUIRE(hf);
  CHECK(hf->width == 320);
  CHECK(hf->dpr == 0.5);
  // Slot space: a Layer view, a held time, a channel view, the Extended Viewer, a ROI, the ground grid.
  ViewportConfig layer = v;
  layer.layer = "L";
  CHECK_FALSE(comp_space_frame(layer, 640, 360));
  ViewportConfig held = v;
  held.time = 0;
  CHECK_FALSE(comp_space_frame(held, 640, 360));
  ViewportConfig ch = v;
  ch.channel = api::ChannelView::alpha;
  CHECK_FALSE(comp_space_frame(ch, 640, 360));
  ViewportConfig ext = v;
  ext.clipToComp = false;
  CHECK_FALSE(comp_space_frame(ext, 640, 360));
  ViewportConfig roi = v;
  roi.regionOfInterest = api::Rect{0, 0, 10, 10};
  CHECK_FALSE(comp_space_frame(roi, 640, 360));
  ViewportConfig grid = v;
  grid.groundGrid = true;
  CHECK_FALSE(comp_space_frame(grid, 640, 360));
}

TEST_CASE("cache scope: a pane resize or a whole-pixel pan keeps the bar and the no-build path; a zoom does not",
          "[session][cache][compspace]") {
  Harness h(64);
  CountingBuilder builder;
  h.session.set_frame_builder(&builder);
  (void)h.hello();
  const auto comp = make_comp(h, 30);  // 1920 x 1080
  const api::LayerId layer = make_layer(h, comp);
  api::AddKeyframes a;
  for (int k = 0; k <= 10; ++k) {
    api::KeyframeInsert ins;
    ins.prop = {layer, "transform/position"};
    ins.time = static_cast<api::Time>(k) * (kSec / 5);
    ins.value = vec2(10.0 * k, 0);
    ins.easing = api::Easing::linear;
    a.keys.push_back(std::move(ins));
  }
  REQUIRE(is_ok(h.run(cmd(a))));
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  // The simulated tiers: a frame's content is its index AND its comp-space
  // geometry (the real content key mixes the texture size and the camera).
  h.sink.contentKeyOf = [](const RenderJob& j) {
    std::uint64_t k = 0x1000 + static_cast<std::uint64_t>(j.frame);
    if (j.compSpace) k ^= (std::uint64_t{j.compSpace->width} << 40U) ^ (std::uint64_t{j.compSpace->height} << 24U);
    return std::optional<std::uint64_t>(k);
  };
  api::SetViewport v;
  v.viewport = 1;
  v.width = 960;
  v.height = 540;
  v.device_pixel_ratio = 1.0;
  v.zoom = 0.5;  // the whole comp at half size fills the pane
  v.pan = api::Vec2{960, 540};
  REQUIRE(is_ok(h.run(cmd(v))));
  play_once(h, 2.0);
  REQUIRE(cached_range(h, 0, 60));
  const int built = builder.built;

  // A wider pane (the same zoom and pan): the comp pixels are the same, the bar stays.
  v.width = 1200;
  REQUIRE(is_ok(h.run(cmd(v))));
  CHECK(cached_range(h, 0, 60));
  CHECK(builder.built == built);  // the frame at the playhead came from the map, no build
  // A pan by whole pixels: the same.
  v.pan = api::Vec2{900, 540};
  REQUIRE(is_ok(h.run(cmd(v))));
  CHECK(cached_range(h, 0, 60));
  CHECK(builder.built == built);
  // Played again at the new size: nothing builds.
  REQUIRE(is_ok(h.run(cmd(api::Seek{0, api::SeekMode::exact}))));
  play_once(h, 2.0);
  CHECK(builder.built == built);
  CHECK(cached_range(h, 0, 60));

  // A zoom is other pixels: the bar empties and the frames build again.
  v.zoom = 0.25;
  REQUIRE(is_ok(h.run(cmd(v))));
  CHECK(none_cached(h, 0, 59));  // only the playhead's frame (59) drew under the new scope
  REQUIRE(is_ok(h.run(cmd(api::Seek{0, api::SeekMode::exact}))));
  play_once(h, 2.0);
  CHECK(builder.built > built + 50);
  CHECK(cached_range(h, 0, 60));
  // And back to the first zoom: the frames are still there.
  v.zoom = 0.5;
  REQUIRE(is_ok(h.run(cmd(v))));
  CHECK(cached_range(h, 0, 60));
  h.session.set_frame_builder(nullptr);
}

TEST_CASE("idle render-ahead: a stopped transport fills the range from the playhead; any command stops it",
          "[session][cache][prefetch]") {
  Harness h(64);
  CountingBuilder builder;
  h.session.set_frame_builder(&builder);
  (void)h.hello();
  const auto comp = make_comp(h, 30);
  const api::LayerId layer = make_layer(h, comp);
  api::AddKeyframes a;
  for (int k = 0; k <= 10; ++k) {
    api::KeyframeInsert ins;
    ins.prop = {layer, "transform/position"};
    ins.time = static_cast<api::Time>(k) * (kSec / 5);
    ins.value = vec2(10.0 * k, 0);
    ins.easing = api::Easing::linear;
    a.keys.push_back(std::move(ins));
  }
  REQUIRE(is_ok(h.run(cmd(a))));
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  h.sink.contentKeyOf = [](const RenderJob& j) { return std::optional<std::uint64_t>(0x1000 + static_cast<std::uint64_t>(j.frame)); };
  api::SetViewport v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  // The work area: frames 30-89. The playhead at frame 40.
  api::SetWorkArea wa;
  wa.comp = comp;
  wa.range = api::TimeRange{kSec, 2 * kSec};
  REQUIRE(is_ok(h.run(cmd(wa))));
  REQUIRE(is_ok(h.run(cmd(api::SetLoop{api::LoopMode::once}))));
  REQUIRE(is_ok(h.run(cmd(api::Seek{40 * kFrame30, api::SeekMode::exact}))));
  h.release_all();
  const auto framesShown = h.frames_ready().size();
  const int builtAtRest = builder.built;

  // Nothing for the quiet period.
  for (int i = 0; i < 250; ++i) h.advance(std::chrono::milliseconds(1));
  CHECK(h.sink.prefetched() == 0);
  CHECK(builder.built == builtAtRest);
  // Then a frame every other tick (submitted, then seen answered), forward from the
  // playhead to the end of the work area, then backward to its start.
  for (int i = 0; i < 300; ++i) h.advance(std::chrono::milliseconds(1));
  CHECK(h.sink.prefetched() >= 59);
  CHECK(cached_range(h, 41, 90));
  CHECK(cached_range(h, 30, 40));
  CHECK(none_cached(h, 1, 30));  // frame 0 drew when the viewport opened
  CHECK(none_cached(h, 90, 100));
  // The playhead never moved and no frame was presented.
  CHECK(h.session.time() == 40 * kFrame30);
  CHECK(h.frames_ready().size() == framesShown);
  // Covered: the prefetcher asks for no more wake-ups.
  const std::uint64_t done = h.sink.prefetched();
  for (int i = 0; i < 50; ++i) h.advance(std::chrono::milliseconds(1));
  CHECK(h.sink.prefetched() == done);
  CHECK_FALSE(h.session.next_deadline().has_value());

  // An edit at 2 s invalidates frames around it. The edit's own frame draws
  // (the viewport), then nothing for the quiet period - then the gap fills again.
  REQUIRE(is_ok(set_prop(h, layer, "transform/position", vec2(999, 0), 2 * kSec)));
  CHECK(none_cached(h, 50, 70));
  const std::uint64_t afterEdit = h.sink.prefetched();
  for (int i = 0; i < 250; ++i) h.advance(std::chrono::milliseconds(1));
  CHECK(h.sink.prefetched() == afterEdit);
  for (int i = 0; i < 300; ++i) h.advance(std::chrono::milliseconds(1));
  CHECK(cached_range(h, 30, 90));
  CHECK(h.session.time() == 40 * kFrame30);

  // A sink whose tiers keep nothing: the prefetcher gives up after a few refusals, and rests.
  h.sink.contentKeyOf = nullptr;
  h.sink.held.clear();
  h.sink.prebuild.clear();
  REQUIRE(is_ok(h.run(cmd(api::Seek{45 * kFrame30, api::SeekMode::exact}))));
  const std::uint64_t beforeRest = h.sink.prefetched();
  for (int i = 0; i < 400; ++i) h.advance(std::chrono::milliseconds(1));
  CHECK(h.sink.prefetched() - beforeRest == 3);
  CHECK_FALSE(h.session.next_deadline().has_value());
  h.session.set_frame_builder(nullptr);
}

namespace {
/// A builder used by one prefetch worker thread, read by the test thread.
class AtomicCountingBuilder final : public FrameBuilder {
 public:
  std::shared_ptr<BuiltFrame> build(const doc::Document& /*d*/, const doc::EditorView& /*view*/, const doc::ExprEnv& /*expr*/,
                                    doc::ExprCache& /*cache*/, std::string_view /*comp*/, api::Time /*time*/,
                                    const ViewportConfig& /*viewport*/, bool /*playing*/,
                                    std::vector<api::LayerError>& /*errors*/) override {
    built.fetch_add(1, std::memory_order_relaxed);
    return nullptr;
  }
  std::atomic<int> built{0};
};
}  // namespace

TEST_CASE("idle render-ahead on prefetch workers: the range fills with frames built beside the main worker",
          "[session][cache][prefetch]") {
  Harness h(64);
  CountingBuilder builder;
  AtomicCountingBuilder extraA;
  AtomicCountingBuilder extraB;
  h.session.set_frame_builder(&builder);
  h.session.set_prefetch_builders({&extraA, &extraB});
  (void)h.hello();
  const auto comp = make_comp(h, 30);
  const api::LayerId layer = make_layer(h, comp);
  api::AddKeyframes a;
  for (int k = 0; k <= 10; ++k) {
    api::KeyframeInsert ins;
    ins.prop = {layer, "transform/position"};
    ins.time = static_cast<api::Time>(k) * (kSec / 5);
    ins.value = vec2(10.0 * k, 0);
    ins.easing = api::Easing::linear;
    a.keys.push_back(std::move(ins));
  }
  REQUIRE(is_ok(h.run(cmd(a))));
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  h.sink.contentKeyOf = [](const RenderJob& j) { return std::optional<std::uint64_t>(0x1000 + static_cast<std::uint64_t>(j.frame)); };
  api::SetViewport v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  api::SetWorkArea wa;
  wa.comp = comp;
  wa.range = api::TimeRange{kSec, 2 * kSec};
  REQUIRE(is_ok(h.run(cmd(wa))));
  REQUIRE(is_ok(h.run(cmd(api::Seek{40 * kFrame30, api::SeekMode::exact}))));
  h.release_all();
  const auto framesShown = h.frames_ready().size();
  for (int i = 0; i < 250; ++i) h.advance(std::chrono::milliseconds(1));
  CHECK(h.sink.prefetched() == 0);
  for (int i = 0; i < 400; ++i) h.advance(std::chrono::milliseconds(1));
  CHECK(cached_range(h, 30, 90));
  // The prefetch workers built frames, and no frame was presented for them.
  CHECK(extraA.built.load() + extraB.built.load() > 0);
  CHECK(h.frames_ready().size() == framesShown);
  CHECK(h.session.time() == 40 * kFrame30);
  // An edit still lands (the workers stop at their next layer), and its frame draws.
  REQUIRE(is_ok(set_prop(h, layer, "transform/position", vec2(999, 0), 2 * kSec)));
  CHECK(none_cached(h, 50, 70));
  h.session.set_prefetch_builders({});
  h.session.set_frame_builder(nullptr);
}

namespace {
/// The main builder, held at a gate while closed; past it, it stops as the
/// real builder does at its next layer when its cancel flag is up.
class GatedBuilder final : public FrameBuilder {
 public:
  std::shared_ptr<BuiltFrame> build(const doc::Document& /*d*/, const doc::EditorView& /*view*/, const doc::ExprEnv& /*expr*/,
                                    doc::ExprCache& /*cache*/, std::string_view /*comp*/, api::Time /*time*/,
                                    const ViewportConfig& /*viewport*/, bool /*playing*/,
                                    std::vector<api::LayerError>& /*errors*/) override {
    {
      std::unique_lock<std::mutex> lock(m_);
      ++entered_;
      cv_.notify_all();
      cv_.wait(lock, [this] { return open_; });
    }
    if (cancel_ != nullptr && cancel_->load(std::memory_order_acquire) != 0) throw BuildCancelled{};
    built.fetch_add(1, std::memory_order_relaxed);
    return nullptr;
  }
  void set_cancel_flag(const std::atomic<std::uint32_t>* flag) noexcept override { cancel_ = flag; }
  void close() {
    const std::lock_guard<std::mutex> lock(m_);
    open_ = false;
    entered_ = 0;
  }
  [[nodiscard]] bool entered() {
    const std::lock_guard<std::mutex> lock(m_);
    return entered_ > 0;
  }
  void open() {
    {
      const std::lock_guard<std::mutex> lock(m_);
      open_ = true;
    }
    cv_.notify_all();
  }
  std::atomic<int> built{0};

 private:
  std::mutex m_;
  std::condition_variable cv_;
  bool open_ = true;
  int entered_ = 0;
  const std::atomic<std::uint32_t>* cancel_ = nullptr;
};
}  // namespace

TEST_CASE("idle render-ahead: a prefetch that gave way to a paused viewport frame is built again, not waited for",
          "[session][cache][prefetch]") {
  // A prefetch build gives way to a viewport frame queued behind it
  // (prefetchYield_) and never reaches the sink. When that frame came from no
  // command (here a pixel read of a cached frame; in the app, the redraw the
  // skip itself asked for, through the build worker for its overlays), nothing
  // forgot the prefetch: the prefetcher waited for its answer for good.
  Harness h(64);
  GatedBuilder builder;
  h.session.set_frame_builder(&builder);
  (void)h.hello();
  const auto comp = make_comp(h, 30);
  const api::LayerId layer = make_layer(h, comp);
  api::AddKeyframes a;
  for (int k = 0; k <= 10; ++k) {
    api::KeyframeInsert ins;
    ins.prop = {layer, "transform/position"};
    ins.time = static_cast<api::Time>(k) * (kSec / 5);
    ins.value = vec2(10.0 * k, 0);
    ins.easing = api::Easing::linear;
    a.keys.push_back(std::move(ins));
  }
  REQUIRE(is_ok(h.run(cmd(a))));
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  h.sink.contentKeyOf = [](const RenderJob& j) { return std::optional<std::uint64_t>(0x1000 + static_cast<std::uint64_t>(j.frame)); };
  api::SetViewport v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  api::SetWorkArea wa;
  wa.comp = comp;
  wa.range = api::TimeRange{kSec, 2 * kSec};
  REQUIRE(is_ok(h.run(cmd(wa))));
  REQUIRE(is_ok(h.run(cmd(api::Seek{40 * kFrame30, api::SeekMode::exact}))));
  h.release_all();

  // The quiet period; then the first prefetch (frame 41) is held in the builder.
  builder.close();
  h.drainBuilds = false;
  // Real time too: the prefetch runs on the worker thread, which a loaded machine may not have scheduled yet.
  for (int i = 0; i < 2000 && !builder.entered(); ++i) {
    h.advance(std::chrono::milliseconds(1));
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  const bool held = builder.entered();
  if (!held) builder.open();  // a failed wait never leaves the worker parked (the suite would hang)
  REQUIRE(held);
  // A built frame for the viewport is wanted, with no command: it is queued
  // behind the prefetch, which gives way when it goes on.
  h.sink.want_build(1);
  h.advance(std::chrono::milliseconds(1));
  builder.open();
  h.drainBuilds = true;
  h.session.drain_builds();
  h.release_all();

  // The range still fills, frame 41 with it.
  for (int i = 0; i < 600; ++i) h.advance(std::chrono::milliseconds(1));
  CHECK(cached_range(h, 30, 90));
  CHECK(h.session.time() == 40 * kFrame30);
  h.session.set_frame_builder(nullptr);
}

namespace {
/// A prefetch builder that holds its build until released or cancelled (its cancel flag raised).
class HeldPrefetchBuilder final : public FrameBuilder {
 public:
  std::shared_ptr<BuiltFrame> build(const doc::Document& /*d*/, const doc::EditorView& /*view*/, const doc::ExprEnv& /*expr*/,
                                    doc::ExprCache& /*cache*/, std::string_view /*comp*/, api::Time /*time*/,
                                    const ViewportConfig& /*viewport*/, bool /*playing*/,
                                    std::vector<api::LayerError>& /*errors*/) override {
    started.fetch_add(1, std::memory_order_acq_rel);
    const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (!open.load(std::memory_order_acquire) && std::chrono::steady_clock::now() < until) {
      if (cancel_ != nullptr && cancel_->load(std::memory_order_acquire) != 0) {
        cancelled.fetch_add(1, std::memory_order_acq_rel);
        throw BuildCancelled{};
      }
      std::this_thread::sleep_for(std::chrono::microseconds(200));
    }
    return nullptr;
  }
  void set_cancel_flag(const std::atomic<std::uint32_t>* flag) noexcept override { cancel_ = flag; }
  std::atomic<int> started{0};
  std::atomic<int> cancelled{0};
  std::atomic<bool> open{false};

 private:
  const std::atomic<std::uint32_t>* cancel_ = nullptr;
};
}  // namespace

TEST_CASE("a scrub's frame does not wait for the idle render-ahead build in flight: the prefetch gives way",
          "[session][cache][prefetch]") {
  Harness h(64);
  CountingBuilder builder;
  HeldPrefetchBuilder held;
  h.session.set_frame_builder(&builder);
  h.session.set_prefetch_builders({&held});
  (void)h.hello();
  const auto comp = make_comp(h, 30);
  const api::LayerId layer = make_layer(h, comp);
  api::AddKeyframes a;
  for (int k = 0; k <= 10; ++k) {
    api::KeyframeInsert ins;
    ins.prop = {layer, "transform/position"};
    ins.time = static_cast<api::Time>(k) * (kSec / 5);
    ins.value = vec2(10.0 * k, 0);
    ins.easing = api::Easing::linear;
    a.keys.push_back(std::move(ins));
  }
  REQUIRE(is_ok(h.run(cmd(a))));
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  h.sink.contentKeyOf = [](const RenderJob& j) { return std::optional<std::uint64_t>(0x1000 + static_cast<std::uint64_t>(j.frame)); };
  api::SetViewport v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  REQUIRE(is_ok(h.run(cmd(api::Seek{40 * kFrame30, api::SeekMode::exact}))));
  h.release_all();
  // Past the quiet period: the prefetch worker's build is in flight, and held.
  h.drainBuilds = false;
  for (int i = 0; i < 2000 && held.started.load() == 0; ++i) {
    h.advance(std::chrono::milliseconds(1));
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  REQUIRE(held.started.load() > 0);
  const std::size_t before = h.sink.submitted();

  // The scrub: its frame builds at once — the held prefetch stops at its next layer —
  // instead of waiting for it (10 s here; a whole heavy frame in the app).
  const auto t0 = std::chrono::steady_clock::now();
  REQUIRE(is_ok(h.run(cmd(api::Seek{70 * kFrame30, api::SeekMode::scrub}))));
  for (int i = 0; i < 2000 && h.sink.submitted() == before; ++i) {
    h.advance(std::chrono::microseconds(100));
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  CHECK(h.sink.submitted() > before);
  CHECK(std::chrono::steady_clock::now() - t0 < std::chrono::seconds(2));
  CHECK(held.cancelled.load() >= 1);
  held.open.store(true, std::memory_order_release);
  h.drainBuilds = true;
  h.session.drain_builds();
  const std::vector<api::FrameReady> ready = h.frames_ready();
  REQUIRE_FALSE(ready.empty());
  CHECK(ready.back().frame == 70);
  h.session.set_prefetch_builders({});
  h.session.set_frame_builder(nullptr);
}
