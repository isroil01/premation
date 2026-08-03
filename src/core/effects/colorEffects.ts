/**
 * Colour kernels that need more than a per-channel table — Vibrance and Colorama.
 *
 * Exposure is deliberately NOT here: it is a per-channel transfer function, so
 * it lives in `colorLut.ts` and renders on both backends with no bake. These two
 * read all three channels of a pixel to decide what to do with it, which no
 * per-channel table can express.
 */

/** sRGB luma. The same coefficients `findEdgesData` uses, deliberately. */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Vibrance — saturate the unsaturated, protect what is already saturated.
 *
 * The point of the effect, and the reason it is not just Saturation: the boost
 * is scaled by how far each pixel ALREADY is from grey. A muted background comes
 * up; a saturated red stays put instead of clipping into a flat blob. Skin tones
 * survive a vibrance push that a saturation push would ruin, which is the whole
 * reason colourists reach for it.
 *
 * `saturation` is the plain, unweighted control, included because AE's effect
 * carries both and the pair is how it is actually used — vibrance for the lift,
 * saturation to pull the whole thing back.
 *
 * Both are applied around the pixel's own luma, so a fully desaturated result is
 * the correct grey rather than black.
 */
export function vibranceData(
  data: Uint8ClampedArray,
  vibrance: number,
  saturation: number,
): Uint8ClampedArray {
  const vib = vibrance / 100;
  const sat = saturation / 100;
  if (vib === 0 && sat === 0) return data;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue; // invisible pixels keep their bytes
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    const l = luma(r, g, b);

    // Existing saturation, 0..1, as the spread between the extreme channels.
    // Cheaper than a full HSL round trip and monotonic in the same direction,
    // which is all the weighting needs.
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const current = mx === 0 ? 0 : (mx - mn) / 255;

    // The weighting. A grey pixel (current 0) gets the full boost; an already
    // saturated one gets almost none.
    const amount = 1 + sat + vib * (1 - current);

    data[i] = l + (r - l) * amount;
    data[i + 1] = l + (g - l) * amount;
    data[i + 2] = l + (b - l) * amount;
  }
  return data;
}

/** A colour stop on a Colorama ramp: position 0..1 and an RGB triple. */
export interface ColoramaStop {
  at: number;
  rgb: readonly [number, number, number];
}

/**
 * The built-in output cycles, by index, so the control can be keyframed.
 *
 * AE ships a long list of these; these five are the ones that get used. Indices
 * are STABLE — inserting into the middle would silently re-map every saved
 * project, so new palettes go on the end.
 */
export const COLORAMA_PALETTES: ReadonlyArray<{ name: string; stops: ReadonlyArray<ColoramaStop> }> = [
  {
    name: 'Fire',
    stops: [
      { at: 0, rgb: [0, 0, 0] },
      { at: 0.35, rgb: [200, 30, 0] },
      { at: 0.7, rgb: [255, 190, 0] },
      { at: 1, rgb: [255, 255, 230] },
    ],
  },
  {
    name: 'Spectrum',
    stops: [
      { at: 0, rgb: [255, 0, 0] },
      { at: 0.17, rgb: [255, 255, 0] },
      { at: 0.33, rgb: [0, 255, 0] },
      { at: 0.5, rgb: [0, 255, 255] },
      { at: 0.67, rgb: [0, 0, 255] },
      { at: 0.83, rgb: [255, 0, 255] },
      { at: 1, rgb: [255, 0, 0] },
    ],
  },
  {
    name: 'Ramp Grey',
    stops: [
      { at: 0, rgb: [0, 0, 0] },
      { at: 1, rgb: [255, 255, 255] },
    ],
  },
  {
    name: 'Ice',
    stops: [
      { at: 0, rgb: [0, 4, 40] },
      { at: 0.5, rgb: [0, 140, 210] },
      { at: 1, rgb: [230, 250, 255] },
    ],
  },
  {
    name: 'Solarize',
    stops: [
      { at: 0, rgb: [0, 0, 0] },
      { at: 0.5, rgb: [255, 240, 180] },
      { at: 1, rgb: [0, 0, 0] },
    ],
  },
];

/** Sample a palette at t (0..1), linearly between stops. */
export function samplePalette(
  stops: ReadonlyArray<ColoramaStop>,
  t: number,
): [number, number, number] {
  if (stops.length === 0) return [0, 0, 0];
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  if (x <= stops[0]!.at) return [...stops[0]!.rgb] as [number, number, number];
  const last = stops[stops.length - 1]!;
  if (x >= last.at) return [...last.rgb] as [number, number, number];

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!, b = stops[i + 1]!;
    if (x >= a.at && x <= b.at) {
      const span = b.at - a.at;
      const f = span <= 0 ? 0 : (x - a.at) / span;
      return [
        a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f,
        a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f,
        a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f,
      ];
    }
  }
  return [...last.rgb] as [number, number, number];
}

/**
 * Colorama — remap the layer through a colour cycle.
 *
 * Each pixel's INPUT PHASE (its luma by default) picks a colour out of the
 * palette. Add `phaseShift` and the whole mapping rotates, which is the effect's
 * signature move: one keyframe on phase cycles the palette through the image and
 * gives you the classic pulsing-energy look for free.
 *
 * The cycle WRAPS rather than clamping — that is what makes a phase animation
 * loop seamlessly instead of slamming into the end of the ramp.
 *
 * `blendWithOriginal` is the fraction of the SOURCE kept — 0 is full Colorama,
 * 1 is untouched. Same sense as AE's control of that name, and the same sense as
 * Find Edges' in this codebase; the two disagreeing would be a trap, since both
 * sit in the same inspector and read identically.
 */
export function coloramaData(
  data: Uint8ClampedArray,
  stops: ReadonlyArray<ColoramaStop>,
  phaseShift: number,
  cycleRepetitions: number,
  blendWithOriginal: number,
): Uint8ClampedArray {
  const phase = phaseShift / 360;
  const reps = Math.max(0.01, cycleRepetitions);
  const keep = blendWithOriginal < 0 ? 0 : blendWithOriginal > 1 ? 1 : blendWithOriginal;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    const t = luma(r, g, b) / 255;

    // Wrap into 0..1. `% 1` alone leaves negatives negative, and a negative
    // phase is exactly what a keyframe scrubbing backwards produces.
    let u = (t * reps + phase) % 1;
    if (u < 0) u += 1;

    const [pr, pg, pb] = samplePalette(stops, u);
    data[i] = pr + (r - pr) * keep;
    data[i + 1] = pg + (g - pg) * keep;
    data[i + 2] = pb + (b - pb) * keep;
  }
  return data;
}
