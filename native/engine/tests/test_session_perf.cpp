// Session performance guards (the two core-thread costs found on 2026-10-20):
//
// 1. Batch edits. Session::run_in_journal used to copy the whole open journal
//    (every part the transaction touched so far) for every command of a batch —
//    O(N²) for the AI author's batches of hundreds of edits. It now reads the
//    journal in place, so a 500-command batch is linear in its size.
// 2. Frame builds. Session::submit_frame_to used to run the frame builder on
//    the core thread, so a heavy comp's build (hundreds of ms) stalled every
//    request queued behind it. The build runs on the session's build worker;
//    the core thread keeps answering queries meanwhile and an edit waits for
//    at most the build in flight.
#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <variant>
#include <vector>

#include "session_harness.hpp"

using namespace premation;
using namespace premation::test;

namespace {

constexpr api::Time kSec = 705'600'000;

api::ItemId make_comp(Harness& h) {
  api::CreateComposition c;
  c.settings.name = "Perf";
  c.settings.width = 1920;
  c.settings.height = 1080;
  c.settings.frame_rate = api::Rational{30, 1};
  c.settings.duration = 10 * kSec;
  const auto r = h.run(cmd(c));
  REQUIRE(is_ok(r));
  return result_item(r);
}

/// Run `commands` as one batch; the response and how long the request took.
std::pair<api::Response, double> timed_batch(Harness& h, const std::string& label, std::vector<api::Command> commands) {
  const auto t0 = std::chrono::steady_clock::now();
  api::Response r = h.batch(label, std::move(commands));
  const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  return {std::move(r), ms};
}

std::vector<api::LayerId> layers_of(const api::Response& r) {
  std::vector<api::LayerId> out;
  const auto& batch = std::get<api::BatchResult>(r.outcome.v);
  for (const api::CommandResult& cr : batch.results) {
    std::visit(
        [&out](const auto& x) {
          if constexpr (std::is_same_v<std::decay_t<decltype(x)>, api::LayerRef>) out.push_back(x.layer);
        },
        cr.v);
  }
  return out;
}


/// A frame builder whose build blocks until the test releases it (one pass per release).
class GateBuilder final : public FrameBuilder {
 public:
  std::shared_ptr<BuiltFrame> build(const doc::Document& /*d*/, const doc::EditorView& /*view*/,
                                    const doc::ExprEnv& /*expr*/, doc::ExprCache& /*cache*/, std::string_view /*comp*/,
                                    api::Time /*time*/, const ViewportConfig& /*viewport*/, bool /*playing*/,
                                    std::vector<api::LayerError>& errors) override {
    std::unique_lock<std::mutex> lock(m_);
    ++started_;
    cv_.notify_all();
    (void)cv_.wait_for(lock, std::chrono::seconds(10), [this] { return open_; });
    open_ = false;
    ++built_;
    errors = next;
    return nullptr;  // the Session draws C2's quads for this frame
  }
  void release() {
    {
      const std::lock_guard<std::mutex> lock(m_);
      open_ = true;
    }
    cv_.notify_all();
  }
  /// True once `n` builds have begun (within 10 s).
  bool wait_started(int n) {
    std::unique_lock<std::mutex> lock(m_);
    return cv_.wait_for(lock, std::chrono::seconds(10), [this, n] { return started_ >= n; });
  }
  int built() const {
    const std::lock_guard<std::mutex> lock(m_);
    return built_;
  }
  std::vector<api::LayerError> next;

