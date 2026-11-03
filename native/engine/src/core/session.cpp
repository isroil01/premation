#include "session.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <filesystem>
#include <limits>
#include <thread>
#include <type_traits>
#include <unordered_set>
#include <utility>
#include <variant>

#include "catalog_data.hpp"
#include "docio.hpp"
#include "fail.hpp"
#include "fxstate.hpp"
#include "handlers.hpp"
#include "handlers_common.hpp"
#include "log.hpp"
#include "native_effects.hpp"
#include "queries.hpp"
#include "readmodel.hpp"
#include "scene.hpp"
#include "scene_build.hpp"
#include "onion_skin.hpp"
#include "render/coverage_ledger.hpp"
#include "scene/media_reload.hpp"
#include "subject_files.hpp"
#include "time_conv.hpp"
#include "variant_util.hpp"

namespace premation {
namespace {

using api::ErrorCode;
using Clock = Session::Clock;
using doc::EngineFail;
using doc::fail;

/// The session's build worker (it holds the build lock for each whole build).
thread_local bool tlBuildWorker = false;
/// A prefetch worker's sampleImage: only the main builder draws a layer alone.
struct NeedsMainBuilder {};

api::EngineError err(ErrorCode code, std::string message) {
  api::EngineError e;
  e.code = code;
  e.message = std::move(message);
  return e;
}

api::EngineError decode_error(wire::Status s) {
  api::EngineError e = err(s == wire::Status::unknown_variant ? ErrorCode::unsupported : ErrorCode::decode,
                           "could not decode the message: " + std::string(wire::to_string(s)));
  e.detail = "{\"status\":\"" + std::string(wire::to_string(s)) + "\"}";
  return e;
}

double resolution_factor(api::PreviewResolution r) {
  switch (r) {
    case api::PreviewResolution::full: return 1.0;
    case api::PreviewResolution::half: return 0.5;
    case api::PreviewResolution::third: return 1.0 / 3.0;
    case api::PreviewResolution::quarter: return 0.25;
    case api::PreviewResolution::auto_: return 1.0;  // adaptive quality not implemented: full
  }
  return 1.0;
}

std::int64_t floor_div(std::int64_t a, std::int64_t b) {
  const std::int64_t q = a / b;
  return (a % b != 0 && ((a < 0) != (b < 0))) ? q - 1 : q;
}
std::int64_t mod_pos(std::int64_t a, std::int64_t b) {
  const std::int64_t m = a % b;
  return m < 0 ? m + b : m;
}

std::uint32_t command_id(const api::Command& c) { return static_cast<std::uint32_t>(c.kind()); }

std::string command_name(const api::Command& c) {
  const auto& names = doc::registry().commandNames;
  const auto it = names.find(command_id(c));
  return it != names.end() ? it->second : "command " + std::to_string(command_id(c));
}

/// `humanize(type)`: 'createLayer' → 'Create Layer'.
std::string humanize(const std::string& type) {
  std::string out;
  for (std::size_t i = 0; i < type.size(); ++i) {
    const char ch = type[i];
    if (ch >= 'A' && ch <= 'Z') out.push_back(' ');
    out.push_back(ch);
  }
  if (!out.empty() && out[0] >= 'a' && out[0] <= 'z') out[0] = static_cast<char>(out[0] - 'a' + 'A');
  return out;
}

api::EngineError with_index(api::EngineError e, std::optional<std::uint32_t> index) {
  if (index && !e.command_index) e.command_index = index;
  return e;
}

}  // namespace

// ── Edit dispatch ───────────────────────────────────────────────────────────

struct EditVisitor {
  doc::HCtx& x;
  const std::string& name;

  template <class T>
  api::CommandResult operator()(const T& c) const {
    if constexpr (requires(const T& cmd, doc::HCtx& ctx) { doc::handle(cmd, ctx); }) {
      return result_for<T>(doc::handle(c, x));
    } else {
      fail(ErrorCode::unsupported, "'" + name + "' is not implemented by this engine");
    }
  }
};

// ── the frame builder's queries, under the build lock ───────────────────────
// The text measurer and the rig are the frame builder's (one object, with its
// fonts and memos), which the build worker uses while it builds: the query
// side reaches them through these, each call under the build lock.

class Session::LockedText final : public TextQueries {
 public:
  explicit LockedText(Session& s) : s_(s) {}
  api::TextLayout text_layout(const doc::Node& n, const api::TextLayoutOverrides* overrides) override {
    const BuildLock lock(s_, false);
    return s_.frameBuilder_->text_queries()->text_layout(n, overrides);
  }
  std::optional<TextGeometry> text_geometry(const doc::Node& n,
                                            const std::vector<std::pair<std::string, double>>& overrides) override {
    const BuildLock lock(s_, false);
    return s_.frameBuilder_->text_queries()->text_geometry(n, overrides);
  }

 private:
  Session& s_;
};

class Session::LockedRig final : public RigQueries {
 public:
  explicit LockedRig(Session& s) : s_(s) {}
  std::optional<api::OverlayRig> rig_overlay(const doc::Document& d, const doc::EditorView& view, const doc::ExprEnv& expr,
                                             doc::ExprCache& cache, TextQueries* text, std::string_view layer, double seconds,
                                             const api::OverlayRigOptions& opts) override {
    const BuildLock lock(s_, false);
    return s_.rig_queries()->rig_overlay(d, view, expr, cache, text, layer, seconds, opts);
  }
  api::RigPose rig_pose(const doc::Document& d, const doc::EditorView& view, const doc::ExprEnv& expr, doc::ExprCache& cache,
                        TextQueries* text, std::string_view layer, double seconds, const std::vector<api::Vec2>& points,
                        std::optional<std::uint32_t> vertex, bool authoring) override {
    const BuildLock lock(s_, false);
    return s_.rig_queries()->rig_pose(d, view, expr, cache, text, layer, seconds, points, vertex, authoring);
  }

