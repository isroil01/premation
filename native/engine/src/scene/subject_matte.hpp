// A layer's subjects combined into one matte as it is read (scene_textures.cpp
// subject_ref): each subject's stored frame (an alpha plane), mixed with its
// neighbouring frames (Temporal Smooth), its edge choked / feathered /
// steepened, inverted if asked, then the subjects united (the largest alpha
// wins). The result is coverage alone, written to every channel ((a, a, a, a),
// premultiplied white): the footage keeps its own colour and the composite
// applies the matte (fxx-omatte.wgsl, set-matte.wgsl).
//
// This is the CPU path. The render thread runs the same steps on the GPU
// (subject-edge.wgsl, scene_textures.cpp) following `edge_plan`, so the two
// agree to float rounding; this one serves without a device (tests, exports
// on a machine without one). Pure: no files, no GPU.
#pragma once

#include <cstdint>
#include <filesystem>
#include <span>
#include <utility>
#include <vector>

namespace premation::scene::subject_matte {

/// One decoded picture, width × height: an alpha plane (one byte per pixel —
/// stream B1's stored mattes), or a legacy premultiplied RGBA8 cut-out whose
/// alpha channel is read. Whichever is set.
struct Picture {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::span<const std::uint8_t> rgba;
  std::span<const std::uint8_t> alpha;
  [[nodiscard]] bool empty() const noexcept { return width == 0 || height == 0 || (rgba.empty() && alpha.empty()); }
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

/// One separable pass of the live edge, in texels: a Gaussian of `amount` sigma, or a square
/// min / max (erode / dilate) of `amount` radius — run along x, then along y.
struct EdgePass {
  enum class Kind : std::uint8_t { gauss, erode, dilate };
  Kind kind = Kind::gauss;
  double amount = 0;
};

/// The widest one pass goes: a morphology window of 2 × 32 + 1, a Gaussian of sigma 16
/// (3 sigma = 48 taps a side). Wider edges are several passes (a dilation composes by
/// radius, a Gaussian by variance), so no pass loops past ~100 taps.
inline constexpr double kMaxMorphRadius = 32;
inline constexpr double kMaxGaussSigma = 16;
/// Below this sigma the blur is a no-op (one texel of weight, nothing to spread).
inline constexpr double kMinGaussSigma = 0.1;

/// The passes a live edge takes: the choke first (whole texels, |choke| rounded), then the
/// feather (sigma = feather / 2). Empty when both are neutral.
[[nodiscard]] std::vector<EdgePass> edge_plan(double feather, double choke);

/// An alpha plane's edge: choked, feathered (`edge_plan`), steepened, inverted. In place.
void refine_alpha(std::vector<float>& a, std::uint32_t w, std::uint32_t h, double feather, double choke, double contrast, bool invert);
/// One pass of `edge_plan` over a plane, along x then y (the ends extended by their own values).
void run_pass(std::vector<float>& a, std::uint32_t w, std::uint32_t h, const EdgePass& pass);
/// The contrast curve and the invert alone (what the GPU's finishing pass applies).
[[nodiscard]] float finish_alpha(float v, double contrast, bool invert) noexcept;

/// The parts united at the first visible part's size (others resampled to it): coverage in every
/// channel, premultiplied RGBA8 (a, a, a, a). No part with a picture: empty. Every part hidden: a
/// transparent picture of the first one's size.
[[nodiscard]] std::vector<std::uint8_t> combine(std::span<const Part> parts, std::uint32_t& width, std::uint32_t& height);

/// A decoded file's alpha plane: a grey (alpha-only) picture's first channel, a cut-out's alpha.
[[nodiscard]] std::vector<std::uint8_t> alpha_plane(std::span<const std::uint8_t> rgba, std::uint32_t w, std::uint32_t h, bool gray);

/// Whether a PNG on disk is greyscale (colour type 0 or 4: an alpha-only matte, stream B1) —
/// read from its header alone. A file that is not a PNG, or cannot be read: false.
[[nodiscard]] bool png_is_gray(const std::filesystem::path& p);
/// The same for a PNG's bytes in memory (a `data:` URL's, decoded).
[[nodiscard]] bool png_bytes_gray(std::span<const std::uint8_t> bytes) noexcept;

}  // namespace premation::scene::subject_matte
