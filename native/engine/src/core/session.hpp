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

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <optional>
#include <map>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "docexpr.hpp"
#include "engine_api.hpp"
#include "engine_ctx.hpp"
#include "events.hpp"
#include "frame_keys.hpp"
#include "frame_scene.hpp"
#include "history.hpp"
#include "jobs/job_api.hpp"
#include "jobs/job_runner.hpp"
#include "joining_thread.hpp"
#include "live_port.hpp"
#include "model.hpp"
#include "overlay_geometry.hpp"
#include "premation/protocol/frame_channel.hpp"
#include "scene/session_hooks.hpp"
#include "timeline.hpp"

namespace premation {

namespace doc {
struct StillRequest;  // queries.hpp
}  // namespace doc

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
  /// With testPorts: mirror the in-memory project files to this directory (FakePorts).
  std::string testPortsDir;
  /// `listFonts`: the installed fonts matching a query (the engine process
  /// passes its font catalogue). Unset, or with testPorts: an empty list.
  std::function<api::FontList(const std::string&)> systemFonts;
  /// `refreshFonts`: re-read the installed fonts; true when they changed (the
  /// engine process passes raster::refresh_system_fonts). Unset, or with
  /// testPorts: never a change.
  std::function<bool()> refreshSystemFonts;
  /// importFiles / importBytes / relinkItem's probe (FilePorts::MediaProbe):
  /// the engine process passes its decoders' probe (jobs::probe_media). Unset:
  /// both imports answer `unsupported`. Ignored with testPorts.
  doc::FilePorts::MediaProbe mediaProbe;
  /// Where importBytes caches bytes as files ('' = `<temp>/premation-session-footage`).
  std::string footageDir;
  /// Called on the core thread as each request starts, with what it is
  /// (`command createLayer`, `query 1000`, `batch <label>`): the engine
  /// process's watchdog names a stalled core thread with it. Unset: nothing.
  std::function<void(std::string)> activity;
  /// Idle render-ahead (Session::idle_prefetch): with the transport stopped and
  /// nothing else to do, frames around the playhead are drawn into the cache
  /// tiers one at a time (AE's idle caching). Off = only playback and Cache
  /// Work Area fill the cache. The engine process reads PREMATION_IDLE_PREFETCH
  /// (0 = off); tests set it directly.
  bool idlePrefetch = true;
  /// The engine process's memory and the machine's, for getRenderStats (the
  /// Cache & Memory panel's leak signal: engine memory no cache accounts for).
  /// The engine process reads them from the OS (os_ffi); unset = absent fields.
  struct HostMemory {
    std::uint64_t processBytes = 0;
    std::uint64_t physicalBytes = 0;
    std::uint64_t availableBytes = 0;
  };
  std::function<HostMemory()> hostMemory;
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
  /// A Hello on an open session is a client RECONNECT (a reloaded page on a
  /// surviving engine) and settles the old client's gesture the same way.
  void on_disconnect();

  /// When the clock next needs `tick` (a frame is due); nullopt when stopped.
  [[nodiscard]] std::optional<Clock::time_point> next_deadline() const;

  void tick(Clock::time_point now);

  /// Goodbye sent or received: the process should shut down.
  [[nodiscard]] bool finished() const noexcept { return phase_ == Phase::closed; }
  [[nodiscard]] api::Revision revision() const noexcept { return revision_; }
  [[nodiscard]] bool playing() const noexcept { return playing_; }
  /// A UI gesture (a drag) is open: interactive frames are flowing, and the
  /// process loop keeps the 1 ms scheduler timer, exactly as while playing —
  /// without it every timed wait in the frame pipeline rounds to Windows'
  /// 15.6 ms tick and a drag's picture updates at ~45 fps in uneven steps.
  [[nodiscard]] bool gesture_open() const noexcept { return gesture_.has_value(); }
  [[nodiscard]] const doc::Document& document() const noexcept { return doc_; }
  [[nodiscard]] api::Time time() const noexcept { return time_; }
  [[nodiscard]] const doc::EditorView& view() const noexcept { return view_; }

  /// Say goodbye (engine shutting down) and close.
  void close(api::GoodbyeReason reason, std::string message);

