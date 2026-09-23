// Ownership of the frame-slot ring (docs/VIEWPORT_ROUTE.md, "Implications for
// C2" 2): a slot is FREE (the engine may render into it) or HELD (announced
// with FrameReady and not yet released by the host). The render thread
// acquires; the frame-channel reader thread releases. A release for another
// generation (the ring was rebuilt since) or for a slot that is not held is
// ignored — a confused or malicious host cannot make the engine render into a
// texture Chromium is still sampling.
#pragma once

#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <vector>

namespace premation::render {

class FrameRing {
 public:
  /// Rebuild: `count` free slots under a new generation.
  void reset(std::uint32_t generation, std::uint32_t count) {
    const std::lock_guard<std::mutex> lock(m_);
    gen_ = generation;
    held_.assign(count, false);
    next_ = 0;
  }

  /// A free slot, marked held; nullopt when every slot is with the host.
  std::optional<std::uint32_t> acquire() {
    const std::lock_guard<std::mutex> lock(m_);
    const auto n = static_cast<std::uint32_t>(held_.size());
    for (std::uint32_t k = 0; k < n; ++k) {
      const std::uint32_t i = (next_ + k) % n;
      if (!held_[i]) {
        held_[i] = true;
        next_ = i + 1;
        return i;
      }
    }
    return std::nullopt;
  }

  /// Give a slot back without announcing it (render failed).
  void unacquire(std::uint32_t slot) {
    const std::lock_guard<std::mutex> lock(m_);
    if (slot < held_.size()) held_[slot] = false;
  }

  /// Host released a slot. True when it was held in this generation.
  bool release(std::uint32_t generation, std::uint32_t slot) {
    bool freed = false;
    {
      const std::lock_guard<std::mutex> lock(m_);
      if (generation == gen_ && slot < held_.size() && held_[slot]) {
        held_[slot] = false;
        freed = true;
      }
    }
    if (freed && onRelease_) onRelease_();
    return freed;
  }

  /// Called (from the releasing thread) after a successful release.
  void on_release(std::function<void()> f) {
    const std::lock_guard<std::mutex> lock(m_);
    onRelease_ = std::move(f);
  }

  [[nodiscard]] bool any_free() const {
    const std::lock_guard<std::mutex> lock(m_);
    for (const bool h : held_) {
      if (!h) return true;
    }
    return false;
  }

  [[nodiscard]] std::uint32_t generation() const {
    const std::lock_guard<std::mutex> lock(m_);
    return gen_;
  }

  [[nodiscard]] std::uint32_t held_count() const {
    const std::lock_guard<std::mutex> lock(m_);
    std::uint32_t n = 0;
    for (const bool h : held_) n += h ? 1U : 0U;
    return n;
  }

 private:
  mutable std::mutex m_;
  std::uint32_t gen_ = 0;
  std::vector<bool> held_;
  std::uint32_t next_ = 0;
  std::function<void()> onRelease_;
};

}  // namespace premation::render
