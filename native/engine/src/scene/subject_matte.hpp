// A layer's subjects combined into one matte as it is read (scene_textures.cpp
// subject_ref): each subject's stored frame (premultiplied RGBA8), mixed with
// its neighbouring frames (Temporal Smooth), its edge choked / feathered /
// steepened, inverted if asked, then the subjects united (the largest alpha
// wins, its colour kept). Pure: no files, no GPU.
#pragma once

#include <cstdint>
#include <span>
#include <utility>
#include <vector>

namespace premation::scene::subject_matte {

/// One decoded picture: premultiplied RGBA8, width × height.
struct Picture {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::span<const std::uint8_t> rgba;
};

/// One subject: its frame, the neighbours mixed in (weights sum below 1, the frame keeps the rest), its live edge.
struct Part {
  Picture frame;
  std::vector<std::pair<Picture, double>> blend;
  double feather = 0;   ///< px: the Gaussian's sigma is half of it
  double choke = 0;     ///< px: + shrinks, − grows
  double contrast = 0;  ///< 0–1
  bool invert = false;
  bool hidden = false;  ///< covers nothing
};

/// An alpha plane's edge: choked (square min / max of radius |choke|), feathered, steepened, inverted. In place.
void refine_alpha(std::vector<float>& a, std::uint32_t w, std::uint32_t h, double feather, double choke, double contrast, bool invert);

/// The parts united at the first visible part's size (others resampled to it), premultiplied RGBA8.
/// No part with a picture: empty. Every part hidden: a transparent picture of the first one's size.
[[nodiscard]] std::vector<std::uint8_t> combine(std::span<const Part> parts, std::uint32_t& width, std::uint32_t& height);

}  // namespace premation::scene::subject_matte