  /// D2w: build viewport frames from the document with the engine's scene
  /// builder (render graph) instead of C2's quad scene. Null = C2's scene.
  /// Waits for the builds in flight first (the worker reads the builder).
  void set_frame_builder(FrameBuilder* builder);
  /// Item 7: builders for the prefetch workers (one worker each; empty = none).
  /// Owned by the caller, outliving the session; set before the first frame.
  void set_prefetch_builders(std::vector<FrameBuilder*> builders);
  /// Wait until every frame build handed to the build worker has been built
  /// and submitted to the sink, then take their reports (layer errors,
  /// cpuFrameMs) as tick() would. Tests: what makes a submit_frame observable
  /// right after the request that caused it. Core thread.
  void drain_builds();
  /// E2: the audio master clock + the document's sound (audio/transport_clock.hpp's
  /// seam). Null = the wall clock paces playback, no sound.
  void set_media_clock(MediaClock* clock) noexcept { mediaClock_ = clock; }
  /// B4 round 5: the rig as the overlays see it (the overlay push's `rig`, getRigPose;
  /// scene/rig_overlay.cpp). Null = the frame builder's (FrameBuilder::rig_queries), else none.
  void set_rig_queries(RigQueries* rig) noexcept { rigQueries_ = rig; }
  /// Engine jobs (jobs/job_api.hpp): the kinds this build runs. Null (the
  /// headless engine, most tests) = startJob answers `unsupported`.
  void set_job_kinds(jobs::JobKinds* kinds) noexcept { jobKinds_ = kinds; }
  /// convertLayer / separateLayer: fonts, text layout and SVG parsing
  /// (core/convert_geometry.hpp). Null (core-only builds, most tests) = those
  /// commands answer `unsupported`, as the TypeScript engine does.
  void set_convert_geometry(doc::ConvertGeometry* g) noexcept { convertGeometry_ = g; }
  /// Live performance input (core/live_port.hpp). Null (the headless engine,
  /// most tests) = startLiveInput / listCameras answer `unsupported`.
  void set_live_input(LivePort* live) noexcept { live_ = live; }

 private:
  enum class Phase : std::uint8_t { awaiting_hello, open, closed };

  // ── envelope ──
  void handle_hello(const api::Hello& hello);
  /// Close the open gesture as ONE committed history entry (§5.1: disconnect,
  /// reconnect). True when a gesture was open.
  bool commit_open_gesture();
  void handle_request(api::Request request, Clock::time_point now);
  void respond(api::Seq seq, api::Outcome outcome);
  void send_events(api::Revision from, api::Revision to, std::vector<api::Event> events, std::optional<api::Seq> seq,
                   api::Origin origin);
  void send_engine_error(api::ErrorCode code, std::string message, bool fatal);

  // ── commands ──
  friend struct ControlVisitor;
  friend struct EditVisitor;
  friend struct QueryVisitor;
  friend class SessionJobApply;
  [[nodiscard]] bool is_edit(const api::Command& cmd) const;
  std::vector<api::CommandResult> run_edits(const std::vector<const api::Command*>& commands, api::Origin origin,
                                            const std::optional<std::string>& batchLabel);
  api::CommandResult run_control(const api::Command& cmd, api::Origin origin, Clock::time_point now);
  /// One edit command inside the open journal (run_edits' body; a job's apply
  /// runs its commands through it). `label`: the entry label it would give.
  api::CommandResult run_in_journal(const api::Command& cmd, api::Origin origin, std::string* label);
  doc::HCtx handler_ctx(api::Origin origin);
  doc::PCtx pctx();
  void ensure_timelines();
  /// `touched`: the open journal (Document::journal) — the parts the request wrote so far.
  void stamp_missing_key_ids(const doc::Parts& touched, doc::HCtx& x);

  // ── history ──
  void apply_history(const doc::ChangeSet& target);
  api::HistoryState history_state() const;
  void emit_status();
  void emit_changes(api::Revision from, const doc::ChangeSet& changes);
  /// New Project (`createEmpty` + loadDocument). `emit` false at construction (before Welcome).
  void load_new_project(api::ResetReason reason, bool emit = true);
  /// loadDocument(doc, {resetWorkspace: true}) for a project file.
  /// `footageRoot`: the bundle the document's relative footage paths are read from (empty: none).
  void load_document(const doc::Json& file, api::ResetReason reason, std::string_view footageRoot = {});
  /// The document's state after a load: history, ids, caches, revision, reset event.
  void after_load(api::ResetReason reason, bool emit);
  [[nodiscard]] doc::Json capture_document() const;

