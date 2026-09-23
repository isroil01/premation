#include "session.hpp"

#include <algorithm>
#include <cmath>
#include <thread>
#include <type_traits>
#include <utility>
#include <variant>

#include "catalog_data.hpp"
#include "docio.hpp"
#include "fail.hpp"
#include "fxstate.hpp"
#include "handlers.hpp"
#include "log.hpp"
#include "queries.hpp"
#include "readmodel.hpp"
#include "scene_build.hpp"
#include "time_conv.hpp"
#include "variant_util.hpp"

namespace premation {
namespace {

using api::ErrorCode;
using Clock = Session::Clock;
using doc::EngineFail;
using doc::fail;

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

// ── Session ─────────────────────────────────────────────────────────────────

Session::Session(Outbox& out, FrameSink& sink, SessionOptions options)
    : out_(out), sink_(sink), options_(std::move(options)) {
  if (options_.testPorts) ports_ = std::make_unique<doc::FakePorts>();
  else ports_ = std::make_unique<doc::FilePorts>();
  // The engine starts on a new project, as the editor does (New Project →
  // `comp_root`), at revision 0.
  load_new_project(api::ResetReason::created, false);
  revision_ = 0;
  savedRevision_ = 0;
}

Session::~Session() = default;

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
      if (phase_ == Phase::awaiting_hello) {
        handle_hello(std::get<api::Hello>(message.v));
      } else {
        send_engine_error(ErrorCode::invalid_argument, "Hello after the session opened; ignored", false);
      }
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
  const bool wantShared = std::find(hello.capabilities.begin(), hello.capabilities.end(), "frames.sharedTexture") !=
                          hello.capabilities.end();
  const bool shared = wantShared && sink_.shared_supported();
  sink_.set_shared(shared);
  api::Welcome w;
  w.protocol_major = api::kProtocolMajor;
  w.protocol_minor = api::kProtocolMinor;
  w.engine = "premation-engine";
  w.engine_version = options_.engineVersion;
  w.revision = revision_;
  w.session_id = options_.sessionId;
  w.capabilities = {"frames.channel", "frames.offscreen", "heartbeat"};
  if (sink_.shared_supported()) w.capabilities.emplace_back("frames.sharedTexture");
  api::EngineMessage m;
  m.v = std::move(w);
  out_.send(m);
  phase_ = Phase::open;
  PREMATION_LOG(info, "welcome")
      .kv("client", hello.client)
      .kv("clientVersion", hello.client_version)
      .kv("minor", hello.protocol_minor)
      .kv("sharedFrames", shared);
}

void Session::close(api::GoodbyeReason reason, std::string message) {
  if (phase_ == Phase::closed) return;
  stop_playback();
  api::EngineMessage m;
  m.v = api::Goodbye{reason, std::move(message)};
  out_.send(m);
  phase_ = Phase::closed;
}

void Session::on_disconnect() {
  // A gesture still open when the client goes away is COMMITTED (§5.1).
  if (gesture_) {
    Gesture g = std::move(*gesture_);
    gesture_.reset();
    g.changes.prune();
    if (!g.changes.empty()) history_.push(doc::Entry{g.label, g.origin, std::move(g.changes)});
  }
  stop_playback();
}

void Session::on_ping(std::uint64_t nonce, std::uint32_t queued) {
  out_.send_frames(frames::Message{.v = api::FramePong{nonce, revision_, playing_, queued}});
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
  scope_ = RequestScope{request.seq, request.origin, std::nullopt};
  api::Outcome o = handle_request_body(request, now);
  respond(request.seq, std::move(o));
  scope_.reset();
  flush_render();
}

api::Outcome Session::handle_request_body(const api::Request& request, Clock::time_point now) {
  api::Outcome o;
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
        ensure_timelines();
        const api::Command& cmd = std::get<api::Command>(request.body.v);
        api::CommandResult r;
        if (is_edit(cmd)) {
          r = std::move(run_edits({&cmd}, request.origin, std::nullopt).at(0));
        } else {
          r = run_control(cmd, request.origin, now);
        }
        log_.push_back(api::LogRecord{request, revision_, 0});
        o.v = std::move(r);
        return o;
      }
      case api::RequestBody::Kind::batch: {
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
        log_.push_back(api::LogRecord{request, revision_, 0});
        o.v = std::move(results);
        return o;
      }
    }
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
  return doc::HCtx{doc_, view_, ids_, keys_, exprEnv_, exprCache_, *ports_, origin, apiTime_, std::nullopt};
}

