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

#include <array>
#include <string_view>
#include <vector>

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

/// Alpha-only min / max over a (2r+1)² square, edge samples clamped
/// (keylight.ts `chokeAlpha`'s window, which skips out-of-range taps).
void alpha_min_max(RgbaView img, int r, bool take_max, ThreadPool* pool);
/// The same on a float plane (aeKeyingAdvanced.ts `morph`).
void plane_min_max(std::vector<float>& plane, int w, int h, int r, bool take_max, ThreadPool* pool);
/// A clamped box blur of a float plane, r = max(1, round(radius)), Float32
/// stores and float sums in the TS's tap order (aeKeyingAdvanced.ts
/// `boxBlurAlpha`, aeDistortAdvanced.ts `blurField`).
void box_blur_plane(std::vector<float>& plane, int w, int h, double radius, ThreadPool* pool);
/// aeRoundSix.ts / aeStylizeRoundFive.ts `lumaField`: Float32 Rec.709 luma × alpha,
/// then a box of radius round(blurRadius) that SKIPS out-of-range taps
/// (horizontal, then vertical), float sums in tap order.
[[nodiscard]] std::vector<float> luma_alpha_field(RgbaView img, double blur_radius, ThreadPool* pool);

// ── keying: keylight.ts, keyingEffects.ts, aeKeyingAdvanced.ts ──────────────
struct Rgb {
  double r, g, b;
};
/// The `keylight` effect: `applyKeyData(data, {screenColor, balance, gain,
/// clipBlack, clipWhite, despill})` then `chokeAlpha(choke)` then
/// `softenAlpha(matteSoftness)` — the applyKeylight wrapper's sequence.
struct KeylightParams {
  Rgb screen;
  double balance, gain, clip_black, clip_white, despill, choke, matte_softness;
};
void keylight(RgbaView img, const KeylightParams& p, ThreadPool* pool);
/// `linearColorKeyData(data, key, colorMatchMode(matchOn), tolerance, softness, keepMatched)`.
void linear_color_key(RgbaView img, const Rgb& key, double match_on, double tolerance, double softness,
                      bool keep_matched, ThreadPool* pool);
/// `lumaKeyData(data, lumaKeyType(keyType), threshold, tolerance, softness)`.
void luma_key(RgbaView img, double key_type, double threshold, double tolerance, double softness, ThreadPool* pool);
/// `shiftChannelsData(data, channelSource(a), channelSource(r), …(g), …(b))`.
void shift_channels(RgbaView img, double alpha_from, double red_from, double green_from, double blue_from,
                    ThreadPool* pool);
/// `colorKeyData(data, key, tolerance, edgeSoftness)`.
void color_key(RgbaView img, const Rgb& key, double tolerance, double edge_softness, ThreadPool* pool);
/// `colorRangeData(data, key, space, minTol, maxTol, lumaWeight)`.
void color_range(RgbaView img, const Rgb& key, double space, double min_tol, double max_tol, double luma_weight,
                 ThreadPool* pool);
/// `extractData(data, channel, black, white, blackSoft, whiteSoft, invert)`.
void extract_matte(RgbaView img, double channel, double black, double white, double black_soft, double white_soft,
             bool invert, ThreadPool* pool);
/// `spillSuppressorData(data, key, amount, preserveLuma)`.
void spill_suppressor(RgbaView img, const Rgb& key, double amount, bool preserve_luma, ThreadPool* pool);
/// `matteChokerData(src, w, h, spread, choke, softness, iterations)`.
void matte_choker(RgbaView img, double spread, double choke, double softness, double iterations, ThreadPool* pool);

