// The document core as a black box: requests in, responses/events/frames out.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>

#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;
using Catch::Approx;

namespace {

constexpr api::Time kSec = doc::kFlicksPerSecond;

api::ItemId make_comp(Harness& h, std::uint32_t num = 30) {
  api::CreateComposition c;
  c.settings.width = 1920;
  c.settings.height = 1080;
  c.settings.frame_rate = api::Rational{num, 1};
  c.settings.duration = 10 * kSec;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_item(r);
}

api::LayerId make_solid(Harness& h, const api::ItemId& comp) {
  api::CreateLayer c;
  c.comp = comp;
  c.kind = api::LayerKind::solid;
  c.init = {api::PropertyInit{"layer/size", vec2(200, 100)}};
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_layer(r);
}

api::Value value_of(Harness& h, const api::LayerId& layer, const std::string& path, api::Time t) {
  api::GetPropertyValues q;
  q.props = {api::PropRef{layer, path}};
  q.time = t;
  const auto r = h.ask(qry(q));
  REQUIRE(is_ok(r));
  const auto& qr = std::get<api::QueryResult>(r.outcome.v);
  return std::get<api::PropertyValues>(qr.v).values.at(0).value;
}

api::Response set_prop(Harness& h, const api::LayerId& layer, const std::string& path, api::Value v,
                       std::optional<api::Time> t = std::nullopt) {
  api::SetProperty s;
  s.prop = {layer, path};
  s.value = std::move(v);
  s.time = t;
  return h.run(cmd(s));
}

api::Response add_key(Harness& h, const api::LayerId& layer, const std::string& path, api::Time t, api::Value v) {
  api::AddKeyframes a;
  api::KeyframeInsert k;
  k.prop = {layer, path};
  k.time = t;
  k.value = std::move(v);
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

TEST_CASE("session: create, edit, events, revisions", "[session]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  REQUIRE(h.session.revision() == 1);
  const std::size_t mark = h.messages.size();
  const auto layer = make_solid(h, comp);
  REQUIRE(h.session.revision() == 2);

  const auto batches = h.batches_since(mark);
  REQUIRE(batches.size() == 1);
  REQUIRE(batches[0].from_revision == 1);
  REQUIRE(batches[0].to_revision == 2);
  const auto ev = batches[0].events;
  REQUIRE(events_of<api::LayersChangedEvent>(ev).at(0).layers.at(0).id == layer);
  REQUIRE(events_of<api::LayerOrderChangedEvent>(ev).at(0).layers == std::vector<api::LayerId>{layer});
  REQUIRE(events_of<api::PropertiesChangedEvent>(ev).at(0).properties.size() == 7);
  REQUIRE(events_of<api::HistoryChangedEvent>(ev).at(0).undo_label == "New Layer");
  // Events arrive BEFORE the response, so an awaiting client sees its mirror updated.
  REQUIRE(h.messages[mark].kind() == api::EngineMessage::Kind::events);

  REQUIRE(is_ok(set_prop(h, layer, "transform/position", vec2(100, 50))));
  REQUIRE(std::get<api::Vec2>(value_of(h, layer, "transform/position", 0).v) == api::Vec2{100, 50});

  SECTION("type mismatch, unknown path, unknown layer change nothing") {
    const auto rev = h.session.revision();
    REQUIRE(is_error(set_prop(h, layer, "transform/position", scalar(1)), api::ErrorCode::type_mismatch));
    REQUIRE(is_error(set_prop(h, layer, "transform/nope", scalar(1)), api::ErrorCode::not_found));
    REQUIRE(is_error(set_prop(h, "L999", "transform/opacity", scalar(1)), api::ErrorCode::not_found));
    REQUIRE(h.session.revision() == rev);
  }
  SECTION("opacity is clamped to 0..100") {
    REQUIRE(is_ok(set_prop(h, layer, "transform/opacity", scalar(250))));
    REQUIRE(std::get<double>(value_of(h, layer, "transform/opacity", 0).v) == 100.0);
  }
  SECTION("setting the same value is not an edit") {
    const auto rev = h.session.revision();
    REQUIRE(is_ok(set_prop(h, layer, "transform/position", vec2(100, 50))));
    REQUIRE(h.session.revision() == rev);
  }
  SECTION("baseRevision conflict") {
    api::SetProperty s;
    s.prop = {layer, "transform/rotation"};
    s.value = scalar(10);
    REQUIRE(is_error(h.run(cmd(s), h.session.revision() - 1), api::ErrorCode::conflict));
    REQUIRE(is_ok(h.run(cmd(s), h.session.revision())));
  }
}

TEST_CASE("session: keyframes interpolate through motion_eval", "[session][eval]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_solid(h, comp);
  REQUIRE(is_ok(add_key(h, layer, "transform/position", 0, vec2(0, 0))));
  REQUIRE(is_ok(add_key(h, layer, "transform/position", 1 * kSec, vec2(100, 200))));
  REQUIRE(is_ok(add_key(h, layer, "transform/position", 2 * kSec, vec2(100, 0))));
  const auto mid = std::get<api::Vec2>(value_of(h, layer, "transform/position", kSec / 2).v);
  REQUIRE(mid.x == Approx(50.0));
  REQUIRE(mid.y == Approx(100.0));
  const auto late = std::get<api::Vec2>(value_of(h, layer, "transform/position", 3 * kSec).v);
  REQUIRE(late == api::Vec2{100, 0});

  SECTION("animated property: setProperty without time is `animated`, with time upserts a key") {
    REQUIRE(is_error(set_prop(h, layer, "transform/position", vec2(1, 1)), api::ErrorCode::animated));
    const auto r = set_prop(h, layer, "transform/position", vec2(7, 7), kSec);
    REQUIRE(is_ok(r));
    const auto wr = result_as<api::PropertyWriteResult>(r);
    REQUIRE(wr.keyframe.has_value());
    REQUIRE(std::get<api::Vec2>(value_of(h, layer, "transform/position", kSec).v) == api::Vec2{7, 7});
  }
  SECTION("a replaced key keeps its id; deleting keys restores a static value") {
    api::GetKeyframes q;
    q.props = {api::PropRef{layer, "transform/position"}};
    auto keysOf = [&] {
      const auto r = h.ask(qry(q));
      return std::get<api::KeyframeSets>(std::get<api::QueryResult>(r.outcome.v).v).sets.at(0).keyframes;
    };
    const auto before = keysOf();
    REQUIRE(before.size() == 3);
    REQUIRE(is_ok(add_key(h, layer, "transform/position", kSec, vec2(5, 5))));
    const auto after = keysOf();
    REQUIRE(after.size() == 3);
    REQUIRE(after[1].id == before[1].id);
    api::DeleteKeyframes d;
    for (const auto& k : after) d.ids.push_back(k.id);
    REQUIRE(is_ok(h.run(cmd(d))));
    REQUIRE(keysOf().empty());
    // The last deleted key's value becomes the static value.
    REQUIRE(std::get<api::Vec2>(value_of(h, layer, "transform/position", 0).v) == api::Vec2{100, 0});
  }
  SECTION("easing hold") {
    api::AddKeyframes a;
    api::KeyframeInsert k;
    k.prop = {layer, "transform/rotation"};
    k.time = 0;
    k.value = scalar(0);
    k.easing = api::Easing::hold;
    a.keys.push_back(k);
    k.time = kSec;
    k.value = scalar(90);
    a.keys.push_back(k);
    REQUIRE(is_ok(h.run(cmd(a))));
    REQUIRE(std::get<double>(value_of(h, layer, "transform/rotation", kSec - 1).v) == 0.0);
    REQUIRE(std::get<double>(value_of(h, layer, "transform/rotation", kSec).v) == 90.0);
  }
}

TEST_CASE("session: undo and redo restore exactly, with the same ids", "[session][history]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto a = make_solid(h, comp);
  const auto b = make_solid(h, comp);
  REQUIRE(is_ok(set_prop(h, a, "transform/rotation", scalar(45))));
  api::DeleteLayers del;
  del.layers = {a};
  REQUIRE(is_ok(h.run(cmd(del))));
  REQUIRE(h.session.document().layer(a) == nullptr);

  const auto rev = h.session.revision();
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  REQUIRE(h.session.revision() == rev + 1);  // undo is a revision too
  REQUIRE(h.session.document().layer(a) != nullptr);
  REQUIRE(h.session.document().comp(comp)->layers == std::vector<api::LayerId>{b, a});
  REQUIRE(std::get<double>(value_of(h, a, "transform/rotation", 0).v) == 45.0);

  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));  // rotation back to 0
  REQUIRE(std::get<double>(value_of(h, a, "transform/rotation", 0).v) == 0.0);
  REQUIRE(is_ok(h.run(cmd(api::Redo{}))));
  REQUIRE(std::get<double>(value_of(h, a, "transform/rotation", 0).v) == 45.0);

