// The CPU bake of a layer raster (D2w effects) — the scene builder's side of
// Canvas2DVectorRasterizer.drawPath / drawText's `bake` branch
// (src/core/rendering/raster/Canvas2DVectorRasterizer.ts): the layer mask
// applied as a matte over the padded raster, then the layer's effect stack —
// resolved (paramsOf) with every px length scaled by the raster scale
// (scaleEffectLengths) — through the E4 effect chain (effects/effect_chain.hpp,
// effectBake.ts applyEffectChain: fill opacity, CSS batching, LUT / colour /
// procedural / pixel / canvas-drawn passes, scoped masks, effect opacity).
//
// It runs on the raster's own canvas (raster::Canvas2D, Skia's CPU backend).
// Anything the chain cannot draw is recorded in `unsupported` (so the frame is
// reported as a fallback) and skipped — never a thrown error, never a blank.
#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include "canvas.hpp"
#include "scene_types.hpp"

namespace premation::effects {
class ThreadPool;
}

namespace premation::scene::bake {

/// A kernel thread pool the bakes of one texture feed share: a bake that finds
/// it busy (another raster worker is baking) runs its kernels inline. The
/// kernels give the same bytes either way.
struct SharedPool {
  effects::ThreadPool* pool = nullptr;
  std::mutex* m = nullptr;
};

/// The bake of one raster: `spec` is the drawable (the RenderLayer / TextSpec
/// JSON the texture request carries), `ctx` the raster canvas after its content
/// was painted, `bw` × `bh` the padded box in layer px, `ss` the raster scale.
void bake_layer_raster(raster::Canvas2D& ctx, const Json& spec, double bw, double bh, double ss,
                       std::vector<std::string>& unsupported, SharedPool pool = {});

/// Footage (AppTextureProvider bakeImageBitmap / setVideoBaked): `ctx` holds
/// the decoded frame drawn at the bake size; `spec` is {effects, width,
/// height, fillOpacity?, mask?} in layer px. The mask matte is drawn in the
/// layer's centred space scaled onto the bitmap, then the stack runs with its
/// px lengths × (bake width / layer width).
void bake_footage(raster::Canvas2D& ctx, const Json& spec, std::vector<std::string>& unsupported, SharedPool pool = {});

/// E4 round 2 — the drawn part of ONE Canvas2D-only effect that only draws
/// (Numbers, Timecode, Audio Spectrum, Audio Waveform, Lightning: none reads
/// the layer's pixels; Path Stroke / Scribble paint a buffer from the mask
/// paths first), painted alone on a transparent canvas the size the CPU bake of
/// the layer would have (raster::raster_canvas_size, bake on: the padded box ×
/// the tier), with the effect's px lengths × that scale, as the bake draws it.
/// The GPU chain lands it through the layer's quad with the effect's composite:
/// `fx-overlay`.
/// `spec` = {effect, width, height, __deviceMax}.
struct OverlayOutput {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> rgba;
  std::vector<std::string> unsupported;
};
[[nodiscard]] OverlayOutput draw_effect_overlay(const Json& spec, double resolutionScale, double padding,
                                                const raster::CanvasOptions& opts, SharedPool pool = {});

/// `bakedEffectSpread(layer)` (vectorDraw.ts): how far a CPU-baked chain paints
/// outside the layer box, px (0 when the layer is not baked).
[[nodiscard]] double baked_effect_spread(const RLayer& l);

}  // namespace premation::scene::bake