// ── stylize.ts / colorEffects.ts ────────────────────────────────────────────
/// `mosaicData(src, w, h, hBlocks, vBlocks, sharpColors)`.
void mosaic(RgbaView img, double h_blocks, double v_blocks, bool sharp_colors, ThreadPool* pool);
/// `findEdgesData(src, w, h, invert)`.
void find_edges(RgbaView img, bool invert, ThreadPool* pool);
/// `embossData(src, w, h, angleDeg, relief, contrast, blend)`.
void emboss(RgbaView img, double angle_deg, double relief, double contrast, double blend, ThreadPool* pool);
/// `vibranceData(data, vibrance, saturation)`.
void vibrance(RgbaView img, double vibrance, double saturation, ThreadPool* pool);

// ── aeColor.ts / toneEffects.ts / colorEffects.ts colorama ─────────────────
/// `photoFilterData(data, filterR, filterG, filterB, density, preserveLuminosity)`.
void photo_filter(RgbaView img, double fr, double fg, double fb, double density, bool preserve_luminosity,
                  ThreadPool* pool);
struct BwWeights {
  double reds, yellows, greens, cyans, blues, magentas;
};
/// `blackAndWhiteData(data, weights, tint)`; `tint` null = no tint.
void black_and_white(RgbaView img, const BwWeights& weights, const std::array<double, 3>* tint, ThreadPool* pool);
/// `tritoneData(data, shadows, midtones, highlights, blend)`.
void tritone(RgbaView img, const std::array<double, 3>& shadows, const std::array<double, 3>& midtones,
             const std::array<double, 3>& highlights, double blend, ThreadPool* pool);
/// `thresholdData(data, level)`.
void threshold(RgbaView img, double level, ThreadPool* pool);
enum class SelectiveRange : std::uint8_t { reds, yellows, greens, cyans, blues, magentas, whites, neutrals, blacks };
/// `selectiveRange(v)`.
[[nodiscard]] SelectiveRange selective_range(double v) noexcept;
/// `selectiveColorData(data, range, cyan, magenta, yellow, black, relative)`.
void selective_color(RgbaView img, SelectiveRange range, double cyan, double magenta, double yellow, double black,
                     bool relative, ThreadPool* pool);
/// `shadowHighlightData(data, w, h, shadowAmount, highlightAmount, radius, tonalWidth)`.
void shadow_highlight(RgbaView img, double shadow_amount, double highlight_amount, double radius, double tonal_width,
                      ThreadPool* pool);
/// `coloramaData(data, COLORAMA_PALETTES[palette].stops, phaseShift, cycleRepetitions, blendWithOriginal)`.
void colorama(RgbaView img, int palette, double phase_shift, double cycle_repetitions, double blend_with_original,
              ThreadPool* pool);

// ── aeColorAdvanced.ts: histogram autos and HSL selectors ───────────────────
/// `equalizeData(data, mode, amount, blend)`.
void equalize(RgbaView img, double mode, double amount, double blend, ThreadPool* pool);
/// `autoLevelsData(data, blackClip, whiteClip, blend)`.
void auto_levels(RgbaView img, double black_clip, double white_clip, double blend, ThreadPool* pool);
/// `autoContrastData(data, blackClip, whiteClip, blend)`.
void auto_contrast(RgbaView img, double black_clip, double white_clip, double blend, ThreadPool* pool);
/// `autoColorData(data, blackClip, whiteClip, snapNeutral, blend)`.
void auto_color(RgbaView img, double black_clip, double white_clip, double snap_neutral, double blend,
                ThreadPool* pool);
/// `changeColorData(data, target, hueTol, satTol, lightTol, softness, hueShift, satScale, lightScale, invert)`.
void change_color(RgbaView img, const Rgb& target, double hue_tol, double sat_tol, double light_tol, double softness,
                  double hue_shift, double sat_scale, double light_scale, bool invert, ThreadPool* pool);
/// `changeToColorData(data, from, to, hueTol, satTol, lightTol, softness, preserveLightness)`.
void change_to_color(RgbaView img, const Rgb& from, const Rgb& to, double hue_tol, double sat_tol, double light_tol,
                     double softness, bool preserve_lightness, ThreadPool* pool);
