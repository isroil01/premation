// Scene Edit Detection — port of src/core/tracking/sceneEditDetect.ts (the
// reference): 64-bin luma histograms, L1 distances between consecutive
// frames, cuts by an adaptive (local-median) threshold, dissolves as runs of
// small consistent steps. Pure: luma planes in, first-of-shot frame indices out.
#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <vector>

#include "media_input.hpp"

namespace premation::jobs::scene_detect {

inline constexpr int kBins = 64;
using Histogram = std::array<float, kBins>;

struct Options {
  double sensitivity = 5;
  double floor = 0.3;
  int window = 12;
  int minShotFrames = 6;
  bool dissolves = true;
  int maxDissolveFrames = 30;
};

[[nodiscard]] Histogram luma_histogram(const LumaImage& plane);
[[nodiscard]] double histogram_distance(const Histogram& a, const Histogram& b);
[[nodiscard]] std::vector<std::int64_t> cuts_from_distances(const std::vector<double>& distances, const Options& o);
[[nodiscard]] std::vector<std::int64_t> dissolves_from_distances(const std::vector<double>& distances,
                                                                 const std::function<double(std::int64_t, std::int64_t)>& direct,
                                                                 const Options& o, const std::vector<std::int64_t>& knownCuts);

struct WalkResult {
  std::vector<std::int64_t> cuts;          ///< first-of-shot SOURCE frames, ascending (dissolve midpoints included)
  std::vector<std::int64_t> dissolveCuts;  ///< the dissolve midpoints among them
  std::vector<double> distances;
  bool cancelled = false;
};

/// walkSceneEdits: frames [from, to] pulled strictly in order through `frameAt`
/// (false = stop, e.g. a decode error / cancel); `progress(fraction)` returns false to cancel.
[[nodiscard]] WalkResult walk(std::int64_t from, std::int64_t to, const Options& o,
                              const std::function<bool(std::int64_t, LumaImage&)>& frameAt,
                              const std::function<bool(double)>& progress);

}  // namespace premation::jobs::scene_detect
