// E4: the CPU effect CHAIN of a baked layer — src/core/effects/effectBake.ts
// `applyEffectChain` and bakeWorkerCore.ts `runBakeJob`, ported onto the
// raster module's Canvas2D (Skia's CPU raster in the engine; a recording canvas
// in the parity tests).
//
// The chain runs the layer's effect stack in order, each effect down the branch
// the TS's `applyOne` takes:
//
//   LUT        levels, curves, posterize, exposure, lumetri, … — one composed
//              per-channel table (colorLut.ts `buildChannelLut([e])`)
//   CSS        blur, glow, drop-shadow, brightness, … — queued and flushed as
//              ONE `ctx.filter` draw, as the TS batches them
//   colour     tint, channel-mixer — effectColorMatrix.ts over the pixels
//   procedural gradient-ramp, fractal-noise (proceduralCanvas2d.ts)
//   canvas2d   the 139 byte-exact pixel kernels of engine_effects, with each
//              effect's params mapped onto its kernel's arguments exactly as
//              the TS `apply*` wrapper does (effect_apply.cpp), and the
//              canvas-drawn effects of canvas_effects.cpp
//
// interleaved with fill opacity (silhouette snapshot + destination-in fade),
// the Compositing-Options opacity and effect-scoped masks (one before / after
// blend, the mask painted by raster/mask_paint), and the TS's batched
// ImageData: consecutive pixel passes share ONE getImageData / putImageData,
// which lands only where a canvas-reading step needs it. The Canvas2D program
// the chain issues is the TS's, op for op (tests/test_effect_chain.cpp).
//
// Effects are JSON objects as the bake job carries them:
//   {type, enabled?, params (RESOLVED: paramsOf — registry defaults under the
//    stored values, lengths already scaled to the raster), opacity?, maskId?}
// An effect the chain cannot draw is skipped and named in the report, never
// drawn wrong.
#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "raster/canvas.hpp"
#include "raster/json.hpp"
#include "pixel_ops.hpp"
#include "thread_pool.hpp"

namespace premation::effects {

struct ChainReport {
  /// "type: reason" for each enabled effect the chain skipped.
  std::vector<std::string> unported;
  /// Features used that the canvas under the chain could not apply (a CSS
  /// filter function the Skia canvas does not draw yet, variable mask feather).
  std::vector<std::string> unsupported;
};

/// `applyEffectChain(oc, w, h, effects, scratch, fillOpacity, masks)`.
/// `effects` is a JSON array (see above); `masks` the layer's mask stack
/// ({paths: [...]}) for effect-scoped masks, or null. Scratch canvases come
/// from `oc.create_canvas`. `pool` splits the pixel kernels' rows.
void apply_effect_chain(raster::Canvas2D& oc, int w, int h, const raster::json::Value& effects, double fill_opacity,
                        const raster::json::Value* masks, ThreadPool* pool, ChainReport& report);

/// `runBakeJob`: seed `canvas` (w × h, fresh) with straight-RGBA `pixels`, run
/// the chain, read the result back (straight RGBA, w × h × 4).
[[nodiscard]] std::vector<std::uint8_t> run_bake_job(raster::Canvas2D& canvas, std::span<const std::uint8_t> pixels,
                                                     const raster::json::Value& effects, double fill_opacity,
                                                     const raster::json::Value* masks, ThreadPool* pool,
                                                     ChainReport& report);

/// The route `applyOne` takes for an effect (for reports and tests):
/// "lut" | "css" | "color" | "procedural" | "canvas2d" | "none".
[[nodiscard]] std::string_view effect_route(const raster::json::Value& effect);

/// Every effect type the chain draws through its canvas2d route (pixel kernels
/// + canvas-drawn), and the canvas-drawn types it does not draw yet.
[[nodiscard]] std::span<const std::string_view> chain_pixel_effects() noexcept;
[[nodiscard]] std::span<const std::string_view> chain_unported_canvas_effects() noexcept;

// ── The pieces, for effect_chain.cpp and the tests ──────────────────────────

/// One CPU pixel pass: `setTransform(identity)`, then the (batched) frame,
/// then the kernel; what the TS `apply*` wrappers do around their kernel.
class PixelPass {
 public:
  virtual ~PixelPass() = default;
  PixelPass() = default;
  PixelPass(const PixelPass&) = delete;
  PixelPass& operator=(const PixelPass&) = delete;
  PixelPass(PixelPass&&) = delete;
  PixelPass& operator=(PixelPass&&) = delete;
  /// setTransform + getImageData: the frame, straight RGBA, to modify in place
  /// (committed by the pass's putImageData when the adapter returns).
  virtual RgbaView frame() = 0;
  [[nodiscard]] virtual ThreadPool* pool() const = 0;
  [[nodiscard]] virtual int w() const = 0;
  [[nodiscard]] virtual int h() const = 0;
};

/// The canvas2d-route pixel effects: map `params` (paramsOf) onto the kernel
/// exactly as the TS `apply*` wrapper does, guards included (a guard that
/// returns never touches the frame). False when `type` is not a pixel effect.
bool apply_pixel_effect(std::string_view type, const raster::json::Value& params, PixelPass& pass);
[[nodiscard]] bool is_pixel_effect(std::string_view type) noexcept;
[[nodiscard]] std::span<const std::string_view> pixel_effect_types() noexcept;

/// colorLut.ts: `isLutEffect(type)`; `buildChannelLut([e])` + `applyChannelLut`
/// over straight RGBA (alpha untouched).
[[nodiscard]] bool is_lut_effect(std::string_view type) noexcept;
struct ChannelLut {
  std::vector<float> r, g, b;  // 256 each, Float32 as the TS stores them
};
[[nodiscard]] ChannelLut build_channel_lut(std::string_view type, const raster::json::Value& params);
void apply_channel_lut(RgbaView img, const ChannelLut& lut, ThreadPool* pool);

/// effects.ts `effectCss(e)` — the effect's CSS filter function(s), "" if none.
[[nodiscard]] std::string effect_css(std::string_view type, const raster::json::Value& params);

/// effectColorMatrix.ts: `isColorEffect(type)`, `effectColorMatrix([e])`,
/// `applyColorMatrixImage`.
[[nodiscard]] bool is_color_matrix_effect(std::string_view type) noexcept;
struct ColorMatrix {
  std::array<double, 9> m{1, 0, 0, 0, 1, 0, 0, 0, 1};
  std::array<double, 3> offset{0, 0, 0};
};
[[nodiscard]] ColorMatrix effect_color_matrix(std::string_view type, const raster::json::Value& params);
void apply_color_matrix_image(RgbaView img, const ColorMatrix& cm, ThreadPool* pool);

/// proceduralCanvas2d.ts: gradient-ramp / fractal-noise onto `oc`. `noise` is
/// the generator's reusable low-res canvas (the TS keeps one per realm).
[[nodiscard]] bool is_procedural_effect(std::string_view type) noexcept;
void apply_procedural_effect(std::string_view type, const raster::json::Value& params, raster::Canvas2D& oc, double w,
                             double h, std::unique_ptr<raster::Canvas2D>& noise);

}  // namespace premation::effects
