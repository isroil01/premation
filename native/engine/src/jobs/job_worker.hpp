// A long-lived job process: the same crash isolation as child_job.hpp's
// one-shot `--job` child, without paying a process start and a model load per
// call. The Object Matte hover preview asks for one frame every time the
// pointer rests; with the model kept loaded (and the frame's encoder output
// kept in memory) a second prompt on that frame costs the decoder only.
//
//   premation-engine --job-worker FILE     FILE = {"plugins": {...}} (child_job.hpp's set)
//
// Protocol — one JSON object per line each way:
//   stdin   {"id":N,"work":NAME,"input":{...}}
//           {"id":N,"cancel":true}            stop request N (in flight or still queued)
//   stdout  {"id":N,"ev":"progress","fraction":F,"message":S}
//           {"id":N,"ev":"result","result":{...}}
//           {"id":N,"ev":"error","code":S,"message":S}
//           {"id":N,"ev":"cancelled"}         the work stopped at a cancel check
// The worker answers requests one at a time, in order, and exits when stdin
// closes. Its stdin is read on a thread of its own, so a cancel line is seen
// while the work runs: WorkerControl::cancelled() reads the in-flight
// request's flag, and the work returns early at its next check (the answer is
// then `cancelled`). Lines that are not this shape are ignored (a library
// printing).
//
// Parent side (JobWorker): started lazily on the first call, reused after.
//   crash      the stream ends without the answer: that call fails with
//              `internal` naming the exit and the log; the next call starts a
//              fresh worker. The engine never dies with it.
//   hang       neither an answer nor a progress line within the call's
//              timeout: the worker is killed, the call fails the same way.
//   cancel     a call still waiting for its turn returns cancelled at once; a
//              call already sent gets a cancel line and returns as soon as the
//              worker answers (the loaded models and the warm frames survive).
//              With `killOnCancel` (a walk) the call also stops waiting after
//              `cancelGrace` without an answer and kills the worker instead: a
//              work that never checks its control still ends.
//   supersede  calls with the same non-empty `supersedeKey` are latest-wins: a
//              call whose `generation` is no longer the key's newest (claimed
//              with claim_generation when the job is SUBMITTED, so a job still
//              queued in the JobRunner counts) returns cancelled instead of
//              running. The one in flight finishes. The hover preview keys by layer.
//   lanes      run_in_worker keeps TWO workers (WorkerCall::lane): `interactive`
//              answers hovers, proposals and edits; `batch` runs walks. A walk of
//              minutes never queues a hover behind it. The cost: a second
//              process with its own copy of every model it loads (a worker
//              holding SAM 2 on DirectML is 2-3 GB of RAM) while both are warm,
//              so the batch lane idles out first (lane_idle).
//   idle       after `idle` without a call the worker's stdin is closed, so a
//              model is not held in RAM forever.
//   plugins    the worker starts with the engine's plugin set of that moment
//              (child_job.hpp); a call made under a different set restarts it.
#pragma once

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <iosfwd>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "child_job.hpp"
#include "job_api.hpp"

namespace premation::jobs {

/// Which of the engine's two workers a call runs on (run_in_worker).
enum class WorkerLane { interactive, batch };

/// The batch lane's longest idle: enough for the next Follow of a selection to find its model warm.
inline constexpr std::chrono::milliseconds kBatchLaneIdle{std::chrono::seconds(30)};

/// How long a lane's worker outlives its last call: three minutes
/// (PREMATION_JOB_WORKER_IDLE_MS overrides), at most kBatchLaneIdle on the batch lane.
[[nodiscard]] std::chrono::milliseconds lane_idle(WorkerLane lane);

/// One call's terms.
struct WorkerCall {
  /// Latest-wins group ('' = never superseded, never supersedes).
  std::string supersedeKey;
  /// This call's place in its group (claim_generation); 0 = claim one when run() is entered.
  std::uint64_t generation = 0;
  /// How long the worker may stay silent (no answer, no progress line) once the request is sent.
  std::chrono::milliseconds timeout{std::chrono::seconds(90)};
  /// Cancelled while in flight: after `cancelGrace` without an answer to the cancel line, kill
  /// the worker so the call returns (a long walk whose work may sit inside one model call).
  /// Without it the call waits for the worker's answer (a short hover keeps the model warm).
  bool killOnCancel = false;
  /// How long a killOnCancel call waits for the worker to answer its cancel before killing it.
  std::chrono::milliseconds cancelGrace{std::chrono::seconds(5)};
  /// The worker this call runs on (run_in_worker only; a JobWorker is one lane).
  WorkerLane lane = WorkerLane::interactive;
};

class JobWorker {
 public:
  struct Options {
    /// The worker executable and its arguments before the start file (["--job-worker"]).
    std::string exe;
    std::vector<std::string> args{"--job-worker"};
    /// Close the worker after this long without a call.
    std::chrono::milliseconds idle{std::chrono::minutes(3)};
    /// The start file's "plugins" at each call (unset = none): a change restarts the worker.
    std::function<std::optional<std::string>()> plugins;
  };

