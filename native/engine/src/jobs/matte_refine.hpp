// Soft mattes (AE parity 3.1 / 3.2): what the video Object Matte does to a
// segmentation between the model and the stored frame. Alpha planes are
// floats in [0, 1], one per pixel, rows top-down; pictures straight RGBA8.
//
//   soft_mask          the decoder's 256² logits → a frame-size soft matte
//                      (bilinear in logit space, then the logistic), not a
//                      thresholded outline;
//   guided_filter      He et al.'s guided filter: the matte follows the
//                      picture's own edges inside a radius (Refine Edge: hair,
//                      fur, motion-blurred edges);
//   decontaminate      the edge colours with the background's colour taken
//                      out (F = (I − (1 − α)·B) / α, B estimated from the
//                      nearby background), blended by `amount`;
//   motion_blur        the matte smeared along the motion (flow) over the
//                      shutter, as a camera would have;
//   choke_feather      AE's Choke (−100…100 %) and Feather (px);
//   warp_by_flow       the previous frame's matte carried onto this frame;
//   seeds_from_matte   prompts for the next frame: points deep inside the
//                      matte, points just outside it, and its box;
//   cutout             the picture × matte, the stored frame.
//
// Pure and deterministic.
#pragma once

#include <cstdint>
#include <span>
#include <vector>

#include "pixel_motion.hpp"
#include "sam_pipeline.hpp"

namespace premation::jobs::matte {

[[nodiscard]] std::vector<float> soft_mask(std::span<const float> logits, std::size_t offset, std::uint32_t width, std::uint32_t height,
                                           double scale);

/// Refine `p` (the matte) guided by `I` (luma, 0…1); radius px, eps regularisation (≈ 1e-4 … 1e-2).
[[nodiscard]] std::vector<float> guided_filter(std::span<const float> p, std::span<const float> I, int width, int height, int radius,
                                               double eps);

/// The guided filter with the picture's COLOUR as the guide (straight RGBA8): the matte follows
/// an edge between two colours of the same brightness too, which the luma guide cannot see.
[[nodiscard]] std::vector<float> guided_filter_rgb(std::span<const float> p, std::span<const std::uint8_t> rgba, int width, int height,
                                                   int radius, double eps);

/// Edge snap: a model matte (its edge traced on the model's coarse grid) moved onto the
/// picture's own edge at full resolution — inside a band of `radius` px around its 0.5
/// crossing the matte is the colour guided filter of itself; elsewhere it is untouched, so
/// nothing far from the subject's edge can bleed in. `radius` ≈ one model cell in frame px.
[[nodiscard]] std::vector<float> snap_edge(std::span<const float> alpha, std::span<const std::uint8_t> rgba, int width, int height, int radius);

/// Rec.601 luma in [0, 1] from straight RGBA8.
[[nodiscard]] std::vector<float> luma(std::span<const std::uint8_t> rgba, int width, int height);

/// Remove the background's colour from edge pixels (0 < α < 1), in place.
void decontaminate(std::span<std::uint8_t> rgba, std::span<const float> alpha, int width, int height, double amount);

/// Smear the matte along `flow` (px per frame, the motion INTO this frame) over `shutterAngle` degrees.
[[nodiscard]] std::vector<float> motion_blur(std::span<const float> alpha, const scene::pixmo::FlowField& flow, int width, int height,
                                             double shutterAngle);

/// Choke: −100…100 % (positive shrinks); feather: Gaussian px.
void choke_feather(std::vector<float>& alpha, int width, int height, double chokePercent, double featherPx);

/// The previous matte moved by `flow` (from the previous frame into this one).
[[nodiscard]] std::vector<float> warp_by_flow(std::span<const float> prev, const scene::pixmo::FlowField& flow, int width, int height);

struct Seeds {
  std::vector<sam::Point> points;  ///< foreground (label 1) and background (label 0)
  sam::Box box;
  bool empty = true;
};

/// Up to `maxFg` points spread over the matte's interior (deepest first),
/// `maxBg` points in a ring just outside it (marched from its deepest point),
/// and its bounds.
[[nodiscard]] Seeds seeds_from_matte(std::span<const float> alpha, int width, int height, int maxFg = 4, int maxBg = 4);

/// seeds_from_matte on the matte box-filtered to at most `maxEdge` px on its
/// long side (a walk calls it per frame; the distance transforms are the cost),
/// the seeds scaled back to frame px. The same matte under `maxEdge` is seeded as is.
[[nodiscard]] Seeds seeds_from_matte_fast(std::span<const float> alpha, int width, int height, int maxEdge = 512, int maxFg = 4, int maxBg = 4);

/// The stored frame: the picture with the matte as its alpha (straight).
[[nodiscard]] std::vector<std::uint8_t> cutout(std::span<const std::uint8_t> rgba, std::span<const float> alpha, int width, int height);

}  // namespace premation::jobs::matte
