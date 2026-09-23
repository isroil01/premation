// Sample-accurate parameter automation: a parameter's value is sampled on the
// control grid (absolute comp frames, every `controlPeriod`) and interpolated
// linearly per sample in between — what audioParams.ts does with
// `buildRamp` + `linearRampToValueAtTime`, except anchored to the comp clock
// instead of the voice's start, so the curve a voice hears never depends on
// where playback (or an export) began.
//
// Values are rounded to float at the grid points, as an AudioParam stores
// them, and interpolated in double.
#pragma once

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <span>
#include <string_view>
#include <utility>
#include <vector>

#include "audio_types.hpp"

namespace premation::audio {

struct ParamDef {
  std::string_view key;
  double defaultValue;
};

/// One effect's parameters resolved to indices: static values (the effect's
/// own, else the definition's default) and keyframe curves where present.
class FxParams {
 public:
  FxParams() = default;
  FxParams(const EffectSpec& fx, std::span<const ParamDef> defs);
  /// Index of `key` (defs order); keys not in defs are appended (plugin params).
  [[nodiscard]] std::size_t idx(std::string_view key) const noexcept;
  [[nodiscard]] std::size_t size() const noexcept { return statics_.size(); }
  [[nodiscard]] double statik(std::size_t i) const noexcept { return statics_[i]; }
  [[nodiscard]] bool animated(std::size_t i) const noexcept { return curves_[i] != nullptr; }
  [[nodiscard]] double at(std::size_t i, double compSec) const noexcept {
    return curves_[i] != nullptr ? curves_[i]->at(compSec) : statics_[i];
  }

 private:
  std::vector<std::string> keys_;
  std::vector<double> statics_;
  std::vector<const ParamCurve*> curves_;
};

/// Up to this many parameters per effect (Parametric EQ has 9).
inline constexpr std::size_t kMaxFxParams = 16;

using Derive = std::function<double(const double* values)>;

/// Where a render quantum sits on the comp clock.
struct QuantumClock {
  double sampleRate = 48000;
  std::int64_t frame0 = 0;  // comp frame of the quantum's first sample
  int controlPeriod = kQuantum;
};

/// An AudioParam bound to effect parameters through `derive` — audioEffects.ts
/// `bind`: static when none of the watched keys is keyframed (one assignment),
/// else a ramp over the control grid.
class Bound {
 public:
  Bound() = default;
  /// A constant (an assigned `.value`).
  explicit Bound(float constant) : constant_(constant) {}
  Bound(const FxParams* params, std::initializer_list<std::size_t> keys, Derive derive);
  /// A single curve through `map` (level dB → gain, pan % → −1…1).
  Bound(const ParamCurve* curve, std::function<double(double)> map);

  [[nodiscard]] bool animated() const noexcept { return animated_; }
  /// Fill `out[0..n)` with the values over the quantum. Returns true when the
  /// value is constant over it (then only out[0] matters and is written).
  bool fill(const QuantumClock& q, float* out, std::size_t n) noexcept;
  /// k-rate: the value at the quantum's first frame.
  [[nodiscard]] float at_start(const QuantumClock& q) noexcept;

 private:
  [[nodiscard]] float grid_value(std::int64_t g, const QuantumClock& q) noexcept;
  float constant_ = 0;
  bool animated_ = false;
  const FxParams* params_ = nullptr;
  std::array<std::size_t, 4> keys_{};
  std::size_t nKeys_ = 0;
  Derive derive_;
  const ParamCurve* curve_ = nullptr;
  std::function<double(double)> map_;
  // Two-entry cache of grid values (grid index → value).
  std::array<std::int64_t, 2> cacheG_{INT64_MIN, INT64_MIN};
  std::array<float, 2> cacheV_{};
};

}  // namespace premation::audio
