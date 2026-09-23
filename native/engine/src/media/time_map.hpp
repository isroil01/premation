// Source time → decoded frame(s): the footage half of the TS time chain,
// ported formula for formula so a layer shows the same frame in both engines.
//
// The COMP half of the chain (clip map in comp frames, precomp ancestor
// retimes, the layer's own Speed % / Frames retime, clone offsets) is document
// evaluation and lives with the C++ document (D1b: core/timeline.cpp
// `remap_time`, retime). It ends in `layer.sourceTime` — seconds on the
// footage's own axis (buildSnapshot.ts:3655). Everything from there down is here:
//
//   loop_source_seconds   Interpret Footage ▸ Loop (sourceInfo.ts:275)
//   posterize_seconds     Posterize Time (buildSnapshot.ts:1190)
//   layer_time_seconds    stretch / reverse / freeze (layerTime.ts:69) — same
//                         formula as D1b's remap_time, restated for the media tests
//   plan_frames           seconds → presentation index via FrameIndex (+1 µs rule),
//                         pulldown removal (pulldownDetect.ts:197), frame
//                         blending bracket (videoFrameCache.ts:309) at the
//                         conformed rate (buildSnapshot.ts:3682)
#pragma once

#include <cstdint>
#include <optional>

#include "frame_index.hpp"
#include "media_types.hpp"

namespace premation::media {

/// Layer ▸ Frame Blending (layerTime.ts FrameBlendMode).
enum class FrameBlend : std::uint8_t { none, mix, pixelMotion };

/// Interpret Footage (sourceInfo.ts FootageInterpretation) — the fields the frame choice reads.
struct FootageInterpretation {
  /// "Assume this frame rate". Does NOT retime playback (time maps by seconds);
  /// it is the grid frame blending brackets on.
  std::optional<double> conformFps;
  /// 1 = play once; 0 = loop forever; N = N passes then hold the last frame.
  int loopCount = 1;
  AlphaMode alpha = AlphaMode::straight;
  /// 3:2 pulldown phase (0–4) when removal is on.
  std::optional<int> pulldownPhase;
};

/// sourceInfo.ts `loopedSourceTime`.
[[nodiscard]] double loop_source_seconds(double sourceSec, double durationSec, int loopCount) noexcept;
/// Posterize Time: floor(t · fps) / fps (fps ≤ 0 → t).
[[nodiscard]] double posterize_seconds(double t, double fps) noexcept;

/// layerTime.ts `LayerTimeConfig` (stretch in percent, 200 = half speed).
struct LayerTimeConfig {
  double stretch = 100;
  bool reverse = false;
  bool freeze = false;
  double freezeTime = 0;
};
/// layerTime.ts `remapTime(t, cfg, span)`.
[[nodiscard]] double layer_time_seconds(double t, const LayerTimeConfig& cfg, double spanStart, double spanEnd) noexcept;

/// One frame the renderer needs: a presentation index, or two field-woven ones.
struct FramePick {
  std::int64_t index = 0;
  /// Pulldown weave: even rows from `index` (top), odd rows from `bottom`.
  std::optional<std::int64_t> bottom;
  friend bool operator==(const FramePick&, const FramePick&) = default;
};

/// What a footage layer draws at one source time.
struct FramePlan {
  FramePick a;
  /// Frame blending: the next frame and its weight (B over A at `weight`, the
  /// TS Frame Mix "over" composite; Pixel Motion warps between them).
  std::optional<FramePick> b;
  double weight = 0;
  FrameBlend mode = FrameBlend::none;
};

/// pulldownDetect.ts `pulldownFrameFor(n, phase)`.
[[nodiscard]] FramePick pulldown_pick(std::int64_t n, int phase) noexcept;

/// videoFrameCache.ts `bracketFrames(time, fps)`: {a, b, weight} in seconds.
struct Bracket {
  double a = 0;
  double b = 0;
  double weight = 0;
};
[[nodiscard]] Bracket bracket_seconds(double time, double fps) noexcept;

/// Frames for `sourceSec` (already looped/posterized/retimed by the chain).
/// `probeFps` is the stream's own rate; `compFps` the last fallback for the blend grid.
[[nodiscard]] FramePlan plan_frames(const FrameIndex& index, double sourceSec, const FootageInterpretation& interp,
                                    FrameBlend blend, double probeFps, double compFps) noexcept;

}  // namespace premation::media