void Session::ensure_timelines() {
  // Every composition's timeline exists before a command runs (outside the
  // journal: a structural mirror, not an edit — LocalEngine.ensureTimelines).
  for (const auto& comp : doc::comp_item_ids(doc_)) {
    if (doc_.timeline(comp) == nullptr) (void)doc::tl_ensure(doc_, comp);
  }
}

void Session::stamp_missing_key_ids(const doc::ChangeSet& touched, doc::HCtx& x) {
  // stamp.ts: any key in the edited scope without an id gets one, tracks and
  // keys in engine order, inside the command (part of its inverse).
  for (const auto& [id, before] : touched.before.anims) {
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
  for (const auto& [id, before] : touched.before.nodes) {
    const doc::Node* n = doc_.node(id);
    if (n == nullptr) continue;
    std::vector<doc::Json> anim = doc::read_node_mask_anim(*n);
    const bool missing = std::any_of(anim.begin(), anim.end(), [](const doc::Json& k) {
      return !(k.at("id").is_string() && !k.at("id").str().empty());
    });
    if (!missing) continue;
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
  doc_.begin();
  for (std::size_t i = 0; i < commands.size(); ++i) {
    const api::Command& cmd = *commands[i];
    const std::string name = command_name(cmd);
    doc::HCtx x = handler_ctx(origin);
    const std::optional<std::uint32_t> index = indexed ? std::optional<std::uint32_t>(static_cast<std::uint32_t>(i)) : std::nullopt;
    // The failure is recorded and re-thrown OUTSIDE the handler: a throw from
    // inside a catch funclet crashes the clang-cl ASan runtime's SEH handler.
    std::optional<api::EngineError> failed;
    try {
      api::CommandResult r = std::visit(EditVisitor{x, name}, cmd.v);
      // stampMissingKeyIds over what this command touched, then syncTimelines.
      doc::ChangeSet sofar;
      doc_.peek_journal(sofar.before);
      stamp_missing_key_ids(sofar, x);
      doc::tl_sync_all(doc_);
      results.push_back(std::move(r));
      if (!batchLabel) label = x.label ? *x.label : humanize(name);
      keys_.invalidate();
    } catch (const EngineFail& f) {
      failed = with_index(f.error, index);
    } catch (const std::exception& e) {
      failed = with_index(err(ErrorCode::internal, e.what()), index);
    }
    if (failed) {
      doc_.rollback();
      keys_.invalidate();
      throw EngineFail{std::move(*failed)};
    }
  }
  doc::ChangeSet changes = doc_.commit();
  if (changes.empty()) return results;
  const api::Revision from = revision_;
  ++revision_;
  std::vector<api::Event> events = builder_.build(changes, pctx());
  if (gesture_) {
    gesture_->changes.merge(changes);
  } else {
    history_.push(doc::Entry{label, origin, std::move(changes)});
  }
  send_events(from, revision_, std::move(events), std::nullopt, origin);
  emit_status();
  request_render();
  return results;
}

// ── history and controls ────────────────────────────────────────────────────

void Session::apply_history(const doc::ChangeSet& target) {
  doc_.apply(target.after);
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
  doc_ = doc::Document{};
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
  after_load(reason, emit);
}

void Session::after_load(api::ResetReason reason, bool emit) {
  ensure_timelines();
  history_.clear();
  gesture_.reset();
  ids_.reset();
  ids_.seed_keyframes(doc::all_keyframe_ids(doc_));
  keys_.invalidate();
  builder_.reset();
  exprCache_.clear();
  const api::Revision from = revision_;
  ++revision_;
  savedRevision_ = revision_;
  if (!emit) return;
  std::vector<api::Event> ev;
  ev.push_back(make_event(api::DocumentResetEvent{revision_, reason}));
  send_events(from, revision_, std::move(ev), std::nullopt, api::Origin::engine);
  emit_status();
}

void Session::load_document(const doc::Json& file, api::ResetReason reason) {
  const std::vector<doc::Json> session = doc_.items().assets;
  const doc::RestoreResult r = doc::restore_document(doc_, view_, file, session);
  lastMissing_ = r.missing;
  after_load(reason, true);
  request_render();
}

doc::Json Session::capture_document() const { return doc::capture_document(doc_, view_); }

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
      s.emit_changes(from, folded);
      s.request_render();
    }
    s.emit_status();
    return result_for<api::JumpToHistory>(api::HistoryStep{label, static_cast<std::uint32_t>(s.history_.index() + 1)});
  }
  R operator()(const api::BeginGesture& c) const {
    if (s.gesture_) fail(ErrorCode::gesture_open, "gesture '" + s.gesture_->label + "' is already open");
    s.gestureSeq_ += 1;
    s.gesture_ = Session::Gesture{s.gestureSeq_, c.label, origin, {}};
    s.emit_status();
    return result_for<api::BeginGesture>(api::GestureRef{s.gestureSeq_});
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
      s.emit_changes(from, back);
      s.request_render();
    }
    s.emit_status();
    return result_for<api::EndGesture>();
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
    doc::Json file = s.ports_->read_project(c.path);
    s.load_document(file, api::ResetReason::opened);
    s.projectPath_ = c.path;
    s.emit_status();
    api::OpenProjectResult r;
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
    const std::uint64_t bytes = s.ports_->write_project(path, s.capture_document());
    if (!c.copy) {
      s.projectPath_ = path;
      s.savedRevision_ = s.revision_;
      std::vector<api::Event> ev;
      ev.push_back(make_event(api::ProjectSavedEvent{path, s.revision_}));
      s.send_events(s.revision_, s.revision_, std::move(ev), std::nullopt, api::Origin::engine);
      s.emit_status();
    }
    return result_for<api::SaveProject>(api::SaveProjectResult{path, bytes});
  }
  R operator()(const api::CollectFiles&) const {
    fail(ErrorCode::unsupported, "no collect-files port is attached to this engine");
  }
  R operator()(const api::ReloadItems&) const { return result_for<api::ReloadItems>(); }
  R operator()(const api::StartJob&) const {
    fail(ErrorCode::unsupported, "jobs run in the editor today (tracking, stabilize, object matte, transcription, render); "
                                 "they move into the engine in phase E/F");
  }
  R operator()(const api::CancelJob& c) const { fail(ErrorCode::not_found, "no job '" + c.job + "'"); }
  R operator()(const api::SetPluginEnabled& c) const {
    // No plugin is installed in the engine process (plugins host in the editor).
    fail(ErrorCode::not_found, "no installed plugin '" + c.plugin + "'");
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
    if (c.from) s.seek_to(*c.from);
    s.transportState_ = c.cache_first ? api::TransportState::caching : api::TransportState::playing;
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
    if (s.viewport_.open) {
      s.viewport_.resolution = s.resolution_;
      s.sink_.configure(s.viewport_);
      s.request_render();
    }
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
    if (c.layer || w > 16384.0 || h > 16384.0 || dpr > 8.0) return result_for<api::SetViewport>();  // state kept; not rendered
    ViewportConfig v;
    v.viewport = c.viewport;
    v.width = static_cast<std::uint32_t>(w);
    v.height = static_cast<std::uint32_t>(h);
    v.resolution = s.resolution_;
    v.open = true;
    if (!(v == s.viewport_)) {
      s.viewport_ = v;
      s.sink_.configure(v);
    }
    s.request_render();
    return result_for<api::SetViewport>();
  }
  R operator()(const api::CloseViewport& c) const {
    if (s.viewports_.erase(c.viewport) == 0) fail(ErrorCode::not_found, "no viewport " + std::to_string(c.viewport));
    if (s.viewport_.open && s.viewport_.viewport == c.viewport) {
      s.viewport_.open = false;
      s.sink_.configure(s.viewport_);
    }
    return result_for<api::CloseViewport>();
  }
  R operator()(const api::SetCacheBudget&) const { return result_for<api::SetCacheBudget>(); }
  R operator()(const api::PurgeCache&) const { return result_for<api::PurgeCache>(); }
  R operator()(const api::SetInteracting&) const { return result_for<api::SetInteracting>(); }
};

