#include "workers.hpp"

namespace premation::plugins {

WorkerPool::WorkerPool(int workers) {
  threads_.reserve(static_cast<std::size_t>(workers > 0 ? workers : 0));
  for (int i = 0; i < workers; ++i) threads_.emplace_back([this, i] { worker(i + 1); });
}

WorkerPool::~WorkerPool() {
  {
    const std::scoped_lock lock(mutex_);
    quit_ = true;
  }
  wake_.notify_all();
  for (std::thread& t : threads_) t.join();
}

void WorkerPool::drain(int thread) {
  for (;;) {
    if (stop_ != nullptr && stop_->load(std::memory_order_relaxed)) return;
    const int i = next_.fetch_add(1, std::memory_order_relaxed);
    if (i >= count_) return;
    item_(ctx_, thread, i);
  }
}

void WorkerPool::worker(int index) {
  std::uint64_t seen = 0;
  for (;;) {
    {
      std::unique_lock lock(mutex_);
      wake_.wait(lock, [&] { return quit_ || generation_ != seen; });
      if (quit_) return;
      seen = generation_;
      ++busy_;
    }
    drain(index);
    {
      const std::scoped_lock lock(mutex_);
      --busy_;
    }
    done_.notify_all();
  }
}

void WorkerPool::run(int count, Item item, void* ctx, const std::atomic<bool>* stop) {
  if (count <= 0) return;
  std::unique_lock job(jobMutex_, std::try_to_lock);
  if (!job.owns_lock() || threads_.empty() || count == 1) {
    // Busy (another render thread's job) or nothing to share: all on the caller.
    for (int i = 0; i < count; ++i) {
      if (stop != nullptr && stop->load(std::memory_order_relaxed)) return;
      item(ctx, 0, i);
    }
    return;
  }
  {
    const std::scoped_lock lock(mutex_);
    count_ = count;
    item_ = item;
    ctx_ = ctx;
    stop_ = stop;
    next_.store(0, std::memory_order_relaxed);
    ++generation_;
  }
  wake_.notify_all();
  drain(0);
  // Every worker that picked the job up must leave it before the job's context goes away.
  std::unique_lock lock(mutex_);
  done_.wait(lock, [&] { return busy_ == 0; });
  item_ = nullptr;
  ctx_ = nullptr;
  stop_ = nullptr;
  count_ = 0;
}

}  // namespace premation::plugins
