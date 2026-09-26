// Footage pixel kernels the TypeScript texture feed runs on the CPU (D2w
// time/comp: "Pixel Motion frame blending"; Interpret Footage ▸ Fields):
//
//   pixelMotionFlow.ts   lumaIntOf, searchAllCells, finalizeFlow, computeFlow,
//                        sampleFlow, warpBlend — block-matched optical flow on
//                        a grid and the symmetric warp-and-blend at weight t.
//                        The search is integer (SADs over integer luma), the
//                        finalize / warp float64 with the typed arrays' float32
//                        and Uint8Clamped stores, so every output byte matches.
//   deinterlace.ts       deinterlaceData — keep one field, rebuild the other
//                        as the rounded average of its neighbours.
//
// Pure (no canvas): the frame side — the downscale the flow runs at, the two
// decoded bracket frames, the texture the in-between lands in — is the
// caller's (the media feed, where the decoded frames live).
//
// Pinned by tests/data/pixel_motion_parity.json (pixelMotionCrossEngine.test.ts).
#pragma once

#include <cstdint>
#include <span>
#include <string_view>
#include <vector>

namespace premation::scene::pixmo {

struct FlowField {
  int cols = 0;
  int rows = 0;
  int step = 0;
  std::vector<float> dx, dy;        ///< per grid point, flow-resolution px (smoothed)
  std::vector<std::uint8_t> valid;  ///< 1 where the block measured motion
};

struct FlowOptions {
  double step = 8;
  double blockRadius = 3;
  double searchRadius = 10;
  double minImprovement = 0.06;
};

/// `resolveFlowOptions`: max(4, step), max(2, blockRadius), max(2, searchRadius).
struct ResolvedFlowOptions {
  int step = 8, r = 3, s = 10;
  double minImp = 0.06;
};
[[nodiscard]] ResolvedFlowOptions resolve_flow_options(const FlowOptions& o);

/// `SEARCH_STRIDE`: [zero, best, bx, by, cxm, cxp, cym, cyp] per cell.
inline constexpr std::size_t kSearchStride = 8;

/// `lumaIntOf`: 77 R + 150 G + 29 B per pixel.
[[nodiscard]] std::vector<std::int32_t> luma_int_of(std::span<const std::uint8_t> rgba, int w, int h);
/// `searchAllCells`.
[[nodiscard]] std::vector<double> search_all_cells(std::span<const std::int32_t> a, std::span<const std::int32_t> b, int w, int h,
                                                   int step, int r, int s, double minImp);
/// `finalizeFlow`.
[[nodiscard]] FlowField finalize_flow(std::span<const double> raw, int cols, int rows, int step, double minImp);
/// `computeFlow(lumA, lumB, w, h, opts)`.
[[nodiscard]] FlowField compute_flow(std::span<const std::int32_t> a, std::span<const std::int32_t> b, int w, int h,
                                     const FlowOptions& opts = {});
/// `warpBlend(a, b, w, h, flow, flowScaleX, flowScaleY, t, out)`; `out` is w·h·4 bytes.
void warp_blend(std::span<const std::uint8_t> a, std::span<const std::uint8_t> b, int w, int h, const FlowField& flow,
                double flowScaleX, double flowScaleY, double t, std::span<std::uint8_t> out);

/// `deinterlaceData(data, w, h, keep)` in place; `keepUpper` = 'upper'.
void deinterlace_data(std::span<std::uint8_t> rgba, int w, int h, bool keepUpper);

/// A Uint8ClampedArray store (ToUint8Clamp: NaN → 0, clamp, round half to even).
[[nodiscard]] std::uint8_t to_uint8_clamp(double v) noexcept;

}  // namespace premation::scene::pixmo
