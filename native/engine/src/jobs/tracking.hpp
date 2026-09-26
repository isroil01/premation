// The point tracker — src/core/tracking/patchMatch.ts (the matcher) and
// tracker.ts (the per-point walk), ported operation for operation so the same
// frames give the same track:
//
//   patchMatch.ts   lumaFromRGBA, sampleBilinear, extractPatch, ncc,
//                   matchPatch (integer NCC search over one bilinear region
//                   with integral-image window statistics, coarse stride-2 +
//                   ±2 refine above searchHalf 6, then Lucas-Kanade sub-pixel
//                   refinement, parabola as the fallback).
//   tracker.ts      PointTrack.step (chained reference + frame-0 anchor drift
//                   correction and anchor re-set, rounded-velocity prediction,
//                   2x / 3x wide-window and anchor re-acquisition before
//                   coasting, coast budget), trackPoints (every live point
//                   matched against each frame, decoded once).
//   autoTrack.ts    mergeBidirectional (a both-ways walk outward from one frame).
//   planarFit.ts    fitHomographyRansac (seeded xorshift32), smoothHomographySequence,
//   Homography.ts   fitHomography (DLT, h22 = 1), project — the corner pin's
//                   overdetermined planar fit (more than four points).
//
// Where the TypeScript stores into a Float32Array (planes, patches, the search
// region, NCC memo, gradients, homographies) this stores a float; everything
// else is double, as JS numbers are. Pure: luma planes in, plain structs out —
// no ffmpeg, no document (the job glue is kind_track_motion.cpp).
#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <optional>
#include <span>
#include <vector>

namespace premation::jobs::tracking {

/// A single-channel image (patchMatch.ts LumaPlane), Float32 storage.
struct LumaPlane {
  int width = 0;
  int height = 0;
  std::vector<float> data;
};

/// `lumaFromRGBA`: Rec.601 luma in [0, 1] from straight RGBA8 (rows top-down, no padding).
[[nodiscard]] LumaPlane luma_from_rgba(std::span<const std::uint8_t> rgba, int width, int height);

/// `sampleBilinear`: clamped at the borders.
[[nodiscard]] double sample_bilinear(const LumaPlane& plane, double x, double y) noexcept;

/// `extractPatch`: a (2·half+1)² patch at a fractional centre; empty when the
/// centre is outside the plane (the TypeScript's null).
[[nodiscard]] std::vector<float> extract_patch(const LumaPlane& plane, double cx, double cy, int half);

/// `ncc`: zero-mean normalized cross-correlation, 0 for a flat patch.
[[nodiscard]] double ncc(std::span<const float> a, std::span<const float> b) noexcept;

struct MatchResult {
  double x = 0;
  double y = 0;
  double confidence = 0;
};

/// `matchPatch`: nullopt only when every candidate centre left the plane.
[[nodiscard]] std::optional<MatchResult> match_patch(std::span<const float> refPatch, int featureHalf,
                                                     const LumaPlane& target, double predictX, double predictY,
                                                     int searchHalf);

/// tracker.ts TrackSample.
struct TrackSample {
  std::int64_t frame = 0;
  double x = 0;
  double y = 0;
  double confidence = 0;
  bool coasted = false;
};

enum class TrackStatus : std::uint8_t { completed, lost, cancelled };

/// One point to track, in the plane's pixels at the walk's first frame.
struct PointSeed {
  double x = 0;
  double y = 0;
  /// tracker.ts defaults: 10 (21×21 patch), ±20 search.
  int featureHalf = 10;
  int searchHalf = 20;
};

struct TrackOptions {
  /// NCC below this is a lost frame (tracker.ts DEFAULT_MIN_CONFIDENCE).
  double minConfidence = 0.55;
  /// Consecutive coasted frames before a point dies (DEFAULT_MAX_COAST).
  int maxCoastFrames = 8;
};

/// A frame of the walk (the reference stays valid until the next call). A frame that cannot be read throws (EngineFail).
using FrameAt = std::function<const LumaPlane&(std::int64_t frame)>;
/// Called before each frame after the first with (done, total); false cancels (tracker.ts onProgress).
using OnProgress = std::function<bool(std::int64_t done, std::int64_t total)>;

struct MultiTrackResult {
  /// One sample list per point, walk order (a backward walk is descending).
  std::vector<std::vector<TrackSample>> tracks;
  TrackStatus status = TrackStatus::completed;
};

/// `trackPoints`: `toFrame < fromFrame` walks backwards.
[[nodiscard]] MultiTrackResult track_points(const FrameAt& frameAt, std::int64_t fromFrame, std::int64_t toFrame,
                                            std::span<const PointSeed> points, const TrackOptions& opts,
                                            const OnProgress& onProgress);

/// autoTrack.ts `mergeBidirectional`: backward (walk order) + forward, one sample per frame, ascending.
[[nodiscard]] std::vector<TrackSample> merge_bidirectional(std::span<const TrackSample> backward,
                                                           std::span<const TrackSample> forward);

// ── planar fit (corner pin with more than four points) ──────────────────

struct Pt {
  double x = 0;
  double y = 0;
};
/// Homography.ts Mat3: column-major [a,d,g, b,e,h, c,f,i], Float32.
using Mat3 = std::array<float, 9>;

/// Homography.ts `fitHomography`: least squares over N ≥ 4 correspondences.
[[nodiscard]] std::optional<Mat3> fit_homography(std::span<const Pt> src, std::span<const Pt> dst);
/// Homography.ts `project`: nullopt on the vanishing line.
[[nodiscard]] std::optional<Pt> project_homography(const Mat3& m, Pt p) noexcept;

struct RansacOptions {
  double inlierPx = 3;
  int iterations = 64;
  std::uint32_t seed = 1;
  /// Per correspondence; empty = all 1. Weight ≤ 0 is excluded.
  std::vector<double> weights;
};
struct RansacFit {
  Mat3 H{};
  std::vector<bool> inliers;
  int inlierCount = 0;
  double rms = 0;
};
/// planarFit.ts `fitHomographyRansac`.
[[nodiscard]] std::optional<RansacFit> fit_homography_ransac(std::span<const Pt> src, std::span<const Pt> dst,
                                                             const RansacOptions& opts);
/// planarFit.ts `smoothHomographySequence`.
[[nodiscard]] std::vector<std::optional<Mat3>> smooth_homography_sequence(std::span<const std::optional<Mat3>> hs,
                                                                          int radius);

}  // namespace premation::jobs::tracking