/// `leaveColorData(data, target, tolerance, softness, amount)`.
void leave_color(RgbaView img, const Rgb& target, double tolerance, double softness, double amount, ThreadPool* pool);
/// `tonerData(data, black, shadows, midtones, highlights, white, blend)`.
void toner(RgbaView img, const std::array<Rgb, 5>& stops, double blend, ThreadPool* pool);

// ── transitions.ts / aeChannel.ts ───────────────────────────────────────────
/// `venetianBlindsData(data, w, h, completion 0–1, angleDeg, widthPx, feather)`.
void venetian_blinds(RgbaView img, double completion, double angle_deg, double width_px, double feather,
                     ThreadPool* pool);
/// `gradientWipeData(data, luminanceMapFrom(data), completion 0–1, softness 0–1, invert)`.
void gradient_wipe(RgbaView img, double completion, double softness, bool invert, ThreadPool* pool);
/// `cardWipeData(data, w, h, completion 0–1, rows, columns, cardWipeDirection(flipOrder))`.
void card_wipe(RgbaView img, double completion, double rows, double columns, double flip_order, ThreadPool* pool);
/// `radialWipeData(data, w, h, completion 0–1, startAngleDeg, radialWipeDirection(dir), cx, cy, featherDeg)`.
void radial_wipe(RgbaView img, double completion, double start_angle_deg, double direction, double cx, double cy,
                 double feather_deg, ThreadPool* pool);
/// `blockDissolveData(data, w, h, completion 0–1, blockWidth, blockHeight, feather, seed)`.
void block_dissolve(RgbaView img, double completion, double block_width, double block_height, double feather,
                    double seed, ThreadPool* pool);
/// `alphaLevelsData(data, inBlack, inWhite, gamma, outBlack, outWhite)`.
void alpha_levels(RgbaView img, double in_black, double in_white, double gamma, double out_black, double out_white,
                  ThreadPool* pool);
/// `solidCompositeData(data, color, sourceOpacity, solidOpacity, mode)`.
void solid_composite(RgbaView img, const Rgb& color, double source_opacity, double solid_opacity, double mode,
                     ThreadPool* pool);
/// `channelCombinerData(data, mode)`.
void channel_combiner(RgbaView img, double mode, ThreadPool* pool);
/// `removeColorMattingData(data, bg, threshold, amount)`.
void remove_color_matting(RgbaView img, const Rgb& bg, double threshold, double amount, ThreadPool* pool);

// ── aeStylizeAdvanced.ts ────────────────────────────────────────────────────
/// `cartoonData(src, w, h, smoothness, levels, edgeThreshold, edgeWidth, edgeOpacity)`.
void cartoon(RgbaView img, double smoothness, double levels, double edge_threshold, double edge_width,
             double edge_opacity, ThreadPool* pool);
/// `brushStrokesData(src, w, h, direction, length, randomness, cellSize, density)`.
void brush_strokes(RgbaView img, double direction, double length, double randomness, double cell_size, double density,
                   ThreadPool* pool);
/// `strobeLightData(data, time, period, duty, operation, color, intensity)`.
void strobe_light(RgbaView img, double time, double period, double duty, double operation, const Rgb& color,
                  double intensity, ThreadPool* pool);
/// `colorEmbossData(src, w, h, direction, relief, contrast, blendWithOriginal)`.
void color_emboss(RgbaView img, double direction, double relief, double contrast, double blend_with_original,
                  ThreadPool* pool);
/// `halftoneData(src, w, h, cellSize, angle, contrast, ink, paper, colorize, blendWithOriginal)`.
void halftone(RgbaView img, double cell_size, double angle, double contrast, const Rgb& ink, const Rgb& paper,
              bool colorize, double blend_with_original, ThreadPool* pool);
/// `kaleidoscopeData(data, w, h, segments, centerX, centerY, rotation, sourceAngle, zoom)`.
void kaleidoscope(RgbaView img, double segments, double center_x, double center_y, double rotation,
                  double source_angle, double zoom, ThreadPool* pool);
