// One-click feature picking (AE parity 3.6) — src/core/tracking/autoFeature.ts
// and autoTrack.ts planTrack / pickCompanion / measureMotion as they were
// before the TypeScript engine was deleted (5ed830eb^), ported to the engine:
//
//   strength      Shi-Tomasi minimum eigenvalue of the windowed structure
//                 tensor (integral images over the scanned region);
//   distinctness  the patch correlated against rings of its neighbourhood —
//                 a periodic texture's rival peak is what a tracker jumps to;
//   scale         the smallest window within 25 % of the best strength;
//   refine        a Gaussian-weighted tensor moves the box-window candidate
//                 onto the corner itself;
//   search        sized from the feature's own measured motion, corroborated
//                 over one and two frames;
//   companion     a second feature on the same surface, for rotation/scale.
//
// Pure: luma planes ([0, 1]) in, plain structs out.
#pragma once

#include <optional>
#include <span>
#include <vector>

#include "tracking.hpp"

namespace premation::jobs::feature {

struct Candidate {
  double x = 0;
  double y = 0;
  /// Shi-Tomasi min-eigenvalue per pixel of window, on a 0..1 luma scale.
  double strength = 0;
  /// 1 = nothing nearby looks like it; → 0 = a rival sits in the search window.
  double distinctness = 1;
  /// strength × distinctness × proximity.
  double score = 0;
};

struct Region {
  int x0 = 0;
  int y0 = 0;
  int x1 = 0;
  int y1 = 0;
};

struct PickOptions {
  std::optional<tracking::Pt> hint;
  /// Search radius around the hint; default 12 % of the short side (≥ 48).
  std::optional<double> radius;
  int margin = 24;
};

[[nodiscard]] double distinctness_at(const tracking::LumaPlane& plane, double x, double y, int half, double radius);

[[nodiscard]] int suggest_feature_half(const tracking::LumaPlane& plane, double x, double y);

/// The best feature near the hint; nullopt when nothing there is trackable.
[[nodiscard]] std::optional<Candidate> pick_feature(const tracking::LumaPlane& plane, const PickOptions& opts = {});

/// Up to `count` features spread across the frame (or `within`), one per tile.
[[nodiscard]] std::vector<Candidate> pick_features(const tracking::LumaPlane& plane, int count, int margin = 24, int tile = 256,
                                                   std::optional<Region> within = std::nullopt);

struct Plan {
  double x = 0;
  double y = 0;
  int featureHalf = 8;
  int searchHalf = 20;
  /// Measured px/frame; nullopt when it could not be corroborated.
  std::optional<double> motionPerFrame;
  Candidate feature;
  std::optional<Candidate> companion;
};

/// autoTrack.ts planTrack: `probes` are the frames after the anchor (0–2).
[[nodiscard]] std::optional<Plan> plan_track(const tracking::LumaPlane& anchor, std::span<const tracking::LumaPlane> probes,
                                             const PickOptions& opts = {});

}  // namespace premation::jobs::feature
