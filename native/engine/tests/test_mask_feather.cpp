// Variable (per-vertex) mask feather — raster/mask_paint.cpp
// variable_feather_alpha, the pure core of maskFeather.ts: the ramp straddles
// the outline, its width follows the nearest outline sample, and pixels far
// from the edge keep their hard coverage.
#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <vector>

#include "mask_paint.hpp"

using premation::raster::FeatherSample;
using premation::raster::variable_feather_alpha;

namespace {

/// A 64×32 matte, hard-covered left of x = 32, with samples on that edge
/// whose feather is `top` at y = 0 and `bottom` at y = 32.
struct Edge {
  int w = 64;
  int h = 32;
  std::vector<std::uint8_t> coverage;
  std::vector<FeatherSample> samples;
  Edge(double top, double bottom) : coverage(static_cast<std::size_t>(64 * 32), 0) {
    for (int y = 0; y < h; ++y) {
      for (int x = 0; x < 32; ++x) coverage[static_cast<std::size_t>(y * w + x)] = 255;
    }
    for (int i = 0; i <= 64; ++i) {
      const double t = i / 64.0;
      samples.push_back({32, t * 32, top + (bottom - top) * t});
    }
  }
  [[nodiscard]] std::uint8_t at(const std::vector<std::uint8_t>& a, int x, int y) const {
    return a[static_cast<std::size_t>(y * w + x)];
  }
};

}  // namespace

TEST_CASE("variable feather: no feather keeps the hard coverage", "[raster][mask]") {
  const Edge e(0, 0);
  const auto out = variable_feather_alpha(e.coverage, e.w, e.h, e.samples, 0);
  CHECK(out == e.coverage);
}

TEST_CASE("variable feather: the ramp widens where the vertex feather grows", "[raster][mask]") {
  const Edge e(2, 20);
  const auto out = variable_feather_alpha(e.coverage, e.w, e.h, e.samples, 20);
  // Deep inside and far outside stay as they were.
  CHECK(e.at(out, 2, 16) == 255);
  CHECK(e.at(out, 62, 16) == 0);
  // Near the top (narrow feather) the edge is sharp: 4 px out is already clear.
  CHECK(e.at(out, 36, 1) == 0);
  // Near the bottom (wide feather) 4 px outside is still partly covered,
  // and 4 px inside is partly transparent.
  CHECK(e.at(out, 36, 30) > 20);
  CHECK(e.at(out, 27, 30) < 250);
  // The ramp is monotonic across the edge.
  for (int x = 20; x < 44; ++x) CHECK(e.at(out, x, 30) >= e.at(out, x + 1, 30));
}

TEST_CASE("variable feather: deterministic", "[raster][mask]") {
  const Edge e(4, 12);
  CHECK(variable_feather_alpha(e.coverage, e.w, e.h, e.samples, 12) == variable_feather_alpha(e.coverage, e.w, e.h, e.samples, 12));
}
