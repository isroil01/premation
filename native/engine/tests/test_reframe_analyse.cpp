// analyse_frames: saliency points plus a histogram cut (autoReframe.ts).

#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <vector>

#include "reframe_analyse.hpp"

namespace rf = premation::jobs::reframe;

namespace {

premation::jobs::RgbaImage solid(std::uint8_t v) {
  premation::jobs::RgbaImage img;
  img.width = 8;
  img.height = 8;
  img.rgba.assign(static_cast<std::size_t>(8 * 8 * 4), v);
  for (std::size_t i = 3; i < img.rgba.size(); i += 4) img.rgba[i] = 255;
  return img;
}

}  // namespace

TEST_CASE("a hard cut is the first frame of the new shot", "[reframe]") {
  std::vector<premation::jobs::RgbaImage> frames;
  frames.reserve(48);
  for (int i = 0; i < 24; ++i) frames.push_back(solid(40));
  for (int i = 0; i < 24; ++i) frames.push_back(solid(220));
  const rf::Analysis a = rf::analyse_frames(frames);
  CHECK(a.points.size() == 48);
  REQUIRE(a.cuts.size() == 1);
  CHECK(a.cuts[0] == 24);
}

TEST_CASE("no frames is an empty analysis", "[reframe]") {
  const rf::Analysis a = rf::analyse_frames({});
  CHECK(a.points.empty());
  CHECK(a.cuts.empty());
}