  // ── queries ──
  api::QueryResult run_query(const api::Query& q);
  /// The folder relative media resolve against (FrameBuilder::set_media_base).
  [[nodiscard]] std::string media_base() const;
  /// getThumbnail: build (frame builder) and draw (render thread) a still.
  StillImage render_still(const doc::StillRequest& r);
  /// sampleImage (doc::ExprCache::pixelProbe): `node` drawn alone by the frame
  /// builder and read back by the render thread. On the build worker (which
  /// holds the build lock) or the core thread (which takes it, as hitTest does).
  std::shared_ptr<const doc::LayerPixels> probe_layer_pixels(const doc::DocExprEnv& env, std::string_view node, double t,
                                                             bool postEffect, std::string& error);
  /// How long an expression waits for the render thread to draw a layer it samples.
  static constexpr std::chrono::milliseconds kSampleImageWait{5000};
  /// renderDocumentStill: `file` restored into a scratch Document (the open one untouched), its `comp` at `time`.
  StillImage render_document_still(const doc::Json& file, const std::string& comp, api::Time time, std::uint32_t maxSize);
  /// A render-thread answer for the request being handled. Ready already →
  /// `finish` makes the query's result now. Otherwise the request is
  /// DEFERRED: its response is owed (deferred_), polled from tick(), sent when
  /// the render thread gets to it — and the hook answers HookAnswer::deferred
  /// so the query handler throws DeferredAnswer. This thread never waits on
  /// the renderer: a heavy frame in hand, a device-lost recovery or a run of
  /// thumbnails used to hold the document core (every edit, the transport and
  /// the heartbeat behind it) for seconds at a time, and the supervisor's hang
  /// window killed a healthy engine over it.
  template <class T>
  T await_render(std::future<T> result, std::string_view what, std::function<api::QueryResult(T)> finish);
  /// Outside a request (a hook used from a job, say) there is nothing to
  /// defer: bounded wait, then `pending` (busy; ask again).
  static constexpr std::chrono::milliseconds kRenderQueryTimeout{2000};
  /// A deferred answer the renderer never produced (its thread stuck, or the
  /// frame hopeless): the request fails `busy` after this, never silently.
  static constexpr std::chrono::seconds kDeferredBudget{60};
  /// How often tick() looks at the owed answers.
  static constexpr std::chrono::milliseconds kDeferredPoll{4};
  struct DeferredReply {
    api::Seq seq = 0;
    std::string what;
    Clock::time_point since;
    /// nullopt until the render thread answered; then the response's outcome.
    std::function<std::optional<api::Outcome>()> poll;
  };
  std::vector<DeferredReply> deferred_;
  void poll_deferred(Clock::time_point now);
  /// The core loop's clock as of the last request or tick (what deferred_ is budgeted against).
  Clock::time_point loopNow_{};

  // ── transport ──
  [[nodiscard]] std::optional<Clock::time_point> next_clock_deadline() const;
  void start_playback(Clock::time_point now, std::optional<api::Time> from);
  /// cacheFirst: store every frame of the play range, one at a time, then play it.
  void fill_cache(Clock::time_point now);
  void stop_playback();
  void rebase_playback(Clock::time_point now);
  void set_time(api::Time t);
  void seek_to(api::Time t);
  void emit_transport();
  void emit_playhead();
  void request_render() noexcept { renderDirty_ = true; }
  void flush_render();
  /// `fromClock`: a playback tick — a viewport whose previous job has not
  /// started yet gets no new build (back-pressure, below).
  void submit_frame(std::uint32_t clockDropped, bool fromClock = false);
  /// One viewport's job for the frame at `time_` (`announce`: report the layer errors).
  /// `prefetchFrame`: instead, an idle render-ahead job for that frame index
  /// (RenderJob::prefetch — stored, never presented; the clock is not touched).
  void submit_frame_to(const ViewportConfig& port, const std::string& comp, std::uint32_t clockDropped, bool announce,
                       std::optional<std::int64_t> prefetchFrame = std::nullopt);
  /// A surface's config as a frame of `comp` draws it: the per-frame editor
  /// state beside it (hidden layers, focus set, viewer LUT) and its comp-space
  /// geometry (ViewportConfig::compSpace) when the frame qualifies.
  [[nodiscard]] ViewportConfig frame_port(const ViewportConfig& surface, const std::string& comp) const;

  // ── idle render-ahead ──
  /// From tick(): with the transport stopped, no command for kIdlePrefetchAfter,
  /// no build / deferred answer / job / cached job outstanding and the last
  /// prefetch answered, the next uncached keyed frame of the play range — forward
  /// from the playhead, then backward — goes to the sink as a prefetch job.
  /// Stops at once on any command (the next one re-arms the delay), when the
  /// range is covered, or when the tiers refuse frames (the RAM budget is full
  /// of the range) — kIdlePrefetchRefusals in a row, until the next edit.
  void idle_prefetch(Clock::time_point now);
  /// Whether idle_prefetch has anything to do and may run now (next_deadline polls for it).
  [[nodiscard]] bool idle_prefetch_armed() const;
  /// A command (an edit, a seek, a viewport move) arrived: the prefetcher waits again.
  void note_activity(Clock::time_point now);
  static constexpr std::chrono::milliseconds kIdlePrefetchAfter{300};
  static constexpr std::chrono::milliseconds kIdlePrefetchPoll{2};
  static constexpr int kIdlePrefetchRefusals = 3;
  Clock::time_point lastActivity_{};
  /// The prefetch job out at the sink: its frame, its pre-build key, and the
  /// sink's answered count when it went (RenderCounters::prefetched moves when it is done).
  std::uint64_t prefetchSeenAnswered_ = 0;
  /// Prefetched frames the tiers did not keep, in a row; at kIdlePrefetchRefusals the prefetcher rests.
  int prefetchRefused_ = 0;
  bool prefetchResting_ = false;
  /// The frame the prefetcher stepped from, and how far it got each way (reset by every edit / seek).
  std::int64_t prefetchOrigin_ = -1;
  std::int64_t prefetchAhead_ = 0;
  std::int64_t prefetchBehind_ = 0;

