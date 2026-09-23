// The document core: one protocol session over one Document.
//
// Everything the engine decides lives behind this class — handshake, command
// dispatch, history, the transport clock, events — and it runs on ONE thread
// (the core thread, engine_process.cpp), fed from one FIFO. That single
// thread and single order are what make the engine deterministic: the same
// request stream produces the same revisions, events and frames.
//
// I/O is injected: `Outbox` receives outgoing messages (the process encodes
// and queues them for the writer threads; tests capture them), `FrameSink`
// receives evaluated frames (the render thread; a null sink in tests and in
// the fuzzer). Nothing here touches a file descriptor, a GPU or a clock —
// `now` is passed in.
#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include "document.hpp"
#include "engine_api.hpp"
#include "evaluate.hpp"
#include "frame_scene.hpp"
#include "history.hpp"
#include "premation/protocol/frame_channel.hpp"

namespace premation {

class Outbox {
 public:
  Outbox() = default;
  virtual ~Outbox() = default;
  Outbox(const Outbox&) = delete;
  Outbox& operator=(const Outbox&) = delete;
  Outbox(Outbox&&) = delete;
  Outbox& operator=(Outbox&&) = delete;

  /// Command pipe (stdout).
  virtual void send(const api::EngineMessage& message) = 0;
  /// Frame channel (fd 3).
  virtual void send_frames(const frames::Message& message) = 0;
  /// Bytes queued on the command pipe and not yet written. Ephemeral
  /// per-frame events (playhead) are skipped while the UI is not reading.
  [[nodiscard]] virtual std::size_t backlog_bytes() const = 0;
};

struct SessionOptions {
  std::string engineVersion = "0.2.0-c2";
  std::string sessionId = "s1";
};

class Session {
 public:
  using Clock = std::chrono::steady_clock;

  Session(Outbox& out, FrameSink& sink, SessionOptions options);

  /// One framed payload from the command pipe (decoded here, so a malformed
  /// frame becomes a typed error instead of reaching the dispatcher).
  void on_frame(std::span<const std::uint8_t> payload, Clock::time_point now);
  void on_message(api::EngineMessage message, Clock::time_point now);
  /// Heartbeat from the frame channel; answered from this (the core) thread.
  void on_ping(std::uint64_t nonce, std::uint32_t queued);
  /// The client went away (stdin closed). An open gesture is committed (§5.1).
  void on_disconnect();

  /// When the clock next needs `tick` (a frame is due); nullopt when stopped.
  [[nodiscard]] std::optional<Clock::time_point> next_deadline() const;
  void tick(Clock::time_point now);

  /// Goodbye sent or received: the process should shut down.
  [[nodiscard]] bool finished() const noexcept { return phase_ == Phase::closed; }
  [[nodiscard]] api::Revision revision() const noexcept { return revision_; }
  [[nodiscard]] bool playing() const noexcept { return playing_; }
  [[nodiscard]] const doc::Document& document() const noexcept { return doc_; }
  [[nodiscard]] api::Time time() const noexcept { return time_; }

  /// Say goodbye (engine shutting down) and close.
  void close(api::GoodbyeReason reason, std::string message);

 private:
  enum class Phase : std::uint8_t { awaiting_hello, open, closed };

  enum class OutcomeKind : std::uint8_t {
    control,       // no document change (transport, viewport, gesture bookkeeping)
    edit,          // changed the document through txn_: one revision, one history entry
    history_move,  // undo / redo / jump / cancelled gesture: `moved` holds what was applied
    reset,         // the document was replaced (newProject)
  };

  struct Outcome {
    std::optional<api::EngineError> error;
    api::CommandResult result;
    OutcomeKind kind = OutcomeKind::control;
    std::string label;             // history label for edits
    doc::ChangeSet moved;          // history_move only
    bool historyChanged = false;   // control that changed history state (gestures, clear, limit)
  };

