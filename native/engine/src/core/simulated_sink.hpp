// A FrameSink without a GPU: the same slot ring and frame-channel messages as
// the render thread, with "rendering" being instantaneous. Used by
// `premation-engine --no-gpu` (protocol work and CI machines with no adapter),
// by the session tests and by the protocol fuzzer — so ring exhaustion, stale
// releases and a host that never releases are exercised without Dawn.
#pragma once

#include <functional>
#include <mutex>
#include <optional>
#include <utility>

#include "frame_scene.hpp"
#include "premation/protocol/frame_channel.hpp"
#include "render/frame_ring.hpp"

namespace premation {

class SimulatedSink final : public FrameSink {
 public:
  using SendFrames = std::function<void(const frames::Message&)>;

  explicit SimulatedSink(SendFrames send, std::uint32_t slots = 3) : send_(std::move(send)), slots_(slots) {}

  void submit(RenderJob job) override {
    const std::lock_guard<std::mutex> lock(m_);
    ++submitted_;
    if (pending_) {
      ++counters_.dropped;
      ++droppedPending_;
    }
    droppedPending_ += job.clockDropped;
    lastScene_ = job.scene;
    pending_ = std::move(job);
    pump_locked();
  }

  void configure(const ViewportConfig& config) override {
    const std::lock_guard<std::mutex> lock(m_);
    config_ = config;
    ++generation_;
    const std::uint32_t count = config.open ? slots_ : 0;
    ring_.reset(generation_, count);
    api::FrameSlots s;
    s.generation = generation_;
    s.viewport = config.viewport;
    s.width = config.width;
    s.height = config.height;
    s.handles.assign(count, 0);
    if (send_) send_(frames::Message{.v = std::move(s)});
  }

  void set_shared(bool) override {}
  [[nodiscard]] bool shared_supported() const override { return false; }
  [[nodiscard]] RenderCounters counters() const override {
    const std::lock_guard<std::mutex> lock(m_);
    return counters_;
  }
  [[nodiscard]] std::string adapter() const override { return "none (simulated)"; }
  [[nodiscard]] std::string backend() const override { return "none"; }

  void release(std::uint32_t generation, std::uint32_t slot) {
    const std::lock_guard<std::mutex> lock(m_);
    if (ring_.release(generation, slot)) pump_locked();
  }

  [[nodiscard]] std::uint64_t submitted() const {
    const std::lock_guard<std::mutex> lock(m_);
    return submitted_;
  }
  [[nodiscard]] FrameScene last_scene() const {
    const std::lock_guard<std::mutex> lock(m_);
    return lastScene_;
  }
  [[nodiscard]] ViewportConfig config() const {
    const std::lock_guard<std::mutex> lock(m_);
    return config_;
  }

 private:
  void pump_locked() {
    if (!pending_ || !config_.open) return;
    const auto slot = ring_.acquire();
    if (!slot) return;  // ring full: keep the newest job until a release
    api::FrameReady f;
    f.generation = generation_;
    f.slot = *slot;
    f.viewport = pending_->viewport;
    f.dropped = droppedPending_;
    f.frame = pending_->frame;
    f.time = pending_->time;
    f.revision = pending_->revision;
    f.width = config_.width;
    f.height = config_.height;
    droppedPending_ = 0;
    pending_.reset();
    ++counters_.rendered;
    if (send_) send_(frames::Message{.v = f});
  }

  SendFrames send_;
  std::uint32_t slots_;
  mutable std::mutex m_;
  render::FrameRing ring_;
  std::uint32_t generation_ = 0;
  ViewportConfig config_;
  std::optional<RenderJob> pending_;
  std::uint32_t droppedPending_ = 0;
  RenderCounters counters_;
  std::uint64_t submitted_ = 0;
  FrameScene lastScene_;
};

}  // namespace premation
