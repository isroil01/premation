// E4: the CPU effect kernels of the TypeScript bake chain, ported to C++.
//
// Each function is a port of ONE TypeScript kernel, operation for operation, on
// the same straight RGBA8 buffer `getImageData` gives it, so the bytes out match
// the TS bake exactly (tests/data/effect_kernel_parity.json, written by
// src/core/effects/nativeKernelCrossEngine.test.ts). All work IN PLACE on `img`:
// where the TS allocates an output buffer, the TS wrapper copies it back with
// `img.data.set(out)`, and so do these.
//
// Rows are split across `pool` (nullptr = the calling thread only); the result
// never depends on the thread count.
//
// The loops are plain C++20 written for auto-vectorisation (contiguous rows,
// no calls in the inner loop, no aliasing through the output); there are no
// intrinsics, so the one code path is also the scalar twin.
#pragma once

#include <string_view>

#include "pixel_ops.hpp"
#include "thread_pool.hpp"

namespace premation::effects {

// ── blurs.ts ────────────────────────────────────────────────────────────────
enum class BlurDims : std::uint8_t { both, horizontal, vertical };
/// `blurDimensions(v)`.
[[nodiscard]] BlurDims blur_dims(double v) noexcept;
/// `blurRgba(data, w, h, radius, {dimensions, iterations, repeatEdge})`.
void blur_rgba(RgbaView img, double radius, BlurDims dims, double iterations, bool repeat_edge, ThreadPool* pool);
/// `radialBlurData(src, w, h, amount, cx, cy, mode, quality)`; zoom = mode 'zoom'.
void radial_blur(RgbaView img, double amount, double cx, double cy, bool zoom, double quality, ThreadPool* pool);
/// `channelBlurData(data, w, h, {red, green, blue, alpha}, dimensions, repeatEdge)`.
void channel_blur(RgbaView img, double red, double green, double blue, double alpha, BlurDims dims, bool repeat_edge,
                  ThreadPool* pool);
/// `unsharpMaskData(data, w, h, amount, radius, threshold)`.
void unsharp_mask(RgbaView img, double amount, double radius, double threshold, ThreadPool* pool);
/// `sharpenData(data, w, h, amount)` (canvas2dEffects.ts).
void sharpen(RgbaView img, double amount, ThreadPool* pool);

// ── noiseEffects.ts / canvas2dEffects.ts noise ──────────────────────────────
/// `addNoiseData(data, w, amount, evolution, mono)` (the `noise` effect).
void add_noise(RgbaView img, double amount, double evolution, bool mono, ThreadPool* pool);
/// `addGrainData(data, w, h, intensity, size, saturation, seed)`.
void add_grain(RgbaView img, double intensity, double size, double saturation, double seed, ThreadPool* pool);
/// `turbulentNoiseData(data, w, h, scale, complexity, evolution, contrast, brightness, invert)`.
void turbulent_noise(RgbaView img, double scale, double complexity, double evolution, double contrast,
                     double brightness, bool invert, ThreadPool* pool);
/// `medianData(data, w, h, radius)`.
void median(RgbaView img, double radius, ThreadPool* pool);

// ── keyingEffects.ts ────────────────────────────────────────────────────────
enum class MinimaxOp : std::uint8_t { maximum, minimum, max_then_min, min_then_max };
enum class MinimaxChannel : std::uint8_t { alpha, color, red, green, blue };
/// `minimaxOp(v)` / `minimaxChannel(v)` (an out-of-menu index falls back like the TS).
[[nodiscard]] MinimaxOp minimax_op(double v) noexcept;
[[nodiscard]] MinimaxChannel minimax_channel(double v) noexcept;
/// `minimaxData(src, w, h, op, radius, channel, direction)`.
void minimax(RgbaView img, MinimaxOp op, double radius, MinimaxChannel channel, BlurDims direction, ThreadPool* pool);
/// `simpleChokerData(data, w, h, chokePx)`.
void simple_choker(RgbaView img, double choke_px, ThreadPool* pool);

// ── stylize.ts / colorEffects.ts ────────────────────────────────────────────
/// `mosaicData(src, w, h, hBlocks, vBlocks, sharpColors)`.
void mosaic(RgbaView img, double h_blocks, double v_blocks, bool sharp_colors, ThreadPool* pool);
/// `findEdgesData(src, w, h, invert)`.
void find_edges(RgbaView img, bool invert, ThreadPool* pool);
/// `embossData(src, w, h, angleDeg, relief, contrast, blend)`.
void emboss(RgbaView img, double angle_deg, double relief, double contrast, double blend, ThreadPool* pool);
/// `vibranceData(data, vibrance, saturation)`.
void vibrance(RgbaView img, double vibrance, double saturation, ThreadPool* pool);

// ── aeBlurAdvanced.ts ───────────────────────────────────────────────────────
/// `bilateralBlurData(src, w, h, radius, colorSigma, preserveAlpha)`.
void bilateral_blur(RgbaView img, double radius, double color_sigma, bool preserve_alpha, ThreadPool* pool);
/// `smartBlurData(src, w, h, radius, threshold, mode)`.
void smart_blur(RgbaView img, double radius, double threshold, double mode, ThreadPool* pool);
/// `cameraLensBlurData(src, w, h, radius, blades, rotation, gain, threshold)`.
void camera_lens_blur(RgbaView img, double radius, double blades, double rotation, double gain, double threshold,
                      ThreadPool* pool);

}  // namespace premation::effects
