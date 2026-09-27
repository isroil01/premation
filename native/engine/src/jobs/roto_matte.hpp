// Roto Brush's matte arithmetic — src/core/tracking/rotoMatte.ts, grabCut.ts
// and the frame half of rotoBrush.ts, ported operation for operation (the
// Float32 stores where the TS has Float32Arrays, Math.round / Math.log through
// motion_jsmath). Mattes are one byte per pixel, 0 or 255 (the TS Uint8Array);
// pictures straight RGBA8, rows top-down. Pure.
#pragma once

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
/// `matteToPath`: the boundary texel centres in raster order, decimated to ≤ 128.
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
/// `refineFrameMatte(rgba, mask, w, h, feather, seed)`: GrabCut on the seed fused with the propagated matte, refined.
[[nodiscard]] Matte refine_frame_matte(std::span<const std::uint8_t> rgba, const Matte& mask, int w, int h, double feather,
                                       const Seed& seed);
/// `warpMatte(mask, w, h, flow, scaleX, scaleY)`: the matte carried by a forward flow.
[[nodiscard]] Matte warp_matte(const Matte& mask, int w, int h, const scene::pixmo::FlowField& flow, double scaleX, double scaleY);

}  // namespace premation::jobs::roto
