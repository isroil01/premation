// The audio master clock.
//
// The device consumes frames at ITS crystal's rate, not the CPU's: over ten
// minutes a 100 ppm difference is 60 ms — two frames at 30 fps — so a video
// clock paced by the wall clock drifts away from the sound. The engine
// therefore derives the playhead from samples: which output frame is at the
// speaker right now, and which comp position that frame was rendered from.
//
//   DeviceClock   a delay-locked loop (Adriaensen) over the callbacks'
//                 (frames delivered, timestamp) pairs: a jitter-free estimate
//                 of the device's frame position at any instant, locked to
//                 its real rate
//   PlayheadMap   the segments the audio thread rendered: from device frame
//                 d0 on, media frame m0 advancing by `rate` per device frame
//                 (a new segment at every play / seek / loop wrap / pause)
//
// playhead(now) = map(deviceClock.frame_at(now) − outputLatency): the comp
// time of the sample being HEARD, compensated for the device buffer and the
// master limiter's look-ahead. Readers on any thread are lock-free (seqlock).
#pragma once

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>

namespace premation::audio {

using SteadyClock = std::chrono::steady_clock;

/// What the transport (D1b's Session clock, E1's media playhead hook) reads.
struct ClockReading {
  /// Comp time of the sample at the speaker (seconds).
  double compSec = 0;
  /// Media seconds advanced since play started (monotonic, × rate, across
  /// loop wraps) — the Session's `elapsed × fps` step counter reads this in
  /// place of the wall clock.
  double mediaElapsedSec = 0;
  bool playing = false;
  /// Changes at every discontinuity (play, seek, loop wrap, pause).
  std::uint64_t epoch = 0;
  /// False until the device has run long enough to estimate its rate.
  bool locked = false;
};

/// Second-order DLL over (device frame, timestamp) callback pairs.
class DeviceClock {
 public:
  /// `bandwidthHz`: the loop's bandwidth once locked (narrow: callback jitter
  /// of ±1–2 ms must not move the rate estimate); it starts 16× wider for
  /// the first 128 callbacks so it locks within about a second.
  explicit DeviceClock(double sampleRate = 48000, double bandwidthHz = 0.1);
  /// One device callback: `frame` = frames delivered before it, at `t`
  /// (seconds on any monotonic clock).
  void on_callback(std::int64_t frame, double t) noexcept;
  /// Estimated device frame position at time `t`.
  [[nodiscard]] double frame_at(double t) const noexcept;
  [[nodiscard]] double frames_per_second() const noexcept { return 1.0 / spf_; }
  [[nodiscard]] bool locked() const noexcept { return count_ >= 8; }
  void reset() noexcept { count_ = 0; }

 private:
  double sr_;
  double bw_;
  double tBase_ = 0;     // estimated time of frame pBase_
  std::int64_t pBase_ = 0;
  double spf_;           // estimated seconds per device frame
  std::uint64_t count_ = 0;
};

/// A rendered segment: from device frame d0, media advances `rate` per frame.
struct PlaySegment {
  std::int64_t deviceFrame = 0;
  double mediaFrame = 0;     // comp frame at deviceFrame
  double rate = 0;           // media frames per device frame (0 = stopped)
  double unfolded = 0;       // media frames since play began, at deviceFrame
  bool playing = false;
  std::uint64_t epoch = 0;
};

/// Lock-free single-writer (audio thread) / multi-reader playhead state.
class MasterClock {
 public:
  explicit MasterClock(double sampleRate);
  // ── audio thread ──
  void on_callback(std::int64_t deviceFrame, double t) noexcept;
  void push(const PlaySegment& s) noexcept;
  void set_latency_frames(double frames) noexcept;
  // ── any thread ──
  [[nodiscard]] ClockReading read(double t) const noexcept;
  [[nodiscard]] double sample_rate() const noexcept { return sr_; }

 private:
  static constexpr std::size_t kRing = 32;
  struct Slot {
    std::atomic<std::int64_t> deviceFrame{0};
    std::atomic<double> mediaFrame{0};
    std::atomic<double> rate{0};
    std::atomic<double> unfolded{0};
    std::atomic<bool> playing{false};
    std::atomic<std::uint64_t> epoch{0};
  };
  double sr_;
  DeviceClock dll_;
  std::atomic<std::uint64_t> seq_{0};
  std::array<Slot, kRing> ring_;
  std::atomic<std::uint64_t> head_{0};  // number of segments pushed
  std::atomic<double> tBase_{0}, pBase_{0}, spf_{0};
  std::atomic<bool> locked_{false};
  std::atomic<double> latency_{0};
};

/// Seconds on the steady clock (the clock every callback timestamp uses).
[[nodiscard]] inline double steady_seconds(SteadyClock::time_point t) noexcept {
  return std::chrono::duration<double>(t.time_since_epoch()).count();
}

}  // namespace premation::audio
