// The realtime half: transport + mix reader + master clock, driven by the
// device callback (or, in tests and the drift simulation, by a simulated
// device). Owns what the audio thread touches; the control thread talks to
// it only through a lock-free command queue.
//
//   play / pause / seek / loop    the audio thread executes them at a sample
//                                 boundary and records a clock segment, so
//                                 the playhead the video reads is the sample
//                                 being heard
//   no clicks                     every discontinuity (play, pause, seek,
//                                 loop wrap, a new program) renders a 5 ms
//                                 tail of the old stream and cross-fades it
//                                 into the new one (raised cosine)
//   scrub                         a seek in scrub mode while stopped plays a
//                                 short grain (AE: audio while dragging the
//                                 playhead), faded in and out
//   varispeed                     play rate r > 0 resamples the mix (pitch
//                                 follows, as J/K/L shuttle); r < 0 is silent
#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <vector>

#include "audio_types.hpp"
#include "clock.hpp"
#include "mixer.hpp"
#include "spsc.hpp"

namespace premation::audio {

enum class LoopMode : std::uint8_t { once, loop, pingPong };

class RealtimeEngine {
 public:
  explicit RealtimeEngine(MixFormat format);
  ~RealtimeEngine();
  RealtimeEngine(const RealtimeEngine&) = delete;
  RealtimeEngine& operator=(const RealtimeEngine&) = delete;
  RealtimeEngine(RealtimeEngine&&) = delete;
  RealtimeEngine& operator=(RealtimeEngine&&) = delete;

  // ── control thread (one producer) ──
  void install(std::unique_ptr<RenderPlan> plan);
  /// Play from comp frame `from` at `rate`, looping over [rangeStart, rangeEnd).
  void play(std::int64_t from, double rate, LoopMode mode, std::int64_t rangeStart, std::int64_t rangeEnd);
  void pause();
  void seek(std::int64_t frame, bool scrub);
  /// Preview output: mute, volume (linear), whether scrubbing makes sound.
  void set_output(bool muted, double volume, bool scrubAudio);
  /// Output latency beyond the played-frame measure (DAC / analog path).
  void set_device_latency(double frames);
  /// Free render plans the audio thread has retired.
  void collect_garbage();

  // ── audio thread ──
  /// Fill `frames` interleaved frames. `writeFrame` = frames delivered
  /// before this call; `t` = the callback's timestamp (steady seconds);
  /// `playedFrame` = frames the hardware had consumed at `t` (the clock is
  /// locked to this — samples actually played).
  void process(float* interleaved, std::uint32_t frames, std::int64_t writeFrame, double t,
               std::int64_t playedFrame) noexcept;

  // ── any thread ──
  [[nodiscard]] ClockReading playhead(double t) const noexcept { return clock_.read(t); }
  [[nodiscard]] MeterLevels meter() const noexcept;
  [[nodiscard]] const MixFormat& format() const noexcept { return fmt_; }
  /// Frames of the last callback that had no plan / no source data in time.
  [[nodiscard]] std::uint64_t underruns() const noexcept { return underruns_.load(std::memory_order_relaxed); }

 private:
  enum class CmdType : std::uint8_t { install, play, pause, seek, output };
  struct Cmd {
    CmdType type = CmdType::pause;
    RenderPlan* plan = nullptr;  // install: ownership transferred
    std::int64_t frame = 0;
    double rate = 1;
    LoopMode mode = LoopMode::loop;
    std::int64_t a = 0, b = 0;
    bool scrub = false;
    bool muted = false;
    double volume = 1;
    bool scrubAudio = true;
  };
  enum class Mode : std::uint8_t { stopped, playing, grain };

  /// Reads the mix of the current plan at arbitrary (monotonic) frames.
  class Reader {
   public:
    explicit Reader(int channels);
    void set_plan(RenderPlan* p) noexcept;
    [[nodiscard]] float get(int ch, std::int64_t frame) noexcept;
    [[nodiscard]] float sample(int ch, double pos) noexcept;

   private:
    void load(std::int64_t q) noexcept;
    RenderPlan* plan_ = nullptr;
    int channels_;
    std::int64_t q_ = INT64_MIN;
    std::int64_t prevQ_ = INT64_MIN;
    std::array<std::array<float, kQuantum>, 2> cur_{}, prev_{};
  };

  void apply(const Cmd& c, std::int64_t deviceFrame) noexcept;
  void capture_tail() noexcept;
  void segment(std::int64_t deviceFrame) noexcept;
  void retire(RenderPlan* p) noexcept;

  MixFormat fmt_;
  std::size_t fade_;
  MasterClock clock_;
  Spsc<Cmd, 64> cmds_;
  Spsc<RenderPlan*, 64> retired_;
  std::array<RenderPlan*, 16> retireOverflow_{};
  std::size_t overflowN_ = 0;
  // Audio-thread state.
  RenderPlan* plan_ = nullptr;
  Reader reader_;
  Mode mode_ = Mode::stopped;
  double pos_ = 0;
  double rate_ = 1;
  LoopMode loop_ = LoopMode::loop;
  std::int64_t rangeA_ = 0, rangeB_ = INT64_MAX;
  double unfolded_ = 0;
  std::uint64_t epoch_ = 0;
  std::int64_t grainLeft_ = 0;
  std::size_t fadeIn_ = 0;
  std::vector<float> tail_;  // fade_ × channels, interleaved
  std::size_t tailLen_ = 0, tailPos_ = 0;
  bool muted_ = false;
  bool scrubAudio_ = true;
  float volume_ = 1, gain_ = 1;
  std::atomic<double> deviceLatencyIn_{0};
  std::atomic<std::uint64_t> underruns_{0};
  // Meter, published for the UI.
  std::array<std::atomic<float>, 5> meter_{};
};

}  // namespace premation::audio
