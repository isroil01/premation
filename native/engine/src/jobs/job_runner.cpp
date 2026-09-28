#include "job_runner.hpp"

#include <algorithm>
#include <exception>
#include <utility>

#include "fail.hpp"

namespace premation::jobs {

struct JobRunner::Job {
  std::string id;
  JobWork work;
  std::atomic<bool> cancel{false};
};

class JobRunner::Control final : public JobControl {
 public:
  Control(JobRunner& runner, Job& job) : runner_(runner), job_(job) {}
  [[nodiscard]] bool cancelled() const noexcept override { return job_.cancel.load(std::memory_order_relaxed); }
  void progress(double fraction, std::string message) override {
    JobUpdate u;
    u.kind = JobUpdate::Kind::progress;
    u.id = job_.id;
    u.fraction = std::clamp(fraction, 0.0, 1.0);
    u.message = std::move(message);
    runner_.post(std::move(u));
  }

 private:
  JobRunner& runner_;
  Job& job_;
};

JobRunner::JobRunner(unsigned workers) : workers_(std::max(1U, workers)) {}

JobRunner::~JobRunner() {
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    stopping_ = true;
    for (const auto& j : queue_) j->cancel.store(true);
    for (const auto& j : running_) j->cancel.store(true);
  }
  cv_.notify_all();
  for (std::thread& t : threads_) {
    if (t.joinable()) t.join();
  }
}

void JobRunner::submit(std::string id, JobWork work) {
  auto job = std::make_shared<Job>();
  job->id = std::move(id);
  job->work = std::move(work);
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    queue_.push_back(std::move(job));
    if (threads_.size() < workers_ && threads_.size() < queue_.size() + running_.size()) {
      threads_.emplace_back([this] { worker_loop(); });
    }
  }
  cv_.notify_one();
}

bool JobRunner::cancel(const std::string& id) {
  std::shared_ptr<Job> queued;
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    const auto q = std::find_if(queue_.begin(), queue_.end(), [&id](const auto& j) { return j->id == id; });
    if (q != queue_.end()) {
      queued = *q;
      queue_.erase(q);
    } else {
      const auto r = std::find_if(running_.begin(), running_.end(), [&id](const auto& j) { return j->id == id; });
      if (r == running_.end()) return false;
      (*r)->cancel.store(true);
      return true;
    }
  }
  JobUpdate u;
  u.kind = JobUpdate::Kind::finished;
  u.id = id;
  u.cancelled = true;
  post(std::move(u));
  return true;
}

std::vector<JobUpdate> JobRunner::drain() {
  std::vector<JobUpdate> all;
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    all.swap(mailbox_);
  }
  // Collapse: a progress update is dropped when a later update of the same job follows it.
  std::vector<JobUpdate> out;
  out.reserve(all.size());
  for (std::size_t i = 0; i < all.size(); ++i) {
    if (all[i].kind == JobUpdate::Kind::progress) {
      bool superseded = false;
      for (std::size_t k = i + 1; k < all.size() && !superseded; ++k) superseded = all[k].id == all[i].id;
      if (superseded) continue;
    }
    out.push_back(std::move(all[i]));
  }
  return out;
}

std::size_t JobRunner::live() const {
  const std::lock_guard<std::mutex> lock(mutex_);
  return queue_.size() + running_.size();
}

void JobRunner::post(JobUpdate u) {
  const std::lock_guard<std::mutex> lock(mutex_);
  mailbox_.push_back(std::move(u));
}

void JobRunner::worker_loop() {
  for (;;) {
    std::shared_ptr<Job> job;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      cv_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
      if (stopping_) return;
      job = queue_.front();
      queue_.pop_front();
      running_.push_back(job);
      JobUpdate s;
      s.kind = JobUpdate::Kind::started;
      s.id = job->id;
      mailbox_.push_back(std::move(s));
    }
    Control control(*this, *job);
    JobUpdate done;
    done.kind = JobUpdate::Kind::finished;
    done.id = job->id;
    // Every failure of the work stays inside the job: the engine keeps running.
    try {
      done.result = job->work(control);
    } catch (const doc::EngineFail& f) {
      done.error = f.error;
    } catch (const std::exception& e) {
      api::EngineError err;
      err.code = api::ErrorCode::internal;
      err.message = e.what();
      done.error = std::move(err);
    }
    done.cancelled = job->cancel.load() && !done.error;
    if (done.cancelled) done.result.reset();
    if (!done.result && !done.error && !done.cancelled) done.cancelled = true;  // null result = the work gave up
    {
      const std::lock_guard<std::mutex> lock(mutex_);
      running_.erase(std::remove(running_.begin(), running_.end(), job), running_.end());
      mailbox_.push_back(std::move(done));
    }
  }
}

std::string job_kind_name(const api::JobSpec& spec) {
  switch (spec.kind()) {
    case api::JobSpec::Kind::track_motion: return "trackMotion";
    case api::JobSpec::Kind::stabilize: return "stabilize";
    case api::JobSpec::Kind::auto_trace: return "autoTrace";
    case api::JobSpec::Kind::scene_detect: return "sceneDetect";
    case api::JobSpec::Kind::object_matte: return "objectMatte";
    case api::JobSpec::Kind::transcribe: return "transcribe";
    case api::JobSpec::Kind::audio_analysis: return "audioAnalysis";
    case api::JobSpec::Kind::render: return "render";
    case api::JobSpec::Kind::prerender: return "prerender";
    case api::JobSpec::Kind::proxy: return "proxy";
    case api::JobSpec::Kind::audio_duck: return "audioDuck";
    case api::JobSpec::Kind::audio_gate: return "audioGate";
    case api::JobSpec::Kind::track_apply: return "trackApply";
    case api::JobSpec::Kind::roto_brush: return "rotoBrush";
    case api::JobSpec::Kind::content_aware_fill: return "contentAwareFill";
    case api::JobSpec::Kind::auto_reframe: return "autoReframe";
    case api::JobSpec::Kind::rig_logo: return "rigLogo";
  }
  return "job";
}

}  // namespace premation::jobs
