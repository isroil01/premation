#include "core/aep/aep_ease.hpp"

#include <cmath>
#include <optional>

namespace premation::doc::aep {

namespace {

double clamp01(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
/// A handle component AE could produce but the engine cannot sample.
double finite(double v) { return std::isfinite(v) ? v : 0; }

/// `a[dim] ?? a[0] ?? 0`.
double pick(const std::vector<double>& a, std::size_t dim) {
  if (dim < a.size()) return a[dim];
  return a.empty() ? 0 : a[0];
}
double at_or_zero(const std::vector<double>& a, std::size_t dim) { return dim < a.size() ? a[dim] : 0; }

/// AE marks a corner vertex by zero tangents; the engine has an explicit mode for it.
std::optional<api::SpatialInterp> spatial_interp_of(const AepKeyframe& kf, std::size_t dim) {
  if (!kf.inTangent && !kf.outTangent) return std::nullopt;
  if (kf.spatialAutoBezier) return api::SpatialInterp::auto_;
  const double si = kf.inTangent ? at_or_zero(*kf.inTangent, dim) : 0;
  const double so = kf.outTangent ? at_or_zero(*kf.outTangent, dim) : 0;
  if (si == 0 && so == 0) return api::SpatialInterp::linear;
  return kf.spatialContinuous ? api::SpatialInterp::continuous : api::SpatialInterp::bezier;
}

/// Hold wins outright; linear on both sides stays linear (the timeline draws the two differently).
api::Easing easing_of(const AepKeyframe& from, const AepKeyframe* to) {
  if (from.outInterp == Interp::hold) return api::Easing::hold;
  if (to == nullptr) return api::Easing::linear;
  if (from.outInterp == Interp::linear && to->inInterp == Interp::linear) return api::Easing::linear;
  return api::Easing::bezier;
}

}  // namespace

std::array<double, 4> segment_bezier(const AepKeyframe& from, const AepKeyframe& to, std::size_t dim) {
  const double dt = to.time - from.time;
  const double dv = at_or_zero(to.value, dim) - at_or_zero(from.value, dim);
  const double outInfluence = clamp01(pick(from.outInfluence, dim));
  const double inInfluence = clamp01(pick(to.inInfluence, dim));
  const double x1 = outInfluence;
  const double x2 = 1 - inInfluence;
  if (dv == 0 || dt == 0) return {x1, x1, x2, x2};
  const double outSpeed = pick(from.outSpeed, dim);
  const double inSpeed = pick(to.inSpeed, dim);
  const double y1 = finite((outSpeed * dt) / dv) * outInfluence;
  const double y2 = 1 - finite((inSpeed * dt) / dv) * inInfluence;
  return {x1, finite(y1), x2, finite(y2)};
}

std::vector<Key> to_keyframe_track(const std::vector<AepKeyframe>& keyframes, std::size_t dim, const ConvertOptions& opts) {
  std::vector<Key> out;
  out.reserve(keyframes.size());
  for (std::size_t i = 0; i < keyframes.size(); ++i) {
    const AepKeyframe& kf = keyframes[i];
    const AepKeyframe* next = i + 1 < keyframes.size() ? &keyframes[i + 1] : nullptr;
    Key k;
    k.t = kf.time + opts.timeOffset;
    k.value = at_or_zero(kf.value, dim) * opts.scale + opts.offset;
    k.easing = easing_of(kf, next);
    if (k.easing == api::Easing::bezier && next != nullptr) k.bezier = segment_bezier(kf, *next, dim);
    if (kf.temporalContinuous) k.continuous = true;
    // An end keyframe cannot rove.
    if (kf.roving && i > 0 && next != nullptr) k.roving = true;
    if (const auto spatial = spatial_interp_of(kf, dim)) {
      k.spatial = *spatial;
      if (kf.inTangent) k.si = at_or_zero(*kf.inTangent, dim) * opts.scale;
      if (kf.outTangent) k.so = at_or_zero(*kf.outTangent, dim) * opts.scale;
    }
    out.push_back(std::move(k));
  }
  return out;
}

}  // namespace premation::doc::aep