  // Undo everything, then nothing is left to undo.
  while (is_ok(h.run(cmd(api::Undo{})))) {
  }
  REQUIRE(h.session.document().comps.empty());
  REQUIRE(is_error(h.run(cmd(api::Undo{})), api::ErrorCode::nothing_to_undo));
  // Redo everything: same ids come back.
  while (is_ok(h.run(cmd(api::Redo{})))) {
  }
  REQUIRE(h.session.document().layer(a) == nullptr);  // the delete was redone too
  REQUIRE(h.session.document().layer(b) != nullptr);
  // A new layer never reuses an id.
  const auto c = make_solid(h, comp);
  REQUIRE(c != a);
  REQUIRE(c != b);
}

TEST_CASE("session: a failed batch changes nothing; a good batch is one entry", "[session][history]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_solid(h, comp);
  const auto rev = h.session.revision();
  const doc::Document before = h.session.document();

  api::SetProperty ok1;
  ok1.prop = {layer, "transform/rotation"};
  ok1.value = scalar(30);
  api::SetProperty bad;
  bad.prop = {layer, "transform/rotation"};
  bad.value = vec2(1, 2);
  const auto r = h.batch("Twist", {cmd(ok1), cmd(bad)});
  REQUIRE(is_error(r, api::ErrorCode::type_mismatch));
  REQUIRE(std::get<api::EngineError>(r.outcome.v).command_index == 1U);
  REQUIRE(h.session.revision() == rev);
  REQUIRE(h.session.document().layers == before.layers);

  api::SetProperty ok2 = ok1;
  ok2.prop.path = "transform/opacity";
  ok2.value = scalar(50);
  REQUIRE(is_ok(h.batch("Twist", {cmd(ok1), cmd(ok2)})));
  REQUIRE(h.session.revision() == rev + 1);
  const auto hist = std::get<api::HistoryState>(std::get<api::QueryResult>(h.ask(qry(api::GetHistory{})).outcome.v).v);
  REQUIRE(hist.entries.back().label == "Twist");
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  REQUIRE(std::get<double>(value_of(h, layer, "transform/rotation", 0).v) == 0.0);
  REQUIRE(std::get<double>(value_of(h, layer, "transform/opacity", 0).v) == 100.0);

  SECTION("controls cannot be batched") {
    const auto c = h.batch("x", {cmd(api::Pause{})});
    REQUIRE(is_error(c, api::ErrorCode::invalid_argument));
  }
}

