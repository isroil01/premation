// Session: engine jobs (ENGINE_API.md §4.9, jobs/job_api.hpp) — startJob /
// cancelJob / applyJobResult / getJobs and the core-thread half of every job:
// progress events, and the result applied as ONE history entry through
// ordinary commands.
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#include "fail.hpp"
#include "jobs/job_apply_util.hpp"
#include "log.hpp"
#include "session.hpp"
#include "variant_util.hpp"

namespace premation {

using api::ErrorCode;
using doc::fail;

namespace {

api::EngineError internal_error(std::string message) {
  api::EngineError e;
  e.code = ErrorCode::internal;
  e.message = std::move(message);
  return e;
}

}  // namespace

/// A job result's commands run inside the Session's open journal.
class SessionJobApply final : public jobs::JobApply {
 public:
  SessionJobApply(Session& s, api::Origin origin) : s_(s), origin_(origin) {}
  api::CommandResult run(const api::Command& cmd) override {
    edits.push_back(cmd);
    return s_.run_in_journal(cmd, origin_, nullptr);
  }
  [[nodiscard]] const doc::Document& document() const override { return s_.doc_; }

  std::vector<api::Command> edits;

 private:
  Session& s_;
  api::Origin origin_;
};

Session::JobRecord* Session::find_job(const std::string& id) {
  const auto it = std::find_if(jobs_.begin(), jobs_.end(), [&id](const JobRecord& r) { return r.info.id == id; });
  return it != jobs_.end() ? &*it : nullptr;
}

api::CommandResult Session::start_job(const api::StartJob& c) {
  if (jobKinds_ == nullptr) {
    fail(ErrorCode::unsupported, "this engine build runs no jobs (the headless engine has no decode)");
  }
  catalogCache_.clear();
  ensure_timelines();
  const jobs::JobDocContext ctx{doc_, bundleRoot_, projectPath_, apiTime_};
  // prepare validates against the document and snapshots the inputs; a refusal
  // is the command's answer and nothing is queued.
  jobs::PreparedJob prepared = jobKinds_->prepare(c.job, ctx);
  if (!prepared.work) fail(ErrorCode::internal, "the job kind prepared no work");
  if (!runner_) runner_ = std::make_unique<jobs::JobRunner>(2);
  JobRecord r;
  r.info.id = "job_" + std::to_string(++jobSeq_);
  r.info.kind = prepared.kind.empty() ? jobs::job_kind_name(c.job) : prepared.kind;
  r.info.status = api::JobStatus::queued;
  r.info.progress = 0;
  r.apply = c.apply;
  const std::string id = r.info.id;
  jobs_.push_back(std::move(r));
  // Keep the list bounded: finished jobs beyond the last 64 are forgotten.
  while (jobs_.size() > 64) {
    const auto old = std::find_if(jobs_.begin(), jobs_.end(), [](const JobRecord& j) {
      return j.info.status != api::JobStatus::queued && j.info.status != api::JobStatus::running && !j.result;
    });
    if (old == jobs_.end()) break;
    jobs_.erase(old);
  }
  runner_->submit(id, std::move(prepared.work));
  PREMATION_LOG(info, "job_started").kv("job", id).kv("kind", find_job(id)->info.kind);
  emit_job(*find_job(id), false, std::nullopt);
  return result_for<api::StartJob>(api::JobRef{id});
}

api::CommandResult Session::cancel_job(const api::CancelJob& c) {
  JobRecord* r = find_job(c.job);
  if (r == nullptr) fail(ErrorCode::not_found, "no job '" + c.job + "'");
  if (r->info.status == api::JobStatus::queued || r->info.status == api::JobStatus::running) {
    if (runner_) (void)runner_->cancel(c.job);
  } else if (r->result && !r->info.applied) {
    // Finished but held (apply=false): cancelling discards it; nothing is applied.
    r->result.reset();
    r->info.status = api::JobStatus::cancelled;
    emit_job(*r, true, std::nullopt);
  }
  return result_for<api::CancelJob>();
}

void Session::emit_job(const JobRecord& r, bool finished, const std::optional<api::EngineError>& error) {
  std::vector<api::Event> ev;
  if (finished) {
    ev.push_back(make_event(api::JobFinishedEvent{r.info, error}));
  } else {
    ev.push_back(make_event(api::JobProgressEvent{r.info}));
  }
  send_events(revision_, revision_, std::move(ev), std::nullopt, api::Origin::engine);
}

bool Session::apply_job(JobRecord& r) {
  if (!r.result) return false;
  catalogCache_.clear();
  ensure_timelines();
  const std::string label = r.result->label();
  std::optional<api::EngineError> failed;
  doc_.begin();
  SessionJobApply a(*this, api::Origin::engine);
  try {
    r.result->apply(a);
  } catch (const doc::EngineFail& f) {
    failed = f.error;
  } catch (const std::exception& e) {
    failed = internal_error(e.what());
  }
  if (failed) {
    doc_.rollback();
    keys_.invalidate();
    r.result.reset();
    r.info.status = api::JobStatus::failed;
    r.info.message = "could not apply: " + failed->message;
    emit_job(r, true, failed);
    return false;
  }
  doc::ChangeSet changes = doc_.commit();
  // The summary again, now with what the apply made (a created null's id…).
  r.info.result = r.result->summary_json();
  r.result.reset();
  r.info.applied = !changes.empty();
  if (!changes.empty()) {
    const api::Revision from = revision_;
    ++revision_;
    std::vector<api::Event> events = builder_.build(changes, pctx());
    history_.push(doc::Entry{label, api::Origin::engine, std::move(changes)});
    send_events(from, revision_, std::move(events), std::nullopt, api::Origin::engine);
    emit_status();
    request_render();
    // The applied edit, as the request a crash replay writes instead of
    // running startJob again (schema LogRecord.job).
    if (!a.edits.empty()) {
      api::CommandBatch batch;
      batch.label = label;
      batch.commands = std::move(a.edits);
      api::Request req;
      req.origin = api::Origin::engine;
      req.body.v = std::move(batch);
      api::LogRecord rec;
      rec.request = std::move(req);
      rec.revision_after = revision_;
      rec.job = r.info.id;
      const auto stale = std::find_if(log_.begin(), log_.end(), [&](const api::LogRecord& row) {
        if (!row.job || *row.job != r.info.id) return false;
        if (row.request.body.kind() != api::RequestBody::Kind::command) return false;
        return std::get<api::Command>(row.request.body.v).kind() == api::Command::Kind::start_job;
      });
      if (stale != log_.end()) log_.erase(stale);
      log_.push_back(rec);
      api::EngineMessage msg;
      msg.v = std::move(rec);
      out_.send(msg);
    }
  }
  emit_job(r, true, std::nullopt);
  return true;
}

api::CommandResult Session::apply_job_in_journal(const api::ApplyJobResult& c, api::Origin origin, std::string& label) {
  JobRecord* r = find_job(c.job);
  if (r == nullptr || r->info.status != api::JobStatus::done) fail(ErrorCode::not_found, "no finished job '" + c.job + "'");
  if (!r->result) fail(ErrorCode::invalid_argument, "job '" + c.job + "' has no result to apply (already applied, or nothing to write)");
  label = r->result->label();
  SessionJobApply a(*this, origin);
  // Throws: run_edits rolls the journal back and the job keeps its result.
  r->result->apply(a);
  r->info.result = r->result->summary_json();
  r->result.reset();
  r->info.applied = true;
  // The finished event again, now `applied` (the UI's job list follows it).
  emit_job(*r, true, std::nullopt);
  return result_for<api::ApplyJobResult>(api::ItemList{});
}

void Session::poll_jobs(Clock::time_point now) {
  jobsPolled_ = now;
  if (runner_) {
    for (jobs::JobUpdate& u : runner_->drain()) {
      JobRecord* r = find_job(u.id);
      if (r == nullptr) continue;  // dropped (a new document)
      switch (u.kind) {
        case jobs::JobUpdate::Kind::started:
          r->info.status = api::JobStatus::running;
          emit_job(*r, false, std::nullopt);
          break;
        case jobs::JobUpdate::Kind::progress:
          r->info.status = api::JobStatus::running;
          r->info.progress = u.fraction;
          r->info.message = std::move(u.message);
          emit_job(*r, false, std::nullopt);
          break;
        case jobs::JobUpdate::Kind::finished:
          if (u.cancelled) {
            r->info.status = api::JobStatus::cancelled;
            r->info.message = "cancelled";
            emit_job(*r, true, std::nullopt);
          } else if (u.error) {
            r->info.status = api::JobStatus::failed;
            r->info.message = u.error->message;
            PREMATION_LOG(warn, "job_failed").kv("job", r->info.id).kv("error", u.error->message);
            emit_job(*r, true, u.error);
          } else {
            r->info.status = api::JobStatus::done;
            r->info.progress = 1;
            r->info.result = u.result->summary_json();
            r->info.message = "done";
            if (!u.result->has_edits()) {
              emit_job(*r, true, std::nullopt);
            } else {
              r->result = std::move(u.result);
              // apply=false: held for applyJobResult; the event says it is ready.
              if (!r->apply) emit_job(*r, true, std::nullopt);
            }
          }
          break;
      }
    }
  }
  // Results waiting to be applied — never inside an open gesture (a drag in
  // progress would absorb them); they land when it closes.
  if (gesture_) return;
  for (JobRecord& r : jobs_) {
    if (r.result && r.apply && r.info.status == api::JobStatus::done && !r.info.applied) (void)apply_job(r);
  }
}

void Session::drop_jobs() {
  for (JobRecord& r : jobs_) {
    if (r.info.status == api::JobStatus::queued || r.info.status == api::JobStatus::running) {
      if (runner_) (void)runner_->cancel(r.info.id);
    }
  }
  jobs_.clear();
}

// ── the autoTrace COMMAND (40_layers.eapi 215) ──────────────────────────────
//
// The same tracer, the same masks as the autoTrace JOB (jobs/kind_auto_trace.cpp):
// the job's prepare validates and snapshots, its work decodes the layer's frames
// and traces them — here on the core thread, to completion, since a command
// answers synchronously — and its result writes the masks through addMask /
// addKeyframes inside the request's journal: one undo entry, "Auto-trace".
// `range` of one frame (or less) traces the frame at range.start (static
// masks); a longer range keys every mask path on every frame of it. The
// command has no blur / minArea / invert: the job's defaults (0, 16, off).

namespace {

/// The job's apply, keeping every mask group an addMask adds.
class MaskCollectingApply final : public jobs::JobApply {
 public:
  explicit MaskCollectingApply(jobs::JobApply& inner) : inner_(inner) {}
  api::CommandResult run(const api::Command& cmd) override {
    api::CommandResult r = inner_.run(cmd);
    if (std::holds_alternative<api::AddMask>(cmd.v)) {
      if (const auto g = jobs::result_payload<api::GroupList>(r)) groups.insert(groups.end(), g->groups.begin(), g->groups.end());
    }
    return r;
  }
  [[nodiscard]] const doc::Document& document() const override { return inner_.document(); }
  std::vector<api::PropPath> groups;