 private:
  Session& s_;
};

// ── Session ─────────────────────────────────────────────────────────────────

Session::Session(Outbox& out, FrameSink& sink, SessionOptions options)
    : out_(out), sink_(sink), options_(std::move(options)) {
  if (options_.testPorts) ports_ = std::make_unique<doc::FakePorts>(options_.testPortsDir);
  else {
    auto files = std::make_unique<doc::FilePorts>(options_.mediaProbe);
    files->set_footage_dir(options_.footageDir);
    ports_ = std::move(files);
  }
  // The frame-key index (core/frame_keys.hpp) holds itself to a share of the machine's RAM.
  if (options_.hostMemory) frameKeys_.set_budget_bytes(doc::FrameKeyIndex::budget_for(options_.hostMemory().physicalBytes));
  // The engine starts on a new project, as the editor does (New Project →
  // `comp_root`), at revision 0.
  load_new_project(api::ResetReason::created, false);
  revision_ = 0;
  savedRevision_ = 0;
  // sampleImage draws through this session's builder and render thread, in queries and builds alike.
  const doc::PixelProbe probe = [this](const doc::DocExprEnv& env, std::string_view node, double t, bool postEffect,
                                       std::string& error) { return probe_layer_pixels(env, node, t, postEffect, error); };
  exprCache_.pixelProbe = probe;
  buildExprCache_.pixelProbe = probe;
}

Session::~Session() {
  // Stop the build workers before any member they read goes (buildThread_, the
  // last member, joins it). A task still queued is dropped with the session.
  {
    const std::lock_guard<std::mutex> lock(buildQueueMu_);
    buildStop_ = true;
  }
  buildCv_.notify_all();
  for (JoiningThread& t : prefetchThreads_) t.join();
  buildThread_.join();
}

void Session::set_prefetch_builders(std::vector<FrameBuilder*> builders) {
  drain_builds();
  prefetchBuilders_ = std::move(builders);
  prefetchExprCaches_.clear();
  for (FrameBuilder* b : prefetchBuilders_) {
    b->set_cancel_flag(&editsWaiting_);
    auto cache = std::make_unique<doc::ExprCache>();
    // sampleImage draws through the main builder: such a frame is the main worker's.
    cache->pixelProbe = [](const doc::DocExprEnv&, std::string_view, double, bool, std::string&) -> std::shared_ptr<const doc::LayerPixels> {
      throw NeedsMainBuilder{};
    };
    prefetchExprCaches_.push_back(std::move(cache));
  }
}

void Session::set_frame_builder(FrameBuilder* builder) {
  drain_builds();  // the worker reads frameBuilder_ while it builds
  frameBuilder_ = builder;
  if (frameBuilder_ != nullptr) frameBuilder_->set_cancel_flag(&editsWaiting_);
}

void Session::on_frame(std::span<const std::uint8_t> payload, Clock::time_point now) {
  if (phase_ == Phase::closed) return;
  api::EngineMessage message;
  wire::Reader reader(payload);
  const wire::Status st = api::decode(reader, message);
  if (st != wire::Status::ok) {
    PREMATION_LOG(warn, "decode_failed").kv("status", wire::to_string(st)).kv("bytes", payload.size());
    if (phase_ == Phase::awaiting_hello) {
      close(api::GoodbyeReason::protocol_error, "the first message must be a Hello");
      return;
    }
    if (const auto seq = peek_request_seq(payload)) {
      scope_ = RequestScope{*seq, api::Origin::ui, std::nullopt};
      api::Outcome o;
      o.v = decode_error(st);
      respond(*seq, std::move(o));
      scope_.reset();
    } else {
      send_engine_error(ErrorCode::decode, "undecodable message: " + std::string(wire::to_string(st)), false);
    }
    return;
  }
  on_message(std::move(message), now);
}

void Session::on_message(api::EngineMessage message, Clock::time_point now) {
  if (phase_ == Phase::closed) return;
  switch (message.kind()) {
    case api::EngineMessage::Kind::hello:
      // A Hello on an OPEN session is a client reconnect (the editor page was
      // reloaded while this process lived on): what the old client left
      // behind is settled (handle_hello) and a fresh Welcome goes out.
      handle_hello(std::get<api::Hello>(message.v));
      return;
    case api::EngineMessage::Kind::goodbye:
      PREMATION_LOG(info, "goodbye_received").kv("message", std::get<api::Goodbye>(message.v).message);
      on_disconnect();
      phase_ = Phase::closed;
      return;
    case api::EngineMessage::Kind::request:
      if (phase_ != Phase::open) {
        close(api::GoodbyeReason::protocol_error, "the first message must be a Hello");
        return;
      }
      handle_request(std::move(std::get<api::Request>(message.v)), now);
      return;
    case api::EngineMessage::Kind::welcome:
    case api::EngineMessage::Kind::response:
    case api::EngineMessage::Kind::events:
    case api::EngineMessage::Kind::log_record:
      if (phase_ == Phase::awaiting_hello) {
        close(api::GoodbyeReason::protocol_error, "the first message must be a Hello");
        return;
      }
      send_engine_error(ErrorCode::invalid_argument, "engine-to-client message received from the client; ignored",
                        false);
      return;
  }
}

void Session::handle_hello(const api::Hello& hello) {
  if (hello.protocol_major != api::kProtocolMajor) {
    PREMATION_LOG(warn, "version_mismatch").kv("client", hello.protocol_major).kv("engine", api::kProtocolMajor);
    close(api::GoodbyeReason::version_mismatch,
          "protocol major " + std::to_string(hello.protocol_major) + " is not supported; this engine speaks " +
              std::to_string(api::kProtocolMajor) + "." + std::to_string(api::kProtocolMinor));
    return;
  }
  const bool reconnect = phase_ == Phase::open;
  if (reconnect) {
    // The previous client is gone as far as this session is concerned: a page
    // reload (location.reload) keeps the engine process, so nothing ever
    // called on_disconnect, and a gesture the old page opened (an AI turn, a
    // drag) would hold the one gesture slot forever — every later beginGesture
    // answers gestureOpen and the new page cannot edit. Settle it exactly as a
    // disconnect does (§5.1): COMMIT, not discard. The edits were applied and
    // shown while they were made, so committing loses nothing the user saw and
    // keeps them undoable as one entry; discarding would silently revert work
    // the user may already have saved on. Playback stops like on a disconnect:
    // the new page starts from a stopped transport.
    const bool closed = commit_open_gesture();
    stop_playback();
    PREMATION_LOG(info, "client_reconnect").kv("client", hello.client).kv("gestureCommitted", closed);
  }
  const bool wantShared = std::find(hello.capabilities.begin(), hello.capabilities.end(), "frames.sharedTexture") !=
                          hello.capabilities.end();
  const bool shared = wantShared && sink_.shared_supported();
  sink_.set_shared(shared);
  // Route A (docs/VIEWPORT_ROUTE.md): a host that cannot import this engine's
  // shared slots (Linux, macOS without the host bridge) takes read-back copies.
  const bool wantCopy = std::find(hello.capabilities.begin(), hello.capabilities.end(), "frames.copy") !=
                        hello.capabilities.end();
  const bool copy = !shared && wantCopy && sink_.copy_supported();
  sink_.set_copy(copy);
  api::Welcome w;
  w.protocol_major = api::kProtocolMajor;
  w.protocol_minor = api::kProtocolMinor;
  w.engine = "premation-engine";
  w.engine_version = options_.engineVersion;
  w.revision = revision_;
  w.session_id = options_.sessionId;
  w.capabilities = {"frames.channel", "frames.offscreen", "heartbeat"};
  if (sink_.shared_supported()) w.capabilities.emplace_back("frames.sharedTexture");
  if (sink_.copy_supported()) w.capabilities.emplace_back("frames.copy");
  api::EngineMessage m;
  m.v = std::move(w);
  out_.send(m);
  phase_ = Phase::open;
  PREMATION_LOG(info, "welcome")
      .kv("client", hello.client)
      .kv("clientVersion", hello.client_version)
      .kv("minor", hello.protocol_minor)
      .kv("sharedFrames", shared)
      .kv("copyFrames", copy);
  // A reconnected client reads the gesture slot from the status it gets now.
  if (reconnect) emit_status();
}

bool Session::commit_open_gesture() {
  if (!gesture_) return false;
  Gesture g = std::move(*gesture_);
  gesture_.reset();
  g.changes.prune();
  if (!g.changes.empty()) history_.push(doc::Entry{g.label, g.origin, std::move(g.changes)});
  return true;
}

void Session::close(api::GoodbyeReason reason, std::string message) {
  if (phase_ == Phase::closed) return;
  stop_playback();
  deferred_.clear();  // nobody to answer; the futures' producers notice nothing
  api::EngineMessage m;
  m.v = api::Goodbye{reason, std::move(message)};
  out_.send(m);
  phase_ = Phase::closed;
}

void Session::on_disconnect() {
  // A gesture still open when the client goes away is COMMITTED (§5.1).
  commit_open_gesture();
  stop_playback();
  deferred_.clear();
  // Nobody is watching: the camera goes off with the editor.
  if (live_ != nullptr) live_->stop();
}

void Session::on_ping(std::uint64_t nonce, std::uint32_t queued) {
  // From the core thread itself: it drained its queue to this ping (busyMs 0;
  // the watchdog's busy pongs come from engine_process.cpp CoreWatchdog).
  api::FramePong pong;
  pong.nonce = nonce;
  pong.revision = revision_;
  pong.playing = playing_;
  pong.queued = queued;
  out_.send_frames(frames::Message{.v = std::move(pong)});
}

void Session::respond(api::Seq seq, api::Outcome outcome) {
  flush_scope();  // the request's one EventBatch goes first (§8.1)
  api::EngineMessage m;
  m.v = api::Response{seq, revision_, std::move(outcome)};
  out_.send(m);
}

void Session::flush_scope() {
  if (!scope_ || !scope_->pending) return;
  api::EngineMessage m;
  m.v = std::move(*scope_->pending);
  scope_->pending.reset();
  out_.send(m);
}

void Session::send_events(api::Revision from, api::Revision to, std::vector<api::Event> events,
                          std::optional<api::Seq> seq, api::Origin origin) {
  if (events.empty() && from == to) return;
  if (scope_) {
    // Inside a request: fold into its single batch, attributed to it.
    if (scope_->pending) {
      api::EventBatch& p = *scope_->pending;
      p.to_revision = std::max(p.to_revision, to);
      for (auto& e : events) p.events.push_back(std::move(e));
      return;
    }
    api::EventBatch b;
    b.from_revision = from;
    b.to_revision = to;
    b.events = std::move(events);
    b.caused_by = scope_->seq;
    b.origin = scope_->origin;
    scope_->pending = std::move(b);
    return;
  }
  api::EventBatch b;
  b.from_revision = from;
  b.to_revision = to;
  b.events = std::move(events);
  b.caused_by = seq;
  b.origin = origin;
  api::EngineMessage m;
  m.v = std::move(b);
  out_.send(m);
}

void Session::send_engine_error(ErrorCode code, std::string message, bool fatal) {
  std::vector<api::Event> ev;
  ev.push_back(make_event(api::EngineErrorEvent{err(code, std::move(message)), fatal}));
  send_events(revision_, revision_, std::move(ev), std::nullopt, api::Origin::engine);
}

// ── the request loop (LocalEngine.handle) ───────────────────────────────────

void Session::handle_request(api::Request request, Clock::time_point now) {
  if (options_.activity) {
    switch (request.body.kind()) {
      case api::RequestBody::Kind::command:
        options_.activity("command " + command_name(std::get<api::Command>(request.body.v)));
        break;
      case api::RequestBody::Kind::query:
        options_.activity("query " + std::to_string(static_cast<std::uint32_t>(std::get<api::Query>(request.body.v).kind())));
        break;
      case api::RequestBody::Kind::batch:
        options_.activity("batch " + std::get<api::CommandBatch>(request.body.v).label);
        break;
    }
  }
  loopNow_ = now;
  // A command is the user at work (an edit, a seek, a pane move): the idle
  // prefetcher stands back. Queries (the UI polling coverage, stats) are not.
  if (request.body.kind() != api::RequestBody::Kind::query) note_activity(now);
  scope_ = RequestScope{request.seq, request.origin, std::nullopt};
  std::optional<api::Outcome> o = handle_request_body(request, now);
  if (o) respond(request.seq, std::move(*o));
  else flush_scope();  // deferred: the response follows from poll_deferred, its events (none, for a query) first
  scope_.reset();
  flush_render();
}

std::optional<api::Outcome> Session::handle_request_body(const api::Request& request, Clock::time_point now) {
  api::Outcome o;
  jobLog_.reset();
  try {
    if (request.base_revision && *request.base_revision != revision_) {
      fail(ErrorCode::conflict,
           "the document is at revision " + std::to_string(revision_) + ", not " + std::to_string(*request.base_revision),
           {.detail = "{\"revision\":" + std::to_string(revision_) + "}"});
    }
    switch (request.body.kind()) {
      case api::RequestBody::Kind::query: {
        o.v = run_query(std::get<api::Query>(request.body.v));
        return o;
      }
      case api::RequestBody::Kind::command: {
        catalogCache_.clear();
        ensure_timelines();
        const api::Command& cmd = std::get<api::Command>(request.body.v);
        api::CommandResult r;
        if (is_edit(cmd)) {
          r = std::move(run_edits({&cmd}, request.origin, std::nullopt).at(0));
        } else {
          r = run_control(cmd, request.origin, now);
        }
        if ((cmd.kind() == api::Command::Kind::apply_job_result || cmd.kind() == api::Command::Kind::run_plugin_command) && jobLog_) {
          // The job's commands are the record (a replay has no held result);
          // an empty apply wrote nothing and is not logged.
          JobLog applied = std::move(*jobLog_);
          jobLog_.reset();
          if (!applied.edits.empty()) log_job_edit(applied.job, std::move(applied.label), std::move(applied.edits));
          o.v = std::move(r);
          return o;
        }
        api::LogRecord row{request, revision_, 0, std::nullopt};
        if (cmd.kind() == api::Command::Kind::start_job) {
          // A transcribe job's provider key (Electron main put it there) is
          // never kept: the logged copy goes without it.
          auto& logged = std::get<api::StartJob>(std::get<api::Command>(row.request.body.v).v);
          if (auto* t = std::get_if<api::TranscribeJob>(&logged.job.v)) t->credential.reset();
        }
        if (cmd.kind() == api::Command::Kind::start_job) {
          const std::optional<std::string> id = std::visit(
              [](const auto& x) -> std::optional<std::string> {
                if constexpr (std::is_same_v<std::decay_t<decltype(x)>, api::JobRef>) return x.job;
                else return std::nullopt;
              },
              r.v);
          if (id) row.job = *id;
        }
        log_.push_back(std::move(row));
        o.v = std::move(r);
        return o;
      }
      case api::RequestBody::Kind::batch: {
        catalogCache_.clear();
        ensure_timelines();
        const api::CommandBatch& batch = std::get<api::CommandBatch>(request.body.v);
        std::vector<const api::Command*> cmds;
        for (std::size_t i = 0; i < batch.commands.size(); ++i) {
          const api::Command& c = batch.commands[i];
          if (!doc::registry().commandKinds.contains(command_id(c))) {
            fail(ErrorCode::unsupported, "unknown command", {.commandIndex = static_cast<std::uint32_t>(i)});
          }
          if (!is_edit(c)) {
            fail(ErrorCode::invalid_argument,
                 "'" + command_name(c) + "' is a " + doc::registry().commandKinds.at(command_id(c)) +
                     " command and cannot be part of a batch",
                 {.commandIndex = static_cast<std::uint32_t>(i)});
          }
          cmds.push_back(&c);
        }
        api::BatchResult results;
        if (!cmds.empty()) results.results = run_edits(cmds, request.origin, batch.label);
        log_.push_back(api::LogRecord{request, revision_, 0, std::nullopt});
        o.v = std::move(results);
        return o;
      }
    }
  } catch (const doc::DeferredAnswer&) {
    return std::nullopt;
  } catch (const EngineFail& f) {
    o.v = f.error;
  } catch (const std::exception& e) {
    o.v = err(ErrorCode::internal, e.what());
  }
  return o;
}

bool Session::is_edit(const api::Command& cmd) const {
  const auto& kinds = doc::registry().commandKinds;
  const auto it = kinds.find(command_id(cmd));
  return it != kinds.end() && it->second == "edit";
}

doc::PCtx Session::pctx() { return doc::PCtx{doc_, view_, exprEnv_, exprCache_}; }

doc::HCtx Session::handler_ctx(api::Origin origin) {
  // The conversions' geometry: one set explicitly (tests), else the frame
  // builder's (the full engine: its fonts and text measurer).
  doc::ConvertGeometry* geometry = convertGeometry_;
  if (geometry == nullptr && frameBuilder_ != nullptr) geometry = frameBuilder_->convert_geometry();
  return doc::HCtx{doc_, view_, ids_, keys_, exprEnv_, exprCache_, *ports_, origin, apiTime_, std::nullopt, geometry};
}

void Session::ensure_timelines() {
  // Every composition's timeline exists before a command runs (outside the
  // journal: a structural mirror, not an edit — LocalEngine.ensureTimelines).
  for (const auto& comp : doc::comp_item_ids(doc_)) {
    if (doc_.timeline(comp) == nullptr) {
      const BuildLock lock(*this, true);  // a document write, like any other
      (void)doc::tl_ensure(doc_, comp);
    }
  }
}

namespace {

// ── Proxy ownership (src/core/engine/proxyOwnership.ts) ─────────────────────
// A plugin's proxy layer generates child layers marked `__ownedByPlugin`. An
// edit whose origin is not `plugin` that changes an EXISTING owned layer
// detaches the whole proxy subtree: every mark under the proxy layer is
// written null inside the same command (its inverse, its log record).

constexpr std::string_view kOwnedBy = "__ownedByPlugin";

bool is_owned(const doc::Node* n) {
  if (n == nullptr) return false;
  return std::any_of(n->components.begin(), n->components.end(),
                     [](const doc::Component& c) { return c.props.at(kOwnedBy).is_string(); });
}

/// The parent of the topmost owned ancestor-or-self of `id` (the proxy layer).
std::string proxy_root_of(const doc::Document& d, const std::string& id) {
  std::string top = id;
  const doc::Node* cur = d.node(id);
  for (int guard = 0; cur != nullptr && guard < 256; ++guard) {
    if (is_owned(cur)) top = cur->id;
    if (!cur->parent) break;
    cur = d.node(*cur->parent);
  }
  const doc::Node* t = d.node(top);
  return t != nullptr && t->parent ? *t->parent : top;
}

void collect_owned(const doc::Document& d, const std::string& id, std::vector<std::string>& out) {
  if (is_owned(d.node(id)) && std::find(out.begin(), out.end(), id) == out.end()) out.push_back(id);
  for (const std::string& c : doc::sg_child_order(d, id)) collect_owned(d, c, out);
}

/// `touched` = the request's open journal (the parts as they were before it),
/// read in place: this pass only reads the map and writes nodes it collected
/// into `owned` afterwards (Document::journal).
void detach_proxy_ownership(doc::Document& d, const doc::Parts& touched, api::Origin origin) {
  if (origin == api::Origin::plugin) return;
  std::vector<std::string> roots;
  for (const auto& [id, before] : touched.nodes) {
    if (!before) continue;  // created by this command
    const doc::Node* now = d.node(id);
    if (now == nullptr || !is_owned(now) || *now == *before) continue;
    std::string root = proxy_root_of(d, id);
    if (std::find(roots.begin(), roots.end(), root) == roots.end()) roots.push_back(std::move(root));
  }
  std::vector<std::string> owned;
  for (const std::string& r : roots) collect_owned(d, r, owned);
  for (const std::string& id : owned) {
    const doc::Node* n = d.node(id);
    if (n == nullptr) continue;
    for (const doc::Component& c : n->components) {
      if (!c.props.at(kOwnedBy).is_string()) continue;
      // null, as the TypeScript writes it (a string test reads it as unowned).
      doc::sg_write_prop(d, id, c.id, kOwnedBy, doc::Json::null());
      break;
    }
  }
}

}  // namespace

void Session::stamp_missing_key_ids(const doc::Parts& touched, doc::HCtx& x) {
  // stamp.ts: any key in the edited scope without an id gets one, tracks and
  // keys in engine order, inside the command (part of its inverse).
  // In the order the command first touched each animation (TS: the scope's
  // key order), not by id — two layers' new keys get their ids in that order.
  // `touched` is the live journal: the anim ids are collected first, and the
  // node loop below writes only nodes already journaled (set_mask_anim on a
  // key of the map), so neither pass adds a key to the map it walks.
  std::vector<std::string> order;
  std::unordered_set<std::string_view> ordered;  // (a linear search here made a batch of N edits O(N³))
  for (const std::string& id : doc_.journal_anim_order()) {
    if (touched.anims.contains(id) && ordered.insert(id).second) order.push_back(id);
  }
  for (const auto& [id, before] : touched.anims) {
    if (ordered.insert(id).second) order.push_back(id);
  }
  for (const std::string& id : order) {
    const doc::NodeAnim* a = doc_.anim(id);
    if (a == nullptr) continue;
    bool missing = false;
    for (const auto& [prop, keys] : a->tracks) {
      for (const doc::Key& k : keys) missing = missing || !k.id;
    }
    for (const auto& [prop, t] : a->data) {
      for (const doc::DataKey& k : t.keys) missing = missing || !k.id;
    }
    if (!missing) continue;
    doc::NodeAnim snap = *a;
    for (auto& [prop, keys] : snap.tracks) {
      for (doc::Key& k : keys) {
        if (!k.id) k.id = x.mint_key_id();
      }
    }
    for (auto& [prop, t] : snap.data) {
      for (doc::DataKey& k : t.keys) {
        if (!k.id) k.id = x.mint_key_id();
      }
    }
    doc_.set_anim(id, std::move(snap));
  }
  for (const auto& [id, before] : touched.nodes) {
    const doc::Node* n = doc_.node(id);
    if (n == nullptr) continue;
    const std::span<const doc::Json> view = doc::mask_anim_view(*n);
    const bool missing = std::any_of(view.begin(), view.end(), [](const doc::Json& k) {
      return !(k.at("id").is_string() && !k.at("id").str().empty());
    });
    if (!missing) continue;
    std::vector<doc::Json> anim(view.begin(), view.end());
    for (doc::Json& k : anim) {
      if (!(k.at("id").is_string() && !k.at("id").str().empty())) k.set("id", doc::Json::string(x.mint_key_id()));
    }
    doc::set_mask_anim(doc_, id, std::move(anim));
  }
}

std::vector<api::CommandResult> Session::run_edits(const std::vector<const api::Command*>& commands, api::Origin origin,
                                                   const std::optional<std::string>& batchLabel) {
  std::vector<api::CommandResult> results;
  std::string label = batchLabel.value_or("");
  const bool indexed = commands.size() > 1 || batchLabel.has_value();
  const BuildLock lock(*this, true);  // the document is written below: no frame builds meanwhile
  const auto editStart = Clock::now();
  doc_.begin();
  // A failed request is rolled back AND left out of the command log, so the ids
  // it minted must be handed back too: otherwise a restart's replay, which never
  // sees the failure, mints every later id one step behind the live engine.
  auto idsBefore = ids_.state();
  for (std::size_t i = 0; i < commands.size(); ++i) {
    const api::Command& cmd = *commands[i];
    const std::optional<std::uint32_t> index = indexed ? std::optional<std::uint32_t>(static_cast<std::uint32_t>(i)) : std::nullopt;
    // The failure is recorded and re-thrown OUTSIDE the handler: a throw from
    // inside a catch funclet crashes the clang-cl ASan runtime's SEH handler.
    std::optional<api::EngineError> failed;
    try {
      std::string own;
      // A held job result is its own commands, in this journal (one entry).
      const auto* applyJob = std::get_if<api::ApplyJobResult>(&cmd.v);
      // autoTrace reads decoded frames: the autoTrace job run inline (session_jobs.cpp).
      const auto* autoTrace = std::get_if<api::AutoTrace>(&cmd.v);
      // P7a: a native plugin's command, its edits in this journal (session_plugins.cpp).
      const auto* pluginCmd = std::get_if<api::RunPluginCommand>(&cmd.v);
      api::CommandResult r = applyJob != nullptr    ? apply_job_in_journal(*applyJob, origin, own)
                             : autoTrace != nullptr ? auto_trace_in_journal(*autoTrace, origin, own)
                             : pluginCmd != nullptr ? run_plugin_command_in_journal(*pluginCmd, origin, own)
                                                    : run_in_journal(cmd, origin, &own);
      results.push_back(std::move(r));
      if (!batchLabel) label = std::move(own);
    } catch (const EngineFail& f) {
      failed = with_index(f.error, index);
    } catch (const std::exception& e) {
      failed = with_index(err(ErrorCode::internal, e.what()), index);
    }
    if (failed) {
      doc_.rollback();
      ids_.restore(std::move(idsBefore));
      keys_.invalidate();
      throw EngineFail{std::move(*failed)};
    }
  }
  // Edit-pipeline trace (debug): where a slow command's time goes, stage by stage.
  const auto tHandlers = Clock::now();
  if (const doc::Parts* written = doc_.journal()) keys_.settle(doc_, *written);
  const auto tSettle = Clock::now();
  doc::ChangeSet changes = doc_.commit();
  if (changes.empty()) return results;
  const api::Revision from = revision_;
  ++revision_;
  const auto tCommit = Clock::now();
  std::vector<api::Event> events = builder_.build(changes, pctx());
  const auto tEvents = Clock::now();
  note_document_changed(from, &changes);
  const auto tKeys = Clock::now();
  if (gesture_) {
    gesture_->changes.merge(changes);
  } else {
    history_.push(doc::Entry{label, origin, std::move(changes)});
  }
  const auto tHistory = Clock::now();
  send_events(from, revision_, std::move(events), std::nullopt, origin);
  emit_status();
  request_render();
  const auto tEnd = Clock::now();
  if (log::enabled(log::Level::debug)) {
    const auto ms = [](Clock::time_point a, Clock::time_point b) { return std::chrono::duration<double, std::milli>(b - a).count(); };
    PREMATION_LOG(debug, "edit_timing")
        .kv("label", label)
        .kv("handlersMs", ms(editStart, tHandlers))
        .kv("settleMs", ms(tHandlers, tSettle))
        .kv("commitMs", ms(tSettle, tCommit))
        .kv("eventsMs", ms(tCommit, tEvents))
        .kv("frameKeysMs", ms(tEvents, tKeys))
        .kv("historyMs", ms(tKeys, tHistory))
        .kv("sendMs", ms(tHistory, tEnd));
  }
  return results;
}

api::CommandResult Session::run_in_journal(const api::Command& cmd, api::Origin origin, std::string* label) {
  const std::string name = command_name(cmd);
  if (!is_edit(cmd)) fail(ErrorCode::invalid_argument, "'" + name + "' is not an edit command");
  doc::HCtx x = handler_ctx(origin);
  api::CommandResult r = std::visit(EditVisitor{x, name}, cmd.v);
  // stampMissingKeyIds over what this request touched so far, then
  // syncTimelines. The journal is read in place (Document::journal): copying
  // it per command made a batch of N edits O(N²) in its size.
  if (const doc::Parts* sofar = doc_.journal()) {
    stamp_missing_key_ids(*sofar, x);
    detach_proxy_ownership(doc_, *sofar, origin);
  }
  doc::tl_sync_all(doc_);
  // The key index follows what the request wrote (KeyIndex::mark_stale: the next
  // lookup re-indexes the journaled layers, O(touched)); a rebuild per command
  // made every key-adding command O(all keys in the document).
  keys_.mark_stale();
  if (label != nullptr) *label = x.label ? *x.label : humanize(name);
  return r;
}

// ── history and controls ────────────────────────────────────────────────────

void Session::apply_history(const doc::ChangeSet& target) {
  const BuildLock lock(*this, true);
  doc_.apply(target.after);
  // ensure_timelines makes every composition's timeline OUTSIDE the journal,
  // so an undo / redo / history jump that takes a composition away does not
  // take its timeline with it: drop the ones whose composition is gone (the
  // same structural mirror, kept in step the other way).
  std::vector<std::string> orphans;
  for (const auto& id : doc_.timelines().keys()) {
    if (doc_.comp(id) == nullptr) orphans.emplace_back(id);
  }
  for (const auto& id : orphans) doc_.remove_timeline(id);
  keys_.invalidate();
}

api::HistoryState Session::history_state() const {
  api::HistoryState s;
  for (const doc::Entry* e : history_.entries()) s.entries.push_back(api::HistoryEntry{e->label, e->origin});
  s.position = static_cast<std::uint32_t>(history_.index() + 1);
  s.can_undo = history_.can_undo();
  s.can_redo = history_.can_redo();
  s.gesture_open = gesture_.has_value();
  s.limit = history_.capacity();
  return s;
}

void Session::emit_status() {
  std::vector<api::Event> ev;
  const doc::Entry* top = history_.top();
  const doc::Entry* next = history_.next();
  ev.push_back(make_event(api::HistoryChangedEvent{history_state(), top != nullptr ? top->label : "",
                                                   next != nullptr ? next->label : ""}));
  ev.push_back(make_event(api::DirtyChangedEvent{revision_ != savedRevision_, projectPath_}));
  send_events(revision_, revision_, std::move(ev), std::nullopt, api::Origin::engine);
}

void Session::emit_changes(api::Revision from, const doc::ChangeSet& changes) {
  std::vector<api::Event> events = builder_.build(changes, pctx());
  send_events(from, revision_, std::move(events), std::nullopt, api::Origin::engine);
}

void Session::load_new_project(api::ResetReason reason, bool emit) {
  // projectDocumentIO.createEmpty('Untitled') + restoreDocument: one empty
  // composition, `comp_root`, and its timeline.
  const BuildLock lock(*this, true);
  doc_ = doc::Document{};
  // After Effects' default for a new project: layers blend in gamma ("Blend
  // Colors Using 1.0 Gamma" off). The document default stays linear for files
  // that predate the setting (model.cpp default_project_settings).
  doc_.project_mut().linear_blending = false;
  doc::Node root;
  root.id = "comp_root";
  root.name = "Composition 1";
  root.components.push_back(doc::Component{"comp_root_meta", "group", [] {
                                              doc::Json p = doc::Json::object();
                                              p.set("__kind", doc::Json::string("group"));
                                              return p;
                                            }()});
  doc::sg_add_node(doc_, std::move(root));
  doc::Json& rec = doc_.comp_mut("comp_root");
  rec.set("id", doc::Json::string("comp_root"));
  rec.set("name", doc::Json::string("Composition 1"));
  rec.set("pristine", doc::Json::boolean(true));
  rec.set("width", doc::Json::number(1920));
  rec.set("height", doc::Json::number(1080));
  rec.set("fps", doc::Json::number(30));
  rec.set("durationSeconds", doc::Json::number(10));
  rec.set("background", doc::Json::string("#101014"));
  rec.set("transparent", doc::Json::boolean(false));
  rec.set("startFrame", doc::Json::number(0));
  view_ = doc::EditorView{};
  projectPath_.clear();
  bundleRoot_.clear();
  after_load(reason, emit);
}

void Session::after_load(api::ResetReason reason, bool emit) {
  drop_jobs();
  ensure_timelines();
  history_.clear();
  gesture_.reset();
  ids_.reset();
  ids_.seed_keyframes(doc::all_keyframe_ids(doc_));
  keys_.invalidate();
  builder_.reset();
  exprCache_.clear();
  buildExprCache_.clear();  // under the caller's write lock (load_new_project / load_document)
  const api::Revision from = revision_;
  ++revision_;
  savedRevision_ = revision_;
  note_document_changed(from, nullptr);
  if (!emit) return;
  std::vector<api::Event> ev;
  ev.push_back(make_event(api::DocumentResetEvent{revision_, reason}));
  send_events(from, revision_, std::move(ev), std::nullopt, api::Origin::engine);
  emit_status();
}

void Session::load_document(const doc::Json& file, api::ResetReason reason, std::string_view footageRoot) {
  const BuildLock lock(*this, true);
  const std::vector<doc::Json> session = doc_.items().assets;
  const doc::RestoreResult r = doc::restore_document(doc_, view_, file, session);
  // The files the document names by path are read again where they still are (docio.hpp).
  lastMissing_ = doc::relink_missing_footage(doc_, *ports_, footageRoot.empty() ? std::string_view(bundleRoot_) : footageRoot, r.missing);
  after_load(reason, true);
  request_render();
}

doc::Json Session::capture_document() const { return doc::capture_document(doc_); }

struct ControlVisitor {
  Session& s;
  api::Origin origin;
  Clock::time_point now;
  const std::string& name;
  using R = api::CommandResult;

