#include "time_map.hpp"

#include <algorithm>
#include <cmath>

namespace premation::media {

double loop_source_seconds(double sourceSec, double durationSec, int loopCount) noexcept {
  // `!durationSec` in the TS is also true for NaN.
  if (!(durationSec > 0) || loopCount == 1 || sourceSec < durationSec) return sourceSec;
  const double pass = std::floor(sourceSec / durationSec);
  if (loopCount != 0 && pass >= loopCount) return durationSec - 1e-6;  // exhausted: hold the last frame
  return sourceSec - pass * durationSec;
}

double posterize_seconds(double t, double fps) noexcept {
  if (!(fps > 0)) return t;
  return std::floor(t * fps) / fps;
}

double layer_time_seconds(double t, const LayerTimeConfig& cfg, double spanStart, double spanEnd) noexcept {
  if (cfg.freeze) return cfg.freezeTime;
  const double stretch = cfg.stretch > 0 ? cfg.stretch : 100;
  double s = spanStart + (t - spanStart) * (100 / stretch);
  if (cfg.reverse) s = spanStart + spanEnd - s;
  return s;
}

FramePick pulldown_pick(std::int64_t n, int phase) noexcept {
  const std::int64_t k = (((n - phase) % 5) + 5) % 5;
  if (k == 2 && n >= 1) return {n - 1, std::nullopt};
  if (k == 3 && n >= 1) return {n, n - 1};
  return {n, std::nullopt};
}

Bracket bracket_seconds(double time, double fps) noexcept {
  if (!(fps > 0) || !std::isfinite(time)) return {time, time, 0};
  const double exact = time * fps;
  const double lo = std::floor(exact);
  return {lo / fps, (lo + 1) / fps, exact - lo};
}

namespace {
FramePick pick_at(const FrameIndex& index, double sec, const FootageInterpretation& interp) noexcept {
  const std::int64_t n = index.frame_at_seconds(sec);
  if (interp.pulldownPhase) return pulldown_pick(n, *interp.pulldownPhase);
  return {n, std::nullopt};
}
}  // namespace

FramePlan plan_frames(const FrameIndex& index, double sourceSec, const FootageInterpretation& interp, FrameBlend blend,
                      double probeFps, double compFps) noexcept {
  FramePlan plan;
  plan.a = pick_at(index, sourceSec, interp);
  if (blend == FrameBlend::none) return plan;
  // buildSnapshot.ts:3696 — the grid is conform > probe > comp.
  double gridFps = compFps;
  if (probeFps > 0) gridFps = probeFps;
  if (interp.conformFps && *interp.conformFps > 0) gridFps = *interp.conformFps;
  const Bracket br = bracket_seconds(sourceSec, gridFps);
  if (!(br.weight > 1e-3)) return plan;
  // Both ends may clamp to the same frame past the end; the TS still draws the
  // pair (B over A changes the result at layer opacity < 1), so this does too.
  plan.a = pick_at(index, br.a, interp);
  plan.b = pick_at(index, br.b, interp);
  plan.weight = br.weight;
  plan.mode = blend;
  return plan;
}

}  // namespace premation::media
