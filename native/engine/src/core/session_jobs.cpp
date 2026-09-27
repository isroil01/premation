// Session: engine jobs (ENGINE_API.md §4.9, jobs/job_api.hpp) — startJob /
// cancelJob / applyJobResult / getJobs and the core-thread half of every job:
// progress events, and the result applied as ONE history entry through
// ordinary commands.
#include <algorithm>
#include <chrono>
#include <string>
#include <utility>

#include "fail.hpp"
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
  api::CommandResult run(const api::Command& cmd) override { return s_.run_in_journal(cmd, origin_, nullptr); }
  [[nodiscard]] const doc::Document& document() const override { return s_.doc_; }

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
  try {
    SessionJobApply a(*this, api::Origin::engine);
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

}  // namespace premation
