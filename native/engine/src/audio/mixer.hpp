// The mixer: renders a Program one render quantum at a time — every voice
// read from its conformed source (varispeed, reverse, loop), run through its
// effect chain, level-gained and panned, summed on the master bus (gain, mute,
// limiter, meter).
//
// A RenderPlan owns ALL mutable DSP state for one Program and is built on the
// control thread; the audio thread only calls reset() and render(), which
// never allocate, lock or read a clock. The output is a pure function of
// (program, the quantum-aligned frame render started at): the realtime path
// and the offline export run this same code, which is what makes an export
// sound exactly like the preview.
#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <vector>

#include "audio_types.hpp"
#include "automation.hpp"
#include "dsp_dynamics.hpp"
#include "effects.hpp"
#include "source_store.hpp"

namespace premation::audio {

/// Levels of the master bus (the VU meter), per channel.
struct MeterLevels {
  std::array<float, 2> peak{};
  std::array<float, 2> rms{};
  float limiterReductionDb = 0;
};

class RenderPlan {
 public:
  explicit RenderPlan(ProgramPtr program);
  ~RenderPlan();
  RenderPlan(const RenderPlan&) = delete;
  RenderPlan& operator=(const RenderPlan&) = delete;
  RenderPlan(RenderPlan&&) = delete;
  RenderPlan& operator=(RenderPlan&&) = delete;

  [[nodiscard]] const Program& program() const noexcept { return *program_; }
  [[nodiscard]] const ProgramPtr& program_ptr() const noexcept { return program_; }
  /// Frames the master bus delays the mix by (the limiter's look-ahead).
  [[nodiscard]] std::size_t latency() const noexcept;

  /// Start over at quantum-aligned `frame0` (all voice state cleared).
  void reset(std::int64_t frame0) noexcept;
  /// Render the quantum at `frame0` (kQuantum frames) into planar `out`
  /// (format.channels planes). A frame0 other than the one following the
  /// previous render implies reset(frame0).
  void render(std::int64_t frame0, float* const* out) noexcept;
  /// Master levels of the last rendered quantum.
  [[nodiscard]] const MeterLevels& meter() const noexcept { return meter_; }

 private:
  struct VoiceDsp;
  void render_voice(VoiceDsp& v, std::int64_t frame0) noexcept;
  ProgramPtr program_;
  std::vector<std::unique_ptr<VoiceDsp>> voices_;
  std::int64_t next_ = INT64_MIN;
  std::array<std::array<float, kQuantum>, 2> bus_{};
  Bound masterGain_;
  bool limiterOn_ = false;
  dsp::Limiter limiter_;
  MeterLevels meter_;
};

/// Offline, sample-exact render of `frames` frames starting at comp frame
/// `startFrame`, for export (muxed by ffmpeg later) and for the parity and
/// determinism tests. Waits for every referenced source to finish conforming.
/// Identical to the realtime mix started at the same frame; the limiter's
/// look-ahead is compensated. Planar output, format.channels planes.
[[nodiscard]] std::vector<std::vector<float>> render_offline(const ProgramPtr& program, std::int64_t startFrame,
                                                             std::int64_t frames);

/// audioParams.ts `dbToGain`: ≤ −60 dB (or non-finite) is exactly 0.
[[nodiscard]] double level_db_to_gain(double db) noexcept;

}  // namespace premation::audio