TEST_CASE("session: a gesture is one entry; cancel restores", "[session][history]") {
  Harness h;
  (void)h.hello();
  const auto comp = make_comp(h);
  const auto layer = make_solid(h, comp);
  const auto entriesBefore =
      std::get<api::HistoryState>(std::get<api::QueryResult>(h.ask(qry(api::GetHistory{})).outcome.v).v).entries.size();

  auto begin = [&](const char* label) {
    const auto r = h.run(cmd(api::BeginGesture{label}));
    REQUIRE(is_ok(r));
    return result_as<api::GestureRef>(r).gesture;
  };
  const auto g = begin("Move");
  for (int i = 1; i <= 60; ++i) REQUIRE(is_ok(set_prop(h, layer, "transform/position", vec2(i, i))));
  REQUIRE(is_error(h.run(cmd(api::Undo{})), api::ErrorCode::gesture_open));
  REQUIRE(is_ok(h.run(cmd(api::EndGesture{g, true}))));
  const auto hist = std::get<api::HistoryState>(std::get<api::QueryResult>(h.ask(qry(api::GetHistory{})).outcome.v).v);
  REQUIRE(hist.entries.size() == entriesBefore + 1);
  REQUIRE(hist.entries.back().label == "Move");
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  REQUIRE(std::get<api::Vec2>(value_of(h, layer, "transform/position", 0).v) == api::Vec2{960, 540});

  const auto g2 = begin("Drag");
  REQUIRE(is_ok(set_prop(h, layer, "transform/rotation", scalar(12))));
  REQUIRE(is_ok(h.run(cmd(api::EndGesture{g2, false}))));
  REQUIRE(std::get<double>(value_of(h, layer, "transform/rotation", 0).v) == 0.0);
  REQUIRE(is_error(h.run(cmd(api::EndGesture{g2, true})), api::ErrorCode::no_gesture));
}

