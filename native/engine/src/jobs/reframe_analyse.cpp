#include "reframe_analyse.hpp"

#include "saliency.hpp"
#include "scene_detect.hpp"

namespace premation::jobs::reframe {

Analysis analyse_frames(const std::vector<RgbaImage>& frames) {
  Analysis out;
  const std::vector<float>* previous = nullptr;
  std::vector<float> held;
  scene_detect::Histogram prevHist{};
  bool haveHist = false;
  std::vector<double> distances;
  distances.reserve(frames.size());
  out.points.reserve(frames.size());
  for (const RgbaImage& frame : frames) {
    if (frame.width == 0 || frame.height == 0 || frame.rgba.size() < static_cast<std::size_t>(frame.width) * frame.height * 4U) continue;
    saliency::FrameAnalysis seen = saliency::analyse_frame(frame.rgba, previous, frame.width, frame.height);
    out.points.push_back(Attention{seen.point.x, seen.point.y, seen.point.confidence});
    LumaImage plane;
    plane.width = frame.width;
    plane.height = frame.height;
    plane.data = seen.luma;
    const scene_detect::Histogram hist = scene_detect::luma_histogram(plane);
    if (haveHist) distances.push_back(scene_detect::histogram_distance(prevHist, hist));
    prevHist = hist;
    haveHist = true;
    held = std::move(seen.luma);
    previous = &held;
  }
  const std::vector<std::int64_t> cuts = scene_detect::cuts_from_distances(distances, {});
  for (const std::int64_t c : cuts) {
    if (c < 0 || static_cast<std::uint64_t>(c) >= out.points.size()) continue;
    out.cuts.push_back(static_cast<int>(c));
  }
  return out;
}

}  // namespace premation::jobs::reframe
