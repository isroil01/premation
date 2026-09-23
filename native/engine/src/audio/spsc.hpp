// Bounded single-producer / single-consumer queue: the only channel between
// the control thread and the audio callback (commands one way, retired render
// plans the other). Wait-free on both ends; no allocation after construction.
#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <optional>
#include <utility>

namespace premation::audio {

template <class T, std::size_t N>
class Spsc {
  static_assert((N & (N - 1)) == 0, "capacity must be a power of two");

 public:
  bool push(T v) noexcept {
    const std::size_t h = head_.load(std::memory_order_relaxed);
    const std::size_t t = tail_.load(std::memory_order_acquire);
    if (h - t == N) return false;
    slots_[h & (N - 1)] = std::move(v);
    head_.store(h + 1, std::memory_order_release);
    return true;
  }
  std::optional<T> pop() noexcept {
    const std::size_t t = tail_.load(std::memory_order_relaxed);
    const std::size_t h = head_.load(std::memory_order_acquire);
    if (h == t) return std::nullopt;
    T v = std::move(slots_[t & (N - 1)]);
    tail_.store(t + 1, std::memory_order_release);
    return v;
  }

 private:
  std::array<T, N> slots_{};
  alignas(64) std::atomic<std::size_t> head_{0};
  alignas(64) std::atomic<std::size_t> tail_{0};
};

}  // namespace premation::audio
