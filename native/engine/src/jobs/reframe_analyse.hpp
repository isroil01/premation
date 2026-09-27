// Auto-reframe's look-at-the-frames pass — the pure half of
// src/core/reframe/autoReframe.ts analyseComposition. Pixels in (the small
// render is the caller's), attention points and shot-change indices out.
#pragma once

#include <vector>

#include "media_input.hpp"
#include "reframe_path.hpp"

namespace premation::jobs::reframe {

struct Analysis {
  std::vector<Attention> points;
  /// Sample indices that begin a shot (scene_detect::cuts_from_distances).
  std::vector<int> cuts;
};

[[nodiscard]] Analysis analyse_frames(const std::vector<RgbaImage>& frames);

}  // namespace premation::jobs::reframe
