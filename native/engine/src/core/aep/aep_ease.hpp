// After Effects easing → this editor's bezier handles (src/core/aep/aepEase.ts).
//
// AE stores, per keyframe and dimension, a SPEED (value units per second) and
// an INFLUENCE (0–1 of the segment), not a curve. For a segment A → B with
// dt = tB − tA and dv = vB − vA:
//
//     x1 = A.outInfluence                       x2 = 1 − B.inInfluence
//     y1 = A.outSpeed · dt/dv · A.outInfluence  y2 = 1 − B.inSpeed · dt/dv · B.inInfluence
//
// dv = 0 is not an error: the handles collapse to a straight ramp (dividing
// anyway yields NaN, which would blank the layer).
#pragma once

#include <array>
#include <vector>

#include "core/aep/aep_model.hpp"
#include "model.hpp"

namespace premation::doc::aep {

/// `segmentBezier(from, to, dim)`: [x1, y1, x2, y2].
[[nodiscard]] std::array<double, 4> segment_bezier(const AepKeyframe& from, const AepKeyframe& to, std::size_t dim);

struct ConvertOptions {
  /// Added to every keyframe time.
  double timeOffset = 0;
  /// Multiplies every value (and tangent).
  double scale = 1;
  /// Added to every value after scaling (never to a tangent: a tangent is a difference).
  double offset = 0;
};

/// `toKeyframeTrack(keyframes, dim, opts)`: one dimension → an engine keyframe track (ids unstamped).
[[nodiscard]] std::vector<Key> to_keyframe_track(const std::vector<AepKeyframe>& keyframes, std::size_t dim,
                                                 const ConvertOptions& opts = {});

}  // namespace premation::doc::aep