 private:
  mutable std::mutex m_;
  std::condition_variable cv_;
  bool open_ = false;
  int started_ = 0;
  int built_ = 0;
};

/// A gated builder that honours the session's cancel flag the way the real
/// one does between layers: while held, it watches the flag and throws
/// BuildCancelled the moment an edit is waiting for the lock.
class CancelGateBuilder final : public FrameBuilder {
 public:
  std::shared_ptr<BuiltFrame> build(const doc::Document& /*d*/, const doc::EditorView& /*view*/,
                                    const doc::ExprEnv& /*expr*/, doc::ExprCache& /*cache*/, std::string_view /*comp*/,
                                    api::Time /*time*/, const ViewportConfig& /*viewport*/, bool /*playing*/,
                                    std::vector<api::LayerError>& /*errors*/) override {
    std::unique_lock<std::mutex> lock(m_);
    ++started_;
    cv_.notify_all();
    const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (!open_ && std::chrono::steady_clock::now() < until) {
      if (cancel_ != nullptr && cancel_->load(std::memory_order_acquire) != 0) {
        ++cancelled_;
        throw BuildCancelled{};
      }
      (void)cv_.wait_for(lock, std::chrono::milliseconds(1));
    }
    open_ = false;
    ++built_;
    return nullptr;
  }
  void set_cancel_flag(const std::atomic<std::uint32_t>* flag) noexcept override { cancel_ = flag; }
  void release() {
    {
      const std::lock_guard<std::mutex> lock(m_);
      open_ = true;
    }
    cv_.notify_all();
  }
  bool wait_started(int n) {
    std::unique_lock<std::mutex> lock(m_);
    return cv_.wait_for(lock, std::chrono::seconds(10), [this, n] { return started_ >= n; });
  }
  int built() const {
    const std::lock_guard<std::mutex> lock(m_);
    return built_;
  }
  int cancelled() const {
    const std::lock_guard<std::mutex> lock(m_);
    return cancelled_;
  }

 private:
  mutable std::mutex m_;
  std::condition_variable cv_;
  const std::atomic<std::uint32_t>* cancel_ = nullptr;
  bool open_ = false;
  int started_ = 0;
  int built_ = 0;
  int cancelled_ = 0;
};

}  // namespace

TEST_CASE("session perf: a 500-command batch of createLayer and addKeyframes succeeds (one entry, one revision)",
          "[session][perf][batch]") {
  Harness h(64);
  (void)h.hello();
  const api::ItemId comp = make_comp(h);
  const api::Revision rev0 = h.session.revision();
  // PREMATION_PERF_N overrides the batch size (scaling experiments).
  const char* envN = std::getenv("PREMATION_PERF_N");
  const std::size_t kN = envN != nullptr ? static_cast<std::size_t>(std::atoi(envN)) : 500;

  std::vector<api::Command> creates;
  creates.reserve(kN);
  for (std::size_t i = 0; i < kN; ++i) {
    api::CreateLayer c;
    c.comp = comp;
    c.kind = api::LayerKind::solid;
    c.name = "L" + std::to_string(i);
    creates.push_back(cmd(std::move(c)));
  }
  const auto [created, createMs] = timed_batch(h, "Author: 500 layers", std::move(creates));
  REQUIRE(is_ok(created));
  const std::vector<api::LayerId> layers = layers_of(created);
  REQUIRE(layers.size() == kN);
  REQUIRE(h.session.revision() == rev0 + 1);

  std::vector<api::Command> keys;
  keys.reserve(kN);
  for (std::size_t i = 0; i < kN; ++i) {
    api::AddKeyframes a;
    for (int k = 0; k < 2; ++k) {
      api::KeyframeInsert ins;
      ins.prop = {layers[i], "transform/position"};
      ins.time = k * kSec;
      ins.value = vec2(100.0 * k, 50.0 * k + static_cast<double>(i));
      ins.easing = api::Easing::linear;
      a.keys.push_back(std::move(ins));
    }
    keys.push_back(cmd(std::move(a)));
  }
  const auto [keyed, keysMs] = timed_batch(h, "Author: 500 animated", std::move(keys));
  REQUIRE(is_ok(keyed));
  REQUIRE(std::get<api::BatchResult>(keyed.outcome.v).results.size() == kN);
  REQUIRE(h.session.revision() == rev0 + 2);
  // Every layer exists and every key got an id (stamp_missing_key_ids ran per command).
  for (const api::LayerId& id : layers) {
    const doc::NodeAnim* anim = h.session.document().anim(id);
    REQUIRE(anim != nullptr);
    REQUIRE_FALSE(anim->tracks.empty());
    for (const auto& [prop, track] : anim->tracks) {
      REQUIRE(track.size() == 2);
      for (const doc::Key& k : track) REQUIRE(k.id.has_value());
    }
  }
  // The batch is one history entry: undo removes all 500 keyframe sets at once.
  REQUIRE(is_ok(h.run(cmd(api::Undo{}))));
  const doc::NodeAnim* undone = h.session.document().anim(layers.front());
  REQUIRE((undone == nullptr || undone->empty()));
  WARN("500 createLayer: " << createMs << " ms; 500 addKeyframes: " << keysMs << " ms");
}

