// Generators: OscillatorNode (Chromium's PeriodicWave — band-limited
// wavetables, 3 ranges per octave, linear interpolation within and between
// tables) and the seeded white-noise loop Tone uses (audioEffects.ts
// `noiseBuffer`, bit-identical: its JavaScript hash is replayed with the same
// IEEE doubles and ToInt32/ToUint32 conversions).
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string_view>
#include <vector>

#include "audio_types.hpp"

namespace premation::audio::dsp {

/// The band-limited tables of one waveform at one sample rate. Immutable and
/// shared (every oscillator of that shape reads the same tables); built on the
/// control thread, never on the audio thread.
class PeriodicWave {
 public:
  PeriodicWave(Wave shape, double sampleRate);
  [[nodiscard]] std::size_t size() const noexcept { return size_; }
  [[nodiscard]] double rate_scale() const noexcept { return rateScale_; }
  /// Chromium `WaveDataForFundamentalFrequency`.
  void tables_for(float fundamental, const float*& lower, const float*& higher, float& tableInterp) const noexcept;

 private:
  std::size_t size_ = 4096;
  std::size_t ranges_ = 36;
  float centsPerRange_ = 400;
  float lowestFundamental_ = 0;
  double rateScale_ = 0;
  std::vector<std::vector<float>> tables_;
};

/// Shared tables for (shape, rate), built once (thread-safe).
[[nodiscard]] std::shared_ptr<const PeriodicWave> periodic_wave(Wave shape, double sampleRate);

class Oscillator {
 public:
  Oscillator() = default;
  explicit Oscillator(std::shared_ptr<const PeriodicWave> wave);
  void reset() noexcept { index_ = 0; }
  /// Advance the phase as if the oscillator had run `frames` at `frequency`.
  void skip(double frames, double frequency) noexcept;
  /// One sample at `frequency` Hz (already detuned).
  [[nodiscard]] float tick(double frequency) noexcept;

 private:
  std::shared_ptr<const PeriodicWave> wave_;
  double index_ = 0;  // virtual read index into the table
};

/// Tone's White Noise: a one-second loop of hashed samples (Float32).
[[nodiscard]] std::vector<float> noise_buffer(double sampleRate, std::uint32_t seed);

/// audioEffects.ts `hashId`: FNV-1a over UTF-16 code units, Math.imul.
[[nodiscard]] std::uint32_t hash_id(std::string_view utf8) noexcept;

/// JavaScript ToUint32 / ToInt32 of a double (ECMA-262 7.1.6/7.1.7).
[[nodiscard]] std::uint32_t js_to_uint32(double v) noexcept;
[[nodiscard]] std::int32_t js_to_int32(double v) noexcept;

}  // namespace premation::audio::dsp
