// Roto Brush's matte arithmetic — src/core/tracking/rotoMatte.ts, grabCut.ts
// and the frame half of rotoBrush.ts, ported operation for operation (the
// Float32 stores where the TS has Float32Arrays, Math.round / Math.log through
// motion_jsmath). Mattes are one byte per pixel, 0 or 255 (the TS Uint8Array);
// pictures straight RGBA8, rows top-down. Pure.
#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

#include "scene/pixel_motion.hpp"

namespace premation::jobs::roto {

using Matte = std::vector<std::uint8_t>;

struct Seed {
  double x = 0;
  double y = 0;
  /// Max summed-RGB distance / 3 (rotoMatte.ts default 32).
  double tolerance = 32;
};

struct Pt {
  double x = 0;
  double y = 0;
};

/// `floodMatte(rgba, w, h, seeds)`.
[[nodiscard]] Matte flood_matte(std::span<const std::uint8_t> rgba, int w, int h, const std::vector<Seed>& seeds);
/// The most vertices `matte_to_path` writes (mask UX).
inline constexpr std::size_t kMaxPathPoints = 128;
/// The matte's outline: its largest outer contour walked in order (trace_bitmap,
/// threshold 128), in pixel-edge coordinates, at most kMaxPathPoints vertices.
/// A simple polygon. Empty when the matte holds less than a few pixels.
[[nodiscard]] std::vector<Pt> matte_to_path(const Matte& mask, int w, int h);
[[nodiscard]] Matte morph_dilate(const Matte& mask, int w, int h, double radius);
[[nodiscard]] Matte morph_erode(const Matte& mask, int w, int h, double radius);
[[nodiscard]] Matte morph_open(const Matte& mask, int w, int h, double radius);
[[nodiscard]] Matte morph_close(const Matte& mask, int w, int h, double radius);
/// `refineMatteEdge(rgba, mask, w, h, tol)`.
[[nodiscard]] Matte refine_matte_edge(std::span<const std::uint8_t> rgba, const Matte& mask, int w, int h, double tol = 28);
/// `softFeatherMask`: a box blur keeping the 0…255 ramp.
[[nodiscard]] Matte soft_feather_mask(const Matte& mask, int w, int h, double radius);
/// `refineRotoMatte`: open → close → colour-edge snap → soft feather → threshold at 128.
[[nodiscard]] Matte refine_roto_matte(std::span<const std::uint8_t> rgba, const Matte& mask, int w, int h, double morphRadius = 1,
                                      double featherPx = 2, double edgeTol = 28);

struct GrabCutOptions {
  double unknownRadius = 8;
  int iterations = 5;
  double featherPx = 0;
};
/// `grabCutMatte`.
[[nodiscard]] Matte grab_cut_matte(std::span<const std::uint8_t> rgba, int w, int h, const std::vector<Seed>& seeds,
                                   const GrabCutOptions& opts = {});

// ── rotoBrush.ts ────────────────────────────────────────────────────────
/// `blurMask`: a box blur re-thresholded at 128.
[[nodiscard]] Matte blur_mask(const Matte& mask, int w, int h, double radius);
/// `refineFrameMatte(rgba, mask, w, h, feather, seeds)`: GrabCut on the seeds fused with the propagated matte, refined.
[[nodiscard]] Matte refine_frame_matte(std::span<const std::uint8_t> rgba, const Matte& mask, int w, int h, double feather,
                                       const std::vector<Seed>& seeds);
/// `warpMatte(mask, w, h, flow, scaleX, scaleY)`: the matte carried by a forward flow.
[[nodiscard]] Matte warp_matte(const Matte& mask, int w, int h, const scene::pixmo::FlowField& flow, double scaleX, double scaleY);

// ── Propagation from every stroke ───────────────────────────────────────
/// Every seed moved by the forward flow (the same displacement warp_matte
/// carries the matte by), clamped to the picture.
void advect_seeds(std::vector<Seed>& seeds, const scene::pixmo::FlowField& flow, int w, int h);
/// The pixel-centre fill of a closed polygon (picture pixels): 255 inside.
[[nodiscard]] Matte fill_polygon(const std::vector<Pt>& poly, int w, int h);

struct Reseed {
  /// Pixels to add to the carried matte.
  Matte add;
  /// The foreground seeds it used: those inside the carried matte, else its centroid.
  std::vector<Seed> seeds;
};
/// A frame's colour re-seed: a flood from every foreground seed that still sits
/// inside the carried matte (its centroid when none does), less the floods of
/// the background seeds, so a background stroke keeps its region out.
[[nodiscard]] Reseed reseed_matte(std::span<const std::uint8_t> rgba, const Matte& carried, int w, int h,
                                  const std::vector<Seed>& fg, const std::vector<Seed>& bg, double tolerance);

}  // namespace premation::jobs::roto