  // ── the build worker ──
  // The frame builder (document → BuiltFrame, hundreds of ms on a heavy comp)
  // used to run on the core thread inside submit_frame_to, so every request
  // queued behind a playback tick waited for it. It now runs on the session's
  // build worker, one thread, one build at a time, and the core thread only
  // assembles the job (what to build, for which viewport, at which time and
  // revision) and hands it over. What makes that safe:
  //   • `buildMu_` (the build lock) is held by the worker for the whole build.
  //     The core thread takes it around everything that WRITES the document
  //     (run_edits, history, loads, a job's apply — BuildLock{write}) and
  //     around every other use of the frame builder, whose text measurer,
  //     fonts and memos are one object (thumbnails, hitTest, the text and rig
  //     queries — BuildLock{read}). Queries that only read the document never
  //     take it: readers on two threads are fine, and the document is written
  //     on the core thread only. So queries, the transport and the heartbeat
  //     run beside a build; an edit waits for at most the build in flight.
  //   • Determinism: a built frame is a pure function of (document revision,
  //     time, viewport). Every write-lock release bumps `docWrites_`; a task
  //     records the count when it is queued and the worker, holding the lock,
  //     skips a task whose count moved (the document is no longer the one the
  //     job describes) and asks the core thread for a fresh frame instead.
  //   • The worker has its own expression cache and expression environment
  //     over a copy of the editor view (the core thread writes `view_.tabTime`
  //     on every seek and tick): no state is shared with the core's queries.
  //   • Back-pressure keeps its meaning: a viewport whose last task has not
  //     STARTED building yet gets no new one from the clock (its frame is
  //     counted dropped, as a job the render thread had not started was).
  //   • The builder's per-layer errors and build time travel back as a report
  //     the core thread takes in tick() (announced once per frame, as before).
  struct BuildTask {
    RenderJob job;  ///< the job's metadata (viewport, frame, time, revision, cache scope); the worker fills the rest
    ViewportConfig port;
    std::string comp;
    api::Time time = 0;       ///< the frame's time (a held viewport's own, else the clock's)
    api::Time clockTime = 0;  ///< the transport clock (the overlays' time)
    bool playing = false;
    bool announce = false;
    std::string mediaBase;
    doc::EditorView view;
    std::optional<std::string> activeComp;
    std::vector<doc::OverlaySubscription> overlays;  ///< this viewport's subscriptions
    std::uint64_t writes = 0;                        ///< docWrites_ when queued
    std::uint64_t seq = 0;                           ///< enqueue order (buildSeq_): pump_builds dedupes skipped tasks by it
    /// A prefetch a prefetch worker could not build (it samples a layer's
    /// pixels, which only the main builder draws): the main worker's.
    bool mainOnly = false;
  };
  struct BuildReport {
    std::string comp;
    std::vector<api::LayerError> errors;
    double ms = 0;
    std::uint32_t viewport = 0;  ///< the task's viewport (a skip is re-requested only if nothing newer was queued for it)
    std::uint64_t seq = 0;       ///< the task's BuildTask::seq
    bool announce = false;
    bool skipped = false;  ///< the document moved on before the build began: build again
    bool cached = false;   ///< a cached frame (RenderJob::cachedKey): no build ran
  };
  /// The build lock as the core thread takes it. Nests (only the outermost
  /// locks); `write` marks a document write, which bumps docWrites_ when the
  /// outermost lock is released. Core thread only.
  class BuildLock {
   public:
    BuildLock(Session& s, bool write) : s_(s) {
      if (s_.buildLockDepth_++ == 0) {
        // A write announces itself before waiting: the build in flight is of a
        // document about to change, and stops at its next layer (BuildCancelled).
        if (write) {
          s_.editsWaiting_.fetch_add(1, std::memory_order_acq_rel);
          s_.prefetchYield_.fetch_add(1, std::memory_order_acq_rel);
        }
        s_.buildMu_.lock();
        if (write) {
          s_.prefetchYield_.fetch_sub(1, std::memory_order_acq_rel);
          s_.editsWaiting_.fetch_sub(1, std::memory_order_acq_rel);
        }
      }
      s_.buildLockWrote_ = s_.buildLockWrote_ || write;
    }
    ~BuildLock() {
      if (--s_.buildLockDepth_ != 0) return;
      if (s_.buildLockWrote_) {
        s_.buildLockWrote_ = false;
        s_.docWrites_.fetch_add(1, std::memory_order_release);
      }
      s_.buildMu_.unlock();
    }
    BuildLock(const BuildLock&) = delete;
    BuildLock& operator=(const BuildLock&) = delete;
    BuildLock(BuildLock&&) = delete;
    BuildLock& operator=(BuildLock&&) = delete;