 private:
  jobs::JobApply& inner_;
};

/// A command's work cannot be cancelled and reports no progress (the request is its progress).
class InlineControl final : public jobs::JobControl {
 public:
  [[nodiscard]] bool cancelled() const noexcept override { return false; }
  void progress(double /*fraction*/, std::string /*message*/) override {}
};

}  // namespace

api::CommandResult Session::auto_trace_in_journal(const api::AutoTrace& c, api::Origin origin, std::string& label) {
  // Validate first (the TS handler's order: the layer, then the arguments).
  if (doc_.node(c.layer) == nullptr) fail(ErrorCode::not_found, "no layer '" + c.layer + "'", {.layer = c.layer});
  static constexpr std::array<std::string_view, 7> kChannels = {"", "alpha", "luminance", "luma", "red", "green", "blue"};
  if (std::find(kChannels.begin(), kChannels.end(), std::string_view(c.channel)) == kChannels.end()) {
    fail(ErrorCode::invalid_argument, "channel '" + c.channel + "' is not alpha, luminance, red, green or blue", {.layer = c.layer});
  }
  if (!std::isfinite(c.threshold) || c.threshold < 0 || c.threshold > 1) {
    fail(ErrorCode::out_of_range, "threshold must be 0…1", {.layer = c.layer});
  }
  if (!std::isfinite(c.tolerance) || c.tolerance < 0) fail(ErrorCode::out_of_range, "tolerance must be ≥ 0", {.layer = c.layer});
  if (c.range.duration <= 0) {
    fail(ErrorCode::invalid_argument, "range is empty: give at least one frame (one frame traces the frame at range.start)",
         {.layer = c.layer});
  }
  if (jobKinds_ == nullptr) {
    fail(ErrorCode::unsupported,
         "Auto-trace decodes the layer's frames and this engine build has no decoder (a headless / no-media build)",
         {.layer = c.layer});
  }
  api::AutoTraceJob spec;
  spec.layer = c.layer;
  spec.range = c.range;
  spec.channel = c.channel;
  spec.threshold = c.threshold;
  spec.tolerance = c.tolerance;
  // The job traces range.start only unless everyFrame; everyFrame over one
  // frame is that frame, unkeyed — so the range alone decides.
  spec.every_frame = true;
  spec.invert = false;
  api::JobSpec job;
  job.v = std::move(spec);
  const jobs::JobDocContext ctx{doc_, bundleRoot_, projectPath_, apiTime_};
  // prepare: notFound / invalidArgument (not footage, retimed, no file) / outOfRange.
  jobs::PreparedJob prepared = jobKinds_->prepare(job, ctx);
  if (!prepared.work) fail(ErrorCode::internal, "the autoTrace job prepared no work");
  InlineControl control;
  const std::unique_ptr<jobs::JobResult> result = prepared.work(control);
  if (!result) fail(ErrorCode::internal, "Auto-trace produced no result");
  label = result->label();
  api::GroupList out;
  if (result->has_edits()) {
    SessionJobApply inner(*this, origin);
    MaskCollectingApply a(inner);
    // Throws: run_edits rolls the journal back — nothing of the trace stays.
    result->apply(a);
    out.groups = std::move(a.groups);
  }
  PREMATION_LOG(info, "auto_trace").kv("layer", c.layer).kv("masks", out.groups.size());
  return result_for<api::AutoTrace>(std::move(out));
}

}  // namespace premation
