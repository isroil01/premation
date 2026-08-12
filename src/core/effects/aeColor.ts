/**
 * Colour kernels that read ALL THREE channels of a pixel — Photo Filter,
 * Black & White, Tritone and Threshold.
 *
 * The membership rule is the one `colorLut.ts` states and `colorEffects.ts`
 * repeats, and it is worth restating because three of these four look like they
 * ought to be cheap:
 *
 *   a per-channel table (`LUT_BUILDERS`) may be used only when each output
 *   channel depends on its OWN input channel and nothing else.
 *
 * All four fail that test, and each fails it for a different reason:
 *
 *   Photo Filter   its Preserve Luminosity rescale divides by the luminance of
 *                  the FILTERED pixel, which mixes all three channels. Without
 *                  that checkbox it is a plain per-channel gain and would belong
 *                  in `effectColorMatrix.ts`; with it, it cannot.
 *   Black & White  chooses its weights from where the pixel's hue falls, so the
 *                  red slider's effect on the red channel depends on green.
 *   Tritone        maps LUMINANCE to a colour ramp — one scalar built from all
 *                  three channels drives all three outputs.
 *   Threshold      the same, one bit wide.
 *
 * Putting any of them in the LUT path would produce an effect that renders,
 * animates and is subtly not the effect — the failure `colorLut.ts` calls out by
 * name for Vibrance. They are pixel passes, and pixel passes force a CPU bake;
 * that cost is the honest one.
 *
 * Every kernel mutates `data` in place and returns it, matching the rest of the
 * family, and every one leaves ALPHA untouched. A colour correction that moved
 * alpha would silently erode the layer's edge over a stack of them.
 */

import { luma } from './colorEffects';

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Photo Filter — a coloured gel over the layer.
 *
 * The gel itself is a MULTIPLY, which is what makes it a filter rather than a
 * tint: multiplying by a warm orange leaves a white highlight warm-white and
 * drives a blue shadow towards black, exactly as a physical filter in front of a
 * lens does. Blending toward that product by `density` gives the strength
 * control.
 *
 * `preserveLuminosity` then puts the brightness back. A real gel darkens the
 * image — an 85 warming filter costs about two thirds of a stop — and AE's
 * checkbox (on by default, and matched here) rescales each pixel so the result
 * carries the ORIGINAL luminance while keeping the new hue. That rescale is the
 * whole reason this file exists rather than an entry in the colour-matrix table:
 * the divisor is the luminance of the filtered pixel, so red's output depends on
 * green and blue.
 *
 * Colour channels arrive 0–255, `density` 0–100.
 */
export function photoFilterData(
  data: Uint8ClampedArray,
  filterR: number,
  filterG: number,
  filterB: number,
  density: number,
  preserveLuminosity: boolean,
): Uint8ClampedArray {
  const d = density <= 0 ? 0 : density >= 100 ? 1 : density / 100;
  if (d === 0) return data;

  // Normalised gel, so the multiply is a gain per channel rather than a scale
  // into 0–255².
  const gr = filterR / 255;
  const gg = filterG / 255;
  const gb = filterB / 255;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;

    let nr = r + (r * gr - r) * d;
    let ng = g + (g * gg - g) * d;
    let nb = b + (b * gb - b) * d;

    if (preserveLuminosity) {
      const before = luma(r, g, b);
      const after = luma(nr, ng, nb);
      // Guard the divisor rather than the numerator: a black pixel is black
      // under any gel, and scaling it by `before/0` would be a division by zero
      // that lands as NaN and clamps to 0 — visually right by accident, and
      // wrong the moment the pixel is merely very dark rather than black.
      if (after > 1e-6) {
        const k = before / after;
        nr *= k;
        ng *= k;
        nb *= k;
      }
    }

    data[i] = clamp255(nr);
    data[i + 1] = clamp255(ng);
    data[i + 2] = clamp255(nb);
  }
  return data;
}

/**
 * The six colour weights of Black & White, as fractions (AE/Photoshop show them
 * as percentages, so 40 arrives here as 0.4).
 */
export interface BlackAndWhiteWeights {
  reds: number;
  yellows: number;
  greens: number;
  cyans: number;
  blues: number;
  magentas: number;
}

/**
 * Black & White — a greyscale conversion with six per-hue weights.
 *
 * Why it is not `grayscale`: a fixed luma conversion maps a pure red and a pure
 * blue of equal luminance to the SAME grey, so a red logo on a blue field
 * vanishes. This effect exists to separate them — pull reds up, push cyans down,
 * and the contrast that the eye sees in colour survives the conversion. It is
 * the single most-used tool for a good monochrome frame, which is why AE and
 * Photoshop both ship it despite already having a saturation control.
 *
 * ── The decomposition ───────────────────────────────────────────────────────
 *
 * The pixel is split into three parts that sum back to it exactly:
 *
 *   min                the achromatic base — carries no hue, so no weight applies
 *   mid − min          the SECONDARY contribution (the two larger channels
 *                      together: yellow, cyan or magenta)
 *   max − mid          the PRIMARY contribution (the largest channel alone:
 *                      red, green or blue)
 *
 * and the grey is `min + (mid−min)·wSecondary + (max−mid)·wPrimary`. This is
 * Photoshop's construction, and it is worth the three lines rather than a hue
 * angle plus interpolation because it is exact at the six primaries and
 * continuous everywhere between them — a pure red returns exactly the reds
 * weight, a pure yellow exactly the yellows weight, and an orange the linear
 * blend of the two, with no special cases at the sector boundaries.
 *
 * Which secondary applies is decided by which channel is the MINIMUM — the one
 * NOT in the pair. That is the same fact as "which two channels are largest",
 * stated in the form that needs one comparison instead of two.
 *
 * Weights are deliberately unclamped and may exceed 1 or go negative, matching
 * AE's −200…300 range; the result is clamped once, at the end.
 *
 * `tint` (0–255 per channel, or null) colourises the result. The grey becomes
 * the LIGHTNESS and the tint supplies hue and saturation, so a sepia tint reads
 * as sepia at every brightness rather than as a flat wash — the same reason
 * Tritone below interpolates rather than multiplies.
 */