   private:
    Session& s_;
  };
  class LockedText;
  friend class LockedText;
  class LockedRig;
  friend class LockedRig;
  /// Queue `task` for the worker (newest task per viewport wins), starting the worker on first use.
  void enqueue_build(BuildTask task);
  /// Whether a task for `viewport` is queued and not yet building (submit_frame's back-pressure).
  [[nodiscard]] bool build_pending(std::uint32_t viewport) const;
  /// Whether any task is queued or building (next_deadline polls for the reports meanwhile).
  [[nodiscard]] bool builds_active() const;
  void build_worker();
  /// One task: the build under the lock, then the job to the sink and a report to the core thread.
  void run_build(BuildTask task);
  /// After the builder (or without one): the C2 fallback scene, the overlays'
  /// geometry, views and rig records, the onion ghosts. On the worker with its
  /// own context, or on the core thread when this Session has no builder.
  void complete_job(BuildTask& t, const doc::PCtx& pc, TextQueries* text, RigQueries* rig);
  /// Take the worker's reports: cpuFrameMs, the layer errors, a rebuild for skipped tasks.
  void pump_builds();
  /// Item 7: the prefetch workers. Each builds idle render-ahead frames (never a
  /// frame a viewport shows, so their order does not matter) with a frame
  /// builder of its own — fonts, text measurer, walk cache — and an expression
  /// cache of its own, under a SHARED hold of the build lock: they build side by
  /// side, while the main worker (which holds it exclusively, as the core
  /// thread's BuildLock does) builds nothing. Plugins stay one call at a time
  /// (plugins::finish_native_frame). A frame that samples a layer's pixels goes
  /// back to the main worker (BuildTask::mainOnly).
  void prefetch_worker(std::size_t index);
  void run_prefetch_build(BuildTask t, std::size_t index);
  /// Whether the main worker builds, or has queued, a frame a viewport will show.
  [[nodiscard]] bool viewport_builds_active() const;
  /// The build lock: exclusive for the core thread's BuildLock and the main
  /// worker, shared by the prefetch workers.
  std::shared_mutex buildMu_;
  /// Core thread only: BuildLock nesting depth, and whether the outermost one wrote.
  std::uint32_t buildLockDepth_ = 0;
  bool buildLockWrote_ = false;
  std::atomic<std::uint64_t> docWrites_{0};
  /// Write locks waiting for buildMu_ (a BuildLock{write} between asking and
  /// holding it). The builder watches it between layers (FrameBuilder::
  /// set_cancel_flag): a build in flight stops at its next layer rather than
  /// make the edit wait for the whole frame, and the worker skips a queued task
  /// while it is non-zero rather than take the lock ahead of the edit.
  std::atomic<std::uint32_t> editsWaiting_{0};
  /// What an idle prefetch build gives way to — the prefetch builders' cancel
  /// flag, and the main builder's while it builds a prefetch: the edits waiting
  /// (counted with editsWaiting_) plus one while a paused viewport frame (a
  /// seek, a scrub step, an edit's redraw — yields_prefetch) is queued or
  /// waiting for the lock. A prefetch holds the lock shared and the viewport's
  /// frame needs it alone: without this a scrub that starts after the idle
  /// quiet period waited for every render-ahead build in flight.
  std::atomic<std::uint32_t> prefetchYield_{0};
  /// Under buildQueueMu_: prefetchYield_ holds the paused viewport frame's one.
  bool shownYield_ = false;
  /// Under buildQueueMu_: the main worker took a paused viewport frame and is waiting for the lock.
  bool shownLocking_ = false;
  /// A task a prefetch gives way to: a frame a viewport shows, not one paced by the
  /// play clock (render-ahead while playing is built beside those on purpose).
  [[nodiscard]] static bool yields_prefetch(const BuildTask& t) noexcept { return !t.job.prefetch && !t.job.playing; }
  /// Under buildQueueMu_: prefetchYield_'s paused-frame part after the queue or shownLocking_ changed.
  void sync_shown_yield_locked();
  /// The worker's expression cache (anim.hpp ExprCache memoises compiled sources; the
  /// core thread's `exprCache_` is written by its own queries). Under buildMu_.
  doc::ExprCache buildExprCache_;
  mutable std::mutex buildQueueMu_;
  std::condition_variable buildCv_;
  std::deque<BuildTask> buildQueue_;
  std::vector<BuildReport> buildReports_;
  /// Core thread only (enqueue_build and pump_builds both run there): the
  /// enqueue counter, and per viewport the seq of the newest frame task (not a
  /// prefetch) queued for it. A skipped task is built again only while it is
  /// still that newest task: the edit that cancelled it has usually queued the
  /// fresh frame already (flush_render after the command), and re-requesting
  /// it from the report as well built the same frame twice.
  std::uint64_t buildSeq_ = 0;
  std::map<std::uint32_t, std::uint64_t> lastFrameSeq_;
  bool buildBusy_ = false;
  bool viewportBusy_ = false;  ///< under buildQueueMu_: the main worker builds a viewport's frame
  int prefetchBusy_ = 0;       ///< under buildQueueMu_: prefetch workers building
  bool buildStop_ = false;
  /// The prefetch workers' builders (engine-owned) and their expression caches.
  std::vector<FrameBuilder*> prefetchBuilders_;
  std::vector<std::unique_ptr<doc::ExprCache>> prefetchExprCaches_;
  /// Core thread: prefetch jobs sent and not yet answered (their pre-build keys).
  std::vector<std::uint64_t> prefetchOut_;
  std::unique_ptr<TextQueries> lockedText_;
  std::unique_ptr<RigQueries> lockedRig_;
  [[nodiscard]] std::optional<std::string> active_comp() const;
  [[nodiscard]] api::Time frame_dur() const;
  struct Range {
    std::int64_t first = 0;  // first frame index
    std::int64_t last = 0;   // last frame index (inclusive)
  };
  [[nodiscard]] Range play_range() const;
  /// The frames idle render-ahead fills: the work area when the comp has one, else the whole comp.
  [[nodiscard]] Range prefetch_range() const;
  /// The frame indices (inclusive) `kind` plays: the comp, its work area or the custom range.
  [[nodiscard]] Range frame_range(api::PlayRange kind) const;
  /// RenderJob::cacheScope for a frame of `comp` built with `port`: the comp,
  /// the document revision and the viewport's view state as one word.
  [[nodiscard]] std::uint64_t cache_scope(const ViewportConfig& port, const std::string& comp);
  void emit_stats(Clock::time_point now);
  /// A2: the figures getRenderStats and renderStatsUpdated share (VRAM, decode, slot switch).
  [[nodiscard]] api::RenderStats render_stats();

