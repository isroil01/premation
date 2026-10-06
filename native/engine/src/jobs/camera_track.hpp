// The automatic 3D Camera Tracker (AE parity 3.5): no user points.
//
//   1. track_features — corners found across the frame (track_feature.hpp,
//      one per tile), followed frame to frame (tracking.hpp match_patch) with
//      a forward-backward check; lost ones replaced in empty tiles. Each
//      feature is a track: its observations on consecutive frames.
//   2. solve — structure from motion over those tracks:
//        • the initial pair: frame 0 and the first frame with enough
//          parallax; the essential matrix (8-point, RANSAC, Sampson error)
//          gives the relative pose, the common tracks are triangulated;
//        • every further frame is resected (PnP: Gauss–Newton on the 6 pose
//          parameters from the previous pose, robust), and tracks seen by two
//          posed frames with enough baseline are triangulated (linear
//          multi-view, then refined);
//        • alternation rounds (points given poses, poses given points) refine
//          the whole solve; points that reproject badly are dropped;
//        • the focal length, when not given, is the one whose solve
//          reprojects best (a coarse sweep, then a golden-section search).
//
// World = camera 0's frame (x right, y down, z forward — the composition's
// axes), the first baseline of length 1. kind_camera_track.cpp scales it into
// composition pixels. Deterministic (seeded RANSAC, no clock). Pure.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <vector>

#include "camera_solve.hpp"
#include "tracking.hpp"

namespace premation::jobs::camtrack {

using camsolve::M3;
using camsolve::V2;
using camsolve::V3;

struct Obs {
  int point = 0;
  double x = 0;
  double y = 0;
};

struct FeatureTracks {
  int width = 0;
  int height = 0;
  int points = 0;
  /// frames[i]: the observations on the walk's i-th frame.
  std::vector<std::vector<Obs>> frames;
};

struct FeatureOptions {
  int maxFeatures = 220;
  int featureHalf = 6;
  int searchHalf = 28;
  double minConfidence = 0.75;
};

/// Walk `from` → `to` (ascending) following corners. Empty when cancelled.
[[nodiscard]] std::optional<FeatureTracks> track_features(const tracking::FrameAt& frameAt, std::int64_t from, std::int64_t to,
                                                          const FeatureOptions& opts, const tracking::OnProgress& onProgress);

/// world → camera: Xc = R (X − C).
struct Pose {
  M3 R{};
  V3 C;
};

struct Solve {
  double focal = 0;
  double cx = 0;
  double cy = 0;
  std::vector<std::optional<Pose>> poses;   ///< per frame
  std::vector<std::optional<V3>> points;    ///< per track
  std::vector<double> pointError;           ///< per track, mean reprojection px (0 when unsolved)
  std::vector<int> pointViews;              ///< per track, frames that saw it
  double rmsPx = 0;
  int solvedFrames = 0;
};

struct SolveOptions {
  /// px; unset: solved.
  std::optional<double> focal;
  /// Rounds of points-then-poses refinement at the end.
  int refineRounds = 4;
  /// A point reprojecting worse than this (px, mean) is dropped.
  double maxPointError = 3;
};

[[nodiscard]] std::optional<Solve> solve(const FeatureTracks& tracks, const SolveOptions& opts);

/// The engine's camera angles (camera_solve.hpp: world→camera = Rz(−roll)·Rx(−pitch)·Ry(−yaw)), degrees.
struct Ypr {
  double yaw = 0;
  double pitch = 0;
  double roll = 0;
};
[[nodiscard]] Ypr r_to_ypr(const M3& R);

/// The least-squares plane through ≥ 3 points: centroid, unit normal, and the
/// largest distance of a point from the centroid (its size on the plane).
struct Plane {
  V3 centroid;
  V3 normal;
  double spread = 0;
};
[[nodiscard]] std::optional<Plane> fit_plane(const std::vector<V3>& pts);

/// The rotation taking unit vector `from` onto unit vector `to`.
[[nodiscard]] M3 rotation_between(const V3& from, const V3& to);

/// Project with a pose (nullopt behind the camera).
[[nodiscard]] std::optional<V2> project(const Pose& p, const V3& X, double f, double cx, double cy);

}  // namespace premation::jobs::camtrack
