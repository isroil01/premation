#include "thread_pool.hpp"

#include <algorithm>

namespace premation::effects {

ThreadPool::ThreadPool(unsigned threads) {
  unsigned n = threads == 0 ? std::max(1U, std::thread::hardware_concurrency()) : threads;
  workers_.reserve(n - 1);
  for (unsigned i = 1; i < n; ++i) {
    workers_.emplace_back([this](const std::stop_token& st) { worker_loop(st); });
  }
}

ThreadPool::~ThreadPool() {
  for (auto& w : workers_) w.request_stop();
  wake_.notify_all();
  // jthread joins on destruction.
}

void ThreadPool::worker_loop(const std::stop_token& stop) {
  std::size_t seen = 0;
  std::unique_lock lock(m_);
  while (true) {
    wake_.wait(lock, stop, [&] { return generation_ != seen && next_ < n_; });
    if (stop.stop_requested()) return;
    seen = generation_;
    while (next_ < n_) {
      const int b = next_;
      const int e = std::min(n_, b + chunk_);
      next_ = e;
      const auto* job = job_;
      lock.unlock();
      (*job)(b, e);
      lock.lock();
      if (--outstanding_ == 0) done_cv_.notify_all();
    }
  }
}

void ThreadPool::parallel_for(int n, int grain, const std::function<void(int, int)>& fn) {
  if (n <= 0) return;
  const int threads = static_cast<int>(size());
  if (threads <= 1 || n <= grain) {
    fn(0, n);
    return;
  }
  // ~4 chunks per thread balances rows of uneven cost (transparent pixels skip).
  const int chunk = std::max(std::max(1, grain), (n + threads * 4 - 1) / (threads * 4));
  std::unique_lock lock(m_);
  job_ = &fn;
  n_ = n;
  chunk_ = chunk;
  next_ = 0;
  outstanding_ = (n + chunk - 1) / chunk;
  ++generation_;
  wake_.notify_all();
  while (next_ < n_) {
    const int b = next_;
    const int e = std::min(n_, b + chunk_);
    next_ = e;
    lock.unlock();
    fn(b, e);
    lock.lock();
    --outstanding_;
  }
  done_cv_.wait(lock, [&] { return outstanding_ == 0; });
  job_ = nullptr;
  n_ = 0;
}

}  // namespace premation::effects