  // ── envelope ──
  void handle_hello(const api::Hello& hello);
  void handle_request(api::Request request, Clock::time_point now);
  void handle_request_body(api::Request request, Clock::time_point now);
  void respond(api::Seq seq, api::Outcome outcome);
  void respond_error(api::Seq seq, api::EngineError error);
  void send_events(api::Revision from, api::Revision to, std::vector<api::Event> events, std::optional<api::Seq> seq,
                   api::Origin origin);
  void send_engine_error(api::ErrorCode code, std::string message, bool fatal);

  // ── commands ──
  friend struct CommandVisitor;
  friend struct QueryVisitor;
  Outcome run_command(const api::Command& cmd, api::Origin origin, Clock::time_point now);
  void finish_edit(api::Seq seq, api::Origin origin, const std::string& label, api::Outcome outcome);
  void finish_history_move(api::Seq seq, api::Origin origin, const doc::ChangeSet& applied, api::Outcome outcome);
  std::optional<api::EngineError> write_property(const api::PropRef& ref, const api::Value& value,
                                                 std::optional<api::Time> time, std::optional<api::KeyframeId>& key);

  // ── queries ──
  api::QueryResult query_document(const api::GetDocument& q);

  // ── events ──
  void append_change_events(const doc::ChangeSet& changes, std::vector<api::Event>& events);
  api::Event history_event() const;

  // ── transport ──
  void start_playback(Clock::time_point now, std::optional<api::Time> from);
  void stop_playback();
  void rebase_playback(Clock::time_point now);
  void set_time(api::Time t);
  void emit_transport();
  void emit_playhead();
  void request_render() noexcept { renderDirty_ = true; }
  void flush_render();
  void submit_frame(std::uint32_t clockDropped);
  [[nodiscard]] const doc::Comp* active_comp() const;
  [[nodiscard]] api::Time frame_dur() const;
  struct Range {
    std::int64_t first = 0;  // first frame index
    std::int64_t last = 0;   // last frame index (inclusive)
  };
  [[nodiscard]] Range play_range() const;
  void emit_stats(Clock::time_point now);

  Outbox& out_;
  FrameSink& sink_;
  SessionOptions options_;
  Phase phase_ = Phase::awaiting_hello;

  doc::Document doc_;
  doc::History history_;
  api::Revision revision_ = 0;
  eval::Scratch scratch_;
  doc::ChangeSet txn_;  // the changes of the request being applied

  // One EventBatch per request (ENGINE_API.md §8.1): while a request is being
  // handled, every send_events folds into `pending_` (causedBy = the request),
  // which respond() sends just before the response — events first.
  struct RequestScope {
    api::Seq seq = 0;
    api::Origin origin = api::Origin::ui;
    std::optional<api::EventBatch> pending;
  };
  std::optional<RequestScope> scope_;
  void flush_scope();

  // transport (engine-owned clock, never document state)
  std::optional<api::ItemId> activeComp_;
  api::Time time_ = 0;
  std::int64_t frame_ = 0;
  bool playing_ = false;
  double rate_ = 1.0;
  api::LoopMode loop_ = api::LoopMode::loop;
  api::PlayRange rangeKind_ = api::PlayRange::all;
  api::TimeRange customRange_;
  Clock::time_point playBase_{};
  std::int64_t playBaseU_ = 0;   // unfolded frame position (relative to range.first) at playBase_
  std::int64_t lastK_ = 0;       // clock steps since playBase_ already shown
  std::int64_t lastU_ = 0;
  api::Time playFrom_ = 0;       // where play started (pause{returnToStart})
  std::uint32_t clockDropped_ = 0;
  std::uint64_t playheadSkipped_ = 0;
  Clock::time_point lastStats_{};

  ViewportConfig viewport_;
  double resolution_ = 1.0;
  bool renderDirty_ = false;
  FrameScene sceneScratch_;
};

/// The seq of a Request inside an EngineMessage that failed to decode (so
/// the client's pending request can still be answered). nullopt when the
/// bytes are not a request or the seq itself is unreadable.
[[nodiscard]] std::optional<api::Seq> peek_request_seq(std::span<const std::uint8_t> payload) noexcept;

}  // namespace premation
