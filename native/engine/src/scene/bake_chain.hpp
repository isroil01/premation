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

/// `bakedEffectSpread(layer)` (vectorDraw.ts): how far a CPU-baked chain paints
/// outside the layer box, px (0 when the layer is not baked).
[[nodiscard]] double baked_effect_spread(const RLayer& l);

}  // namespace premation::scene::bake