export function blackAndWhiteData(
  data: Uint8ClampedArray,
  weights: BlackAndWhiteWeights,
  tint: readonly [number, number, number] | null,
): Uint8ClampedArray {
  // Precompute the tint's hue/saturation once — it is constant across the
  // image, and `rgbToHsl` per pixel would be the dominant cost of the effect.
  let tintH = 0;
  let tintS = 0;
  if (tint) {
    const [h, s] = rgbToHsl(tint[0], tint[1], tint[2]);
    tintH = h;
    tintS = s;
  }

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;

    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    // The median without a sort: the three sum to r+g+b.
    const md = r + g + b - mx - mn;

    // Primary = the channel holding the maximum. Ties are harmless — when two
    // channels tie for max, `max − mid` is 0 and the primary weight is
    // multiplied by nothing.
    const wPrimary = mx === r ? weights.reds : mx === g ? weights.greens : weights.blues;
    // Secondary = the pair that EXCLUDES the minimum channel.
    const wSecondary = mn === b ? weights.yellows : mn === r ? weights.cyans : weights.magentas;

    const grey = mn + (md - mn) * wSecondary + (mx - md) * wPrimary;

    if (tint) {
      const [tr, tg, tb] = hslToRgb(tintH, tintS, clamp255(grey) / 255);
      data[i] = tr;
      data[i + 1] = tg;
      data[i + 2] = tb;
    } else {
      const v = clamp255(grey);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
  }
  return data;
}

/**
 * Tritone — map luminance onto a three-stop colour ramp.
 *
 * Shadows at luminance 0, midtones at 0.5, highlights at 1, linear between.
 * Two piecewise-linear segments rather than a smooth spline on purpose: the
 * midtone stop is a control the user is placing deliberately, and a spline would
 * make the colour at 0.5 something other than the colour they picked.
 *
 * This is a duotone/tritone print look and also the cheapest honest way to get a
 * colour-graded monochrome — the reason it survives in AE next to Curves.
 *
 * `blend` (0–100) mixes the original back in, matching AE's Blend With Original,
 * where 100 is a no-op.
 */
export function tritoneData(
  data: Uint8ClampedArray,
  shadows: readonly [number, number, number],
  midtones: readonly [number, number, number],
  highlights: readonly [number, number, number],
  blend: number,
): Uint8ClampedArray {
  const keep = blend <= 0 ? 0 : blend >= 100 ? 1 : blend / 100;
  if (keep >= 1) return data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const t = luma(r, g, b) / 255;

    let mr: number;
    let mg: number;
    let mb: number;
    if (t <= 0.5) {
      const u = t * 2;
      mr = shadows[0] + (midtones[0] - shadows[0]) * u;
      mg = shadows[1] + (midtones[1] - shadows[1]) * u;
      mb = shadows[2] + (midtones[2] - shadows[2]) * u;
    } else {
      const u = (t - 0.5) * 2;
      mr = midtones[0] + (highlights[0] - midtones[0]) * u;
      mg = midtones[1] + (highlights[1] - midtones[1]) * u;
      mb = midtones[2] + (highlights[2] - midtones[2]) * u;
    }

    data[i] = clamp255(mr + (r - mr) * keep);
    data[i + 1] = clamp255(mg + (g - mg) * keep);
    data[i + 2] = clamp255(mb + (b - mb) * keep);
  }
  return data;
}

/**
 * Threshold — everything above `level` becomes white, everything below black.
 *
 * The decision is made on LUMINANCE, not per channel. Thresholding each channel
 * separately would give eight colours rather than two, which is a different
 * effect entirely (and a bad one) — and it is the version a per-channel LUT
 * would have produced, which is why this is here and not there.
 *
 * `level` is 0–255 on the same scale as the luminance it is compared against.
 * Alpha survives, so thresholding a shaped layer keeps its shape.
 */
export function thresholdData(data: Uint8ClampedArray, level: number): Uint8ClampedArray {
  for (let i = 0; i < data.length; i += 4) {
    const v = luma(data[i]!, data[i + 1]!, data[i + 2]!) >= level ? 255 : 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
  return data;
}

// ── HSL, for Black & White's tint ─────────────────────────────────
//
// Local rather than shared: `hue-saturation` does its work in a colour MATRIX
// (see effectColorMatrix.ts), so there is no existing HSL pair in the effects
// tree to import. Two small pure functions here beat a new shared module whose
// only caller is twenty lines above it.

/** RGB 0–255 → `[hue 0..1, saturation 0..1, lightness 0..1]`. */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const mx = Math.max(rn, gn, bn);
  const mn = Math.min(rn, gn, bn);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d === 0) return [0, 0, l];
  // Denominator flips at l = 0.5 because saturation is measured against the
  // distance to the nearer end of the range, not against the range itself.
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (mx === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

/** The inverse of {@link rgbToHsl}. Returns RGB 0–255. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = clamp255(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    clamp255(hueToChannel(p, q, h + 1 / 3) * 255),
    clamp255(hueToChannel(p, q, h) * 255),
    clamp255(hueToChannel(p, q, h - 1 / 3) * 255),
  ];
}

function hueToChannel(p: number, q: number, tIn: number): number {
  let t = tIn;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

export { rgbToHsl as __rgbToHslForTests, hslToRgb as __hslToRgbForTests };