  template <class T>
  R operator()(const T&) const {
    fail(ErrorCode::unsupported, "control '" + name + "' is not implemented");
  }

  static void no_gesture_for(const Session& s, const char* what) {
    if (s.gesture_) fail(ErrorCode::gesture_open, what);
  }

  R history_step(bool undo) const {
    if (s.gesture_) fail(ErrorCode::gesture_open, std::string("'") + (undo ? "undo" : "redo") + "' is refused while a gesture is open");
    if (undo && !s.history_.can_undo()) fail(ErrorCode::nothing_to_undo, "nothing to undo");
    if (!undo && !s.history_.can_redo()) fail(ErrorCode::nothing_to_redo, "nothing to redo");
    const doc::Entry* e = undo ? s.history_.undo() : s.history_.redo();
    const doc::ChangeSet step = undo ? e->changes.reversed() : e->changes;
    const std::string label = e->label;
    s.apply_history(step);
    const api::Revision from = s.revision_;
    ++s.revision_;
    s.note_document_changed(from, &step);
    s.emit_changes(from, step);
    s.emit_status();
    s.request_render();
    return undo ? result_for<api::Undo>(api::HistoryStep{label, static_cast<std::uint32_t>(s.history_.index() + 1)})
                : result_for<api::Redo>(api::HistoryStep{label, static_cast<std::uint32_t>(s.history_.index() + 1)});
  }

  R operator()(const api::Undo&) const { return history_step(true); }
  R operator()(const api::Redo&) const { return history_step(false); }
  R operator()(const api::JumpToHistory& c) const {
    no_gesture_for(s, "close the gesture before moving through history");
    const auto entries = s.history_.entries();
    if (c.position > entries.size()) fail(ErrorCode::out_of_range, "history has " + std::to_string(entries.size()) + " entries");
    const std::int64_t target = static_cast<std::int64_t>(c.position) - 1;
    std::string label;
    doc::ChangeSet folded;
    while (s.history_.index() > target) {
      const doc::Entry* e = s.history_.undo();
      label = e->label;
      const doc::ChangeSet step = e->changes.reversed();
      s.apply_history(step);
      folded.merge(step);
    }
    while (s.history_.index() < target) {
      const doc::Entry* e = s.history_.redo();
      label = e->label;
      s.apply_history(e->changes);
      folded.merge(e->changes);
    }
    // One revision for the whole jump (first-seen from, last-seen to per part).
    folded.after = s.doc_.current_of(folded.before);
    folded.prune();
    if (!folded.empty()) {
      const api::Revision from = s.revision_;
      ++s.revision_;
      s.note_document_changed(from, &folded);
      s.emit_changes(from, folded);
      s.request_render();
    }
    s.emit_status();
    return result_for<api::JumpToHistory>(api::HistoryStep{label, static_cast<std::uint32_t>(s.history_.index() + 1)});
  }
  R operator()(const api::BeginGesture& c) const {
    if (s.gesture_) fail(ErrorCode::gesture_open, "gesture '" + s.gesture_->label + "' is already open");
    const std::uint32_t id = s.ids_.next_gesture();  // in the id state (ids.ts)
    s.gesture_ = Session::Gesture{id, c.label, origin, {}};
    s.emit_status();
    return result_for<api::BeginGesture>(api::GestureRef{id});
  }
  R operator()(const api::EndGesture& c) const {
    if (!s.gesture_) fail(ErrorCode::no_gesture, "no gesture is open");
    if (c.gesture != 0 && c.gesture != s.gesture_->id) {
      fail(ErrorCode::invalid_argument, "gesture " + std::to_string(c.gesture) + " is not the open gesture (" +
                                            std::to_string(s.gesture_->id) + ")");
    }
    Session::Gesture g = std::move(*s.gesture_);
    s.gesture_.reset();
    g.changes.prune();
    if (g.changes.empty()) {
      s.emit_status();
      return result_for<api::EndGesture>();
    }
    if (c.commit) {
      s.history_.push(doc::Entry{g.label, g.origin, std::move(g.changes)});
    } else {
      // Esc: every edit of the gesture reverts; a new revision with events.
      const doc::ChangeSet back = g.changes.reversed();
      s.apply_history(back);
      const api::Revision from = s.revision_;
      ++s.revision_;
      s.note_document_changed(from, &back);
      s.emit_changes(from, back);
      s.request_render();
    }
    s.emit_status();
    return result_for<api::EndGesture>();
  }
  R operator()(const api::AddHistoryCheckpoint& c) const {
    // B3z (LocalEngine addHistoryCheckpoint): a NAMED entry that changes nothing.
    no_gesture_for(s, "close the gesture first");
    const bool blank = std::all_of(c.label.begin(), c.label.end(), [](char ch) {
      return ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' || ch == '\f' || ch == '\v';
    });
    if (blank) fail(ErrorCode::invalid_argument, "a checkpoint needs a name");
    s.history_.push(doc::Entry{c.label, origin, {}});
    s.emit_status();
    return result_for<api::AddHistoryCheckpoint>();
  }
  R operator()(const api::ClearHistory&) const {
    no_gesture_for(s, "close the gesture first");
    s.history_.clear();
    s.emit_status();
    return result_for<api::ClearHistory>();
  }
  R operator()(const api::SetHistoryLimit& c) const {
    if (!(c.entries > 0)) fail(ErrorCode::out_of_range, "the history limit must be at least 1");
    s.history_.set_capacity(c.entries);
    s.emit_status();
    return result_for<api::SetHistoryLimit>();
  }
  R operator()(const api::SetAutosave& c) const {
    s.autosave_ = Session::Autosave{c.enabled, c.interval_seconds, c.keep};
    return result_for<api::SetAutosave>();
  }
  // Live performance input (core/session_live.cpp): editor input, not the document.
  R operator()(const api::StartLiveInput& c) const { return s.start_live(c); }
  R operator()(const api::StopLiveInput&) const { return s.stop_live(); }
  R operator()(const api::NewProject&) const {
    no_gesture_for(s, "close the gesture first");
    s.load_new_project(api::ResetReason::created);
    s.emit_status();
    s.request_render();
    return result_for<api::NewProject>();
  }
  R operator()(const api::OpenProject& c) const {
    no_gesture_for(s, "close the gesture first");
    if (!s.ports_->has_projects()) fail(ErrorCode::unsupported, "no project file port is attached to this engine");
    doc::Ports::Opened opened = s.ports_->open_project(c.path);
    s.load_document(opened.doc, api::ResetReason::opened, opened.footageRoot);
    // F2: a portable `.motion` is a copy — the project stays untitled (Save
    // asks where), its footage in the staging bundle it was unpacked into.
    s.projectPath_ = opened.portable ? std::string() : c.path;
    s.bundleRoot_ = std::move(opened.footageRoot);
    s.emit_status();
    api::OpenProjectResult r;
    if (opened.portable) {
      r.warnings.push_back("portable: opened a portable copy with " + std::to_string(opened.embedded) +
                           " embedded footage file(s); the project is untitled until saved");
    }
    r.missing_items = s.lastMissing_;
    return result_for<api::OpenProject>(std::move(r));
  }
  R operator()(const api::RevertProject&) const {
    no_gesture_for(s, "close the gesture first");
    if (!s.ports_->has_projects() || s.projectPath_.empty()) {
      fail(ErrorCode::unsupported, "nothing to revert to: no saved project path or file port");
    }
    doc::Json file = s.ports_->read_project(s.projectPath_);
    s.load_document(file, api::ResetReason::reverted);
    return result_for<api::RevertProject>();
  }
  R operator()(const api::SaveProject& c) const {
    if (!s.ports_->has_projects()) fail(ErrorCode::unsupported, "no project file port is attached to this engine");
    const std::string path = c.path ? *c.path : s.projectPath_;
    if (path.empty()) fail(ErrorCode::invalid_argument, "the project has no path yet; pass one");
    const api::ProjectFormat format = c.format.value_or(api::ProjectFormat::auto_);
    if (format == api::ProjectFormat::portable && !c.copy) {
      fail(ErrorCode::invalid_argument, "a portable .motion is a copy (copy:true): the project stays bound to its own file");
    }
    const std::uint64_t bytes = s.ports_->write_project_as(path, s.capture_document(), format, s.bundleRoot_);
    if (!c.copy) {
      s.projectPath_ = path;
      // Stream B2: the stored subject matte files no state of this session names any more
      // (not the document, not an undo / redo entry, not the open gesture) go with the save.
      // Never with a copy: the project stays bound to its own folder.
      doc::gc_object_matte_files(std::filesystem::path(std::u8string(path.begin(), path.end())), s.doc_, s.history_,
                                 s.gesture_ ? &s.gesture_->changes : nullptr);
      // A bundle now holds every blob the document names (collected in); a JSON file holds none.
      if (s.ports_->is_bundle(path)) s.bundleRoot_ = path;
      s.savedRevision_ = s.revision_;
      std::vector<api::Event> ev;
      ev.push_back(make_event(api::ProjectSavedEvent{path, s.revision_}));
      s.send_events(s.revision_, s.revision_, std::move(ev), std::nullopt, api::Origin::engine);
      s.emit_status();
    }
    return result_for<api::SaveProject>(api::SaveProjectResult{path, bytes, std::nullopt});
  }
  R operator()(const api::CollectFiles& c) const {
    // collect_files.hpp: a captured COPY is collected; the document, its path,
    // dirty flag and history are untouched.
    if (!s.ports_->has_collect()) fail(ErrorCode::unsupported, "no collect-files port is attached to this engine");
    doc::CollectRequest req;
    req.folder = c.folder;
    req.onlyUsed = c.only_used;
    req.doc = s.capture_document();
    for (const js::Json& a : s.doc_.items().assets) {
      if (a.at("id").is_string() && doc::layers_using_item(s.doc_, a.at("id").str()).empty()) req.unusedItems.insert(a.at("id").str());
    }
    req.sourceBundle = s.bundleRoot_;
    req.projectPath = s.projectPath_;
    doc::CollectOutcome out = s.ports_->collect_files(std::move(req));
    PREMATION_LOG(info, "collect_files").kv("path", out.path).kv("files", out.collected).kv("missing", out.missing.size());
    api::SaveProjectResult r{out.path, out.bytes, std::nullopt};
    if (!out.missing.empty()) {
      std::string lines;
      for (const std::string& m : out.missing) lines += (lines.empty() ? "" : "\n") + m;
      r.missing = std::move(lines);
    }
    return result_for<api::CollectFiles>(std::move(r));
  }
  R operator()(const api::ReloadItems& c) const {
    // AE's Reload Footage (and Edit Original's save): the document is unchanged —
    // no history entry, nothing dirty — but every viewport drops what it decoded
    // or cached from those files and draws them again from disk. Footage only;
    // an unknown id fails, compositions and folders have no file.
    std::vector<std::string> files;
    for (const std::string& id : c.items) {
      const doc::ItemRef ref = doc::require_item(s.doc_, id);
      if (ref.kind != doc::ItemRefKind::footage) continue;
      const doc::Json* a = doc::find_asset(s.doc_, id);
      if (a == nullptr) continue;
      for (const doc::Json* f : {&a->at("path"), &a->at("src"), &a->at("proxy").at("src")}) {
        if (f->is_string() && !f->str().empty() && !f->str().starts_with("data:") && !f->str().starts_with("blob:")) files.push_back(f->str());
      }
    }
    if (!files.empty()) {
      PREMATION_LOG(info, "reload_items").kv("items", c.items.size()).kv("files", files.size());
      (void)scene::MediaReloadLog::instance().post(std::move(files));
      // Cached frames are keyed by content, not file stamps: any of them may show the old bytes.
      s.sink_.purge_frame_cache();
      if (s.any_viewport_open()) s.request_render();
    }
    return result_for<api::ReloadItems>();
  }
  R operator()(const api::StartJob& c) const { return s.start_job(c); }
  R operator()(const api::CancelJob& c) const { return s.cancel_job(c); }
  R operator()(const api::SetPluginEnabled& c) const {
    // G1: native SDK plugins live in this process (src/plugins); JavaScript
    // plugins are the editor's and are not ported (plan §5 G2).
    if (!doc::NativeEffects::set_enabled(c.plugin, c.enabled)) fail(ErrorCode::not_found, "no installed plugin '" + c.plugin + "'");
    return result_for<api::SetPluginEnabled>();
  }
  R operator()(const api::RescanPlugins&) const {
    std::optional<std::vector<api::PluginInfo>> list = doc::NativeEffects::rescan();
    if (!list) fail(ErrorCode::unsupported, "this engine was started without a plugin folder (--plugins)");
    return result_for<api::RescanPlugins>(api::PluginList{std::move(*list)});
  }
  R operator()(const api::RefreshFonts&) const {
    // The frame builder and the drawer follow the new list on their next frame
    // (engine_frames.cpp Fonts::follow_installed_fonts); this redraws now.
    const bool changed = !s.options_.testPorts && s.options_.refreshSystemFonts && s.options_.refreshSystemFonts();
    if (changed) {
      std::vector<api::Event> ev;
      ev.push_back(make_event(api::FontsChangedEvent{}));
      s.send_events(s.revision_, s.revision_, std::move(ev), std::nullopt, api::Origin::engine);
      if (s.any_viewport_open()) s.request_render();
    }
    return result_for<api::RefreshFonts>(api::FontsRefreshed{changed});
  }

