// The planar tracker (AE parity 3.4, Mocha class): a REGION of a flat
// surface tracked as one homography per frame, not as four points.
//
// At the origin frame the region (a quad) is filled with features
// (track_feature.hpp: Shi-Tomasi corners, spread out, inside the quad and
// outside every exclusion polygon). Each frame every feature is matched from
// the previous frame (chained), then re-matched against its own anchor patch
// near that spot so the walk does not drift; RANSAC fits the homography from
// the origin frame to this one over everything that agrees, and a least
// squares pass over the inliers refines it. Features lost to occlusion,
// leaving the frame or falling under an exclusion are re-predicted through
// the homography; when too few survive, new ones are found inside the
// projected region. The walk stops (status lost) when the plane can no
// longer be fitted with confidence.
//
// The SURFACE (AE / Mocha "surface adjust") is a second quad in the origin
// frame — where the insert goes — independent of the region that is tracked;
// its corners ride the homography. Pure: luma planes in, homographies out.
#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <span>
#include <vector>

#include "tracking.hpp"

namespace premation::jobs::planar {

using Poly = std::vector<tracking::Pt>;
using Polys = std::vector<Poly>;

struct Spec {
  /// The tracked region, origin-frame px (TL, TR, BR, BL; any simple quad).
  std::array<tracking::Pt, 4> region{};
  int featureHalf = 7;
  int searchHalf = 20;
  int maxFeatures = 96;
  /// Inliers ÷ live features below this (or fewer than 8 inliers): the plane is lost.
  double minInlierRatio = 0.3;
  /// RANSAC inlier distance, px.
  double inlierPx = 2.5;
};

/// Exclusion polygons at a frame (px of that frame).
using ExcludeAt = std::function<Polys(std::int64_t frame)>;

struct FrameH {
  std::int64_t frame = 0;
  /// Origin frame px → this frame px.
  tracking::Mat3 H{};
  int inliers = 0;
  int features = 0;
};

struct Result {
  std::vector<FrameH> frames;  ///< walk order, the origin first
  tracking::TrackStatus status = tracking::TrackStatus::completed;
};

[[nodiscard]] bool point_in_poly(tracking::Pt p, std::span<const tracking::Pt> poly) noexcept;

/// Features for the region: corners inside `quad`, at least `half` px from its
/// edges, outside every exclusion polygon, up to `count`, spread over the region.
[[nodiscard]] std::vector<tracking::Pt> region_features(const tracking::LumaPlane& plane, std::span<const tracking::Pt> quad,
                                                        const Polys& exclude, int count, int half);

/// Walk `from` → `to` (descending when to < from).
[[nodiscard]] Result track_planar(const tracking::FrameAt& frameAt, std::int64_t from, std::int64_t to, const Spec& spec,
                                  const ExcludeAt& excludeAt, const tracking::OnProgress& onProgress);

/// The identity homography.
[[nodiscard]] tracking::Mat3 identity() noexcept;

}  // namespace premation::jobs::planar
