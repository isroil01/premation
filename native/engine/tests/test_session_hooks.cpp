// D2w / E2: the Session's scene-builder and audio-clock hooks
// (scene/session_hooks.hpp) — the transport drives the media clock, the media
// clock paces playback while it runs, the audio program follows the document,
// and the builder's per-layer errors reach the UI as layerErrors (changes only).
#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <limits>
#include <optional>
#include <string>
#include <type_traits>
#include <variant>
#include <vector>

#include "session_harness.hpp"

namespace premation::test {
namespace {

constexpr api::Time kSec = 705'600'000;

class FakeClock final : public MediaClock {
 public:
  void play(double fromSec, double rate, Loop loop, double rangeStartSec, double rangeEndSec) override {
    plays.push_back({fromSec, rate, loop, rangeStartSec, rangeEndSec});
    playing = true;
  }
  void pause() override {
    ++pauses;
    playing = false;
  }
  void seek(double sec, bool /*scrub*/) override { seeks.push_back(sec); }
  [[nodiscard]] std::optional<double> media_elapsed(std::chrono::steady_clock::time_point /*now*/) const override {
    return playing ? elapsed : std::nullopt;
  }
  void set_document(const doc::Document& /*d*/, const doc::EditorView& /*view*/, const doc::ExprEnv& /*expr*/,
                    doc::ExprCache& /*cache*/, std::string_view comp) override {
    documents.emplace_back(comp);
  }