  // ── transport (transport.ts semantics, the C2 clock underneath) ──
  R operator()(const api::SetActiveComposition& c) const {
    if (!doc::is_comp_item(s.doc_, c.comp)) fail(ErrorCode::not_found, "no composition '" + c.comp + "'", {.item = c.comp});
    if (!(s.activeComp_ && *s.activeComp_ == c.comp)) {
      s.stop_playback();
      s.activeComp_ = c.comp;
      s.set_time(s.time_);
      s.request_render();
    }
    s.emit_transport();
    s.emit_playhead();
    return result_for<api::SetActiveComposition>();
  }
  R operator()(const api::Play& c) const {
    const auto comp = s.active_comp();
    if (!comp) fail(ErrorCode::not_found, "no composition to play");
    if (!(std::abs(c.rate) > 0 && std::abs(c.rate) <= 4)) fail(ErrorCode::out_of_range, "rate must be within ±4 and not 0");
    if (c.range == api::PlayRange::custom && (!c.custom || c.custom->duration <= 0)) {
      fail(ErrorCode::invalid_argument, "a custom range needs a positive duration");
    }
    s.rate_ = c.rate;
    s.rangeKind_ = c.range;
    if (c.custom) s.customRange_ = *c.custom;
    s.cacheOnly_ = c.cache_first && c.cache_only;
    s.cacheReturn_ = s.playing_ ? s.time_ : s.apiTime_;
    if (s.cacheOnly_) {
      // Cache Work Area Now: a fill from a stopped transport, never a restart of playback.
      s.stop_playback();
      // No viewport: there is nowhere to store frames, and nothing to play either.
      if (!s.any_viewport_open()) {
        s.cacheOnly_ = false;
        s.transportState_ = api::TransportState::stopped;
        s.emit_transport();
        return result_for<api::Play>();
      }
    }
    if (c.from) s.seek_to(*c.from);
    // A play-once whose last pass dropped frames: store the range before the
    // clock runs (see the clock tick), unless this Play is itself a fill.
    const bool cacheFirst = c.cache_first || (s.loop_ == api::LoopMode::once && s.nextPlayCachesFirst_ && !s.cacheOnly_);
    s.nextPlayCachesFirst_ = false;
    s.transportState_ = cacheFirst ? api::TransportState::caching : api::TransportState::playing;
    // No viewport: there is nowhere to store frames, so play at once.
    if (s.transportState_ == api::TransportState::caching && !s.any_viewport_open()) {
      s.transportState_ = api::TransportState::playing;
    }
    s.start_playback(now, std::nullopt);
    return result_for<api::Play>();
  }
  R operator()(const api::Pause& c) const {
    s.stop_playback();
    s.transportState_ = api::TransportState::stopped;
    if (c.return_to_start && s.active_comp()) {
      s.seek_to(s.customRange_.duration > 0 ? s.customRange_.start : 0);
    }
    s.emit_transport();
    s.emit_playhead();
    s.request_render();
    return result_for<api::Pause>();
  }
  R operator()(const api::Seek& c) const {
    if (!s.active_comp()) fail(ErrorCode::not_found, "no composition to seek");
    s.seek_to(c.time);
    if (s.transportState_ == api::TransportState::caching && s.cacheOnly_) {
      // A seek ends a cache-only fill with what is stored: nothing was going to play.
      s.cacheOnly_ = false;
      s.stop_playback();
    } else if (s.transportState_ == api::TransportState::caching) {
      // A seek interrupts the fill; playback continues from here with what is stored.
      s.transportState_ = api::TransportState::playing;
      s.cacheInFlight_ = false;
    }
    if (s.playing_) s.rebase_playback(now);
    s.emit_transport();
    s.emit_playhead();
    s.request_render();
    return result_for<api::Seek>();
  }
  R operator()(const api::Step& c) const {
    const auto comp = s.active_comp();
    if (!comp) fail(ErrorCode::not_found, "no composition to step");
    const double fps = doc::comp_fps(s.doc_, *comp);
    s.seek_to(doc::frames_to_flicks(doc::flicks_to_frames(s.apiTime_, fps) + c.frames, fps));
    if (s.playing_) s.rebase_playback(now);
    s.emit_transport();
    s.emit_playhead();
    s.request_render();
    return result_for<api::Step>();
  }
  R operator()(const api::SetLoop& c) const {
    s.loop_ = c.mode;
    s.emit_transport();
    s.emit_playhead();
    return result_for<api::SetLoop>();
  }
  R operator()(const api::SetPreviewQuality& c) const {
    s.resolution_ = resolution_factor(c.resolution);
    s.draft3d_ = c.draft3d;
    s.previewMotionBlur_ = c.motion_blur;
    for (auto& [id, v] : s.surfaces_) {
      v.resolution = s.resolution_;
      v.draft3d = s.draft3d_;
      v.previewMotionBlur = s.previewMotionBlur_;
      s.sink_.configure(v);
    }
    if (s.any_viewport_open()) s.request_render();
    return result_for<api::SetPreviewQuality>();
  }
  R operator()(const api::SetAudioPreview& c) const {
    if (!(c.volume >= 0)) fail(ErrorCode::out_of_range, "volume must be ≥ 0");
    return result_for<api::SetAudioPreview>();
  }
  R operator()(const api::SetViewport& c) const {
    if (!(c.width > 0 && c.height > 0)) fail(ErrorCode::out_of_range, "viewport size must be positive");
    const double dpr = c.device_pixel_ratio > 0.0 && std::isfinite(c.device_pixel_ratio) ? c.device_pixel_ratio : 1.0;
    const double w = std::round(static_cast<double>(c.width) * dpr);
    const double h = std::round(static_cast<double>(c.height) * dpr);
    s.viewports_.insert(c.viewport);
    if (w > 16384.0 || h > 16384.0 || dpr > 8.0) return result_for<api::SetViewport>();  // state kept; not rendered
    ViewportConfig v;
    v.viewport = c.viewport;
    v.width = static_cast<std::uint32_t>(w);
    v.height = static_cast<std::uint32_t>(h);
    v.resolution = s.resolution_;
    v.draft3d = s.draft3d_;
    v.previewMotionBlur = s.previewMotionBlur_;
    v.open = true;
    // D5: the page's camera (zoom ≤ 0 = fit). Only finite values; the pan is the
    // comp point at the viewport centre.
    v.zoom = std::isfinite(c.zoom) && c.zoom > 0.0 ? c.zoom : 0.0;
    v.panX = std::isfinite(c.pan.x) ? c.pan.x : 0.0;
    v.panY = std::isfinite(c.pan.y) ? c.pan.y : 0.0;
    v.devicePixelRatio = dpr;
    // View ▸ Show Channel: applied on the final blit (RenderView.channel).
    v.channel = c.channel;
    // Adjust Exposure (stops) on the final blit; ±40 covers any useful view.
    v.exposure = std::isfinite(c.exposure) ? std::clamp(c.exposure, -40.0, 40.0) : 0.0;
    if (c.region_of_interest && std::isfinite(c.region_of_interest->x) && std::isfinite(c.region_of_interest->y)
        && c.region_of_interest->width > 0 && c.region_of_interest->height > 0) {
      v.regionOfInterest = *c.region_of_interest;
    }
    // The pane's 3D view: '' = the composition's camera; a custom view carries its own orbit.
    v.view = c.view && !c.view->empty() ? *c.view : std::string("active");
    if (v.view == "custom" && c.custom_view) {
      CustomViewParams cv;
      cv.yaw = std::isfinite(c.custom_view->yaw) ? c.custom_view->yaw : 0.0;
      cv.pitch = std::isfinite(c.custom_view->pitch) ? c.custom_view->pitch : 0.0;
      if (c.custom_view->distance && std::isfinite(*c.custom_view->distance) && *c.custom_view->distance > 0) cv.distance = *c.custom_view->distance;
      if (const auto& p = c.custom_view->poi; p && std::isfinite(p->x) && std::isfinite(p->y) && std::isfinite(p->z)) cv.poi = {p->x, p->y, p->z};
      v.customView = cv;
    }
    // The Layer panel: one layer alone at its source size, optionally at a held time.
    if (c.layer && !c.layer->empty()) {
      if (s.doc_.node(*c.layer) == nullptr) fail(ErrorCode::not_found, "no layer " + *c.layer, {.layer = *c.layer});
      v.layer = *c.layer;
      v.layerRenderEffects = c.layer_render_effects;
      v.layerTransparencyGrid = c.transparency_grid;
      if (c.layer_alpha_view && !c.layer_alpha_view->empty()) {
        const std::string& av = *c.layer_alpha_view;
        if (av != "alpha" && av != "boundary" && av != "overlay") {
          fail(ErrorCode::invalid_argument, "layerAlphaView '" + av + "' is not alpha, boundary or overlay", {.layer = *c.layer});
        }
        v.layerAlphaView = av;
      }
      if (c.layer_alpha_overlay_color) {
        const std::string& col = *c.layer_alpha_overlay_color;
        const bool hex = col.size() == 7 && col[0] == '#' &&
                         std::all_of(col.begin() + 1, col.end(), [](char ch) { return std::isxdigit(static_cast<unsigned char>(ch)) != 0; });
        if (!hex) fail(ErrorCode::invalid_argument, "layerAlphaOverlayColor '" + col + "' is not #rrggbb", {.layer = *c.layer});
        v.layerAlphaOverlayColor = col;
      }
      if (c.layer_alpha_overlay_opacity && std::isfinite(*c.layer_alpha_overlay_opacity)) {
        v.layerAlphaOverlayOpacity = std::clamp(*c.layer_alpha_overlay_opacity, 0.0, 100.0) / 100;
      }
    } else {
      v.transparencyGrid = c.transparency_grid;
      v.clipToComp = c.clip_to_comp.value_or(true);  // U1: the Extended Viewer draws outside the frame
      v.groundGrid = c.ground_grid.value_or(false);  // E8: the engine-drawn ground grid
    }
    if (c.subject_view && !c.subject_view->layer.empty()) {
      const api::SubjectView& sv = *c.subject_view;
      if (s.doc_.node(sv.layer) == nullptr) fail(ErrorCode::not_found, "no layer " + sv.layer, {.layer = sv.layer});
      if (sv.mode != "overlay" && sv.mode != "black" && sv.mode != "white" && sv.mode != "alpha" && sv.mode != "boundary") {
        fail(ErrorCode::invalid_argument, "subjectView mode '" + sv.mode + "' is not overlay, black, white, alpha or boundary", {.layer = sv.layer});
      }
      if (sv.color) {
        const std::string& col = *sv.color;
        const bool hex = col.size() == 7 && col[0] == '#' &&
                         std::all_of(col.begin() + 1, col.end(), [](char ch) { return std::isxdigit(static_cast<unsigned char>(ch)) != 0; });
        if (!hex) fail(ErrorCode::invalid_argument, "subjectView colour '" + col + "' is not #rrggbb", {.layer = sv.layer});
      }
      v.subjectView = sv;
    }
    if (c.time && *c.time >= 0) v.time = *c.time;
    if (c.layer_source_time && v.time) v.layerSourceTime = *c.layer_source_time;
    if (c.onion && v.layer.empty()) {
      api::OnionSkin skin = *c.onion;
      skin.before = std::min<std::uint32_t>(skin.before, 8);
      skin.after = std::min<std::uint32_t>(skin.after, 8);
      skin.step = std::max<std::uint32_t>(1, std::min<std::uint32_t>(skin.step == 0 ? 1 : skin.step, 30));
      skin.opacity = std::isfinite(skin.opacity) ? std::clamp(skin.opacity, 0.0, 1.0) : 0.0;
      if (skin.before > 0 || skin.after > 0) v.onion = skin;
    }
    // C: each viewport id is its own engine surface (a pop-out, a second view).
    const auto it = s.surfaces_.find(c.viewport);
    if (it == s.surfaces_.end() || !(it->second == v)) {
      s.surfaces_.insert_or_assign(c.viewport, v);
      s.sink_.configure(v);
    }
    s.request_render();
    return result_for<api::SetViewport>();
  }
  R operator()(const api::CloseViewport& c) const {
    if (s.viewports_.erase(c.viewport) == 0) fail(ErrorCode::not_found, "no viewport " + std::to_string(c.viewport));
    s.hiddenLayers_.erase(c.viewport);
    s.focusLayers_.erase(c.viewport);
    if (const auto it = s.surfaces_.find(c.viewport); it != s.surfaces_.end()) {
      ViewportConfig closed = it->second;
      closed.open = false;
      s.surfaces_.erase(it);
      s.sink_.configure(closed);
    }
    return result_for<api::CloseViewport>();
  }
  R operator()(const api::SetCacheBudget& c) const {
    // The disk tier (AE's Media & Disk Cache): its folder and size limit; a
    // 0 MB limit or no folder turns it off. The RAM tier (render/ram_cache.hpp):
    // `ramMegabytes`, 0 = sized from the machine. The VRAM tier sizes itself
    // from the adapter (render/frame_cache.hpp).
    constexpr std::uint64_t kMiB = 1024ULL * 1024ULL;
    if (c.disk_megabytes > (std::numeric_limits<std::uint64_t>::max() / kMiB)) {
      fail(ErrorCode::invalid_argument, "diskMegabytes is out of range");
    }
    if (c.ram_megabytes > (std::numeric_limits<std::uint64_t>::max() / kMiB)) {
      fail(ErrorCode::invalid_argument, "ramMegabytes is out of range");
    }
    s.sink_.configure_ram_cache(c.ram_megabytes * kMiB);
    s.sink_.configure_disk_cache(c.disk_path, c.disk_megabytes * kMiB);
    if (c.idle_render_ahead) s.options_.idlePrefetch = *c.idle_render_ahead;
    return result_for<api::SetCacheBudget>();
  }
  R operator()(const api::PurgeCache& c) const {
    if (c.kind == api::PurgeKind::all || c.kind == api::PurgeKind::ram) s.sink_.purge_frame_cache();
    if (c.kind == api::PurgeKind::all || c.kind == api::PurgeKind::disk) s.sink_.purge_disk_cache();
    return result_for<api::PurgeCache>();
  }
  R operator()(const api::SetInteracting&) const { return result_for<api::SetInteracting>(); }
  R operator()(const api::SetViewportHiddenLayers& c) const {
    // A viewport's own state: replaces its set; empty = every layer draws. Kept
    // for a viewport that is not open yet, dropped when it closes.
    if (c.layers.empty()) {
      s.hiddenLayers_.erase(c.viewport);
    } else {
      s.hiddenLayers_.insert_or_assign(c.viewport, c.layers);
    }
    if (s.any_viewport_open()) s.request_render();
    return result_for<api::SetViewportHiddenLayers>();
  }
  R operator()(const api::SetViewportFocus& c) const {
    // A viewport's own state, like its hidden layers: replaces the set; empty = no focus.
    if (c.layers.empty()) {
      s.focusLayers_.erase(c.viewport);
    } else {
      s.focusLayers_.insert_or_assign(c.viewport, c.layers);
    }
    if (s.any_viewport_open()) s.request_render();
    return result_for<api::SetViewportFocus>();
  }
  R operator()(const api::SetViewerLut& c) const {
    // Editor state for every viewport (never an export): '' clears it.
    if (c.lut.empty()) {
      s.viewerLut_.reset();
    } else {
      std::optional<js::Json> table = js::parse(c.lut);
      const bool shaped = table && table->is_object() && table->at("data").is_array()
                          && (table->at("size").is_number() || table->at("size1d").is_number());
      if (!shaped) fail(ErrorCode::invalid_argument, "viewer LUT is not a stored .cube table");
      auto lut = std::make_shared<ViewerLut>();
      lut->table = std::move(*table);
      lut->intensity = std::isfinite(c.intensity) ? std::clamp(c.intensity, 0.0, 1.0) : 1.0;
      s.viewerLut_ = std::move(lut);
    }
    if (s.any_viewport_open()) s.request_render();
    return result_for<api::SetViewerLut>();
  }
  R operator()(const api::SetUseProxies& c) const {
    // Editor state for every viewport (never an export): frame_port carries it
    // to each frame, and to the cache scope — the proxy frames and the
    // original frames are never the same cached frame.
    if (s.useProxies_ != c.enabled) {
      s.useProxies_ = c.enabled;
      if (s.any_viewport_open()) s.request_render();
    }
    return result_for<api::SetUseProxies>();
  }
  R operator()(const api::SetOverlayGeometry& c) const {
    // B4 round 2: replace this viewport's subscription (none = unsubscribe); the next frame carries it.
    auto& subs = s.overlays_;
    subs.erase(std::remove_if(subs.begin(), subs.end(), [&](const doc::OverlaySubscription& o) { return o.viewport == c.viewport; }),
               subs.end());
    doc::OverlaySubscription sub;
    sub.viewport = c.viewport;
    sub.layers = c.layers;
    sub.kinds = c.kinds;
    sub.groups = c.groups;  // B4 round 5
    sub.views = c.views;
    sub.rig = c.rig;  // B4 round 5: the rig overlay's focus
    if (sub.active()) subs.push_back(std::move(sub));
    s.request_render();
    return result_for<api::SetOverlayGeometry>();
  }
};

api::CommandResult Session::run_control(const api::Command& cmd, api::Origin origin, Clock::time_point now) {
  const std::string name = command_name(cmd);
  if (!doc::registry().commandKinds.contains(command_id(cmd))) fail(ErrorCode::unsupported, "unknown command '" + name + "'");
  return std::visit(ControlVisitor{*this, origin, now, name}, cmd.v);
}

// ── queries ─────────────────────────────────────────────────────────────────

api::QueryResult Session::run_query(const api::Query& q) {
  doc::QCtx c{pctx(), keys_, 0, "", false, {}, {}, {}, {}, &catalogCache_, {}, {}};
  if (!options_.testPorts) c.fonts = options_.systemFonts;
  // The builder's text measurer and the rig, each call under the build lock
  // (the build worker uses the same objects while it builds a frame).
  if (frameBuilder_ != nullptr && frameBuilder_->text_queries() != nullptr) {
    if (!lockedText_) lockedText_ = std::make_unique<LockedText>(*this);
    c.text = lockedText_.get();
  }
  if (rig_queries() != nullptr) {
    if (!lockedRig_) lockedRig_ = std::make_unique<LockedRig>(*this);
    c.rig = lockedRig_.get();
  }
  c.revision = revision_;
  c.projectPath = projectPath_;
  c.dirty = revision_ != savedRevision_;
  c.history = [this] { return history_state(); };
  c.log = [this](api::Revision from) {
    std::vector<api::LogRecord> out;
    for (const auto& r : log_) {
      if (r.revision_after > from) out.push_back(r);
    }
    return out;
  };
  c.capabilities = [this] {
    api::Capabilities cap;
    cap.gpu_adapter = sink_.adapter();
    cap.gpu_backend = sink_.backend();
    cap.export_formats = {"mp4-h264", "mov-prores", "webm-vp9", "png-seq", "gif"};
    cap.color_management = true;
    cap.expression_engines = {"premation"};
    cap.cpu_threads = std::thread::hardware_concurrency();
    return cap;
  };
  c.renderStats = [this](bool profileLayers) {
    if (profileLayers) sink_.request_layer_profile();
    return render_stats();
  };
  c.cacheCoverage = [this](const std::optional<std::string>& comp) {
    api::CacheCoverage out;
    const auto active = active_comp();
    if (comp && active && *comp != *active) return out;
    if (comp && !active) return out;
    const double fps = active ? doc::comp_fps(doc_, *active) : 30.0;
    const CacheCoverageSnap snap = sink_.cache_coverage();
    out.ram_bytes = snap.ramBytes;
    out.disk_bytes = snap.diskBytes;
    out.ram.reserve(snap.ram.size());
    for (const auto& [start, end] : snap.ram) {
      out.ram.push_back(api::CacheRange{doc::frames_to_flicks(static_cast<double>(start), fps),
                                        doc::frames_to_flicks(static_cast<double>(end), fps)});
    }
    out.disk.reserve(snap.disk.size());
    for (const auto& [start, end] : snap.disk) {
      out.disk.push_back(api::CacheRange{doc::frames_to_flicks(static_cast<double>(start), fps),
                                         doc::frames_to_flicks(static_cast<double>(end), fps)});
    }
    return out;
  };
  c.layerErrors = [this](const std::string& comp) {
    if (!comp.empty() && comp != layerErrorsComp_) return std::vector<api::LayerError>{};
    return layerErrors_;
  };
  if (frameBuilder_ != nullptr) {
    c.hitTest = [this](const std::string& comp, api::Time time, api::Vec2 point, std::vector<std::string>& out) {
      const BuildLock lock(*this, false);
      frameBuilder_->set_media_base(media_base());
      return frameBuilder_->hit_test(doc_, view_, exprEnv_, exprCache_, comp, time, point, out);
    };
    c.layerFaces = [this](const std::string& comp, api::Time time, const std::string& layer) {
      const BuildLock lock(*this, false);
      frameBuilder_->set_media_base(media_base());
      return frameBuilder_->layer_faces(doc_, view_, exprEnv_, exprCache_, comp, time, layer);
    };
  }
  c.still = [this](const doc::StillRequest& r) { return render_still(r); };
  c.documentStill = [this](const doc::Json& file, const std::string& comp, api::Time time, std::uint32_t maxSize) {
    return render_document_still(file, comp, time, maxSize);
  };
  c.viewportSlot = [this](std::uint32_t viewport) -> std::optional<std::pair<std::uint32_t, std::uint32_t>> {
    const auto it = surfaces_.find(viewport);
    if (it == surfaces_.end() || it->second.width == 0 || it->second.height == 0) return std::nullopt;
    return std::pair{it->second.width, it->second.height};
  };
  c.readPixels = [this](std::uint32_t viewport, PixelRegion region) {
    return await_render<WorkingPixels>(sink_.read_pixels(viewport, region), "readPixels", [](WorkingPixels px) {
      return query_result_for<api::ReadPixels>(api::PixelSamples{px.width, px.height, std::move(px.rgba)});
    });
  };
  if (mediaClock_ != nullptr) {
    c.waveform = [this](std::string_view src, double fromSec, double durationSec, std::uint32_t buckets,
                        api::WaveformPeaks& out) { return mediaClock_->peaks(src, fromSec, durationSec, buckets, out); };
  }
  // Live input is session state too (the cameras, through the live port).
  if (std::holds_alternative<api::ListCameras>(q.v)) return list_cameras();
  // Jobs are session state (jobs_), not the document's.
  if (std::holds_alternative<api::GetJobs>(q.v)) {
    api::JobList list;
    for (const JobRecord& r : jobs_) list.jobs.push_back(r.info);
    return query_result_for<api::GetJobs>(std::move(list));
  }
  // Queries never write the document: bar lookups come from an index for the
  // duration (timeline.hpp TlReadScope).
  const doc::TlReadScope readOnly;
  return doc::run_query(q, c);
}

std::string Session::media_base() const {
  // project_open.cpp's rule: a bundle holds its media; a JSON file's sit beside it.
  if (projectPath_.empty()) return {};
  if (!bundleRoot_.empty() && bundleRoot_ == projectPath_) return projectPath_;
  // The folder, by the UTF-8 string itself (a std::filesystem::path from a
  // narrow string is the ANSI code page on Windows).
  const std::size_t slash = projectPath_.find_last_of("/\\");
  return slash == std::string::npos ? std::string() : projectPath_.substr(0, slash);
}

namespace {

/// A still's or pixel read's answer as the query's outcome: `finish` for a
/// ready one, the hook's error otherwise.
template <class T>
api::Outcome render_outcome(T value, std::string_view what, const std::function<api::QueryResult(T)>& finish) {
  api::Outcome o;
  try {
    if (value.answer != HookAnswer::ready) doc::fail_hook(value.answer, value.error, what);
    o.v = finish(std::move(value));
  } catch (const EngineFail& f) {
    o.v = f.error;
  } catch (const std::exception& e) {
    o.v = err(ErrorCode::internal, e.what());
  }
  return o;
}

}  // namespace

template <class T>
T Session::await_render(std::future<T> result, std::string_view what, std::function<api::QueryResult(T)> finish) {
  const auto take = [&what](std::future<T>& f) -> T {
    try {
      return f.get();
    } catch (const std::future_error&) {
      T out;
      out.answer = HookAnswer::failed;
      out.error = std::string(what) + ": the renderer stopped";
      return out;
    }
  };
  // Answered already (the simulated sink, a cached still): the handler finishes it inline.
  if (result.wait_for(std::chrono::milliseconds(0)) == std::future_status::ready) return take(result);
  if (!scope_) {
    // No request to answer later: a bounded wait, then `busy`.
    if (result.wait_for(kRenderQueryTimeout) != std::future_status::ready) {
      T out;
      out.answer = HookAnswer::pending;
      out.error = std::string(what) + ": the renderer is busy; ask again";
      return out;
    }
    return take(result);
  }
  // Owed: the response goes out from poll_deferred once the render thread got to it.
  auto shared = std::make_shared<std::future<T>>(std::move(result));
  DeferredReply reply;
  reply.seq = scope_->seq;
  reply.what = std::string(what);
  reply.since = loopNow_;
  reply.poll = [shared, take, finish = std::move(finish), what = std::string(what)]() -> std::optional<api::Outcome> {
    if (shared->wait_for(std::chrono::milliseconds(0)) != std::future_status::ready) return std::nullopt;
    return render_outcome<T>(take(*shared), what, finish);
  };
  deferred_.push_back(std::move(reply));
  T out;
  out.answer = HookAnswer::deferred;
  return out;
}

void Session::poll_deferred(Clock::time_point now) {
  // Answers go out in the order they became ready; a reply past its budget
  // fails `busy` — the page asks again, and the log says which query it was.
  for (std::size_t i = 0; i < deferred_.size();) {
    DeferredReply& r = deferred_[i];
    std::optional<api::Outcome> o = r.poll();
    if (!o && now - r.since >= kDeferredBudget) {
      PREMATION_LOG(warn, "render_query_abandoned")
          .kv("what", r.what)
          .kv("ms", static_cast<std::int64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(now - r.since).count()));
      o.emplace();
      o->v = err(ErrorCode::busy, r.what + ": the renderer did not answer in " + std::to_string(kDeferredBudget.count()) + " s; ask again");
    }
    if (!o) {
      ++i;
      continue;
    }
    const api::Seq seq = r.seq;
    deferred_.erase(deferred_.begin() + static_cast<std::ptrdiff_t>(i));
    respond(seq, std::move(*o));
  }
}

