#include "reframe_path.hpp"

#include <algorithm>
#include <cmath>
#include <set>

#include "jsmath.hpp"

namespace premation::jobs::reframe {

double cover_scale(const Geometry& g) noexcept {
  if (!(g.sourceWidth > 0) || !(g.sourceHeight > 0)) return 1;
  return std::max(g.targetWidth / g.sourceWidth, g.targetHeight / g.sourceHeight);
}

Pan pan_range(const Geometry& g) noexcept {
  const double scale = cover_scale(g);
  const double scaledW = g.sourceWidth * scale;
  const double scaledH = g.sourceHeight * scale;
  return Pan{std::max(0.0, (scaledW - g.targetWidth) / 2), std::max(0.0, (scaledH - g.targetHeight) / 2)};
}

XYPath build_reframe_path(std::span<const Attention> samples, std::span<const int> cuts, const Geometry& g,
                          const PathOptions& options) {
  const Pan range = pan_range(g);
  std::set<int> cutSet(cuts.begin(), cuts.end());
  const double alpha = options.lagSeconds <= 0 || options.sampleRate <= 0
                           ? 1
                           : 1 - motion::js::exp(-1 / (options.lagSeconds * options.sampleRate));
  auto desired = [](double normalised, double axisRange) {
    return std::max(-axisRange, std::min(axisRange, -(normalised - 0.5) * 2 * axisRange));
  };
  XYPath out;
  out.x.reserve(samples.size());
  out.y.reserve(samples.size());
  double holdX = 0;
  double holdY = 0;
  double currentX = 0;
  double currentY = 0;
  bool started = false;
  for (std::size_t i = 0; i < samples.size(); ++i) {
    const Attention& sample = samples[i];
    const bool confident = sample.confidence >= options.confidenceFloor;
    const bool isCut = cutSet.contains(static_cast<int>(i)) || !started;
    if (confident) {
      const double targetX = desired(sample.x, range.x);
      const double targetY = desired(sample.y, range.y);
      if (isCut || std::abs(targetX - holdX) > range.x * options.deadZone) holdX = targetX;
      if (isCut || std::abs(targetY - holdY) > range.y * options.deadZone) holdY = targetY;
    }
    if (isCut) {
      currentX = holdX;
      currentY = holdY;
      started = true;
    } else {
      currentX += (holdX - currentX) * alpha;
      currentY += (holdY - currentY) * alpha;
    }
    out.x.push_back(currentX);
    out.y.push_back(currentY);
  }
  return out;
}

std::vector<PathKeyframe> path_to_keyframes(std::span<const double> path, std::span<const int> cuts, double sampleRate,
                                           double tolerance) {
  if (path.empty()) return {};
  if (path.size() == 1) return {PathKeyframe{0, path[0], PathEase::linear}};
  std::set<int> cutSet;
  for (const int c : cuts) {
    if (c > 0 && c < static_cast<int>(path.size())) cutSet.insert(c);
  }
  std::set<int> keep;
  keep.insert(0);
  keep.insert(static_cast<int>(path.size()) - 1);
  for (const int c : cutSet) {
    keep.insert(c - 1);
    keep.insert(c);
  }
  int anchor = 0;
  for (int i = 1; i < static_cast<int>(path.size()) - 1; ++i) {
    if (keep.contains(i)) {
      anchor = i;
      continue;
    }
    const int next = i + 1;
    const int span = next - anchor;
    if (span <= 0) continue;
    const double lerped = path[static_cast<std::size_t>(anchor)] +
                          (path[static_cast<std::size_t>(next)] - path[static_cast<std::size_t>(anchor)]) *
                              (static_cast<double>(i - anchor) / static_cast<double>(span));
    if (std::abs(path[static_cast<std::size_t>(i)] - lerped) > tolerance) {
      keep.insert(i);
      anchor = i;
    }
  }
  std::vector<PathKeyframe> out;
  out.reserve(keep.size());
  const double rate = sampleRate > 0 ? sampleRate : 1;
  for (const int i : keep) {
    PathKeyframe k;
    k.t = static_cast<double>(i) / rate;
    k.value = path[static_cast<std::size_t>(i)];
    k.easing = cutSet.contains(i + 1) ? PathEase::step : PathEase::linear;
    out.push_back(k);
  }
  return out;
}

}  // namespace premation::jobs::reframe