/// `vignetteData(data, w, h, amount, size, feather, roundness, centerX, centerY)`.
void vignette(RgbaView img, double amount, double size, double feather, double roundness, double center_x,
              double center_y, ThreadPool* pool);
/// `burnFilmData(data, w, h, burn, centerX, centerY, burnColor, charColor, randomness, seed)`.
void burn_film(RgbaView img, double burn, double center_x, double center_y, const Rgb& burn_color,
               const Rgb& char_color, double randomness, double seed, ThreadPool* pool);

// ── aeTransitionsAdvanced.ts ────────────────────────────────────────────────
/// `irisWipeData(data, w, h, completion %, centerX, centerY, points, rotation, innerRadius, useInnerRadius, feather, invert)`.
void iris_wipe(RgbaView img, double completion, double center_x, double center_y, double points, double rotation,
               double inner_radius, bool use_inner_radius, double feather, bool invert, ThreadPool* pool);
/// `lightWipeData(data, w, h, completion %, shape, angle, centerX, centerY, width, color, intensity, feather)`.
void light_wipe(RgbaView img, double completion, double shape, double angle, double center_x, double center_y,
                double width, const Rgb& color, double intensity, double feather, ThreadPool* pool);
/// `lineSweepData(data, w, h, completion %, lineCount, angle, stagger, feather, invert)`.
void line_sweep(RgbaView img, double completion, double line_count, double angle, double stagger, double feather,
                bool invert, ThreadPool* pool);
/// `gridWipeData(data, w, h, completion %, columns, rows, shape, random, feather, invert)`.
void grid_wipe(RgbaView img, double completion, double columns, double rows, double shape, double random,
               double feather, bool invert, ThreadPool* pool);
/// `dustAndScratchesData(src, w, h, radius, threshold)`.
void dust_and_scratches(RgbaView img, double radius, double threshold, ThreadPool* pool);
/// `noiseAlphaData(data, w, amount, uniform, seed, phase, clipResult)`.
void noise_alpha(RgbaView img, double amount, bool uniform, double seed, double phase, bool clip_result,
                 ThreadPool* pool);

// ── warp.ts / stylize.ts displacement + noise bites ─────────────────────────
/// `waveWarpData(src, w, h, waveHeight, waveWidth, directionDeg, phaseDeg)`.
void wave_warp(RgbaView img, double wave_height, double wave_width, double direction_deg, double phase_deg,
               ThreadPool* pool);
/// `turbulentDisplaceData(src, w, h, amount, size, complexity, evolution)`.
void turbulent_displace(RgbaView img, double amount, double size, double complexity, double evolution,
                        ThreadPool* pool);
/// `curlNoiseData(src, w, h, amount, size, complexity, evolution)`.
void curl_noise(RgbaView img, double amount, double size, double complexity, double evolution, ThreadPool* pool);
/// `roughenEdgesData(src, w, h, border, scale, complexity, evolution, seed)` + applyRoughenEdges' Edge Sharpness.
void roughen_edges(RgbaView img, double border, double scale, double complexity, double evolution, double seed,
                   double edge_sharpness, ThreadPool* pool);
/// `scatterData(src, w, h, amount, grain (0 both / 1 horizontal / 2 vertical), seed, evolution)`.
void scatter(RgbaView img, double amount, double grain, double seed, double evolution, ThreadPool* pool);

// ── aeDistortAdvanced.ts ────────────────────────────────────────────────────
void ripple(RgbaView img, double center_x, double center_y, double radius, double amplitude, double frequency,
            double phase, double decay, ThreadPool* pool);
void magnify(RgbaView img, double center_x, double center_y, double magnification, double radius, double shape,
             double feather, ThreadPool* pool);
void warp(RgbaView img, double style, double bend, double horizontal, double vertical, double axis, ThreadPool* pool);
void page_turn(RgbaView img, double amount, double angle, double radius, double back_opacity, double shading,
               ThreadPool* pool);