StillImage Session::render_still(const doc::StillRequest& r) {
  if (frameBuilder_ == nullptr) {
    StillImage out;
    out.error = "getThumbnail needs the engine's scene builder (D2w); this engine draws C2 quads only";
    return out;
  }
  std::shared_ptr<BuiltFrame> frame;
  {
    const BuildLock lock(*this, false);
    frameBuilder_->set_media_base(media_base());
    frame = r.footageSrc.empty()
                ? frameBuilder_->build_still(doc_, view_, exprEnv_, exprCache_, r.comp, r.time, r.width, r.height, r.isolateLayer)
                : frameBuilder_->build_footage_still(doc_, r.footageSrc, r.video, r.sourceSec, r.sourceWidth, r.sourceHeight,
                                                     r.width, r.height);
  }
  if (!frame) {
    StillImage out;
    out.error = "the scene builder cannot build this still";
    return out;
  }
  return await_render<StillImage>(sink_.render_still(std::move(frame), r.width, r.height), "getThumbnail", [](StillImage img) {
    return query_result_for<api::GetThumbnail>(api::Thumbnail{img.width, img.height, std::move(img.format), std::move(img.data)});
  });
}

std::shared_ptr<const doc::LayerPixels> Session::probe_layer_pixels(const doc::DocExprEnv& env, std::string_view node,
                                                                    double t, bool postEffect, std::string& error) {
  if (frameBuilder_ == nullptr) {
    error = "sampleImage needs the engine's renderer; this engine has none.";
    return nullptr;
  }
  const std::optional<std::string> comp = doc::comp_of_layer(env.document(), node);
  if (!comp) {
    error = "sampleImage: the layer is in no composition.";
    return nullptr;
  }
  std::shared_ptr<BuiltFrame> frame;
  doc::LayerPixels drawn;
  {
    // The build worker holds the build lock for its whole build; elsewhere this takes it.
    std::optional<BuildLock> lock;
    if (!tlBuildWorker) {
      lock.emplace(*this, false);
      frameBuilder_->set_media_base(media_base());
    }
    try {
      frame = frameBuilder_->build_layer_pixels(env.document(), env.view(), env, env.cache(), *comp, node, t, postEffect, drawn);
    } catch (const EngineFail& f) {
      error = "sampleImage: " + f.error.message;
      return nullptr;
    } catch (const std::exception& e) {
      error = std::string("sampleImage: ") + e.what();
      return nullptr;
    }
  }
  if (!frame) {
    error = "sampleImage: this engine's frame builder cannot draw a layer alone.";
    return nullptr;
  }
  // The render thread draws it between viewport frames; it never waits on this thread.
  std::future<WorkingPixels> pending = sink_.read_frame(std::move(frame), drawn.width, drawn.height);
  if (pending.wait_for(kSampleImageWait) != std::future_status::ready) {
    error = "sampleImage: the renderer did not draw the layer in time.";
    return nullptr;
  }
  WorkingPixels px;
  try {
    px = pending.get();
  } catch (const std::future_error&) {
    error = "sampleImage: the renderer stopped.";
    return nullptr;
  }
  if (px.answer != HookAnswer::ready || px.rgba.size() < std::size_t{px.width} * px.height * 4) {
    error = "sampleImage: " + (px.error.empty() ? std::string("the layer could not be drawn.") : px.error);
    return nullptr;
  }
  // The read's own size (the slot may have been clamped): the scale follows it.
  drawn.scale *= drawn.width > 0 ? static_cast<double>(px.width) / drawn.width : 1.0;
  auto out = std::make_shared<doc::LayerPixels>(std::move(drawn));
  out->width = px.width;
  out->height = px.height;
  out->rgba = std::move(px.rgba);
  // The read is straight colour; the area average weighs it by alpha.
  for (std::size_t i = 0; i + 3 < out->rgba.size(); i += 4) {
    const float a = out->rgba[i + 3];
    out->rgba[i] *= a;
    out->rgba[i + 1] *= a;
    out->rgba[i + 2] *= a;
  }
  return out;
}

StillImage Session::render_document_still(const doc::Json& file, const std::string& compSel, api::Time time, std::uint32_t maxSize) {
  StillImage out;
  if (frameBuilder_ == nullptr) {
    out.error = "renderDocumentStill needs the engine's scene builder (D2w)";
    return out;
  }
  // A scratch document: the open one, its history and its caches are untouched.
  doc::Document d;
  doc::EditorView v;
  try {
    (void)doc::restore_document(d, v, file, doc_.items().assets);
  } catch (const std::exception& e) {
    out.error = std::string("the document could not be read: ") + e.what();
    return out;
  }
  std::string comp = compSel;
  if (comp.empty()) comp = v.tabComp;
  if (comp.empty() && !d.comps().empty()) comp = d.comps().keys().front();
  if (comp.empty() || d.comp(comp) == nullptr) {
    out.error = "the document has no composition" + (comp.empty() ? std::string() : " '" + comp + "'");
    return out;
  }
  v.tabComp = comp;
  const api::CompSettings cs = doc::comp_settings(d, comp);
  const double w = std::max(1.0, static_cast<double>(cs.width));
  const double h = std::max(1.0, static_cast<double>(cs.height));
  const double scale = std::min(1.0, static_cast<double>(maxSize) / std::max(w, h));
  const auto width = static_cast<std::uint32_t>(std::max(1.0, std::round(w * scale)));
  const auto height = static_cast<std::uint32_t>(std::max(1.0, std::round(h * scale)));
  doc::ExprCache cache;
  cache.pixelProbe = exprCache_.pixelProbe;
  const doc::DocExprEnv env(d, v, cache);
  std::shared_ptr<BuiltFrame> frame;
  {
    const BuildLock lock(*this, false);
    frameBuilder_->set_media_base(media_base());
    frame = frameBuilder_->build_still(d, v, env, cache, comp, time, width, height, "");
  }
  if (!frame) {
    out.error = "the scene builder cannot build this still";
    return out;
  }
  return await_render<StillImage>(sink_.render_still(std::move(frame), width, height), "renderDocumentStill", [](StillImage img) {
    return query_result_for<api::RenderDocumentStill>(api::Thumbnail{img.width, img.height, std::move(img.format), std::move(img.data)});
  });
}

// ── transport ───────────────────────────────────────────────────────────────

std::optional<std::string> Session::active_comp() const {
  if (activeComp_ && doc::is_comp_item(doc_, *activeComp_)) return *activeComp_;
  if (doc::is_comp_item(doc_, view_.tabComp)) return view_.tabComp;
  const auto ids = doc::comp_item_ids(doc_);
  if (!ids.empty()) return ids.front();
  return std::nullopt;
}

api::Time Session::frame_dur() const {
  const auto c = active_comp();
  const double fps = c ? doc::comp_fps(doc_, *c) : 30.0;
  const api::Time d = doc::frames_to_flicks(1, fps);
  return d > 0 ? d : static_cast<api::Time>(doc::kFlicks / 30);
}

Session::Range Session::play_range() const { return frame_range(rangeKind_); }

Session::Range Session::prefetch_range() const {
  // The work area when the comp has one (AE caches the work area), else the whole comp.
  const auto c = active_comp();
  const bool workArea = c && doc::comp_settings(doc_, *c).work_area.duration > 0;
  return frame_range(workArea ? api::PlayRange::work_area : api::PlayRange::all);
}

Session::Range Session::frame_range(api::PlayRange kind) const {
  const auto c = active_comp();
  const api::Time fd = frame_dur();
  api::TimeRange r{0, fd};
  if (c) {
    const api::CompSettings cs = doc::comp_settings(doc_, *c);
    r = api::TimeRange{0, cs.duration};
    if (kind == api::PlayRange::work_area && cs.work_area.duration > 0) r = cs.work_area;
  }
  if (kind == api::PlayRange::custom && customRange_.duration > 0) r = customRange_;
  Range out;
  out.first = std::max<std::int64_t>(0, floor_div(r.start + fd - 1, fd));
  out.last = std::max(out.first, floor_div(r.start + r.duration + fd - 1, fd) - 1);
  return out;
}

void Session::set_time(api::Time t) {
  const auto c = active_comp();
  const api::Time fd = frame_dur();
  const api::Time dur = c ? doc::comp_settings(doc_, *c).duration : fd;
  const api::Time maxT = std::max<api::Time>(0, dur - fd);
  time_ = std::clamp<api::Time>(t, 0, maxT);
  frame_ = floor_div(time_, fd);
}

void Session::seek_to(api::Time flicks) {
  const auto comp = active_comp();
  const double fps = comp ? doc::comp_fps(doc_, *comp) : 30.0;
  // Frame-exact, like the editor's clock mirror (transport.ts seekTo).
  apiTime_ = doc::frames_to_flicks(doc::flicks_to_frames(std::max<api::Time>(0, flicks), fps), fps);
  if (comp && *comp == view_.tabComp) view_.tabTime = doc::flicks_to_seconds(apiTime_);
  set_time(apiTime_);
}

void Session::start_playback(Clock::time_point now, std::optional<api::Time> from) {
  const Range r = play_range();
  if (from) set_time(*from);
  std::int64_t f = frame_;
  // AE: play from the start when the playhead is outside the range or at its end.
  if (rate_ > 0 && (f < r.first || f >= r.last)) f = r.first;
  if (rate_ < 0 && (f > r.last || f <= r.first)) f = r.last;
  set_time(f * frame_dur());
  playFrom_ = time_;
  playing_ = true;
  playTally_ = {};
  playBase_ = now;
  playBaseU_ = frame_ - r.first;
  lastK_ = 0;
  lastU_ = playBaseU_;
  clockDropped_ = 0;
  lastStats_ = now;
  autoFilled_ = false;
  passDropBase_ = drops_so_far();
  // cacheFirst stores the range before the clock runs, so audio waits with it.
  const bool filling = transportState_ == api::TransportState::caching;
  if (!filling && mediaClock_ != nullptr) {  // E2: the audio clock starts with the transport
    sync_audio();
    const double fd = doc::flicks_to_seconds(frame_dur());
    const MediaClock::Loop lp = loop_ == api::LoopMode::once        ? MediaClock::Loop::once
                                : loop_ == api::LoopMode::ping_pong ? MediaClock::Loop::pingPong
                                                                    : MediaClock::Loop::loop;
    mediaClock_->play(doc::flicks_to_seconds(time_), rate_, lp, static_cast<double>(r.first) * fd,
                      static_cast<double>(r.last + 1) * fd);
    mediaPaced_ = false;
  }
  emit_transport();
  emit_playhead();
  if (filling) {
    cacheFrame_ = r.first;
    cacheInFlight_ = false;
    cacheRetryUntil_.reset();
    renderDirty_ = false;
    return;
  }
  submit_frame(0);
  renderDirty_ = false;
}

void Session::fill_cache(Clock::time_point now) {
  const Range r = play_range();
  // The fill's viewport: the first open comp viewport that records coverage
  // (a pop-out or the Layer panel finishing a frame must not advance the fill).
  if (cacheViewport_ == 0 || !surfaces_.contains(cacheViewport_) || !surfaces_.at(cacheViewport_).open) {
    cacheViewport_ = 0;
    for (const auto& [id, port] : surfaces_) {
      if (port.open && port.layer.empty() && !port.time) {
        cacheViewport_ = id;
        break;
      }
    }
    if (cacheViewport_ == 0) {
      for (const auto& [id, port] : surfaces_) {
        if (port.open) {
          cacheViewport_ = id;
          break;
        }
      }
    }
  }
  if (cacheInFlight_) {
    const PortCounters c = sink_.port_counters(cacheViewport_);
    if (c.rendered == cacheSeenRendered_) {
      if (now - lastStats_ >= std::chrono::seconds(1)) emit_stats(now);
      return;
    }
    cacheInFlight_ = false;
    // The frame drew with footage still decoding (a stand-in, never stored):
    // draw it again rather than leave a hole in the range — for a while, so a
    // source that never decodes cannot stall the fill.
    constexpr auto kStandInRetry = std::chrono::seconds(2);
    if (c.standIn != cacheSeenStandIn_) {
      if (!cacheRetryUntil_) cacheRetryUntil_ = now + kStandInRetry;
      if (now < *cacheRetryUntil_) --cacheFrame_;
      else cacheRetryUntil_.reset();
    } else {
      cacheRetryUntil_.reset();
    }
  }
  if (cacheFrame_ > r.last) sink_.publish_coverage_now();  // the whole range is in: the bar shows it now
  if (cacheFrame_ > r.last && cacheOnly_) {
    // The range is stored and that was the whole request: stop where the playhead was.
    cacheOnly_ = false;
    stop_playback();
    seek_to(cacheReturn_);
    emit_transport();
    emit_playhead();
    submit_frame(0);  // from a tick: nothing flushes a render request after it
    renderDirty_ = false;
    return;
  }
  if (cacheFrame_ > r.last) {
    // The range is stored. Play it from the start play() chose, on the clock.
    transportState_ = api::TransportState::playing;
    set_time(playFrom_);
    playBase_ = now;
    playBaseU_ = frame_ - r.first;
    lastK_ = 0;
    lastU_ = playBaseU_;
    clockDropped_ = 0;
    if (mediaClock_ != nullptr) {
      sync_audio();
      const double fd = doc::flicks_to_seconds(frame_dur());
      const MediaClock::Loop lp = loop_ == api::LoopMode::once        ? MediaClock::Loop::once
                                  : loop_ == api::LoopMode::ping_pong ? MediaClock::Loop::pingPong
                                                                      : MediaClock::Loop::loop;
      mediaClock_->play(doc::flicks_to_seconds(time_), rate_, lp, static_cast<double>(r.first) * fd,
                        static_cast<double>(r.last + 1) * fd);
      mediaPaced_ = false;
    }
    emit_transport();
    emit_playhead();
    submit_frame(0);
    renderDirty_ = false;
    return;
  }
  set_time(cacheFrame_ * frame_dur());
  emit_playhead();
  {
    const PortCounters c = sink_.port_counters(cacheViewport_);
    cacheSeenRendered_ = c.rendered;
    cacheSeenStandIn_ = c.standIn;
  }
  submit_frame(0);
  cacheInFlight_ = true;
  ++cacheFrame_;
  if (now - lastStats_ >= std::chrono::seconds(1)) emit_stats(now);
}

// ── idle render-ahead ───────────────────────────────────────────────────────

void Session::note_activity(Clock::time_point now) {
  lastActivity_ = now;
  // Whatever the prefetcher had out is stale (an edit) or in the way (a seek,
  // a play): forgotten here; its answer, if it comes, is folded into the count
  // the next prefetch starts from. It steps out from the playhead again.
  prefetchOut_.clear();
  prefetchRefused_ = 0;
  prefetchResting_ = false;
  prefetchOrigin_ = -1;
  prefetchAhead_ = 0;
  prefetchBehind_ = 0;
}