  struct Play {
    double from, rate;
    Loop loop;
    double rangeStart, rangeEnd;
  };
  std::vector<Play> plays;
  std::vector<double> seeks;
  std::vector<std::string> documents;
  int pauses = 0;
  bool playing = false;
  std::optional<double> elapsed;
};

class FakeBuilder final : public FrameBuilder {
 public:
  std::shared_ptr<BuiltFrame> build(const doc::Document& /*d*/, const doc::EditorView& /*view*/,
                                    const doc::ExprEnv& /*expr*/, doc::ExprCache& /*cache*/, std::string_view /*comp*/,
                                    api::Time /*time*/, const ViewportConfig& viewport, bool /*playing*/,
                                    std::vector<api::LayerError>& errors) override {
    ++builds;
    lastViewport = viewport;
    errors = next;
    return nullptr;  // the Session draws C2's quads for this frame
  }
  int builds = 0;
  ViewportConfig lastViewport;
  std::vector<api::LayerError> next;
};

api::ItemId open_comp(Harness& h) {
  api::CreateComposition c;
  c.settings.name = "Hooks";
  c.settings.width = 1920;
  c.settings.height = 1080;
  c.settings.frame_rate = api::Rational{30, 1};
  c.settings.duration = 10 * kSec;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  const api::ItemId comp = result_item(r);
  api::CreateLayer l;
  l.comp = comp;
  l.kind = api::LayerKind::solid;
  REQUIRE(is_ok(h.run(cmd(l))));
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  api::SetViewport v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  return comp;
}

std::size_t count_layer_errors(const std::vector<api::Event>& ev) {
  std::size_t n = 0;
  for (const api::Event& e : ev) n += std::holds_alternative<api::LayerErrorsEvent>(e.v) ? 1 : 0;
  return n;
}

}  // namespace

TEST_CASE("session hooks: the transport drives the media clock and the audio clock paces playback",
          "[session][transport][audio]") {
  Harness h(64);
  FakeClock clock;
  h.session.set_media_clock(&clock);
  (void)h.hello();
  const auto comp = open_comp(h);

  REQUIRE(is_ok(h.run(cmd(api::Play{1.0, api::PlayRange::all, {}, false, false, {}}))));
  REQUIRE(clock.plays.size() == 1);
  CHECK(clock.plays[0].from == 0);
  CHECK(clock.plays[0].rangeStart == 0);
  CHECK(clock.plays[0].rangeEnd == 10.0);
  CHECK(clock.plays[0].loop == MediaClock::Loop::loop);
  REQUIRE(clock.documents.size() == 1);  // the program is built from the document on play
  CHECK(clock.documents[0] == comp);

  // Not locked yet: the wall clock paces.
  h.release_all();
  h.advance(std::chrono::milliseconds(100));
  CHECK(h.session.time() == 3 * (kSec / 30));

  // Locked: the AUDIO clock decides the frame, whatever the wall clock says.
  clock.elapsed = 1.0;
  h.release_all();
  h.advance(std::chrono::milliseconds(1));
  CHECK(h.session.time() == 30 * (kSec / 30));
  h.release_all();
  h.advance(std::chrono::seconds(5));  // the wall clock ran ahead; the audio did not
  CHECK(h.session.time() == 30 * (kSec / 30));
  // The next deadline is predicted from the audio clock (one frame on), never a spin.
  const auto dl = h.session.next_deadline();
  REQUIRE(dl.has_value());
  CHECK(*dl > h.now);
  clock.elapsed = 1.5;
  h.release_all();
  h.advance(std::chrono::milliseconds(1));
  CHECK(h.session.time() == 45 * (kSec / 30));

  SECTION("an edit while playing rebuilds the audio program once") {
    api::CreateLayer l;
    l.comp = comp;
    l.kind = api::LayerKind::solid;
    REQUIRE(is_ok(h.run(cmd(l))));
    h.advance(std::chrono::milliseconds(1));
    h.advance(std::chrono::milliseconds(1));
    CHECK(clock.documents.size() == 2);
  }
  SECTION("a seek while playing restarts the audio clock there") {
    REQUIRE(is_ok(h.run(cmd(api::Seek{2 * kSec, api::SeekMode::exact}))));
    REQUIRE(clock.plays.size() == 2);
    CHECK(clock.plays[1].from == 2.0);
  }
  SECTION("pause stops the audio clock") {
    REQUIRE(is_ok(h.run(cmd(api::Pause{false}))));
    CHECK(clock.pauses == 1);
    CHECK_FALSE(h.session.next_deadline().has_value());
  }
}

TEST_CASE("session hooks: the frame builder's layer errors are announced when they change",
          "[session][frames]") {
  Harness h(64);
  FakeBuilder builder;
  builder.next = {api::LayerError{"layer_a", "unported", "3D layers", std::nullopt}};
  h.session.set_frame_builder(&builder);
  (void)h.hello();
  const std::size_t from = h.messages.size();
  (void)open_comp(h);
  REQUIRE(builder.builds >= 1);
  REQUIRE(h.sink.submitted() >= 1);  // a null build still delivers a frame (C2's quads)
  CHECK(count_layer_errors(h.events_since(from)) == 1);

  // The same errors on later frames: nothing new.
  const std::size_t mid = h.messages.size();
  REQUIRE(is_ok(h.run(cmd(api::Seek{kSec, api::SeekMode::exact}))));
  CHECK(count_layer_errors(h.events_since(mid)) == 0);

  // Cleared: announced once, empty.
  builder.next.clear();
  const std::size_t late = h.messages.size();
  REQUIRE(is_ok(h.run(cmd(api::Seek{2 * kSec, api::SeekMode::exact}))));
  const auto ev = h.events_since(late);
  REQUIRE(count_layer_errors(ev) == 1);
  for (const api::Event& e : ev) {
    if (const auto* le = std::get_if<api::LayerErrorsEvent>(&e.v)) CHECK(le->errors.empty());
  }
}

TEST_CASE("session hooks: setViewport carries the page's camera to the frame builder (D5)", "[session][frames]") {
  Harness h(64);
  FakeBuilder builder;
  h.session.set_frame_builder(&builder);
  (void)h.hello();
  (void)open_comp(h);  // 640 × 360 at DPR 1, zoom 0 = fit
  CHECK(builder.lastViewport.zoom == 0.0);

  api::SetViewport v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.device_pixel_ratio = 2.0;
  v.zoom = 1.5;
  v.pan = api::Vec2{960.0, 540.0};
  REQUIRE(is_ok(h.run(cmd(v))));
  CHECK(builder.lastViewport.width == 1280);  // physical px
  CHECK(builder.lastViewport.height == 720);
  CHECK(builder.lastViewport.devicePixelRatio == 2.0);
  CHECK(builder.lastViewport.zoom == 1.5);
  CHECK(builder.lastViewport.panX == 960.0);
  CHECK(builder.lastViewport.panY == 540.0);

  // A zoom that is not a positive finite number means fit.
  v.zoom = std::numeric_limits<double>::quiet_NaN();
  REQUIRE(is_ok(h.run(cmd(v))));
  CHECK(builder.lastViewport.zoom == 0.0);
}

TEST_CASE("session hooks: a camera-only setViewport keeps the slot ring (D5)", "[session][frames]") {
  ViewportConfig a;
  a.viewport = 1;
  a.width = 1280;
  a.height = 720;
  a.open = true;
  a.zoom = 1.0;
  ViewportConfig b = a;
  b.zoom = 2.5;
  b.panX = 100;
  b.panY = -40;
  b.devicePixelRatio = 2.0;
  CHECK_FALSE(ring_config_changed(a, b));  // pan / zoom / DPR at the same physical size
  b.width = 1281;
  CHECK(ring_config_changed(a, b));
  b = a;
  b.resolution = 0.5;
  CHECK(ring_config_changed(a, b));
  b = a;
  b.open = false;
  CHECK(ring_config_changed(a, b));
  b = a;
  b.viewport = 2;
  CHECK(ring_config_changed(a, b));
}

TEST_CASE("session hooks: getLayerErrors answers the set last announced (D5)", "[session][frames]") {
  Harness h(64);
  FakeBuilder builder;
  builder.next = {api::LayerError{"layer_a", "unported", "glTF models", std::nullopt}};
  h.session.set_frame_builder(&builder);
  (void)h.hello();
  const api::ItemId comp = open_comp(h);
  const auto errors_of = [&h](std::optional<api::ItemId> c) {
    api::GetLayerErrors q;
    q.comp = std::move(c);
    const api::Response r = h.ask(qry(q));
    REQUIRE(r.outcome.kind() == api::Outcome::Kind::query);
    const auto& qr = std::get<api::QueryResult>(r.outcome.v);
    return std::visit(
        [](const auto& x) -> std::vector<api::LayerError> {
          if constexpr (std::is_same_v<std::decay_t<decltype(x)>, api::LayerErrorList>) {
            return x.errors;
          } else {
            return {};
          }
        },
        qr.v);
  };
  const auto named = errors_of(comp);
  REQUIRE(named.size() == 1);
  CHECK(named[0].stage == "unported");
  CHECK(named[0].message == "glTF models");
  CHECK(errors_of(std::nullopt).size() == 1);  // no comp = the comp last built

  builder.next.clear();
  REQUIRE(is_ok(h.run(cmd(api::Seek{kSec, api::SeekMode::exact}))));
  CHECK(errors_of(comp).empty());
}

}  // namespace premation::test