TEST_CASE("session perf: a frame builds on the build worker; queries answer meanwhile and an edit waits for it",
          "[session][perf][frames]") {
  Harness h(64);
  h.drainBuilds = false;  // watch the worker and the core thread side by side
  GateBuilder builder;
  builder.next = {api::LayerError{"layer_a", "unported", "3D layers", std::nullopt}};
  h.session.set_frame_builder(&builder);
  (void)h.hello();
  const api::ItemId comp = make_comp(h);
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  const std::size_t from = h.messages.size();
  api::SetViewport v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  // The viewport's first frame is building — and held — on the worker.
  REQUIRE(builder.wait_started(1));
  REQUIRE(builder.built() == 0);
  REQUIRE(h.sink.submitted() == 0);

  // Queries answer while the build is in flight (the build holds for 10 s if never released).
  const auto t0 = std::chrono::steady_clock::now();
  REQUIRE(is_ok(h.ask(qry(api::GetHistory{}))));
  REQUIRE(is_ok(h.ask(qry(api::GetRenderStats{}))));
  REQUIRE(std::chrono::steady_clock::now() - t0 < std::chrono::seconds(2));
  REQUIRE(builder.built() == 0);

  // An edit waits for the build in flight: it returns only once the frame was built.
  std::thread releaser([&builder] {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    builder.release();
  });
  api::CreateLayer l;
  l.comp = comp;
  l.kind = api::LayerKind::solid;
  REQUIRE(is_ok(h.run(cmd(l))));
  releaser.join();
  REQUIRE(builder.built() == 1);
  REQUIRE(h.sink.submitted() == 1);

  // The edit queued the next frame (a new revision): let it through and wait for it.
  builder.release();
  h.session.drain_builds();
  REQUIRE(builder.built() == 2);
  REQUIRE(h.sink.submitted() == 2);
  const std::vector<api::FrameReady> frames = h.frames_ready();
  REQUIRE(frames.size() == 2);
  REQUIRE(frames[0].revision < frames[1].revision);
  REQUIRE(frames[1].revision == h.session.revision());
  // The builder's layer errors reached the UI once (the same set on both frames).
  std::size_t announced = 0;
  for (const api::Event& e : h.events_since(from)) announced += std::holds_alternative<api::LayerErrorsEvent>(e.v) ? 1 : 0;
  REQUIRE(announced == 1);
  h.session.set_frame_builder(nullptr);
}

TEST_CASE("session perf: an edit cancels the stale frame build in flight instead of waiting for it; the frame is built again",
          "[session][perf][frames]") {
  Harness h(64);
  h.drainBuilds = false;
  CancelGateBuilder builder;
  h.session.set_frame_builder(&builder);
  (void)h.hello();
  const api::ItemId comp = make_comp(h);
  api::SetActiveComposition active;
  active.comp = comp;
  REQUIRE(is_ok(h.run(cmd(active))));
  api::SetViewport v;
  v.viewport = 1;
  v.width = 640;
  v.height = 360;
  v.device_pixel_ratio = 1.0;
  REQUIRE(is_ok(h.run(cmd(v))));
  // The viewport's first frame is building — and held — on the worker.
  REQUIRE(builder.wait_started(1));
  REQUIRE(builder.built() == 0);

  // An edit does not wait for the held build: the builder sees the edit
  // waiting (editsWaiting_) and throws BuildCancelled; the edit lands at once.
  const auto t0 = std::chrono::steady_clock::now();
  api::CreateLayer l;
  l.comp = comp;
  l.kind = api::LayerKind::solid;
  REQUIRE(is_ok(h.run(cmd(l))));
  REQUIRE(std::chrono::steady_clock::now() - t0 < std::chrono::seconds(2));
  REQUIRE(builder.cancelled() == 1);
  REQUIRE(builder.built() == 0);
  REQUIRE(h.sink.submitted() == 0);

  // The cancelled task is a skip: the core thread queues the frame of the
  // edited document, which builds once released.
  REQUIRE(builder.wait_started(2));
  builder.release();
  h.session.drain_builds();
  REQUIRE(builder.built() == 1);
  REQUIRE(h.sink.submitted() == 1);
  const std::vector<api::FrameReady> frames = h.frames_ready();
  REQUIRE(frames.size() == 1);
  REQUIRE(frames[0].revision == h.session.revision());
  h.session.set_frame_builder(nullptr);
}