bool Session::idle_prefetch_armed() const {
  // While a play is served from the cache tiers the build worker idles: the
  // prefetcher renders ahead of the playhead then (idle_prefetch). Not during a
  // cache fill, which builds every frame itself.
  if (!options_.idlePrefetch || phase_ != Phase::open || prefetchResting_ || gesture_) return false;
  if (playing_ && transportState_ == api::TransportState::caching) return false;
  // No scene builder (C2's quads: the core-only tests, PREMATION_ENGINE_SCENE=0): nothing worth caching.
  if (frameBuilder_ == nullptr || !active_comp()) return false;
  const bool view = std::ranges::any_of(surfaces_, [](const auto& e) { return e.second.open && e.second.layer.empty() && !e.second.time; });
  if (!view) return false;
  if (!prefetchOut_.empty()) return true;
  // Stepped through the whole range from this playhead: nothing until something moves.
  const Range r = prefetch_range();
  const std::int64_t origin = std::clamp(frame_, r.first, r.last);
  return !(prefetchOrigin_ == origin && origin + prefetchAhead_ >= r.last && origin - prefetchBehind_ <= r.first);
}

void Session::idle_prefetch(Clock::time_point now) {
  if (!idle_prefetch_armed()) return;
  if (!deferred_.empty() || !forceBuild_.empty() || renderDirty_) return;
  if (now - lastActivity_ < kIdlePrefetchAfter) return;
  const RenderCounters counters = sink_.counters();
  if (prefetchOut_.empty()) prefetchSeenAnswered_ = counters.prefetched;
  // One prefetch per worker in flight (item 7: the prefetch workers build side
  // by side); `prefetchOut_` is what went since the sink's answered count was
  // `prefetchSeenAnswered_` (answers to jobs a move forgot count too: clamped).
  const std::uint64_t answered = counters.prefetched - prefetchSeenAnswered_;
  if (!prefetchOut_.empty() && answered >= prefetchOut_.size()) {
    // All landed. The map knows a key once a tier kept it; refused by every tier
    // (the RAM budget full of this range, VRAM too small) a few rounds in a row,
    // the prefetcher rests until the next edit or move.
    const bool kept = std::ranges::any_of(prefetchOut_, [this](std::uint64_t k) { return k != 0 && sink_.cached_frame(k).has_value(); });
    prefetchRefused_ = kept ? 0 : prefetchRefused_ + 1;
    prefetchOut_.clear();
    prefetchSeenAnswered_ = counters.prefetched;
    if (prefetchRefused_ >= kIdlePrefetchRefusals) {
      prefetchResting_ = true;
      return;
    }
  }
  if (prefetchOut_.size() >= 1 + prefetchBuilders_.size()) return;  // every worker has one
  // Only when nothing else wants the main worker or the GPU: a frame being
  // built or drawn for a viewport, a cached job not yet answered, an engine job.
  if (viewport_builds_active() || cachedSubmitted_ > cachedAnswered_) return;
  if (runner_ && runner_->live() > 0) return;
  const std::optional<std::string> c = active_comp();
  if (!c) return;
  const ViewportConfig* view = nullptr;
  for (const auto& [id, port] : surfaces_) {
    if (port.open && port.layer.empty() && !port.time) {
      view = &port;
      break;
    }
  }
  if (view == nullptr || sink_.job_pending(view->viewport) || build_pending(view->viewport)) return;
  // Keyed frames only: the pre-build key is how the prefetcher knows what a
  // tier already holds, and what it just stored. A comp with volatile inputs
  // (time-dependent expressions outside the index) rebuilds every frame anyway.
  sync_frame_keys();
  if (!frameKeys_.indexed() || frameKeys_.volatile_inputs()) return;
  const Range r = prefetch_range();
  const std::int64_t origin = std::clamp(frame_, r.first, r.last);
  const ViewportConfig port = frame_port(*view, *c);
  const std::uint64_t scope = cache_scope(port, *c);
  if (playing_) {
    // Render-ahead while playing — only while the play is served from the tiers
    // (the worker would otherwise be building the frames it shows): the first
    // frame of the PLAY range no tier holds, far enough ahead that it is built
    // before the playhead reaches it (a build, in frames, and two more).
    // Forward only; the next tick looks again.
    if (!playFromCache_) return;
    const Range pr = play_range();
    const std::int64_t at = std::clamp(frame_, pr.first, pr.last);
    const double frameMs = static_cast<double>(frame_dur()) / static_cast<double>(doc::kFlicksPerSecond) * 1000.0;
    const auto lead = static_cast<std::int64_t>(std::clamp(std::ceil(builtMs_ / std::max(1.0, frameMs)) + 2.0, 2.0, 120.0));
    constexpr std::int64_t kPlayScan = 240;
    for (std::int64_t f = at + lead; f <= pr.last && f < at + lead + kPlayScan; ++f) {
      const std::uint64_t docKey = frameKeys_.key(f);
      if (docKey == 0) continue;
      const std::uint64_t pk = render::prebuild_key(scope, docKey);
      if (sink_.cached_frame(pk)) continue;
      prefetchOut_.push_back(pk);
      submit_frame_to(*view, *c, 0, false, f);
      return;
    }
    return;
  }
  if (prefetchOrigin_ != origin) {
    prefetchOrigin_ = origin;
    prefetchAhead_ = 0;
    prefetchBehind_ = 0;
  }
  // The next frame no tier holds: forward from the playhead to the end of the
  // range, then backward to its start (what Play needs first, then a scrub back).
  for (;;) {
    std::int64_t f = 0;
    if (origin + prefetchAhead_ < r.last) {
      f = origin + ++prefetchAhead_;
    } else if (origin - prefetchBehind_ > r.first) {
      f = origin - ++prefetchBehind_;
    } else {
      return;  // the range is covered
    }
    const std::uint64_t docKey = frameKeys_.key(f);
    if (docKey == 0) continue;
    const std::uint64_t pk = render::prebuild_key(scope, docKey);
    if (sink_.cached_frame(pk)) continue;  // a tier holds it (or will: a build of it is on its way)
    prefetchOut_.push_back(pk);
    submit_frame_to(*view, *c, 0, false, f);
    return;
  }
}

ViewportConfig Session::frame_port(const ViewportConfig& surface, const std::string& comp) const {
  // The surface's config plus this frame's editor-side hidden layers (they ride
  // beside the config, not in it: see `hiddenLayers_`), focus set and viewer LUT.
  ViewportConfig port = surface;
  if (const auto hidden = hiddenLayers_.find(surface.viewport); hidden != hiddenLayers_.end()) port.hiddenLayers = hidden->second;
  if (const auto focus = focusLayers_.find(surface.viewport); focus != focusLayers_.end()) port.focusLayers = focus->second;
  port.viewerLut = viewerLut_;
  // Use Proxies, only while some footage item has an enabled proxy: a part of
  // the view state (same_cache_view compares it), so a frame drawn from a
  // proxy and the same frame from the original never share a cache scope —
  // and a project without proxies keeps its scope (and its cache) on a toggle.
  port.useProxies = useProxies_ && doc::any_proxy_enabled(doc_);
  // Comp-space caching (frame_scene.hpp comp_space_frame): a composition view
  // whose slots take copies draws the comp's own pixels, so its cached frames
  // outlive a pane resize or a pan. Decided here, once per frame, and carried
  // to the builder (the port) and the render thread (the job) alike.
  if (port.layer.empty() && !port.time && sink_.slots_copyable()) {
    const api::CompSettings cs = doc::comp_settings(doc_, comp);
    port.compSpace = comp_space_frame(port, static_cast<double>(cs.width), static_cast<double>(cs.height));
  }
  return port;
}

void Session::rebase_playback(Clock::time_point now) {
  const Range r = play_range();
  playBase_ = now;
  playBaseU_ = frame_ - r.first;
  lastK_ = 0;
  lastU_ = playBaseU_;
  if (mediaClock_ != nullptr) {  // a seek while playing restarts the audio clock there
    const double fd = doc::flicks_to_seconds(frame_dur());
    const MediaClock::Loop lp = loop_ == api::LoopMode::once        ? MediaClock::Loop::once
                                : loop_ == api::LoopMode::ping_pong ? MediaClock::Loop::pingPong
                                                                    : MediaClock::Loop::loop;
    mediaClock_->play(doc::flicks_to_seconds(time_), rate_, lp, static_cast<double>(r.first) * fd,
                      static_cast<double>(r.last + 1) * fd);
    mediaPaced_ = false;
  }
}

std::uint64_t Session::drops_so_far() const {
  const RenderCounters c = sink_.counters();
  return c.dropped + c.inexact + clockDropped_;
}

namespace {
/// Two view states whose cached frames are the same pixels. Onion skin is
/// composited OVER the drawn frame on the render thread (composite_onion),
/// after the cache took its copy, and playback ignores it — so toggling it
/// must not open a new scope (the bar emptied and every frame was built
/// again). The viewer LUT is compared by its table, not its pointer: the
/// page re-sends the same LUT on a reload or a focus change.
/// A comp-space frame's view (ViewportConfig::compSpace) is the comp-space
/// texture: its size, scale and phase — not the pane's size, the pan or the
/// device pixel ratio, which no longer decide its pixels. Those fields are
/// replaced by the texture's, so two panes showing the same comp pixels share
/// one scope (the bar, the pre-build map, the RAM tier's protected range).
void canonical_cache_view(ViewportConfig& v) {
  if (!v.compSpace) return;
  const CompSpaceFrame& cs = *v.compSpace;
  v.width = cs.width;
  v.height = cs.height;
  v.zoom = cs.zoom;
  v.devicePixelRatio = cs.dpr;
  v.panX = cs.phaseX;
  v.panY = cs.phaseY;
  v.resolution = 1.0;  // folded into cs.dpr
  // Where the texture lands in the slot is the present's business, not the frame's.
  v.compSpace->slotX = 0;
  v.compSpace->slotY = 0;
  v.compSpace->present = 1;
  v.compSpace->originX = 0;
  v.compSpace->originY = 0;
}

bool same_cache_view(const ViewportConfig& a, const ViewportConfig& b) {
  const bool lutEq = (!a.viewerLut && !b.viewerLut) ||
                     (a.viewerLut && b.viewerLut && a.viewerLut->intensity == b.viewerLut->intensity &&
                      a.viewerLut->table == b.viewerLut->table);
  if (!lutEq) return false;
  ViewportConfig x = a;
  ViewportConfig y = b;
  x.onion.reset();
  y.onion.reset();
  x.viewerLut.reset();
  y.viewerLut.reset();
  canonical_cache_view(x);
  canonical_cache_view(y);
  return x == y;
}
}  // namespace

std::uint64_t Session::cache_scope(const ViewportConfig& port, const std::string& comp) {
  std::uint64_t configId = 0;
  for (const auto& [config, id] : scopeConfigs_) {
    if (same_cache_view(config, port)) {
      configId = id;
      break;
    }
  }
  if (configId == 0) {
    configId = ++scopeConfigSeq_;
    // A new view state (a zoom, a pane the comp-space frame could not absorb, a channel view): the bar starts over for it.
    PREMATION_LOG(info, "cache_scope_new")
        .kv("viewport", port.viewport)
        .kv("width", port.width)
        .kv("height", port.height)
        .kv("zoom", std::to_string(port.zoom))
        .kv("compSpace", port.compSpace ? static_cast<std::int64_t>(port.compSpace->width) : std::int64_t{-1})
        .kv("phaseX", std::to_string(port.compSpace ? port.compSpace->phaseX : -1.0))
        .kv("configs", static_cast<std::int64_t>(scopeConfigs_.size()));
    scopeConfigs_.emplace_back(port, configId);
    // A handful of recent view states is all a scope switch back needs (a pane, a zoom, a resolution).
    constexpr std::size_t kConfigsKept = 32;
    if (scopeConfigs_.size() > kConfigsKept) scopeConfigs_.erase(scopeConfigs_.begin());
  }
  // Two halves: the high word names the VIEW (the comp and the view-state id),
  // the low word the document revision. The render thread carries a view's
  // coverage over a revision that did not change the frame it draws
  // (RenderThread::note_coverage), so it can tell the two apart.
  std::uint64_t view = 0xcbf29ce484222325ULL;  // FNV-1a over the comp id
  for (const char ch : comp) {
    view ^= static_cast<unsigned char>(ch);
    view *= 0x100000001b3ULL;
  }
  view ^= configId * 0x9e3779b97f4a7c15ULL;
  const std::uint64_t scope = ((view ^ (view >> 32U)) << 32U) | revision_word(revision_);
  return scope == 0 ? 1 : scope;  // 0 = no scope (ram_cache.hpp ProtectedRange)
}

std::uint32_t Session::revision_word(api::Revision revision) noexcept {
  std::uint64_t rev = static_cast<std::uint64_t>(revision) * 0xff51afd7ed558ccdULL;
  rev ^= rev >> 32U;
  return static_cast<std::uint32_t>(rev & 0xffffffffULL);
}

void Session::sync_frame_keys() {
  const std::optional<std::string> active = active_comp();
  if (!active) {
    if (!frameKeys_.comp().empty()) frameKeys_.reset();
    return;
  }
  if (frameKeys_.comp() == *active) return;
  (void)frameKeys_.rebuild(doc_, view_, *active, media_base());
}

void Session::note_document_changed(api::Revision from, const doc::ChangeSet* changes) {
  FrameRevision rev;
  rev.fromRev = revision_word(from);
  rev.toRev = revision_word(revision_);
  if (changes == nullptr) {
    // The whole document changed under the index (a load, a reset): built
    // again for the active comp the next time a frame asks.
    frameKeys_.reset();
  } else {
    sync_frame_keys();
    if (frameKeys_.indexed()) {
      doc::FrameKeyIndex::Delta delta = frameKeys_.update(doc_, view_, *changes, media_base());
      rev.all = delta.all;
      if (!delta.all) {
        rev.frames = std::move(delta.frames);
        // The changed frames' new keys let the bars take back what a tier
        // still holds (an undo) without a build. Bounded: a step that reaches
        // thousands of frames sends the frames alone (they come back as drawn).
        constexpr std::size_t kKeyedFrames = 4096;
        if (rev.frames.size() <= kKeyedFrames) {
          rev.keys.reserve(rev.frames.size());
          for (const std::int64_t f : rev.frames) rev.keys.push_back(frameKeys_.key(f));
        }
      }
    }
  }
  sink_.note_frames_changed(std::move(rev));
}

void Session::poll_build_requests() {
  const std::vector<std::uint32_t> wants = sink_.take_build_requests();
  if (wants.empty()) return;
  for (const std::uint32_t v : wants) {
    if (std::ranges::find(forceBuild_, v) == forceBuild_.end()) forceBuild_.push_back(v);
  }
  if (playing_ && transportState_ == api::TransportState::caching && cacheInFlight_) {
    // The frame the fill is waiting on was a cached job no tier held after all:
    // the fill takes it again, built this time.
    cacheInFlight_ = false;
    cacheFrame_ = std::max(play_range().first, cacheFrame_ - 1);
    return;
  }
  request_render();
  flush_render();  // paused: build it now; playing: the next tick's frame builds
}

void Session::stop_playback() {
  if (!playing_) return;
  PREMATION_LOG(info, "playback_summary")
      .kv("frames", playTally_.frames)
      .kv("keyed", playTally_.keyed)
      .kv("servedWithoutBuild", playTally_.cached)
      .kv("indexed", frameKeys_.indexed())
      .kv("indexBytes", frameKeys_.bytes())
      .kv("volatile", frameKeys_.volatile_inputs())
      .kv("buildMs", buildMs_);
  playing_ = false;
  cacheInFlight_ = false;
  transportState_ = api::TransportState::stopped;
  if (mediaClock_ != nullptr) mediaClock_->pause();
  mediaPaced_ = false;
  // The end of a play (its own, or a pause) starts the idle prefetcher's quiet
  // period over: it never cuts in on the frame the viewer settles on.
  note_activity(loopNow_);
}

std::optional<Clock::time_point> Session::next_deadline() const {
  // Jobs: the core loop wakes to drain them (progress, results) every 50 ms.
  std::optional<Clock::time_point> jobs;
  if (runner_ && runner_->live() > 0) jobs = jobsPolled_ + std::chrono::milliseconds(50);
  for (const JobRecord& r : jobs_) {
    if (r.result && r.apply && r.info.status == api::JobStatus::done && !r.info.applied) jobs = jobsPolled_ + std::chrono::milliseconds(50);
  }
  // Owed render answers, and frame builds in flight on the build worker (their
  // layer errors and build times come back as reports tick() takes): looked
  // at every few ms until sent.
  if (!deferred_.empty() || (buildThread_.joinable() && builds_active())) {
    const Clock::time_point poll = Clock::now() + kDeferredPoll;
    jobs = jobs ? std::min(*jobs, poll) : poll;
  }
  // Cached jobs (RenderJob::cachedKey) the sink has not answered yet: one of
  // them may come back as a build request (a tier evicted the frame meanwhile).
  if (cachedSubmitted_ > cachedAnswered_ && loopNow_ < cachedPollUntil_) {
    const Clock::time_point poll = Clock::now() + kDeferredPoll;
    jobs = jobs ? std::min(*jobs, poll) : poll;
  }
  // Idle render-ahead: the quiet period after the last command, then a poll
  // per prefetched frame (each waits for the one before it to land).
  if (idle_prefetch_armed()) {
    const Clock::time_point quiet = lastActivity_ + kIdlePrefetchAfter;
    const Clock::time_point poll = std::max(quiet, Clock::now() + kIdlePrefetchPoll);
    jobs = jobs ? std::min(*jobs, poll) : poll;
  }
  // Live input: its frames are relayed as they come (≈ the camera's 30–60 Hz),
  // so the loop looks every few ms while it runs — a frame waits at most that.
  if (live_ != nullptr && live_->active()) {
    const Clock::time_point poll = Clock::now() + std::chrono::milliseconds(4);
    jobs = jobs ? std::min(*jobs, poll) : poll;
  }
  const std::optional<Clock::time_point> clock = next_clock_deadline();
  if (jobs && clock) return std::min(*jobs, *clock);
  return jobs ? jobs : clock;
}

std::optional<Session::Clock::time_point> Session::next_clock_deadline() const {
  if (!playing_) return std::nullopt;
  if (transportState_ == api::TransportState::caching) {
    // Poll until the frame in flight is stored, then take the next one.
    return Clock::now() + std::chrono::milliseconds(1);
  }
  const auto c = active_comp();
  if (!c) return std::nullopt;
  const double fps = doc::comp_fps(doc_, *c) * std::abs(rate_);
  if (fps <= 0) return std::nullopt;
  if (mediaPaced_) {
    // E2: predict when the audio clock reaches the next frame from its last
    // reading; never sooner than 1 ms after it (the device clock advances in
    // buffer steps — polling faster would spin).
    const double compFps = doc::comp_fps(doc_, *c);
    const double ahead = (static_cast<double>(lastK_ + 1) / compFps - mediaElapsed_) / std::abs(rate_);
    const auto wait = std::chrono::duration<double>(std::max(ahead, 0.001));
    return mediaReadAt_ + std::chrono::duration_cast<Clock::duration>(wait);
  }
  const auto step = std::chrono::duration<double>(static_cast<double>(lastK_ + 1) / fps);
  return playBase_ + std::chrono::duration_cast<Clock::duration>(step);
}

