// The worker threads behind PrHostSuite.iterate (G1): a fixed pool that runs
// one index-range job at a time, the calling thread working alongside. A
// second caller arriving while a job runs does its whole range itself (no
// queueing, no deadlock between two render threads).
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <thread>
#include <vector>

namespace premation::plugins {

class WorkerPool {
 public:
  using Item = void (*)(void* ctx, int thread, int index);

  /// `workers` threads besides the caller (0 = run everything on the caller).
  explicit WorkerPool(int workers);
  ~WorkerPool();
  WorkerPool(const WorkerPool&) = delete;
  WorkerPool& operator=(const WorkerPool&) = delete;
  WorkerPool(WorkerPool&&) = delete;
  WorkerPool& operator=(WorkerPool&&) = delete;

  /// Threads a job may use (the workers + the caller): the `thread` argument is below this.
  [[nodiscard]] int width() const noexcept { return static_cast<int>(threads_.size()) + 1; }

  /// item(ctx, thread, i) exactly once for every i in [0, count) unless `stop`
  /// becomes true (then the remaining items are skipped). Returns when all
  /// started items have finished.
  void run(int count, Item item, void* ctx, const std::atomic<bool>* stop);

 private:
  void worker(int index);
  void drain(int thread);

  std::vector<std::thread> threads_;
  std::mutex mutex_;
  std::condition_variable wake_;
  std::condition_variable done_;
  std::mutex jobMutex_;  ///< held by the caller that owns the pool for its job
  // The current job (guarded by mutex_ for publication; indices are atomic).
  std::uint64_t generation_ = 0;
  bool quit_ = false;
  int count_ = 0;
  Item item_ = nullptr;
  void* ctx_ = nullptr;
  const std::atomic<bool>* stop_ = nullptr;
  std::atomic<int> next_{0};
  int busy_ = 0;  ///< workers inside the current job
};

}  // namespace premation::plugins