api::CommandResult Session::run_control(const api::Command& cmd, api::Origin origin, Clock::time_point now) {
  const std::string name = command_name(cmd);
  if (!doc::registry().commandKinds.contains(command_id(cmd))) fail(ErrorCode::unsupported, "unknown command '" + name + "'");
  return std::visit(ControlVisitor{*this, origin, now, name}, cmd.v);
}

// ── queries ─────────────────────────────────────────────────────────────────

api::QueryResult Session::run_query(const api::Query& q) {
  doc::QCtx c{pctx(), keys_, 0, "", false, {}, {}, {}, {}};
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
  c.renderStats = [this] {
    const RenderCounters rc = sink_.counters();
    api::RenderStats st;
    st.gpu_frame_ms = rc.gpuFrameMs;
    st.fps = rc.fps;
    st.dropped_frames = rc.dropped;
    return st;
  };
  return doc::run_query(q, c);
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

Session::Range Session::play_range() const {
  const auto c = active_comp();
  const api::Time fd = frame_dur();
  api::TimeRange r{0, fd};
  if (c) {
    const api::CompSettings cs = doc::comp_settings(doc_, *c);
    r = api::TimeRange{0, cs.duration};
    if (rangeKind_ == api::PlayRange::work_area && cs.work_area.duration > 0) r = cs.work_area;
  }
  if (rangeKind_ == api::PlayRange::custom && customRange_.duration > 0) r = customRange_;
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
  playBase_ = now;
  playBaseU_ = frame_ - r.first;
  lastK_ = 0;
  lastU_ = playBaseU_;
  clockDropped_ = 0;
  lastStats_ = now;
  emit_transport();
  emit_playhead();
  submit_frame(0);
  renderDirty_ = false;
}

void Session::rebase_playback(Clock::time_point now) {
  const Range r = play_range();
  playBase_ = now;
  playBaseU_ = frame_ - r.first;
  lastK_ = 0;
  lastU_ = playBaseU_;
}

void Session::stop_playback() {
  if (!playing_) return;
  playing_ = false;
  transportState_ = api::TransportState::stopped;
}

std::optional<Clock::time_point> Session::next_deadline() const {
  if (!playing_) return std::nullopt;
  const auto c = active_comp();
  if (!c) return std::nullopt;
  const double fps = doc::comp_fps(doc_, *c) * std::abs(rate_);
  if (fps <= 0) return std::nullopt;
  const auto step = std::chrono::duration<double>(static_cast<double>(lastK_ + 1) / fps);
  return playBase_ + std::chrono::duration_cast<Clock::duration>(step);
}

void Session::tick(Clock::time_point now) {
  if (!playing_ || phase_ != Phase::open) return;
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
  const double elapsed = std::chrono::duration<double>(now - playBase_).count();
  const auto k = static_cast<std::int64_t>(std::floor(elapsed * fps + 1e-9));
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
  lastK_ = k;
  lastU_ = u;
  clockDropped_ += dropped;
  set_time((r.first + pos) * frame_dur());
  emit_playhead();
  submit_frame(dropped);
  renderDirty_ = false;
  if (stop) {
    stop_playback();
    emit_transport();
  }
  if (now - lastStats_ >= std::chrono::seconds(1)) emit_stats(now);
}

void Session::emit_stats(Clock::time_point now) {
  lastStats_ = now;
  const RenderCounters c = sink_.counters();
  api::RenderStats st;
  st.gpu_frame_ms = c.gpuFrameMs;
  st.fps = c.fps;
  st.dropped_frames = c.dropped + clockDropped_;
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

void Session::submit_frame(std::uint32_t clockDropped) {
  if (!viewport_.open) return;
  const auto c = active_comp();
  if (!c) return;
  RenderJob job;
  // The scene's quad vector changes hands (core → render thread) once per
  // frame: one small allocation per frame, deliberately, so the two threads
  // never share a buffer.
  doc::build_frame_scene(pctx(), *c, time_, job.scene);
  job.viewport = viewport_.viewport;
  job.frame = frame_;
  job.time = time_;
  job.revision = revision_;
  job.clockDropped = clockDropped;
  sink_.submit(std::move(job));
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
