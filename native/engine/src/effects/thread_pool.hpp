// E4 effect kernels — a small fixed pool of std::jthread workers that split a
// kernel's rows.
//
// Every kernel is written so that each OUTPUT row depends only on the input
// buffer (never on another output row of the same pass), so splitting rows
// across threads cannot change a single byte: the result is the same on 1 thread
// and on 64. Tests run every parity fixture on both to hold that.
#pragma once

#include <condition_variable>
#include <cstddef>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace premation::effects {

class ThreadPool {
 public:
  /// `threads` workers in total, counting the caller (0 → hardware
  /// concurrency). A pool of 1 runs everything on the calling thread.
  explicit ThreadPool(unsigned threads = 0);
  ~ThreadPool();
  ThreadPool(const ThreadPool&) = delete;
  ThreadPool& operator=(const ThreadPool&) = delete;
  ThreadPool(ThreadPool&&) = delete;
  ThreadPool& operator=(ThreadPool&&) = delete;

  [[nodiscard]] unsigned size() const noexcept { return static_cast<unsigned>(workers_.size()) + 1U; }

  /// Run `fn(begin, end)` over [0, n) in contiguous chunks of at least `grain`
  /// items, the caller taking a share; returns when every chunk is done.
  /// Not re-entrant: a kernel never nests parallel_for.
  void parallel_for(int n, int grain, const std::function<void(int, int)>& fn);

 private:
  void worker_loop(const std::stop_token& stop);

  std::vector<std::jthread> workers_;
  std::mutex m_;
  std::condition_variable_any wake_;
  std::condition_variable done_cv_;
  const std::function<void(int, int)>* job_ = nullptr;
  int n_ = 0;
  int chunk_ = 1;
  int next_ = 0;         // next chunk start handed out
  int outstanding_ = 0;  // chunks not yet finished
  std::size_t generation_ = 0;
};

/// Rows [0, h) of a kernel: through `pool` when one is given, else inline.
inline void for_rows(ThreadPool* pool, int h, const std::function<void(int, int)>& fn, int grain = 8) {
  if (pool == nullptr || pool->size() <= 1 || h <= grain) {
    if (h > 0) fn(0, h);
    return;
  }
  pool->parallel_for(h, grain, fn);
}

}  // namespace premation::effects