void Session::tick(Clock::time_point now) {
  // The render thread stores every frame of a fill (FrameSink::set_filling).
  sink_.set_filling(playing_ && transportState_ == api::TransportState::caching);
  loopNow_ = now;
  if (buildThread_.joinable()) pump_builds();
  if (cachedSubmitted_ > cachedAnswered_) {
    const RenderCounters c = sink_.counters();
    cachedAnswered_ = c.cacheServed + c.cacheMissed + c.cacheDropped;
  }
  poll_build_requests();
  if (!deferred_.empty()) poll_deferred(now);
  if (phase_ == Phase::open && (runner_ || !jobs_.empty())) poll_jobs(now);
  poll_live();
  if (phase_ == Phase::open && options_.idlePrefetch) idle_prefetch(now);
  if (!playing_ || phase_ != Phase::open) return;
  if (transportState_ == api::TransportState::caching) {
    fill_cache(now);
    return;
  }
  const auto c = active_comp();
  if (!c) {
    stop_playback();
    emit_transport();
    return;
  }
  const double fps = doc::comp_fps(doc_, *c) * std::abs(rate_);
  // Wall time only PACES the clock (which frame is due); what a frame shows is
  // a pure function of its frame index. Late → frames are skipped, never
  // stretched (AE: video drops frames rather than drifting).
  //
  // E2 (audio/transport_clock.hpp): while the document's audio plays, the
  // AUDIO clock paces — frames follow the samples the device consumed, so
  // picture and sound never drift. Until the clock locks, the wall clock does.
  if (mediaClock_ != nullptr && revision_ != audioRevision_) sync_audio();
  std::optional<double> media = mediaClock_ != nullptr ? mediaClock_->media_elapsed(now) : std::nullopt;
  // A play or a seek restarts the audio clock, but until the restart reaches the speaker
  // (one output latency) the device reports the segment it is still sounding: the OLD one,
  // its elapsed counted from the old Play. Taken, that jumped the playhead ahead by
  // everything played before and then held it there (k <= lastK_) until the new clock
  // caught up — Go to Start mid-play froze the picture and the timer for as long as it
  // had played. The restarted clock never runs ahead of the wall time since the restart
  // (1 % covers any device drift), so a reading that does is stale: the wall clock paces.
  if (media) {
    const double wall = std::chrono::duration<double>(now - playBase_).count() * std::abs(rate_);
    if (*media > (wall * 1.01) + 0.1) media.reset();
  }
  std::int64_t k = 0;
  if (media) {
    mediaPaced_ = true;
    mediaElapsed_ = *media;
    mediaReadAt_ = now;
    k = static_cast<std::int64_t>(std::floor(*media * doc::comp_fps(doc_, *c) + 1e-9));
  } else {
    mediaPaced_ = false;
    const double elapsed = std::chrono::duration<double>(now - playBase_).count();
    k = static_cast<std::int64_t>(std::floor(elapsed * fps + 1e-9));
  }
  if (k <= lastK_) {
    if (now - lastStats_ >= std::chrono::seconds(1)) emit_stats(now);
    return;
  }
  const Range r = play_range();
  const std::int64_t span = r.last - r.first + 1;
  const std::int64_t dir = rate_ < 0 ? -1 : 1;
  const std::int64_t u = playBaseU_ + dir * k;
  const std::int64_t jumped = std::abs(u - lastU_);
  std::uint32_t dropped = jumped > 1 ? static_cast<std::uint32_t>(std::min<std::int64_t>(jumped - 1, 1'000'000)) : 0;
  bool stop = false;
  std::int64_t pos = 0;
  switch (loop_) {
    case api::LoopMode::once:
      if (u >= span || u < 0) {
        pos = u >= span ? span - 1 : 0;
        stop = true;
      } else {
        pos = u;
      }
      break;
    case api::LoopMode::loop:
      pos = mod_pos(u, span);
      break;
    case api::LoopMode::ping_pong: {
      const std::int64_t period = span > 1 ? 2 * (span - 1) : 1;
      const std::int64_t m = mod_pos(u, period);
      pos = m < span ? m : period - m;
      break;
    }
  }
  // P9 — AE's RAM preview: a looping play whose pass dropped frames never
  // gets smoother on its own (only shown frames are stored, and the same ones
  // are skipped every pass). At the wrap the transport stores the whole range
  // once (Cache Work Area's exact fill), then plays it from the start out of
  // the cache. Once per play: a range larger than the cache does not refill forever.
  const bool wrapped = loop_ == api::LoopMode::loop && span > 0 && floor_div(u, span) != floor_div(lastU_, span);
  if (wrapped && !autoFilled_ && drops_so_far() + dropped > passDropBase_) {
    autoFilled_ = true;
    lastK_ = k;
    lastU_ = u;
    transportState_ = api::TransportState::caching;
    cacheOnly_ = false;
    cacheFrame_ = r.first;
    cacheInFlight_ = false;
    playFrom_ = r.first * frame_dur();
    if (mediaClock_ != nullptr) mediaClock_->pause();
    mediaPaced_ = false;
    emit_transport();
    fill_cache(now);
    return;
  }
  // The same for a play-once (the UI's default: it sends `once` whenever
  // looping is off), where there is no wrap to fill at: a pass that skipped
  // more than a frame ends where it ends, and the NEXT Play of this transport
  // stores the range first (cacheFirst — AE's preview rendering before it
  // plays), then plays it from the cache. One late frame is not worth a pass.
  if (stop && drops_so_far() + dropped > passDropBase_ + 1) nextPlayCachesFirst_ = true;
  if (wrapped) passDropBase_ = drops_so_far() + dropped;
  lastK_ = k;
  lastU_ = u;
  clockDropped_ += dropped;
  set_time((r.first + pos) * frame_dur());
  emit_playhead();
  // The last frame of a play-once always draws: it is what the viewport keeps.
  submit_frame(dropped, !stop);
  renderDirty_ = false;
  if (stop) {
    stop_playback();
    emit_transport();
  }
  if (now - lastStats_ >= std::chrono::seconds(1)) emit_stats(now);
}

api::RenderStats Session::render_stats() {
  // A2: getRenderStats and renderStatsUpdated answer the same figures — VRAM
  // (device pool + footage textures + frame cache, from the render thread),
  // decode time and the last slot-size switch included.
  const RenderCounters c = sink_.counters();
  api::RenderStats st;
  st.gpu_frame_ms = c.gpuFrameMs;
  st.cpu_frame_ms = buildMs_;
  st.fps = c.fps;
  st.decode_ms = c.decodeMs;
  st.cache_hit_rate = c.cacheHitRate;
  st.vram_bytes = c.vramBytes;
  st.dropped_frames = c.dropped + clockDropped_;
  // What the viewport frame cache holds (VRAM; the HUD's cache row and getCacheCoverage agree).
  const CacheCoverageSnap cacheSnap = sink_.cache_coverage();
  st.ram_cache_bytes = cacheSnap.ramBytes;
  st.disk_cache_bytes = cacheSnap.diskBytes;
  st.ram_cache_budget = cacheSnap.ramBudget;
  st.vram_cache_bytes = cacheSnap.vramBytes;
  st.vram_cache_budget = cacheSnap.vramBudget;
  st.disk_cache_budget = cacheSnap.diskBudget;
  if (cacheSnap.diskReadMsPerMp > 0) st.disk_read_ms_per_mp = cacheSnap.diskReadMsPerMp;
  st.idle_render_ahead = options_.idlePrefetch;
  if (options_.hostMemory) {
    const SessionOptions::HostMemory mem = options_.hostMemory();
    if (mem.processBytes > 0) st.engine_memory_bytes = mem.processBytes;
    if (mem.physicalBytes > 0) st.physical_memory_bytes = mem.physicalBytes;
    if (mem.availableBytes > 0) st.available_memory_bytes = mem.availableBytes;
  }
  if (c.gpuBudgetBytes > 0) {
    st.gpu_memory_budget = c.gpuBudgetBytes;
    st.gpu_memory_used = c.gpuUsedBytes;
    if (c.gpuTotalBytes > 0) st.gpu_memory_total = c.gpuTotalBytes;
  }
  st.gpu_memory_trimmed = c.gpuTrimmedBytes;
  if (const std::optional<LayerProfile> prof = sink_.layer_profile()) {
    // Heaviest first already; the panel shows a dozen, the wire carries 32 at most.
    constexpr std::size_t kMaxLayers = 32;
    for (const LayerProfile::Layer& l : prof->layers) {
      if (st.layer_costs.size() >= kMaxLayers) break;
      st.layer_costs.push_back(api::LayerCost{l.id, l.kind, l.gpuMs, l.passes});
    }
    st.layer_costs_frame_ms = prof->totalMs;
    const double nowUs = static_cast<double>(
        std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count());
    st.layer_costs_ago_ms = std::max(0.0, (nowUs - prof->drawnUs) / 1000.0);
  }
  if (c.slotSwitchEpochUs > 0) {
    // The same clock os::epoch_us reads (engine_core does not link os_ffi).
    const double nowUs = static_cast<double>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                                 std::chrono::system_clock::now().time_since_epoch())
                                                 .count()) /
                         1000.0;
    st.last_slot_switch_ago_ms = std::max(0.0, (nowUs - c.slotSwitchEpochUs) / 1000.0);
    st.slot_switch_ms = c.slotSwitchMs;
  }
  return st;
}

void Session::emit_stats(Clock::time_point now) {
  lastStats_ = now;
  const api::RenderStats st = render_stats();
  std::vector<api::Event> ev;
  ev.push_back(make_event(api::RenderStatsUpdatedEvent{st}));
  send_events(revision_, revision_, std::move(ev), std::nullopt, api::Origin::engine);
}

void Session::emit_transport() {
  if (phase_ != Phase::open) return;
  api::TransportChangedEvent t;
  t.state = playing_ ? transportState_ : api::TransportState::stopped;
  t.comp = active_comp().value_or("");
  t.time = playing_ ? time_ : apiTime_;
  t.rate = rate_;
  t.loop = loop_;
  const Range r = play_range();
  t.range = api::TimeRange{r.first * frame_dur(), (r.last - r.first + 1) * frame_dur()};
  std::vector<api::Event> ev;
  ev.push_back(make_event(std::move(t)));
  send_events(revision_, revision_, std::move(ev), std::nullopt, api::Origin::engine);
}

void Session::emit_playhead() {
  if (phase_ != Phase::open) return;
  // A UI that stopped reading must not grow our queue by 60 events a second;
  // the playhead is a status, the next one supersedes it.
  constexpr std::size_t kMaxBacklog = std::size_t{1} << 20U;
  if (out_.backlog_bytes() > kMaxBacklog) {
    ++playheadSkipped_;
    return;
  }
  api::PlayheadEvent p;
  p.comp = active_comp().value_or("");
  p.time = playing_ ? time_ : apiTime_;
  p.frame = playing_ ? frame_ : doc::to_i64(doc::flicks_to_frames(apiTime_, p.comp.empty() ? 30.0 : doc::comp_fps(doc_, p.comp)));
  p.dropped_frames = clockDropped_;
  std::vector<api::Event> ev;
  ev.push_back(make_event(std::move(p)));
  send_events(revision_, revision_, std::move(ev), std::nullopt, api::Origin::engine);
}

void Session::flush_render() {
  if (!renderDirty_ || playing_) return;  // while playing the next tick renders
  renderDirty_ = false;
  submit_frame(0);
}

void Session::submit_frame(std::uint32_t clockDropped, bool fromClock) {
  const auto c = active_comp();
  if (!c) return;
  // One job per open viewport, each built with its own camera (the frame
  // builder bakes zoom / pan / size into the job). The layer errors are the
  // document's, the same for every viewport: announced once.
  bool first = true;
  for (const auto& [id, port] : surfaces_) {
    if (port.open) {
      // Back-pressure: while playing, a viewport whose last job has not
      // started — a build still queued on the build worker, or a job the
      // render thread has not begun — would only see that job superseded: no
      // new build is queued, and the frame is counted as dropped with the
      // pending job. Edits and seeks still replace a pending job: they must show.
      if (fromClock && (build_pending(id) || sink_.job_pending(id))) sink_.note_dropped(id, 1, clockDropped);
      else submit_frame_to(port, *c, clockDropped, first);
    }
    first = false;
  }
}

void Session::submit_frame_to(const ViewportConfig& surface, const std::string& c, std::uint32_t clockDropped, bool announce,
                              std::optional<std::int64_t> prefetchFrame) {
  BuildTask t;
  // The surface's config as this frame draws it (frame_port: hidden layers, focus, LUT, comp space).
  ViewportConfig& port = t.port;
  port = frame_port(surface, c);
  // A held viewport (the Layer panel's own ruler) renders at its time, not the clock's.
  const std::int64_t frameIndex = prefetchFrame.value_or(frame_);
  const api::Time time = prefetchFrame ? frameIndex * frame_dur() : port.time.value_or(time_);
  // The job's metadata: what this frame IS (viewport, frame, time, revision,
  // cache scope). Read here, on the core thread, from the transport; the
  // frame's content is built from the document at this revision (below).
  RenderJob& job = t.job;
  job.viewport = port.viewport;
  job.recordCoverage = port.layer.empty() && !port.time;
  if (job.recordCoverage) {
    job.compSpace = port.compSpace;  // comp-space caching: the render thread presents through this geometry
    job.cacheScope = cache_scope(port, c);
    const Range range = play_range();
    job.rangeFirst = range.first;
    job.rangeLast = range.last;
  }
  job.frame = frameIndex;
  job.time = time;
  job.revision = revision_;
  job.clockDropped = clockDropped;
  job.contentWidth = preview_pixels(port.width, port.resolution);
  job.contentHeight = preview_pixels(port.height, port.resolution);
  // A prefetched frame is stored, so its footage is exact (as a fill's); it is never shown.
  job.prefetch = prefetchFrame.has_value();
  job.exactMedia = job.prefetch || (playing_ && transportState_ == api::TransportState::caching);
  job.playing = playing_;
  job.transient = gesture_.has_value() && !playing_;
  // Cached playback without a build (core/frame_keys.hpp): the frame's
  // pre-build key, and — when the sink has seen that key built and a tier may
  // still hold the frame — the job goes out with the content key alone. A
  // viewport the sink asked a built frame for (forceBuild_) builds this once.
  bool forceBuild = job.prefetch;  // a prefetch is a build by definition (idle_prefetch skips frames a tier holds)
  if (const auto fb = std::ranges::find(forceBuild_, port.viewport); !job.prefetch && fb != forceBuild_.end()) {
    forceBuild = true;
    forceBuild_.erase(fb);
  }
  if (playing_) ++playTally_.frames;
  if (job.recordCoverage && frameBuilder_ != nullptr) {
    sync_frame_keys();
    if (const std::uint64_t docKey = frameKeys_.key(frameIndex); docKey != 0 && !frameKeys_.volatile_inputs()) {
      job.prebuildKey = render::prebuild_key(job.cacheScope, docKey);
      if (playing_) ++playTally_.keyed;
      if (!forceBuild) {
        if (const std::optional<CachedKeys> hit = sink_.cached_frame(*job.prebuildKey)) {
          job.cachedKey = hit->content;
          job.cachedDiskKey = hit->disk;
          if (playing_) ++playTally_.cached;
          ++cachedSubmitted_;
          cachedPollUntil_ = loopNow_ + kCachedPoll;
          // No build for this frame: the HUD's cpuFrameMs (buildMs_, a moving
          // average over built frames) decays towards zero as the cache serves.
          buildMs_ += (0 - buildMs_) * 0.2;
        }
      }
    }
  }
  // Render-ahead while playing runs only while the play is served from the tiers (idle_prefetch).
  if (playing_ && !job.prefetch) playFromCache_ = job.cachedKey.has_value();
  t.comp = c;
  t.time = time;
  t.clockTime = job.prefetch ? time : time_;
  t.playing = playing_;
  t.announce = announce && !job.prefetch;
  t.activeComp = active_comp();
  // B4 round 2: the overlays' geometry at this frame's time and revision goes with the job;
  // the sink sends it (FrameGeometry) right before the frame's FrameReady.
  // A prefetch is never shown: no overlays, no onion ghosts.
  if (job.prefetch) {
    port.onion.reset();
  } else {
    for (const doc::OverlaySubscription& o : overlays_) {
      if (o.viewport == job.viewport) t.overlays.push_back(o);
    }
  }
  if (frameBuilder_ == nullptr) {
    // No scene builder (the core-only tests, the fuzzer, PREMATION_ENGINE_SCENE=0):
    // C2's quad scene, built here — cheap, and nothing else reads the document.
    complete_job(t, pctx(), nullptr, rig_queries());
    sink_.submit(std::move(t.job));
    return;
  }
  if (job.cachedKey && t.overlays.empty() && !port.onion) {
    // A cached frame with nothing to compute beside it: straight to the sink,
    // no trip through the build worker. (Overlay geometry and onion ghosts
    // still want the builder's measurer: those go through the worker below,
    // which skips the frame build itself.)
    sink_.submit(std::move(t.job));
    return;
  }
  // D2w: the engine's own scene builder (scene/snapshot_build.cpp) — the
  // document through the render graph, on the build worker (session.hpp "the
  // build worker"). Per-layer failures and features outside the port come back
  // as layerErrors, never as a blank frame.
  t.mediaBase = media_base();
  t.view = view_;
  enqueue_build(std::move(t));
}

// ── the build worker ────────────────────────────────────────────────────────