void split(RgbaView img, double offset, double angle, double center_x, double center_y, ThreadPool* pool);
void slant(RgbaView img, double slant_px, double axis, double floor_v, ThreadPool* pool);
void smear(RgbaView img, double from_x, double from_y, double to_x, double to_y, double radius, double elasticity,
           ThreadPool* pool);
void rolling_shutter(RgbaView img, double sweep, double wobble, double direction, bool vertical, ThreadPool* pool);
void radial_shadow(RgbaView img, double light_x, double light_y, double projection, const Rgb& color, double opacity,
                   double softness, double render_mode, ThreadPool* pool);

// ── aeRoundSevenColor.ts / aeRoundSevenStylize.ts ───────────────────────────
void color_difference_key(RgbaView img, const Rgb& key, double matte_in_black, double matte_in_white,
                          double matte_gamma, double view_mode, ThreadPool* pool);
void wire_removal(RgbaView img, double point_ax, double point_ay, double point_bx, double point_by, double thickness,
                  double slope, ThreadPool* pool);
void broadcast_colors(RgbaView img, double standard, double how, double max_signal_amplitude, ThreadPool* pool);
void noise_hls(RgbaView img, double noise_type, double hue, double lightness, double saturation, double grain_size,
               double noise_phase, ThreadPool* pool);
void block_load(RgbaView img, double completion, double scans, double block_size, ThreadPool* pool);
/// `kernelConvolveData(src, w, h, [k00 … k22], divisor, offset)`.
void kernel_convolve(RgbaView img, const std::array<double, 9>& k, double divisor, double offset, ThreadPool* pool);
void glasses_3d(RgbaView img, double convergence_offset, double view, double balance, bool swap_left_right,
                ThreadPool* pool);
/// `fractalData(w, h, …)` — a generator: the input pixels are replaced.
void fractal(RgbaView img, double set_type, double center_x, double center_y, double magnification, double iterations,
             double julia_x, double julia_y, double color_phase, double color_cycles, const Rgb& inside,
             ThreadPool* pool);

// ── aeRoundSix.ts ───────────────────────────────────────────────────────────
void unmult(RgbaView img, double threshold, double boost, ThreadPool* pool);
/// `ccCompositeData(d, d, w, h, opacity, compositeBlendMode(mode), rgbOnly)` — the layer over itself.
void cc_composite(RgbaView img, double opacity, double blend_mode, bool rgb_only, ThreadPool* pool);
/// `ccScatterizeData(src, w, h, amount, windX, windY, twist, seed)` — serial (a forward scatter).
void cc_scatterize(RgbaView img, double amount, double wind_x, double wind_y, double twist, double seed,
                   ThreadPool* pool);
void radial_fast_blur(RgbaView img, double amount, double center_x, double center_y, double mode, ThreadPool* pool);
void cross_blur(RgbaView img, double radius_x, double radius_y, bool repeat_edges, ThreadPool* pool);
void scale_wipe(RgbaView img, double completion, double stretch, double direction, double center_x, double center_y,
                ThreadPool* pool);
void plastic(RgbaView img, double surface_bump, double softness, double light_angle, double light_intensity,
             double specular, ThreadPool* pool);

// ── aeStylizeRoundFive.ts ───────────────────────────────────────────────────
void glass(RgbaView img, double bump_softness, double height, double displacement, double light_angle,
           double light_intensity, double shininess, ThreadPool* pool);
void texturize(RgbaView img, double pattern, double contrast, double scale, double light_angle, ThreadPool* pool);
void threads(RgbaView img, double thickness, double spacing, double depth, ThreadPool* pool);
void chromatic_aberration(RgbaView img, double amount, double aberration_mode, double angle, double falloff,
                          double center_x, double center_y, ThreadPool* pool);
void hex_tile(RgbaView img, double radius, double border, ThreadPool* pool);
void vector_blur(RgbaView img, double amount, double angle_offset, double smoothness, ThreadPool* pool);

// ── aeDistortRoundFive.ts / aeTransitionsRoundFive.ts ───────────────────────
void flo_motion(RgbaView img, double k1x, double k1y, double k1a, double k2x, double k2y, double k2a, double falloff,
                ThreadPool* pool);
