// Stateless-per-sample DSP primitives with Web Audio semantics — the node
// types audioEffects.ts builds its chains from, each as the specification
// (and Chromium, which Electron runs) defines it, so a chain sounds the same
// in the engine as in the TypeScript offline mix:
//
//   Biquad        BiquadFilterNode: Audio EQ Cookbook with the spec's
//                 conventions (lowpass/highpass Q in dB, shelves at S = 1),
//                 double-precision direct form I, per-sample coefficients
//                 while a parameter moves (a-rate)
//   DelayLine     DelayNode: linear-interpolated fractional read; inside a
//                 feedback cycle the delay is at least one render quantum
//   pan_*         StereoPannerNode's equal-power law, mono and stereo input
//   WaveShaper    WaveShaperNode: linear curve lookup, 2×/4× oversampling
//                 through Chromium's half-band up/down samplers
//
// Signals are float, coefficients and state double — Chromium's split.
#pragma once

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <numbers>
#include <span>
#include <vector>

#include "audio_types.hpp"

namespace premation::audio::dsp {

inline constexpr double kPi = std::numbers::pi;

// ── Biquad ──────────────────────────────────────────────────────────────────

struct BiquadCoefs {
  double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
};

/// Web Audio BiquadFilterNode coefficients. `frequency` in Hz (clamped to
/// [0, nyquist] as the AudioParam's nominal range does), `q` linear except for
/// lowpass/highpass (dB), `gainDb`, `detuneCents`.
[[nodiscard]] BiquadCoefs biquad_coefs(BiquadType type, double sampleRate, double frequency, double q, double gainDb,
                                       double detuneCents) noexcept;

struct BiquadState {
  double x1 = 0, x2 = 0, y1 = 0, y2 = 0;
};

/// Direct form I over `n` samples with one coefficient set.
void biquad_run(const BiquadCoefs& c, BiquadState& s, const float* in, float* out, std::size_t n) noexcept;
/// One sample.
[[nodiscard]] float biquad_tick(const BiquadCoefs& c, BiquadState& s, float in) noexcept;

// ── Delay ───────────────────────────────────────────────────────────────────

/// One channel's delay line (Chromium AudioDelayDSPKernel). Capacity is fixed
/// at construction from the node's maxDelayTime, like DelayNode.
class DelayLine {
 public:
  DelayLine() = default;
  DelayLine(double maxDelaySec, double sampleRate);
  /// Write `in`, then read `delayFrames` behind it (fractional, linear
  /// interpolation; clamped to [minFrames, capacity]).
  [[nodiscard]] float process(float in, double delayFrames) noexcept;
  /// Read `delayFrames` behind the write position WITHOUT writing (the reader
  /// half of a feedback cycle: its output feeds back into the same line's
  /// input this sample), then `write` the input.
  [[nodiscard]] float read(double delayFrames) const noexcept;
  void write(float in) noexcept;
  /// Silence the line (no allocation).
  void clear() noexcept;
  [[nodiscard]] double max_frames() const noexcept { return maxFrames_; }

 private:
  std::vector<float> buf_;
  std::size_t write_ = 0;
  double maxFrames_ = 0;
};

// ── Stereo panner (spec §StereoPannerNode, Chromium StereoPanner) ───────────

inline void pan_mono(float in, double pan, float& l, float& r) noexcept;
inline void pan_stereo(float inL, float inR, double pan, float& l, float& r) noexcept;

// ── WaveShaper ──────────────────────────────────────────────────────────────

/// Chromium's UpSampler: 2× by a 128-tap Blackman-windowed sinc at a half-sample
/// offset for the odd outputs; the even outputs are the input delayed by 64.
class UpSampler2x {
 public:
  explicit UpSampler2x(std::size_t maxBlock);
  void process(const float* in, float* out, std::size_t n) noexcept;  // out has 2n
  void reset() noexcept;

 private:
  std::vector<double> kernel_;
  std::vector<float> hist_;  // last (kernel-1) inputs, oldest first
  std::size_t maxBlock_;
  std::vector<float> scratch_;
};

/// Chromium's DownSampler: half-band 2× decimation (the odd taps of a 128-tap
/// windowed sinc + the 0.5 centre tap).
class DownSampler2x {
 public:
  explicit DownSampler2x(std::size_t maxBlock);
  void process(const float* in, float* out, std::size_t n) noexcept;  // in has n (even), out n/2
  void reset() noexcept;

 private:
  std::vector<double> kernel_;  // 64 reduced taps
  std::vector<float> hist_;     // input history at the 2× rate
  std::vector<float> scratch_;
  std::size_t maxBlock_;
};

/// One channel of WaveShaperNode.
class WaveShaper {
 public:
  WaveShaper() = default;
  WaveShaper(std::vector<float> curve, Oversample os, std::size_t maxBlock);
  void process(const float* in, float* out, std::size_t n) noexcept;
  void reset() noexcept;

 private:
  void shape(float* x, std::size_t n) const noexcept;
  std::vector<float> curve_;
  Oversample os_ = Oversample::none;
  std::vector<UpSampler2x> up_;
  std::vector<DownSampler2x> down_;
  std::vector<float> a_, b_;
  // Chromium's oversampled shaper is 32 (2×) / 48 (4×) frames later than
  // its up/down samplers' own group delay — measured in Electron's Chromium
  // (identity curve, impulse at 300 → peak at 428 / 492) with an identical
  // response otherwise; a pure delay reproduces it.
  std::vector<float> lag_;
  std::size_t lagPos_ = 0;
  void delay_out(float* out, std::size_t n) noexcept;
};

// ── inline ──────────────────────────────────────────────────────────────────

inline void pan_mono(float in, double pan, float& l, float& r) noexcept {
  const double p = pan < -1 ? -1 : (pan > 1 ? 1 : pan);
  const double x = (p * 0.5 + 0.5) * (kPi / 2);
  l = static_cast<float>(static_cast<double>(in) * std::cos(x));
  r = static_cast<float>(static_cast<double>(in) * std::sin(x));
}

inline void pan_stereo(float inL, float inR, double pan, float& l, float& r) noexcept {
  const double p = pan < -1 ? -1 : (pan > 1 ? 1 : pan);
  const double x = (p <= 0 ? p + 1 : p) * (kPi / 2);
  const double gl = std::cos(x);
  const double gr = std::sin(x);
  if (p <= 0) {
    l = static_cast<float>(static_cast<double>(inL) + static_cast<double>(inR) * gl);
    r = static_cast<float>(static_cast<double>(inR) * gr);
  } else {
    l = static_cast<float>(static_cast<double>(inL) * gl);
    r = static_cast<float>(static_cast<double>(inR) + static_cast<double>(inL) * gr);
  }
}

}  // namespace premation::audio::dsp
