#include "clock.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>

namespace premation::audio {

DeviceClock::DeviceClock(double sampleRate, double bandwidthHz)
    : sr_(sampleRate), bw_(bandwidthHz), spf_(1.0 / sampleRate) {}

void DeviceClock::on_callback(std::int64_t frame, double t) noexcept {
  const double nominal = 1.0 / sr_;
  if (count_ == 0 || frame <= pBase_) {
    tBase_ = t;
    pBase_ = frame;
    spf_ = nominal;
    count_ = 1;
    return;
  }
  const auto dn = static_cast<double>(frame - pBase_);
  const double predicted = tBase_ + dn * spf_;
  const double e = t - predicted;
  // A glitch (device restart, xrun, a suspended process) is not jitter:
  // re-seed rather than bend the loop toward it.
  if (std::fabs(e) > 0.050) {
    tBase_ = t;
    pBase_ = frame;
    count_ = 1;
    return;
  }
  const double interval = dn * spf_;
  const double omega = 2 * std::numbers::pi * bw_ * interval;
  const double b = std::numbers::sqrt2 * omega;
  const double c = omega * omega;
  // Converge fast at first (wide loop for the first callbacks), then narrow.
  const double boost = count_ < 128 ? 16.0 : 1.0;
  tBase_ = predicted + std::min(1.0, b * boost) * e;
  pBase_ = frame;
  spf_ += std::min(1.0, c * boost * boost) * e / dn;
  spf_ = std::clamp(spf_, nominal * 0.99, nominal * 1.01);
  ++count_;
}

double DeviceClock::frame_at(double t) const noexcept {
  if (count_ == 0) return 0;
  return static_cast<double>(pBase_) + (t - tBase_) / spf_;
}

MasterClock::MasterClock(double sampleRate) : sr_(sampleRate), dll_(sampleRate), spf_(1.0 / sampleRate) {}

void MasterClock::on_callback(std::int64_t deviceFrame, double t) noexcept {
  dll_.on_callback(deviceFrame, t);
  // Publish the DLL's line (t = tBase + (frame − pBase)·spf).
  seq_.fetch_add(1, std::memory_order_acq_rel);
  const double pAt = dll_.frame_at(t);
  tBase_.store(t, std::memory_order_relaxed);
  pBase_.store(pAt, std::memory_order_relaxed);
  spf_.store(1.0 / dll_.frames_per_second(), std::memory_order_relaxed);
  locked_.store(dll_.locked(), std::memory_order_relaxed);
  seq_.fetch_add(1, std::memory_order_release);
}

void MasterClock::push(const PlaySegment& s) noexcept {
  seq_.fetch_add(1, std::memory_order_acq_rel);
  const std::uint64_t h = head_.load(std::memory_order_relaxed);
  Slot& slot = ring_[h % kRing];
  slot.deviceFrame.store(s.deviceFrame, std::memory_order_relaxed);
  slot.mediaFrame.store(s.mediaFrame, std::memory_order_relaxed);
  slot.rate.store(s.rate, std::memory_order_relaxed);
  slot.unfolded.store(s.unfolded, std::memory_order_relaxed);
  slot.playing.store(s.playing, std::memory_order_relaxed);
  slot.epoch.store(s.epoch, std::memory_order_relaxed);
  head_.store(h + 1, std::memory_order_relaxed);
  seq_.fetch_add(1, std::memory_order_release);
}

void MasterClock::set_latency_frames(double frames) noexcept { latency_.store(frames, std::memory_order_relaxed); }

ClockReading MasterClock::read(double t) const noexcept {
  ClockReading r;
  for (int attempt = 0; attempt < 64; ++attempt) {
    const std::uint64_t s0 = seq_.load(std::memory_order_acquire);
    if ((s0 & 1U) != 0) continue;
    const double tBase = tBase_.load(std::memory_order_relaxed);
    const double pBase = pBase_.load(std::memory_order_relaxed);
    const double spf = spf_.load(std::memory_order_relaxed);
    const bool locked = locked_.load(std::memory_order_relaxed);
    const double lat = latency_.load(std::memory_order_relaxed);
    const std::uint64_t head = head_.load(std::memory_order_relaxed);
    // The device frame at the speaker now.
    const double heard = pBase + (t - tBase) / spf - lat;
    // The newest segment that had begun by then.
    PlaySegment seg;
    bool found = false;
    const std::uint64_t n = std::min<std::uint64_t>(head, kRing);
    for (std::uint64_t k = 0; k < n; ++k) {
      const Slot& slot = ring_[(head - 1 - k) % kRing];
      const std::int64_t d0 = slot.deviceFrame.load(std::memory_order_relaxed);
      if (static_cast<double>(d0) <= heard || k + 1 == n) {
        seg.deviceFrame = d0;
        seg.mediaFrame = slot.mediaFrame.load(std::memory_order_relaxed);
        seg.rate = slot.rate.load(std::memory_order_relaxed);
        seg.unfolded = slot.unfolded.load(std::memory_order_relaxed);
        seg.playing = slot.playing.load(std::memory_order_relaxed);
        seg.epoch = slot.epoch.load(std::memory_order_relaxed);
        found = true;
        break;
      }
    }
    std::atomic_thread_fence(std::memory_order_acquire);
    if (seq_.load(std::memory_order_relaxed) != s0) continue;
    if (!found) return r;
    const double dd = std::max(0.0, heard - static_cast<double>(seg.deviceFrame));
    r.compSec = (seg.mediaFrame + dd * seg.rate) / sr_;
    r.mediaElapsedSec = (seg.unfolded + dd * std::fabs(seg.rate)) / sr_;
    r.playing = seg.playing;
    r.epoch = seg.epoch;
    r.locked = locked;
    return r;
  }
  return r;
}

}  // namespace premation::audio
