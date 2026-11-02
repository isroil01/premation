// How far a layer's effect chain reaches on screen — After Effects' grow
// bounds. Each chain entry widens the region its input covers by what its
// passes can touch: a blur by its kernel's last tap, a drop shadow by its
// offset plus softness, a glow by its radius, a stroke by its width. The chain
// scissors its passes to that region (effect_chain.cpp), so a small layer's
// blur costs its own area instead of the whole frame.
//
// A reach is exact or larger, never smaller: each number in fx_bounds.cpp is
// read off the entry's WGSL (its farthest tap, plus the second texel of a
// fractional bilinear tap and one to spare). Outside the region the entry's
// passes would have written zero anyway, so the scissored chain draws the
// same pixels, bit for bit (test_render_graph_gpu.cpp). An entry not listed
// there — a generator that fills the frame, a displacement by another layer,
// a plugin — has an unknown reach, and the chain runs full frame from that
// entry on.
//
// GPU-free (engine_rg_core), so engine_tests pins the arithmetic.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <vector>

#include "frame_scene.hpp"

namespace premation::rg {

/// The glow's wide pass (2.2 x the radius, screened at 0.4) runs blur.wgsl with
/// its taps this many times further apart (pack_blur spacingMul): a soft halo
/// at a third of the fetches. The chain and the reach must agree on it.
constexpr double kGlowWideSpacing = 3;

/// A region of the chain buffer in texels, x right and y down: [x0, x1) × [y0, y1).
/// Fractional and unclamped (a reach may run off the frame).
struct PxBox {
  double x0 = 0, y0 = 0, x1 = 0, y1 = 0;
};

/// Buffer texels per layer px on each axis: the layer's world scale (Renderable.fx_scale)
/// times the view's texels per comp px — what run_effects_chain draws a radius at.
struct FxBoundsView {
  double pxPerWorldX = 1;
  double pxPerWorldY = 1;
};

/// One entry's reach from an input that is zero outside `in`.
struct FxReach {
  PxBox passes;  ///< every texel any of the entry's passes may write non-zero (contains `out`)
  PxBox out;     ///< every texel the entry's result may be non-zero
};

/// The entry's reach; nullopt when it is unknown (the entry may fill the frame).
[[nodiscard]] std::optional<FxReach> fx_reach(const api::RenderEffect& e, const PxBox& in, const FxBoundsView& view);

/// Where a renderable's content draw lands — its unit quad under the model
/// matrix and every motion sample — in texels of a `width` × `height` buffer
/// drawn through `viewProjection`. nullopt when it cannot be bounded (a
/// deformed mesh, a quad projected through infinity).
[[nodiscard]] std::optional<PxBox> content_box(const api::Renderable& r, const Mat3& viewProjection, double width,
                                               double height);

/// The scissor (x, y, w, h) covering `b` inside a `width` × `height` buffer: whole texels, clamped.
[[nodiscard]] std::array<std::uint32_t, 4> scissor_of(const PxBox& b, std::uint32_t width, std::uint32_t height);

/// deepGlowKernel.ts: each octave's sigma and the blur it adds to the octave before.
struct DeepGlowOctave {
  double sigma = 0;
  double delta = 0;
};
[[nodiscard]] std::vector<DeepGlowOctave> deep_glow_octaves(double radius, double octaves);
/// The texel step between deep-glow-blur.wgsl's taps for `sigma`.
[[nodiscard]] double deep_glow_step(double sigma);

}  // namespace premation::rg