void Session::enqueue_build(BuildTask task) {
  const std::uint32_t viewport = task.job.viewport;
  task.writes = docWrites_.load(std::memory_order_acquire);
  task.seq = ++buildSeq_;
  if (!task.job.prefetch) lastFrameSeq_[viewport] = task.seq;
  // Frame-pipeline trace (debug level, PREMATION_LOG_LEVEL=debug): where a
  // frame's time goes between an edit and its pixels — one atomic load when off.
  PREMATION_LOG(debug, "ft_enqueue").kv("rev", static_cast<std::uint64_t>(task.job.revision)).kv("vp", viewport);
  std::optional<BuildTask> superseded;
  {
    const std::lock_guard<std::mutex> lock(buildQueueMu_);
    if (!buildThread_.joinable()) buildThread_ = JoiningThread([this] { build_worker(); });
    while (prefetchThreads_.size() < prefetchBuilders_.size()) {
      const std::size_t index = prefetchThreads_.size();
      prefetchThreads_.emplace_back([this, index] { prefetch_worker(index); });
    }
    // Newest wins per viewport: a task still queued (not building yet) is replaced.
    // An idle prefetch (RenderJob::prefetch) never replaces a frame the viewport
    // will show; a frame for the viewport drops a queued prefetch (the user is
    // back: idle_prefetch starts over after the quiet period) — not a drop of playback.
    if (!task.job.prefetch) {
      for (auto it = buildQueue_.begin(); it != buildQueue_.end(); ++it) {
        if (it->job.viewport == viewport && it->job.prefetch) {
          buildQueue_.erase(it);
          break;
        }
      }
      for (auto it = buildQueue_.begin(); it != buildQueue_.end(); ++it) {
        if (it->job.viewport == viewport) {
          superseded = std::move(*it);
          buildQueue_.erase(it);
          break;
        }
      }
    }
    buildQueue_.push_back(std::move(task));
  }
  buildCv_.notify_all();
  // Counted as the render thread counts a job superseded before it started: a
  // frame of playback lost (an edit's is not), its clock drops carried over.
  if (superseded) sink_.note_dropped(viewport, superseded->playing ? 1U : 0U, superseded->job.clockDropped);
}

bool Session::build_pending(std::uint32_t viewport) const {
  const std::lock_guard<std::mutex> lock(buildQueueMu_);
  return std::any_of(buildQueue_.begin(), buildQueue_.end(),
                     [viewport](const BuildTask& t) { return t.job.viewport == viewport && !t.job.prefetch; });
}

bool Session::builds_active() const {
  const std::lock_guard<std::mutex> lock(buildQueueMu_);
  return buildBusy_ || prefetchBusy_ > 0 || !buildQueue_.empty();
}

bool Session::viewport_builds_active() const {
  const std::lock_guard<std::mutex> lock(buildQueueMu_);
  return viewportBusy_ || std::ranges::any_of(buildQueue_, [](const BuildTask& t) { return !t.job.prefetch || t.mainOnly; });
}

void Session::build_worker() {
  tlBuildWorker = true;
  for (;;) {
    BuildTask task;
    {
      std::unique_lock<std::mutex> lock(buildQueueMu_);
      buildCv_.wait(lock, [this] { return buildStop_ || !buildQueue_.empty(); });
      if (buildStop_) return;
      // A frame a viewport shows first; a prefetch when there is none.
      auto it = std::ranges::find_if(buildQueue_, [](const BuildTask& t) { return !t.job.prefetch || t.mainOnly; });
      if (it == buildQueue_.end()) it = buildQueue_.begin();
      task = std::move(*it);
      buildQueue_.erase(it);
      buildBusy_ = true;
      viewportBusy_ = !task.job.prefetch;
    }
    run_build(std::move(task));
    {
      const std::lock_guard<std::mutex> lock(buildQueueMu_);
      buildBusy_ = false;
      viewportBusy_ = false;
    }
    buildCv_.notify_all();  // drain_builds
  }
}

void Session::prefetch_worker(std::size_t index) {
  tlBuildWorker = true;
  const auto mine = [](const BuildTask& t) { return t.job.prefetch && !t.mainOnly; };
  for (;;) {
    BuildTask task;
    {
      std::unique_lock<std::mutex> lock(buildQueueMu_);
      buildCv_.wait(lock, [&] { return buildStop_ || std::ranges::any_of(buildQueue_, mine); });
      if (buildStop_) return;
      const auto it = std::ranges::find_if(buildQueue_, mine);
      task = std::move(*it);
      buildQueue_.erase(it);
      ++prefetchBusy_;
    }
    run_prefetch_build(std::move(task), index);
    {
      const std::lock_guard<std::mutex> lock(buildQueueMu_);
      --prefetchBusy_;
    }
    buildCv_.notify_all();  // drain_builds
  }
}

void Session::run_prefetch_build(BuildTask t, std::size_t index) {
  BuildReport report;
  report.comp = t.comp;
  report.viewport = t.job.viewport;
  report.seq = t.seq;
  bool submit = false;
  bool toMain = false;
  if (editsWaiting_.load(std::memory_order_acquire) != 0) {
    report.skipped = true;  // an edit is waiting: not ahead of it (run_build)
  } else {
    const std::shared_lock<std::shared_mutex> lock(buildMu_);
    if (docWrites_.load(std::memory_order_acquire) != t.writes) {
      report.skipped = true;
    } else {
      FrameBuilder& builder = *prefetchBuilders_.at(index);
      doc::ExprCache& cache = *prefetchExprCaches_.at(index);
      try {
        const auto t0 = Clock::now();
        builder.set_media_base(t.mediaBase);
        const doc::DocExprEnv env(doc_, t.view, cache);
        t.job.built = builder.build(doc_, t.view, env, cache, t.comp, t.time, t.port, t.playing, report.errors);
        t.job.buildMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
        if (std::ranges::any_of(report.errors, [](const api::LayerError& e) { return e.stage == "plugin" || e.stage == "snapshot"; })) {
          t.job.prebuildKey.reset();
        }
        report.ms = t.job.buildMs;
        // Never shown: no overlay geometry, no onion ghosts (complete_job's other work).
        if (!t.job.built) doc::build_frame_scene(doc::PCtx{doc_, t.view, env, cache}, t.comp, t.time, t.job.scene);
        submit = true;
      } catch (const NeedsMainBuilder&) {
        toMain = true;
      } catch (const BuildCancelled&) {
        report.skipped = true;
      } catch (const std::exception& e) {
        PREMATION_LOG(error, "frame_build_failed").kv("error", std::string(e.what()));
        report.errors.push_back(api::LayerError{"", "snapshot", std::string("frame build failed: ") + e.what(), std::nullopt});
        submit = true;
      }
    }
  }
  if (toMain) {
    t.mainOnly = true;
    t.job.built.reset();
    {
      const std::lock_guard<std::mutex> lock(buildQueueMu_);
      buildQueue_.push_front(std::move(t));
    }
    buildCv_.notify_all();
    return;
  }
  if (submit) sink_.submit(std::move(t.job));
  else sink_.note_dropped(t.job.viewport, 0U, t.job.clockDropped);
  const std::lock_guard<std::mutex> lock(buildQueueMu_);
  buildReports_.push_back(std::move(report));
}

void Session::run_build(BuildTask t) {
  BuildReport report;
  report.comp = t.comp;
  report.announce = t.announce;
  report.viewport = t.job.viewport;
  report.seq = t.seq;
  bool submit = false;
  const auto ftWait0 = Clock::now();
  if (editsWaiting_.load(std::memory_order_acquire) != 0) {
    // An edit is waiting for the lock: taking it first would make the edit
    // wait for a frame of the document it is about to change. The task is
    // skipped without the lock (the core thread queues a fresh one, below).
    report.skipped = true;
  } else {
    const std::lock_guard<std::shared_mutex> lock(buildMu_);
    // Frame-pipeline trace: how long the build waited for the lock, and a skip.
    PREMATION_LOG(debug, "ft_build").kv("rev", static_cast<std::uint64_t>(t.job.revision))
        .kv("lockMs", std::chrono::duration<double, std::milli>(Clock::now() - ftWait0).count())
        .kv("skip", docWrites_.load(std::memory_order_acquire) != t.writes);
    if (docWrites_.load(std::memory_order_acquire) != t.writes) {
      // The document was written since this task was queued: the job's
      // revision no longer names what we would build. The core thread queues
      // a fresh frame for it (pump_builds) — a built frame is always a pure
      // function of its job's revision and time.
      report.skipped = true;
    } else {
      try {
        const auto t0 = Clock::now();
        frameBuilder_->set_media_base(t.mediaBase);
        const doc::DocExprEnv env(doc_, t.view, buildExprCache_);
        if (t.job.cachedKey) {
          // A cached frame (RenderJob::cachedKey): no build; only what rides
          // beside it (overlay geometry, onion ghosts) is computed here.
          report.cached = true;
        } else {
          t.job.built = frameBuilder_->build(doc_, t.view, env, buildExprCache_, t.comp, t.time, t.port, t.playing, report.errors);
          t.job.buildMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
          // A frame built from an input that may still change on its own (a
          // plugin instance loading or failing, a build that threw part-way):
          // its pre-build key is not learned, so it is never presented without
          // a build. Every other stage is the document's own and stable — an
          // expression error, a missing font, an unported feature, an oversize
          // texture — and blocking on those (any warning, before) kept a whole
          // comp off the no-build path: its cached frames still cost a full build.
          if (std::any_of(report.errors.begin(), report.errors.end(),
                          [](const api::LayerError& e) { return e.stage == "plugin" || e.stage == "snapshot"; })) {
            t.job.prebuildKey.reset();
          }
        }
        // Measurement only (RenderStats.cpuFrameMs, averaged by pump_builds).
        report.ms = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
        const doc::PCtx pc{doc_, t.view, env, buildExprCache_};
        complete_job(t, pc, frameBuilder_->text_queries(), rig_queries());
        submit = true;
      } catch (const BuildCancelled&) {
        // An edit arrived while this frame was being built (BuildLock{write}
        // raised editsWaiting_): the builder stopped at its next layer. The
        // task is dropped as a skip — the core thread queues a fresh frame of
        // the edited document — and nothing of the half-built frame is kept.
        PREMATION_LOG(debug, "ft_build_cancelled")
            .kv("rev", static_cast<std::uint64_t>(t.job.revision))
            .kv("ms", std::chrono::duration<double, std::milli>(Clock::now() - ftWait0).count());
        report.skipped = true;
      } catch (const std::exception& e) {
        // Nothing here is expected to throw (the builder isolates its layers);
        // if it does, the frame goes out as far as it got, with the failure on
        // layerErrors — never a dead worker (CLAUDE.md: isolate, record, continue).
        PREMATION_LOG(error, "frame_build_failed").kv("error", std::string(e.what()));
        report.errors.push_back(api::LayerError{"", "snapshot", std::string("frame build failed: ") + e.what(), std::nullopt});
        submit = true;
      }
    }
  }
  if (submit) sink_.submit(std::move(t.job));
  else sink_.note_dropped(t.job.viewport, t.playing ? 1U : 0U, t.job.clockDropped);
  const std::lock_guard<std::mutex> lock(buildQueueMu_);
  buildReports_.push_back(std::move(report));
}

void Session::complete_job(BuildTask& t, const doc::PCtx& pc, TextQueries* text, RigQueries* rig) {
  RenderJob& job = t.job;
  // The scene's quad vector changes hands (→ render thread) once per frame:
  // one small allocation per frame, deliberately, so the threads never share a buffer.
  if (!job.built && !job.cachedKey) doc::build_frame_scene(pc, t.comp, t.time, job.scene);
  for (const doc::OverlaySubscription& o : t.overlays) {
    job.geometrySubscribed = true;
    job.geometry = doc::overlay_geometry(pc, text, o, t.clockTime);
    job.views = doc::overlay_views(pc, o, t.activeComp, t.clockTime);  // B4 round 5: the view cameras
    attach_overlay_rig(rig, text, pc, o, t.clockTime, job.geometry);   // B4 round 5: the rig records
  }
  attach_onion(t, pc);
}

void Session::pump_builds() {
  std::vector<BuildReport> reports;
  {
    const std::lock_guard<std::mutex> lock(buildQueueMu_);
    reports.swap(buildReports_);
  }
  bool rebuild = false;
  for (BuildReport& r : reports) {
    if (r.skipped) {
      // Build again only if no frame for this viewport was queued after the
      // skipped task: the edit that made it stale queues its own frame
      // (flush_render after the command), and that one is the rebuild. A
      // skipped prefetch (never recorded in lastFrameSeq_) re-requests the
      // viewport's frame unless a frame was queued since.
      const auto last = lastFrameSeq_.find(r.viewport);
      if (last == lastFrameSeq_.end() || last->second <= r.seq) rebuild = true;
      continue;
    }
    if (r.cached) continue;  // no build happened: nothing to average, nothing to announce
    // D5: the frame builder's CPU time per frame — an exponential moving average.
    buildMs_ = buildMs_ <= 0 ? r.ms : buildMs_ + (r.ms - buildMs_) * 0.2;
    builtMs_ = builtMs_ <= 0 ? r.ms : builtMs_ + (r.ms - builtMs_) * 0.2;
    if (r.announce) announce_layer_errors(r.comp, std::move(r.errors));
  }
  if (rebuild) {
    request_render();
    flush_render();  // while playing, the next tick's frame is the fresh one
  }
}

void Session::drain_builds() {
  if (!buildThread_.joinable()) return;
  for (;;) {
    {
      std::unique_lock<std::mutex> lock(buildQueueMu_);
      buildCv_.wait(lock, [this] { return buildQueue_.empty() && !buildBusy_ && prefetchBusy_ == 0; });
    }
    pump_builds();  // may queue a rebuild for a skipped task: wait for that too
    if (!builds_active()) return;
  }
}

void Session::attach_onion(BuildTask& t, const doc::PCtx& pc) {
  const ViewportConfig& port = t.port;
  if (t.playing || !port.onion || !port.layer.empty() || port.time || frameBuilder_ == nullptr) return;
  RenderJob& job = t.job;
  const api::OnionSkin skin = *port.onion;
  OnionMemo& memo = onionMemo_[port.viewport];
  const bool same = memo.revision == job.revision && memo.frame == job.frame && memo.width == port.width &&
                    memo.height == port.height && memo.zoom == port.zoom && memo.panX == port.panX &&
                    memo.panY == port.panY && memo.dpr == port.devicePixelRatio && memo.view == port.view &&
                    memo.custom == port.customView && memo.settings == skin;
  if (!same) {
    OnionPlanSettings plan;
    plan.before = static_cast<int>(skin.before);
    plan.after = static_cast<int>(skin.after);
    plan.step = static_cast<int>(skin.step);
    plan.opacity = skin.opacity;
    plan.colorize = skin.colorize;
    const double fps = doc::comp_fps(pc.d, t.comp);
    const auto planned = onion_skin_plan(job.frame, plan, 0, static_cast<std::int64_t>(doc::comp_duration_frames(pc.d, t.comp)));
    ViewportConfig ghostPort = port;
    ghostPort.ghost = true;
    ghostPort.onion.reset();
    ghostPort.compSpace.reset();  // ghosts are composited onto the slot at its size (composite_onion)
    std::vector<RenderJob::OnionGhost> built;
    built.reserve(planned.size());
    for (const OnionGhostPlan& g : planned) {
      std::vector<api::LayerError> errors;
      auto frame = frameBuilder_->build(pc.d, pc.view, pc.expr, pc.cache, t.comp,
                                        doc::frames_to_flicks(static_cast<double>(g.frame), fps), ghostPort, false, errors);
      if (!frame) continue;
      RenderJob::OnionGhost ghost;
      ghost.built = std::move(frame);
      ghost.opacity = g.opacity;
      ghost.tintR = g.tintR;
      ghost.tintG = g.tintG;
      ghost.tintB = g.tintB;
      ghost.tintStrength = g.tintStrength;
      built.push_back(std::move(ghost));
    }
    memo.revision = job.revision;
    memo.frame = job.frame;
    memo.width = port.width;
    memo.height = port.height;
    memo.zoom = port.zoom;
    memo.panX = port.panX;
    memo.panY = port.panY;
    memo.dpr = port.devicePixelRatio;
    memo.view = port.view;
    memo.custom = port.customView;
    memo.settings = skin;
    memo.ghosts = std::move(built);
  }
  job.onion = memo.ghosts;
}

void Session::attach_overlay_rig(RigQueries* rig, TextQueries* text, const doc::PCtx& pc, const doc::OverlaySubscription& o,
                                 api::Time time, std::vector<api::OverlayLayerGeometry>& geometry) {
  if (rig == nullptr) return;
  const auto kinds = doc::subscribed_layer_kinds(o);
  const api::OverlayRigOptions opts = o.rig.value_or(api::OverlayRigOptions{});
  const double seconds = doc::flicks_to_seconds(time);
  for (api::OverlayLayerGeometry& g : geometry) {
    const auto it = std::find_if(kinds.begin(), kinds.end(), [&g](const auto& e) { return e.first == g.layer; });
    if (it == kinds.end() || std::find(it->second.begin(), it->second.end(), api::OverlayKind::rig) == it->second.end()) continue;
    // A rig this frame cannot resolve is left out; the frame and the other records still go (CLAUDE.md).
    try {
      g.rig = rig->rig_overlay(pc.d, pc.view, pc.expr, pc.cache, text, g.layer, seconds, opts);
    } catch (const doc::EngineFail&) {
      g.rig.reset();
    } catch (const std::exception&) {
      g.rig.reset();
    }
  }
}

void Session::announce_layer_errors(const std::string& comp, std::vector<api::LayerError> errors) {
  if (comp == layerErrorsComp_ && errors == layerErrors_) return;  // announce changes only
  layerErrorsComp_ = comp;
  layerErrors_ = errors;
  if (phase_ != Phase::open) return;
  std::vector<api::Event> ev;
  ev.push_back(make_event(api::LayerErrorsEvent{comp, std::move(errors)}));
  send_events(revision_, revision_, std::move(ev), std::nullopt, api::Origin::engine);
}

void Session::sync_audio() {
  if (mediaClock_ == nullptr) return;
  const std::string comp = active_comp().value_or("");
  if (revision_ == audioRevision_ && comp == audioComp_) return;
  audioRevision_ = revision_;
  audioComp_ = comp;
  mediaClock_->set_document(doc_, view_, exprEnv_, exprCache_, comp);
}

// ── seq peek for undecodable requests ──────────────────────────────────────

std::optional<api::Seq> peek_request_seq(std::span<const std::uint8_t> payload) noexcept {
  wire::Reader r(payload);
  while (!r.at_end()) {
    std::uint64_t key = 0;
    if (!r.varint(key)) return std::nullopt;
    if (key == ((3U << 3U) | wire::kWireLen)) {  // EngineMessage.request
      wire::Reader req;
      if (!r.ld(req)) return std::nullopt;
      while (!req.at_end()) {
        std::uint64_t k = 0;
        if (!req.varint(k)) return std::nullopt;
        if (k == ((1U << 3U) | wire::kWireVarint)) {  // Request.seq
          std::uint64_t seq = 0;
          if (!req.varint(seq)) return std::nullopt;
          return seq;
        }
        if (!req.skip(k)) return std::nullopt;
      }
      return std::nullopt;
    }
    if (!r.skip(key)) return std::nullopt;
  }
  return std::nullopt;
}

}  // namespace premation
