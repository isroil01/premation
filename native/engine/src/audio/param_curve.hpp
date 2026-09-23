// A time-varying audio parameter, self-contained so the audio thread can
// evaluate it without touching the document: a constant, a copy of the
// property's keyframe track (sampled with motion_eval — the same sampler the
// rest of the engine uses, bit-identical to packages/animation), or a baked
// table (anything the audio thread cannot evaluate itself — an expression, a
// driver — sampled by the document thread at a fixed rate).
//
// Times are COMPOSITION seconds, the clock audioParams.ts samples on
// (`sampleLevelDb(nodeId, compSec, …)`).
#pragma once

#include <cstdint>
#include <vector>

#include "motion/motion_eval.h"

namespace premation::audio {

class ParamCurve {
 public:
  enum class Kind : std::uint8_t { constant, keyframes, table };

  ParamCurve() = default;
  [[nodiscard]] static ParamCurve constant(double v) noexcept;
  /// A keyframe track. `fallback` is the static value used when the track is
  /// empty or invalid (the TS falls back to the component prop the same way).
  [[nodiscard]] static ParamCurve keyframes(std::vector<motion_keyframe> keys, double fallback);
  /// Samples at `startSec + i / rate`, linearly interpolated, ends held.
  [[nodiscard]] static ParamCurve table(std::vector<double> values, double startSec, double rate);

  [[nodiscard]] Kind kind() const noexcept { return kind_; }
  /// True when the value can change over time (a ramp is needed).
  [[nodiscard]] bool animated() const noexcept { return kind_ != Kind::constant; }
  [[nodiscard]] double at(double compSec) const noexcept;
  /// The constant value (or the fallback of an animated curve).
  [[nodiscard]] double static_value() const noexcept { return value_; }

 private:
  Kind kind_ = Kind::constant;
  double value_ = 0;
  std::vector<motion_keyframe> keys_;
  std::vector<double> table_;
  double tableStart_ = 0;
  double tableRate_ = 0;
};

}  // namespace premation::audio