  Outbox& out_;
  FrameSink& sink_;
  SessionOptions options_;
  Phase phase_ = Phase::awaiting_hello;

  // ── the document and what edits it ──
  doc::Document doc_;
  doc::EditorView view_;
  doc::IdAllocator ids_;
  /// Query-side catalog cache (queries.hpp QCtx::catalogs); cleared before every command.
  std::unordered_map<std::string, doc::Catalog> catalogCache_;
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
  api::Revision revision_ = 0;
  api::Revision savedRevision_ = 0;
  std::string projectPath_;
  /// F2: the `.motion` bundle the document's `motion-blob:` footage lives in —
  /// the bundle last opened or saved to (not a copy); '' = none. A bundle save
  /// collects from it (bundle_io.hpp).
  std::string bundleRoot_;
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
  /// nullopt: the request's answer is deferred (deferred_), no response yet.
  std::optional<api::Outcome> handle_request_body(const api::Request& request, Clock::time_point now);

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
  /// cacheFirst fill: the next frame index to store, and the render count when
  /// the in-flight frame was submitted (it landed when `rendered` moves).
  std::int64_t cacheFrame_ = 0;
  std::uint64_t cacheSeenRendered_ = 0;
  bool cacheInFlight_ = false;
  /// The viewport whose frames the fill waits on (FrameSink::port_counters):
  /// the first open comp viewport that records coverage; 0 = none yet.
  std::uint32_t cacheViewport_ = 0;
  /// The stand-in count when the in-flight frame was submitted: it moved = the
  /// frame drew with a stand-in and was not stored, so the fill draws it again
  /// (its decode catching up) until `cacheRetryUntil_`, then moves on.
  std::uint64_t cacheSeenStandIn_ = 0;
  std::optional<Clock::time_point> cacheRetryUntil_;
  /// play{cacheOnly}: the fill stops when the range is stored and the playhead
  /// returns to `cacheReturn_` (where it was before the fill).
  bool cacheOnly_ = false;
  api::Time cacheReturn_ = 0;
  /// P9: frames dropped so far (sink + clock) when the current loop pass
  /// began, and whether this play already switched to a fill once.
  std::uint64_t passDropBase_ = 0;
  bool autoFilled_ = false;
  /// A play-once pass dropped frames: the next Play stores the range first.
  bool nextPlayCachesFirst_ = false;
  /// Frames the viewer did not get right so far: dropped (sink + clock), or
  /// shown with footage from a nearest decoded frame (RenderCounters::inexact).
  [[nodiscard]] std::uint64_t drops_so_far() const;
  /// cache_scope's view-state ids: equal configs (operator==) share one, so a
  /// view put back (a pane, a zoom, a resolution) is the scope it was.
  std::vector<std::pair<ViewportConfig, std::uint64_t>> scopeConfigs_;
  std::uint64_t scopeConfigSeq_ = 0;
  /// The revision half of a cache scope (its low word): the revision, mixed.
  [[nodiscard]] static std::uint32_t revision_word(api::Revision revision) noexcept;

