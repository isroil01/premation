// Time at the seam (src/core/engine/time.ts + packages/engine-api/src/time.ts),
// operation for operation: API times are integer flicks, keyframes are seconds,
// clip bars are frames of the owning composition's (float) rate.
#pragma once

#include <cmath>
#include <cstdint>

#include "engine_api.hpp"
#include "jsmath.hpp"

namespace premation::doc {

inline constexpr double kFlicks = 705'600'000.0;

/// `Math.round(seconds * FLICKS_PER_SECOND)`.
[[nodiscard]] inline api::Time seconds_to_flicks(double seconds) noexcept {
  const double r = motion::js::round(seconds * kFlicks);
  if (!std::isfinite(r)) return 0;
  return static_cast<api::Time>(r);
}

[[nodiscard]] inline double flicks_to_seconds(api::Time flicks) noexcept { return static_cast<double>(flicks) / kFlicks; }

/// `fpsToRational`: integers exact, NTSC ×1000/1001, else millis.
[[nodiscard]] inline api::Rational fps_to_rational(double fps) noexcept {
  const auto u32 = [](double x) -> std::uint32_t {
    if (!(x > 0)) return 0;
    if (x > 4294967295.0) return 0xFFFFFFFFU;
    return static_cast<std::uint32_t>(x);
  };
  if (std::floor(fps) == fps && std::isfinite(fps)) return {u32(fps), 1};
  const double ntsc = motion::js::round(fps * 1.001);
  if (std::fabs((ntsc * 1000) / 1001 - fps) < 1e-3) return {u32(ntsc * 1000), 1001};
  return {u32(motion::js::round(fps * 1000)), 1000};
}

/// `framesToFlicks(frames, fps)`: Math.round((frames * FLICKS * den) / num).
[[nodiscard]] inline api::Time frames_to_flicks(double frames, double fps) noexcept {
  const api::Rational r = fps_to_rational(fps);
  if (r.num == 0) return 0;
  const double v = motion::js::round((frames * kFlicks * static_cast<double>(r.den)) / static_cast<double>(r.num));
  return std::isfinite(v) ? static_cast<api::Time>(v) : 0;
}

/// `flicksToFrames(flicks, fps)`: Math.round((flicks * num) / (FLICKS * den)).
[[nodiscard]] inline double flicks_to_frames(api::Time flicks, double fps) noexcept {
  const api::Rational r = fps_to_rational(fps);
  return motion::js::round((static_cast<double>(flicks) * static_cast<double>(r.num)) /
                           (kFlicks * static_cast<double>(r.den)));
}

/// A double that holds an integer, as an int64 (frames are integral in practice).
[[nodiscard]] inline std::int64_t to_i64(double v) noexcept {
  if (!std::isfinite(v)) return 0;
  return static_cast<std::int64_t>(v);
}

}  // namespace premation::doc