  explicit JobWorker(Options o);
  /// Kills the worker (if any) and joins every thread.
  ~JobWorker();
  JobWorker(const JobWorker&) = delete;
  JobWorker& operator=(const JobWorker&) = delete;
  JobWorker(JobWorker&&) = delete;
  JobWorker& operator=(JobWorker&&) = delete;

  /// Run `work` on `inputJson` in the worker; progress is relayed to `control`.
  /// The result JSON, or nullopt when cancelled or superseded. Throws
  /// EngineFail: the work's own error, or `internal` on a crash / timeout.
  [[nodiscard]] std::optional<std::string> run(const std::string& work, const std::string& inputJson, JobControl& control,
                                               const WorkerCall& call = {});

  /// Worker processes started so far (tests: a restart after a kill).
  [[nodiscard]] std::uint64_t starts() const;
  /// True while a worker process is up.
  [[nodiscard]] bool alive() const;
  /// Kill the running worker as a crash would (tests).
  void kill_for_test();

 private:
  struct Proc;
  struct Waiter {
    std::uint64_t ticket = 0;
    std::string key;
    std::uint64_t generation = 0;
  };
  void ensure_proc_locked(std::unique_lock<std::mutex>& lk, const std::optional<std::string>& plugins);
  void stop_proc(std::unique_ptr<Proc> p, bool kill);
  void reader_loop(Proc* p);
  void idle_loop();
  /// Write one line to the worker's stdin (the lock is NOT held: a blocking write).
  static bool write_line(Proc* p, std::string line);

  Options opt_;
  mutable std::mutex mu_;
  std::condition_variable cv_;
  std::deque<Waiter> queue_;
  std::uint64_t tickets_ = 0;
  std::uint64_t requestIds_ = 0;
  bool busy_ = false;
  bool stopping_ = false;
  std::unique_ptr<Proc> proc_;
  std::uint64_t starts_ = 0;
  std::chrono::steady_clock::time_point lastUse_;
  std::thread idler_;
};

/// A new newest generation of latest-wins group `key`: every call holding an older one is superseded.
[[nodiscard]] std::uint64_t claim_generation(const std::string& key);
/// True while `generation` is still `key`'s newest.
[[nodiscard]] bool is_latest(const std::string& key, std::uint64_t generation);

/// The engine's shared workers on child_executable() (child_job.hpp), one per
/// WorkerLane, each started on its first call. With no executable known (tests,
/// tools) the work runs in-process, as run_child does. PREMATION_JOB_WORKER=0
/// sends every call to a one-shot run_child instead (a measurement baseline).
[[nodiscard]] std::optional<std::string> run_in_worker(const std::string& work, const std::string& inputJson, JobControl& control,
                                                       const WorkerCall& call = {});

/// `premation-engine --job-worker FILE`: the worker's main over `in` / `out`
/// with the works registered so far (the caller registers them). Returns the
/// exit code when `in` ends.
int worker_main(const std::string& startFile, std::istream& in, std::ostream& out, const ChildPluginStarter& startPlugins = {});

}  // namespace premation::jobs