void lens(RgbaView img, double center_x, double center_y, double size, double convergence, ThreadPool* pool);
void griddler(RgbaView img, double tile_size, double horizontal_scale, double vertical_scale, double rotation,
              ThreadPool* pool);
void ball_action(RgbaView img, double grid, double ball_size, double scatter_amt, double seed, ThreadPool* pool);
void drizzle(RgbaView img, double drip_rate, double ripple_height, double spreading, double evolution, double seed,
             ThreadPool* pool);
void jaws(RgbaView img, double completion, double direction, double teeth_height, double teeth_width,
          ThreadPool* pool);
void pixel_polly(RgbaView img, double completion, double cell_size, double gravity, double spin, double center_x,
                 double center_y, double seed, ThreadPool* pool);
void twister(RgbaView img, double completion, double center_y, double twist, ThreadPool* pool);
void card_dance(RgbaView img, double rows, double columns, double amount, double card_rotation, double phase,
                ThreadPool* pool);

// ── distort.ts: inverse-map resamples ───────────────────────────────────────
/// `bulgeData(data, w, h, centerX, centerY, radius, height)` (centre in px).
void bulge(RgbaView img, double cx, double cy, double radius, double height, ThreadPool* pool);
/// `spherizeData(data, w, h, centerX, centerY, radius, amountPct)`.
void spherize(RgbaView img, double cx, double cy, double radius, double amount_pct, ThreadPool* pool);
/// `twirlData(data, w, h, centerX, centerY, radius, angleDeg)`.
void twirl(RgbaView img, double cx, double cy, double radius, double angle_deg, ThreadPool* pool);
/// `cornerPinData(data, w, h, [tlx, tly, trx, try, brx, bry, blx, bly])`.
void corner_pin(RgbaView img, const std::array<double, 8>& corners, ThreadPool* pool);
/// `polarCoordinatesData(data, w, h, interpolation, polarConversion(type))`.
void polar_coordinates(RgbaView img, double interpolation, bool polar_to_rect, ThreadPool* pool);
/// `mirrorData(data, w, h, centerX, centerY, angleDeg)`.
void mirror(RgbaView img, double cx, double cy, double angle_deg, ThreadPool* pool);
/// `offsetData(data, w, h, shiftX, shiftY, blend)`.
void offset(RgbaView img, double shift_x, double shift_y, double blend, ThreadPool* pool);
/// `opticsCompensationData(data, w, h, fieldOfView, reverse, centerX, centerY)`.
void optics_compensation(RgbaView img, double field_of_view, bool reverse, double center_x, double center_y,
                         ThreadPool* pool);
struct Pt2 {
  double x, y;
};
/// `meshWarpData(data, w, h, offsets)` for the 4×4 (MESH_WARP_N) grid.
void mesh_warp(RgbaView img, const std::array<Pt2, 16>& offsets, ThreadPool* pool);
/// `liquifyData(data, w, h, centerX, centerY, radius, pushX, pushY, twirlDeg, pinchPct)`.
void liquify(RgbaView img, double cx, double cy, double radius, double push_x, double push_y, double twirl_deg,
             double pinch_pct, ThreadPool* pool);

// ── aeBlurAdvanced.ts ───────────────────────────────────────────────────────
/// `bilateralBlurData(src, w, h, radius, colorSigma, preserveAlpha)`.
void bilateral_blur(RgbaView img, double radius, double color_sigma, bool preserve_alpha, ThreadPool* pool);
/// `smartBlurData(src, w, h, radius, threshold, mode)`.
void smart_blur(RgbaView img, double radius, double threshold, double mode, ThreadPool* pool);
/// `cameraLensBlurData(src, w, h, radius, blades, rotation, gain, threshold)`.
void camera_lens_blur(RgbaView img, double radius, double blades, double rotation, double gain, double threshold,
                      ThreadPool* pool);

}  // namespace premation::effects
