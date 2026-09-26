// vegas.ts `extractAlphaContours` (marching squares over an alpha plane,
// chained into closed loops, each rotated to its canonical start) — shared by
// the Vegas effect (canvas_effects_generate.cpp) and the image-alpha puppet
// mesh (scene/alpha_mesh.cpp, alphaMesh.ts). Pure; Skia-free.
#pragma once

#include <cstdint>
#include <vector>

namespace premation::effects {

struct AlphaPt {
  double x, y;
};
using AlphaContour = std::vector<AlphaPt>;

/// `extractAlphaContours(alpha, w, h, threshold)`: contour coordinates in
/// cell-centre units ((0, 0) is the centre of the top-left sample).
[[nodiscard]] std::vector<AlphaContour> extract_alpha_contours(const std::vector<std::uint8_t>& alpha, int w, int h,
                                                               double threshold);

}  // namespace premation::effects
