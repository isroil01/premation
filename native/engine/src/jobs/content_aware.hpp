// Content-Aware Fill's picture arithmetic — src/core/effects/contentAwareFill.ts,
// ported operation for operation (the uint32 PRNG, Math.imul, and
// Uint8ClampedArray stores). Pictures are straight RGBA8, rows top-down.
// Pure: no ffmpeg, no document.
#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <vector>

namespace premation::jobs::caf {

struct InpaintOptions {
  /// Patch half-size (default 4 → 9×9).
  int patchHalf = 4;
  /// Random-search iterations per pixel.
  int iterations = 4;
  /// PRNG seed. Unset uses `holeCount * 2654435761` (the TS default).
  std::optional<std::uint32_t> seed;
};

/// `inpaintPatchMatch`. Fills `rgba` where `hole[i] != 0`. Returns the hole count
/// (0 when there is nothing to fill or nothing to copy from).
[[nodiscard]] int inpaint_patch_match(std::span<std::uint8_t> rgba, int width, int height, std::span<const std::uint8_t> hole,
                                      const InpaintOptions& opts = {});

/// `propagateFillFrame`: warp `prev` into `next`'s hole by block flow, then
/// re-inpaint whatever the warp could not cover. `hole` is cleared where the
/// warp wrote. Returns the residual pixels sent to PatchMatch.
/// `opts.iterations` is used as given (the page passes 4; an omitted bag is 5).
[[nodiscard]] int propagate_fill_frame(std::span<const std::uint8_t> prev, std::span<std::uint8_t> next, int width, int height,
                                       std::span<std::uint8_t> hole, const InpaintOptions& opts = {});

struct Poly {
  std::vector<std::pair<double, double>> points;
};

/// `maskToHole`: a pixel is in the hole when it sits inside any polygon.
/// Polygons are already in picture pixels.
void raster_hole(std::span<std::uint8_t> hole, int width, int height, std::span<const Poly> polys);

/// `propagateFillBidirectional`. `frames[i]` is RGBA of length width*height*4;
/// `holes[i]` is one byte per pixel. Returns the count of PatchMatch fills.
[[nodiscard]] int propagate_fill_bidirectional(std::vector<std::vector<std::uint8_t>>& frames, int width, int height,
                                              std::vector<std::vector<std::uint8_t>>& holes, const InpaintOptions& opts = {});

}  // namespace premation::jobs::caf
