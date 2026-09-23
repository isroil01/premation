// Dynamics: DynamicsCompressorNode (the spec's algorithm, which is Chromium's
// DynamicsCompressorKernel — 6 ms pre-delay, knee curve solved for its slope,
// adaptive release through the 4-point polynomial, sin-warped gain, makeup
// gain (1/fullRangeGain)^0.6), and the master bus's look-ahead limiter.
#pragma once

#include <array>
#include <cstddef>
#include <vector>

namespace premation::audio::dsp {

struct CompressorParams {
  float thresholdDb = -24;
  float kneeDb = 30;
  float ratio = 12;
  float attackSec = 0.003F;
  float releaseSec = 0.25F;
};

/// DynamicsCompressorNode over 1 or 2 channels. Parameters are k-rate: the
/// caller passes the values at the start of each render quantum. `process`
/// runs in 32-frame divisions; a partial division (a render that starts or
/// ends between quantum boundaries) runs with its own frame count.
class Compressor {
 public:
  Compressor() = default;
  Compressor(double sampleRate, std::size_t channels);
  /// Back to the constructed state (no allocation).
  void reset() noexcept;
  /// `in`/`out` are per-channel pointers (out may alias in); n ≤ 32.
  void process_division(const float* const* in, float* const* out, std::size_t n, const CompressorParams& p) noexcept;
  /// Metering reduction in dB (≤ 0), as DynamicsCompressorNode.reduction.
  [[nodiscard]] float reduction_db() const noexcept { return meteringGain_; }

 private:
  [[nodiscard]] float knee_curve(float x, float k) const noexcept;
  [[nodiscard]] float saturate(float x, float k) const noexcept;
  [[nodiscard]] float slope_at(float x, float k) const noexcept;
  [[nodiscard]] float k_at_slope(float desiredSlope) const noexcept;
  float update_static_curve(float dbThreshold, float dbKnee, float ratio) noexcept;

  double sampleRate_ = 48000;
  std::size_t channels_ = 2;
  static constexpr std::size_t kMaxPreDelay = 1024;
  static constexpr std::size_t kMask = kMaxPreDelay - 1;
  std::vector<std::array<float, kMaxPreDelay>> preDelay_;
  std::size_t readIdx_ = 0;
  std::size_t writeIdx_ = 256;
  std::size_t lastPreDelayFrames_ = 256;
  float detectorAverage_ = 0;
  float compressorGain_ = 1;
  float meteringGain_ = 1;
  float meteringReleaseK_ = 0;
  float maxAttackCompressionDiffDb_ = -1;
  // Static curve (recomputed when threshold/knee/ratio change).
  float ratio_ = -1, slope_ = -1, linearThreshold_ = -1, dbThreshold_ = -1, dbKnee_ = -1;
  float kneeThreshold_ = -1, kneeThresholdDb_ = -1, ykneeThresholdDb_ = -1, k_ = -1;
  // Per-quantum envelope state (computed at each division start).
};

/// Master bus limiter: look-ahead peak limiter with an instant attack over the
/// look-ahead window and an exponential release. Deterministic (no clock), a
/// fixed latency of `lookahead` frames that both preview and export compensate.
class Limiter {
 public:
  Limiter() = default;
  Limiter(double sampleRate, std::size_t channels, double ceilingDb, double releaseMs, std::size_t lookahead);
  void process(float* const* io, std::size_t n) noexcept;
  void reset() noexcept;
  [[nodiscard]] std::size_t latency() const noexcept { return lookahead_; }
  [[nodiscard]] float gain_reduction_db() const noexcept;

 private:
  std::size_t channels_ = 2;
  std::size_t lookahead_ = 0;
  float ceiling_ = 1;
  float releaseCoef_ = 0;
  float gain_ = 1;
  std::vector<std::vector<float>> delay_;  // per channel ring, lookahead + 1
  std::vector<float> target_;              // ring: per-frame target gain min(1, ceiling/peak)
  std::vector<float> mins_;                // ring: sliding minimum of target_ over the window
  double minSum_ = 0;                      // running sum of mins_ (the smoothing boxcar)
  std::size_t pos_ = 0;
};

}  // namespace premation::audio::dsp