TEST_CASE("session: every command and query is recognised; unimplemented ones are typed", "[session]") {
  Harness h;
  (void)h.hello();
  const auto r = h.run(cmd(api::ImportFiles{}));
  REQUIRE(is_error(r, api::ErrorCode::unsupported));
  REQUIRE(std::get<api::EngineError>(r.outcome.v).detail.value_or("").find("notImplemented") != std::string::npos);
  REQUIRE(is_error(h.ask(qry(api::ListFonts{})), api::ErrorCode::unsupported));
  api::CreateLayer text;
  text.comp = make_comp(h);
  text.kind = api::LayerKind::text;
  REQUIRE(is_error(h.run(cmd(text)), api::ErrorCode::unsupported));
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
  (void)make_solid(h, comp);
  api::SetViewport v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  const std::size_t base = h.sink.submitted();
  REQUIRE(base == 1);  // the viewport opening renders the current frame

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
  const auto comp = make_comp(h, 30);
  const auto layer = make_solid(h, comp);
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
  // A release for another generation is ignored.
  h.sink.release(99, 0);
  REQUIRE(h.frames_ready().size() == 3);
  // A real release lets the newest pending frame through, with the drop count.
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
  const auto comp = make_comp(h);
  const auto layer = make_solid(h, comp);
  api::SetViewport v;
  v.viewport = 1;
  v.width = 1920;
  v.height = 1080;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  REQUIRE(is_ok(set_prop(h, layer, "transform/position", vec2(300, 400))));
  const FrameScene s = h.sink.last_scene();
  REQUIRE(s.quads.size() == 1);
  // 200×100 solid, anchor at its centre, placed at (300, 400): origin corner at (200, 350).
  REQUIRE(s.quads[0].affine[0] == Approx(200.0F));
  REQUIRE(s.quads[0].affine[3] == Approx(100.0F));
  REQUIRE(s.quads[0].affine[4] == Approx(200.0F));
  REQUIRE(s.quads[0].affine[5] == Approx(350.0F));
  REQUIRE(is_ok(set_prop(h, layer, "transform/opacity", scalar(0))));
  REQUIRE(h.sink.last_scene().quads.empty());
}

TEST_CASE("session: the same request stream produces the same bytes", "[session][determinism]") {
  auto script = [](Harness& h) {
    (void)h.hello();
    const auto comp = make_comp(h);
    const auto layer = make_solid(h, comp);
    (void)add_key(h, layer, "transform/position", 0, vec2(0, 0));
    (void)add_key(h, layer, "transform/position", kSec, vec2(500, 500));
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