  // ── cached playback without a build (core/frame_keys.hpp, render/coverage_ledger.hpp) ──
  /// The active comp's per-frame document keys. Follows the active comp
  /// (sync_frame_keys) and every commit (note_document_changed).
  doc::FrameKeyIndex frameKeys_;
  void sync_frame_keys();
  /// After every revision bump: the index follows `changes` (null = the whole
  /// document changed) and the sink learns which frames the step touched.
  void note_document_changed(api::Revision from, const doc::ChangeSet* changes);
  /// Viewports whose next frame must be BUILT (FrameSink::take_build_requests:
  /// a cached job found no tier holding its frame; a pixel read of a frame the
  /// render thread has no build of).
  std::vector<std::uint32_t> forceBuild_;
  /// Cached jobs handed to the sink, and how many it has answered (served,
  /// missed or dropped) as of the last look: while some are outstanding the
  /// core loop polls the sink for build requests (next_deadline), for at most
  /// kCachedPoll after the last one.
  std::uint64_t cachedSubmitted_ = 0;
  std::uint64_t cachedAnswered_ = 0;
  /// This play's frames: ticked, with a pre-build key, sent as cached (no build).
  /// Logged when it stops (`playback_summary`): why a cached comp still builds.
  struct PlayTally {
    std::uint64_t frames = 0;
    std::uint64_t keyed = 0;
    std::uint64_t cached = 0;
  } playTally_;
  Clock::time_point cachedPollUntil_{};
  static constexpr std::chrono::seconds kCachedPoll{2};
  void poll_build_requests();
  std::uint64_t playheadSkipped_ = 0;
  Clock::time_point lastStats_{};

  /// Every open viewport (setViewport / closeViewport), by id: the editor's,
  /// a pop-out window's, a second view. Each gets its own frame per tick,
  /// built with its own camera, into its own ring (FrameSink).
  std::map<std::uint32_t, ViewportConfig> surfaces_;
  /// setViewportHiddenLayers: the layers each viewport does not draw (editor
  /// state, kept beside the surface config so a setViewport per pointer move
  /// does not reset it). Absent = every layer draws.
  std::map<std::uint32_t, std::vector<std::string>> hiddenLayers_;
  /// setViewportFocus: Focus Mode's working set per viewport (editor state,
  /// beside the surface config like `hiddenLayers_`). Absent = no focus.
  std::map<std::uint32_t, std::vector<std::string>> focusLayers_;
  [[nodiscard]] bool any_viewport_open() const noexcept { return !surfaces_.empty(); }
  double resolution_ = 1.0;
  /// setPreviewQuality `draft3d`, applied to every viewport.
  bool draft3d_ = false;
  /// setPreviewQuality `motionBlur`, applied to every viewport.
  bool previewMotionBlur_ = true;
  /// setViewerLut (editor state): null = none. Shared with the frame jobs (see ViewportConfig::viewerLut).
  std::shared_ptr<const ViewerLut> viewerLut_;
  /// setUseProxies (editor state): viewport frames decode footage from its
  /// enabled proxy. Off until the page says otherwise; exports never read it.
  bool useProxies_ = false;
  bool renderDirty_ = false;
  /// B4 round 2: the overlay geometry push (setOverlayGeometry) — at most one subscription per viewport.
  std::vector<doc::OverlaySubscription> overlays_;

  // D2w / E2 hooks (session_hooks.hpp) and their bookkeeping.
  FrameBuilder* frameBuilder_ = nullptr;
  MediaClock* mediaClock_ = nullptr;
  RigQueries* rigQueries_ = nullptr;
  /// The rig hook in effect: set_rig_queries', else the frame builder's.
  [[nodiscard]] RigQueries* rig_queries() const noexcept {
    return rigQueries_ != nullptr ? rigQueries_ : frameBuilder_ != nullptr ? frameBuilder_->rig_queries() : nullptr;
  }
  /// B4 round 5: fill the `rig` records of a frame's geometry for the layers `o` subscribes with the rig kind.
  /// `rig`, `text` and the context are the caller's (the worker's or the core thread's).
  void attach_overlay_rig(RigQueries* rig, TextQueries* text, const doc::PCtx& pc, const doc::OverlaySubscription& o,
                          api::Time time, std::vector<api::OverlayLayerGeometry>& geometry);
  /// Onion skins: ghost frames for this viewport, reused while the playhead,
  /// the document and the camera stay put. Worker thread only (a Session
  /// without a frame builder draws no onion skins).
  struct OnionMemo {
    std::uint64_t revision = ~std::uint64_t{0};
    std::int64_t frame = -1;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    double zoom = 0;
    double panX = 0;
    double panY = 0;
    double dpr = 0;
    std::string view;
    std::optional<CustomViewParams> custom;
    api::OnionSkin settings{};
    std::vector<RenderJob::OnionGhost> ghosts;
  };
  std::map<std::uint32_t, OnionMemo> onionMemo_;
  void attach_onion(BuildTask& t, const doc::PCtx& pc);
  std::vector<api::LayerError> layerErrors_;   // the set last announced (layerErrors event)
  std::string layerErrorsComp_;
  /// D5: the frame builder's CPU time per frame (ms, moving average) — the
  /// half of the engine's frame cost the render thread's gpuFrameMs does not
  /// see (RenderStats.cpuFrameMs). Measurement only, never an input to pixels.
  double buildMs_ = 0;
  /// The builds' own time (buildMs_ without the decay a cache-served frame adds): render-ahead's lead.
  double builtMs_ = 0;
  /// The last frame a play submitted came from the tiers (no build): render-ahead may use the idle worker.
  bool playFromCache_ = false;
  api::Revision audioRevision_ = ~api::Revision{0};  // document revision the audio program was built from
  std::string audioComp_;
  bool mediaPaced_ = false;           // the last tick was paced by the audio clock
  double mediaElapsed_ = 0;           // …and read this many media seconds
  Clock::time_point mediaReadAt_{};   // …at this time
  void sync_audio();
  void announce_layer_errors(const std::string& comp, std::vector<api::LayerError> errors);

