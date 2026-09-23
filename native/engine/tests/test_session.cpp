// The document core as a black box: requests in, responses/events/frames out.
// Semantics are the TypeScript LocalEngine's (crossEngine.test.ts replays the
// same requests into both engines); these tests pin the engine-level
// contracts on their own, fast, without Node: history exactness, batches,
// gestures, events-before-response, every command answering, the catalog,
// expressions, the clock and determinism.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <set>

#include "core/catalog_data.hpp"
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
  return std::get<T>(std::get<api::QueryResult>(r.outcome.v).v);
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
  imp.files = {api::ImportFile{"C:/m/clip.mp4", false, {}, {}, false}};
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

  REQUIRE(is_ok(h.run(cmd(api::Play{1.0, api::PlayRange::all, {}, false, false, {}}))));
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
  REQUIRE(is_ok(h.run(cmd(api::Play{1.0, api::PlayRange::all, {}, false, false, {}}))));
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
    (void)h.run(cmd(api::Play{1.0, api::PlayRange::all, {}, false, false, {}}));
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
