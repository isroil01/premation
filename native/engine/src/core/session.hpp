// The document core: one protocol session over one Document.
//
// Everything the engine decides lives behind this class — handshake, command
// dispatch, history, the transport clock, events — and it runs on ONE thread
// (the core thread, engine_process.cpp), fed from one FIFO. That single
// thread and single order are what make the engine deterministic: the same
// request stream produces the same revisions, events and frames.
//
// D1b: the request loop is the TypeScript LocalEngine's (src/core/engine/
// LocalEngine.ts) over the C++ document model (model.hpp): edits run through
// the handlers (handlers_*.cpp) inside one journal per request, the journal's
// ChangeSet is the history entry, and events come from the EventBuilder.
//
// I/O is injected: `Outbox` receives outgoing messages (the process encodes
// and queues them for the writer threads; tests capture them), `FrameSink`
// receives evaluated frames (the render thread; a null sink in tests and in
// the fuzzer). Nothing here touches a file descriptor, a GPU or a clock —
// `now` is passed in.
#pragma once

#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <set>
#include <span>
#include <string>
#include <vector>

#include "docexpr.hpp"
#include "engine_api.hpp"
#include "engine_ctx.hpp"
#include "events.hpp"
#include "frame_scene.hpp"
#include "history.hpp"
#include "model.hpp"
#include "premation/protocol/frame_channel.hpp"
#include "timeline.hpp"

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
  std::string engineVersion = "0.3.0-d1b";
  std::string sessionId = "s1";
  /// The test harness's ports (in-memory projects, deterministic fake media).
  bool testPorts = false;
};

class Session {
 public:
  using Clock = std::chrono::steady_clock;

  Session(Outbox& out, FrameSink& sink, SessionOptions options);
  ~Session();
  Session(const Session&) = delete;
  Session& operator=(const Session&) = delete;
  Session(Session&&) = delete;
  Session& operator=(Session&&) = delete;

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
  [[nodiscard]] const doc::EditorView& view() const noexcept { return view_; }

  /// Say goodbye (engine shutting down) and close.
  void close(api::GoodbyeReason reason, std::string message);

 private:
  enum class Phase : std::uint8_t { awaiting_hello, open, closed };

  // ── envelope ──
  void handle_hello(const api::Hello& hello);
  void handle_request(api::Request request, Clock::time_point now);
  api::Outcome handle_request_body(const api::Request& request, Clock::time_point now);
  void respond(api::Seq seq, api::Outcome outcome);
  void send_events(api::Revision from, api::Revision to, std::vector<api::Event> events, std::optional<api::Seq> seq,
                   api::Origin origin);
  void send_engine_error(api::ErrorCode code, std::string message, bool fatal);

  // ── commands ──
  friend struct ControlVisitor;
  friend struct EditVisitor;
  friend struct QueryVisitor;
  [[nodiscard]] bool is_edit(const api::Command& cmd) const;
  std::vector<api::CommandResult> run_edits(const std::vector<const api::Command*>& commands, api::Origin origin,
                                            const std::optional<std::string>& batchLabel);
  api::CommandResult run_control(const api::Command& cmd, api::Origin origin, Clock::time_point now);
  doc::HCtx handler_ctx(api::Origin origin);
  doc::PCtx pctx();
  void ensure_timelines();
  void stamp_missing_key_ids(const doc::ChangeSet& touched, doc::HCtx& x);

  // ── history ──
  void apply_history(const doc::ChangeSet& target);
  api::HistoryState history_state() const;
  void emit_status();
  void emit_changes(api::Revision from, const doc::ChangeSet& changes);
  /// New Project (`createEmpty` + loadDocument). `emit` false at construction (before Welcome).
  void load_new_project(api::ResetReason reason, bool emit = true);
  /// loadDocument(doc, {resetWorkspace: true}) for a project file.
  void load_document(const doc::Json& file, api::ResetReason reason);
  /// The document's state after a load: history, ids, caches, revision, reset event.
  void after_load(api::ResetReason reason, bool emit);
  [[nodiscard]] doc::Json capture_document() const;

  // ── queries ──
  api::QueryResult run_query(const api::Query& q);

  // ── transport ──
  void start_playback(Clock::time_point now, std::optional<api::Time> from);
  void stop_playback();
  void rebase_playback(Clock::time_point now);
  void set_time(api::Time t);
  void seek_to(api::Time t);
  void emit_transport();
  void emit_playhead();
  void request_render() noexcept { renderDirty_ = true; }
  void flush_render();
  void submit_frame(std::uint32_t clockDropped);
  [[nodiscard]] std::optional<std::string> active_comp() const;
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

  // ── the document and what edits it ──
  doc::Document doc_;
  doc::EditorView view_;
  doc::IdAllocator ids_;
  doc::KeyIndex keys_;
  doc::EventBuilder builder_;
  doc::ExprCache exprCache_;
  doc::DocExprEnv exprEnv_{doc_, view_, exprCache_};
  std::unique_ptr<doc::Ports> ports_;
  doc::History history_;
  struct Gesture {
    std::uint32_t id = 0;
    std::string label;
    api::Origin origin = api::Origin::ui;
    doc::ChangeSet changes;
  };
  std::optional<Gesture> gesture_;
  std::uint32_t gestureSeq_ = 0;
  api::Revision revision_ = 0;
  api::Revision savedRevision_ = 0;
  std::string projectPath_;
  std::vector<api::LogRecord> log_;
  struct Autosave {
    bool enabled = false;
    std::uint32_t intervalSeconds = 0;
    std::uint32_t keep = 0;
  } autosave_;
  std::vector<std::string> lastMissing_;

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
  api::Time time_ = 0;          // the render clock's time (frame-aligned, clamped to the comp)
  api::Time apiTime_ = 0;       // the TypeScript transport's `time` (what handlers see)
  std::int64_t frame_ = 0;
  bool playing_ = false;
  api::TransportState transportState_ = api::TransportState::stopped;
  double rate_ = 1.0;
  api::LoopMode loop_ = api::LoopMode::loop;
  api::PlayRange rangeKind_ = api::PlayRange::all;
  api::TimeRange customRange_;
  std::set<std::uint32_t> viewports_;
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
};

/// The seq of a Request inside an EngineMessage that failed to decode (so
/// the client's pending request can still be answered). nullopt when the
/// bytes are not a request or the seq itself is unreadable.
[[nodiscard]] std::optional<api::Seq> peek_request_seq(std::span<const std::uint8_t> payload) noexcept;

}  // namespace premation