  // ── jobs (jobs/job_api.hpp; ENGINE_API.md §4.9) ──
  struct JobRecord {
    api::JobInfo info;
    bool apply = true;
    /// A finished result not applied yet (apply=false → applyJobResult; or held while a gesture is open).
    std::unique_ptr<jobs::JobResult> result;
  };
  jobs::JobKinds* jobKinds_ = nullptr;
  doc::ConvertGeometry* convertGeometry_ = nullptr;

  // ── live performance input (core/session_live.cpp) ──
  LivePort* live_ = nullptr;
  api::CommandResult start_live(const api::StartLiveInput& c);
  api::CommandResult stop_live();
  api::QueryResult list_cameras();
  /// Relay the live input's newest state / frame as a `liveInput` event (core thread, from tick()).
  void poll_live();
  std::unique_ptr<jobs::JobRunner> runner_;
  std::vector<JobRecord> jobs_;
  std::uint64_t jobSeq_ = 0;
  Clock::time_point jobsPolled_{};
  api::CommandResult start_job(const api::StartJob& c);
  api::CommandResult cancel_job(const api::CancelJob& c);
  JobRecord* find_job(const std::string& id);
  /// JobDocContext.layerToComp over this document (world2DAt; nullopt for 3D).
  std::function<std::optional<std::array<double, 6>>(std::string_view, double)> layer_to_comp();
  std::function<std::vector<std::pair<std::string, double>>(std::string_view, double)> layer_values();
  /// JobDocContext.layerSize over this document (layer_geometry_at's base box).
  std::function<std::optional<std::array<double, 2>>(std::string_view, double)> layer_size();
  /// Drain the runner: progress events, results applied (core thread, from tick()).
  void poll_jobs(Clock::time_point now);
  /// Apply a held result as ONE history entry (origin engine). False with the error recorded on the job.
  bool apply_job(JobRecord& r);
  void emit_job(const JobRecord& r, bool finished, const std::optional<api::EngineError>& error);
  /// A new / opened document: running jobs read the old one — cancel them, drop held results.
  void drop_jobs();
  /// applyJobResult: the held result's commands inside the request's journal.
  api::CommandResult apply_job_in_journal(const api::ApplyJobResult& c, api::Origin origin, std::string& label);
  /// What an applyJobResult request wrote: its job's commands, kept until the
  /// request is logged so the log holds them instead of the applyJobResult
  /// (a replay has no held result to apply).
  struct JobLog {
    std::string job;
    std::string label;
    std::vector<api::Command> edits;
  };
  std::optional<JobLog> jobLog_;
  /// A job's applied edit as the request a crash replay writes instead of the
  /// job (schema LogRecord.job): the job's startJob row dropped from `log_`,
  /// the edits appended as one batch, and the record sent to the client.
  void log_job_edit(const std::string& job, std::string label, std::vector<api::Command> edits);
  /// The autoTrace COMMAND: the autoTrace job's trace run to completion on this
  /// thread, its masks written inside the request's journal (one entry);
  /// answers the added mask groups (session_jobs.cpp).
  api::CommandResult auto_trace_in_journal(const api::AutoTrace& c, api::Origin origin, std::string& label);
  /// P7a runPluginCommand: the plugin's command run inside the request's journal (one entry), its edits
  /// kept in jobLog_ for the log (session_plugins.cpp).
  api::CommandResult run_plugin_command_in_journal(const api::RunPluginCommand& c, api::Origin origin, std::string& label);

  /// The prefetch workers (item 7) and the build worker. LAST: joined (after
  /// ~Session told them to stop) before any member they read goes away.
  std::vector<JoiningThread> prefetchThreads_;
  JoiningThread buildThread_;
};

/// The seq of a Request inside an EngineMessage that failed to decode (so
/// the client's pending request can still be answered). nullopt when the
/// bytes are not a request or the seq itself is unreadable.
[[nodiscard]] std::optional<api::Seq> peek_request_seq(std::span<const std::uint8_t> payload) noexcept;

}  // namespace premation
