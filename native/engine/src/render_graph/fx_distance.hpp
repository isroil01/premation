// E4: alpha distance fields for the styles, on the GPU — jump flooding (Rong &
// Tan 2006, "1+JFA": one extra unit step) over the chain buffer's alpha.
//
// The field is what makes a stroke or a spread O(1) per pixel: the reference
// STROKE_MATERIAL takes the max / min alpha over a disc of the stroke width
// (up to 129² taps a pixel at the 64 px cap), the field answers the same
// question — the disc dilation / erosion of the ½-contour — with one load.
//
//   seed     inside texels (alpha ≥ ½) seed the "nearest inside" offset, outside
//            texels the "nearest outside" one (rgba16float: two offsets)
//   flood    log2(range) passes of 9 taps at halving steps, then a unit step
//   resolve  r = signed distance to the ½-contour in texels (+ outside), with the
//            texel's own alpha placing the edge inside a contour texel (so the
//            dilation of the field by 0 gives back the alpha: antialiased);
//            g = that alpha
//
// Offsets are texel integers: rgba16float holds them exactly up to 2048, and
// the flood never needs more than the requested range (≤ kMaxSdfRange).
// Beyond the range the distance is only a lower bound — a style asks for its
// own reach plus a margin.
#pragma once

#include <cstdint>

#include "render_context.hpp"

namespace premation::rg {

/// The deepest field a style may ask for, texels (Stroke Size's UI maximum is 100).
inline constexpr double kMaxSdfRange = 256;

struct DistanceField {
  TexRef tex;  ///< r = signed distance (texels, + outside), g = alpha; empty = not built
  bool reused = false;
};

/// The distance field of `src`'s alpha, exact to `range` texels. `key` ≠ 0:
/// the chain input's content key (see fx_cache.hpp) — a field built from the
/// same content at least as deep is reused, and a new one is kept.
[[nodiscard]] DistanceField distance_field(PassContext& ctx, const TexRef& src, double range, std::uint64_t key);

/// Draw `cmds` into a Device target that is not a declared graph target
/// (the persistent field slots), cleared first.
void draw_to_target(PassContext& ctx, RenderTarget& t, const Commands& cmds);

}  // namespace premation::rg
