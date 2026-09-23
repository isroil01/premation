// A multi-producer, single-consumer FIFO with a deadline-aware pop. The
// document core drains exactly one of these, so every command is applied in
// the order it arrived (determinism: one thread, one order).
#pragma once

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <mutex>
#include <optional>
#include <utility>

namespace premation {

template <class T>
class BlockingQueue {
 public:
  using Clock = std::chrono::steady_clock;

  /// False once closed (the item is dropped).
  bool push(T item) {
    {
      const std::lock_guard<std::mutex> lock(mutex_);
      if (closed_) return false;
      items_.push_back(std::move(item));
    }
    cv_.notify_one();
    return true;
  }

  /// Wait for an item until `deadline` (nullopt = forever). Returns nullopt on
  /// timeout, or when closed and empty.
  std::optional<T> pop_until(std::optional<Clock::time_point> deadline) {
    std::unique_lock<std::mutex> lock(mutex_);
    const auto ready = [this] { return closed_ || !items_.empty(); };
    if (deadline) {
      if (!cv_.wait_until(lock, *deadline, ready)) return std::nullopt;
    } else {
      cv_.wait(lock, ready);
    }
    if (items_.empty()) return std::nullopt;
    T item = std::move(items_.front());
    items_.pop_front();
    return item;
  }

  std::optional<T> try_pop() {
    const std::lock_guard<std::mutex> lock(mutex_);
    if (items_.empty()) return std::nullopt;
    T item = std::move(items_.front());
    items_.pop_front();
    return item;
  }

  void close() {
    {
      const std::lock_guard<std::mutex> lock(mutex_);
      closed_ = true;
    }
    cv_.notify_all();
  }

  [[nodiscard]] bool closed() const {
    const std::lock_guard<std::mutex> lock(mutex_);
    return closed_;
  }

  [[nodiscard]] std::size_t size() const {
    const std::lock_guard<std::mutex> lock(mutex_);
    return items_.size();
  }

 private:
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::deque<T> items_;
  bool closed_ = false;
};

}  // namespace premation
