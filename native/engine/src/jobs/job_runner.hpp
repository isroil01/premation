// The engine's job queue: worker threads that run JobWork (job_api.hpp) and a
// mailbox the core thread drains. The document never crosses: work gets its
// inputs from `prepare` (core thread) and hands back a JobResult the core
// thread applies.
//
// Order: jobs start in submission order; with more than one worker a later job
// may finish first — every result is applied by the core thread in the order
// it drains them, and each is one history entry of its own.
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "job_api.hpp"

namespace premation::jobs {

/// One thing the core thread learns about a job.
struct JobUpdate {
  enum class Kind : std::uint8_t { started, progress, finished };
  Kind kind = Kind::progress;
  std::string id;
  double fraction = 0;
  std::string message;
  /// finished: the result (null when it failed or was cancelled).
  std::unique_ptr<JobResult> result;
  /// finished: why it failed.
  std::optional<api::EngineError> error;
  bool cancelled = false;
};

class JobRunner {
 public:
  /// `workers` threads (at least 1), started lazily on the first submit.
  explicit JobRunner(unsigned workers = 2);
  /// Cancels everything queued or running and joins the workers.
  ~JobRunner();
  JobRunner(const JobRunner&) = delete;
  JobRunner& operator=(const JobRunner&) = delete;
  JobRunner(JobRunner&&) = delete;
  JobRunner& operator=(JobRunner&&) = delete;

  void submit(std::string id, JobWork work);
  /// Ask a queued or running job to stop. A queued one finishes cancelled at
  /// once; a running one when its work next checks `cancelled()`. False: no such live job.
  bool cancel(const std::string& id);
  /// Everything since the last drain, in the order it happened. Progress is
  /// collapsed to the latest per job (the UI wants the state, not the history).
  [[nodiscard]] std::vector<JobUpdate> drain();
  /// Jobs queued or running (the core loop polls while this is non-zero).
  [[nodiscard]] std::size_t live() const;

 private:
  struct Job;
  class Control;
  void worker_loop();
  void post(JobUpdate u);

  const unsigned workers_;
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::deque<std::shared_ptr<Job>> queue_;
  std::vector<std::shared_ptr<Job>> running_;
  std::vector<JobUpdate> mailbox_;
  std::vector<std::thread> threads_;
  bool stopping_ = false;
};

}  // namespace premation::jobs
