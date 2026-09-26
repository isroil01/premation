// The comp-frame ↔ source-frame seam both tracker jobs share
// (trackVideoLayer.ts `srcIndexAt` / `compToSourceMap`, smoothStabilize.ts's
// copy of it), header-only.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>

#include "fail.hpp"
#include "job_inputs.hpp"
#include "jsmath.hpp"

namespace premation::jobs::trackframes {

/// A job range as composition frames: [first, last], half-open in API time
/// (`range.start` … `range.start + range.duration`, as the bake handler reads a range).
struct CompFrames {
  std::int64_t first = 0;
  std::int64_t last = -1;
};

[[nodiscard]] inline CompFrames comp_frames_of(const api::TimeRange& r, double fps) {
  const double f0 = motion::js::round(seconds_of(r.start) * fps);
  const double f1 = motion::js::round(seconds_of(r.start + r.duration) * fps) - 1;
  return CompFrames{static_cast<std::int64_t>(f0), static_cast<std::int64_t>(f1)};
}

/// `srcIndexAt(compFrame)`: comp frame → media seconds through the layer's
/// timing → the presentation frame showing at that time (+1 µs, the
/// fractional-boundary rule), clamped to the stream.
[[nodiscard]] inline std::int64_t source_index(const FootageLayer& fl, std::int64_t compFrame, double compFps,
                                               double sourceFps, std::int64_t frameCount) {
  if (frameCount <= 1 || !(sourceFps > 0)) return 0;
  const double mediaSec = fl.source_seconds(static_cast<double>(compFrame) / compFps);
  const double us = std::max(0.0, motion::js::round(mediaSec * 1e6) + 1);
  const double idx = std::floor(us * sourceFps / 1e6);
  return std::clamp(static_cast<std::int64_t>(idx), std::int64_t{0}, frameCount - 1);
}

/// A number for a summary: `digits` decimals, trailing zeros dropped.
[[nodiscard]] inline std::string fixed(double v, int digits) {
  if (!std::isfinite(v)) return "0";
  char buf[48];
  std::snprintf(buf, sizeof buf, "%.*f", digits, v);
  std::string s(buf);
  if (s.find('.') != std::string::npos) {
    while (!s.empty() && s.back() == '0') s.pop_back();
    if (!s.empty() && s.back() == '.') s.pop_back();
  }
  if (s == "-0") s = "0";
  return s;
}

}  // namespace premation::jobs::trackframes
