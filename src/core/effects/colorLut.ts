/**
 * Per-channel colour lookup tables (LUTs) for the effects that CSS `filter`
 * and the 3×3 colour matrix can't express — Levels and Curves.
 *
 * These map each 0–255 input value to an output per RGB channel. They are the
 * mechanism the audit's Tier-4 colour work needed: brightness/contrast/etc. are
 * affine (matrix / CSS), but Levels (black/white points + gamma) and Curves
 * (spline) are non-linear per-channel remaps.
 */

import type { Effect, EffectType } from './effects';
import { effectNumber } from './effects';

/** 256-entry output tables, one per channel. */
export interface ChannelLut {
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
}

/**
 * Effects expressible as a per-channel 0–255 transfer function.
 *
 * Membership here is worth more than it looks: everything in this set renders on
 * BOTH backends with NO CPU bake. `MotionRendererBackend` filters by
 * `isLutEffect` and uploads the composed table, `snapshotToFrameScene` flags the
 * layer, `capabilities` declares the need. An effect that fits this shape
 * belongs here rather than in the Canvas2D pixel-pass family — the pixel pass
 * would work, but it would drag the whole layer onto the CPU to do something the
 * GPU already does.
 *
 * The SHAPE is the entry requirement: each channel must map independently, with
 * no reference to the other two. Exposure qualifies. Vibrance does not — its
 * strength depends on the pixel's existing saturation, which needs all three
 * channels — which is why that one is a pixel pass despite also being "a colour
 * effect". Getting that wrong gives an effect that is subtly not the effect.
 */
const LUT_EFFECTS: ReadonlySet<EffectType> = new Set<EffectType>([
  'levels',
  'curves',
  'posterize',
  'exposure',
]);

export function isLutEffect(type: EffectType): boolean {
  return LUT_EFFECTS.has(type);
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Identity table (input === output). */
function identityTable(): Uint8Array {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = i;
  return t;
}

/**
 * A Levels remap as a single-channel table.
 *
 * out = outBlack + (outWhite − outBlack) · clamp((in − inBlack)/(inWhite − inBlack))^(1/gamma)
 *
 * All points are 0–255; gamma is the midtone control (>1 brightens midtones).
 */
function levelsTable(inBlack: number, inWhite: number, gamma: number, outBlack: number, outWhite: number): Uint8Array {
  const t = new Uint8Array(256);
  const span = Math.max(1e-6, inWhite - inBlack);
  const g = 1 / Math.max(1e-3, gamma);
  for (let i = 0; i < 256; i++) {
    let n = (i - inBlack) / span;
    n = n < 0 ? 0 : n > 1 ? 1 : n;
    n = Math.pow(n, g);
    t[i] = clamp255(Math.round(outBlack + n * (outWhite - outBlack)));
  }
  return t;
}

/**
 * A monotone Curves remap through the control points, as a single-channel table.
 *
 * Points are `[inputX, outputY]` pairs in 0–255, sorted by X. Segments use
 * Catmull–Rom (cubic Hermite with finite-difference tangents) so midtones roll
 * instead of kink at every control point — the AE Curves feel. Endpoints clamp
 * their missing neighbours so the curve stays well-defined with 2+ points.
 * Output is clamped 0–255; tangents are scaled so a monotone control polygon
 * stays nearly monotone in practice.
 */
function curvesTable(points: ReadonlyArray<[number, number]>): Uint8Array {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return identityTable();
  const t = new Uint8Array(256);
  const n = pts.length;
  const tangents: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[Math.max(0, i - 1)]!;
    const [x1, y1] = pts[Math.min(n - 1, i + 1)]!;
    const dx = x1 - x0;
    tangents[i] = dx === 0 ? 0 : (y1 - y0) / dx;
  }
  let seg = 0;
  for (let i = 0; i < 256; i++) {
    while (seg < n - 2 && i > pts[seg + 1]![0]) seg++;
    const [x0, y0] = pts[seg]!;
    const [x1, y1] = pts[seg + 1]!;
    const dx = x1 - x0;
    const u = dx <= 0 ? 0 : Math.max(0, Math.min(1, (i - x0) / dx));
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    const m0 = tangents[seg]! * dx;
    const m1 = tangents[seg + 1]! * dx;
    t[i] = clamp255(Math.round(h00 * y0 + h10 * m0 + h01 * y1 + h11 * m1));
  }
  return t;
}

/**
 * A Posterize remap: quantise each channel to `n` evenly-spaced output levels
 * (n≥2). in → nearest of n bands, expanded back across 0–255. n=2 → hard
 * two-tone per channel; large n → near-identity.
 */
function posterizeTable(levels: number): Uint8Array {
  const n = Math.max(2, Math.min(255, Math.round(levels)));
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const band = Math.round((i / 255) * (n - 1));
    t[i] = clamp255(Math.round((band / (n - 1)) * 255));
  }
  return t;
}

/** Read a Curves effect's control points from its params (or a default ramp). */
function curvePoints(effect: Effect): [number, number][] {
  const raw = (effect.params as Record<string, unknown> | undefined)?.points;
  if (Array.isArray(raw)) {
    const pts = raw
      .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number'))
      .map((p) => [p[0], p[1]] as [number, number]);
    if (pts.length >= 2) return pts;
  }
  return [[0, 0], [255, 255]];
}

/** The single-channel table for one LUT effect, or null if it isn't one. */
function tableFor(effect: Effect): Uint8Array | null {
  if (effect.type === 'levels') {
    return levelsTable(
      effectNumber(effect, 'inputBlack'),
      effectNumber(effect, 'inputWhite'),
      effectNumber(effect, 'gamma'),
      effectNumber(effect, 'outputBlack'),
      effectNumber(effect, 'outputWhite'),
    );
  }
  if (effect.type === 'curves') return curvesTable(curvePoints(effect));
  if (effect.type === 'posterize') return posterizeTable(effectNumber(effect, 'levels'));
  if (effect.type === 'exposure') {
    return exposureTable(
      effectNumber(effect, 'exposure'),
      effectNumber(effect, 'offset'),
      effectNumber(effect, 'gammaCorrection'),
    );
  }
  return null;
}

/**
 * Exposure, as a transfer table.
 *
 * AE's three controls, in the order they apply:
 *
 *   linear = (in/255) · 2^exposure      — exposure is in STOPS, so +1 doubles
 *                                          the light. That is the whole reason
 *                                          the control is worth having over
 *                                          Brightness: it is multiplicative, so
 *                                          it behaves like a camera rather than
 *                                          washing the blacks up off zero.
 *   linear += offset                    — an additive lift, applied AFTER the
 *                                          gain. This one does move black, and
 *                                          is what you reach for to flatten a
 *                                          contrasty plate.
 *   out    = linear^(1/gamma)           — the midtone bend, last.
 *
 * Order matters and is not interchangeable: offset before the gain would be
 * multiplied by it, and a gamma applied first would be undone by the gain.
 */
function exposureTable(stops: number, offset: number, gamma: number): Uint8Array {
  const t = new Uint8Array(256);
  const gain = Math.pow(2, stops);
  // Guard the reciprocal: gamma 0 is reachable from the inspector and would
  // otherwise produce Infinity and a table of NaN, which clamps to a black frame.
  const invGamma = gamma > 0.0001 ? 1 / gamma : 1;
  for (let i = 0; i < 256; i++) {
    const linear = (i / 255) * gain + offset;
    // Math.pow of a negative base with a fractional exponent is NaN, so the
    // clamp has to happen BEFORE the gamma, not after. A negative offset makes
    // this reachable for real inputs, not just pathological ones.
    const clamped = linear < 0 ? 0 : linear > 1 ? 1 : linear;
    t[i] = clamp255(Math.round(Math.pow(clamped, invGamma) * 255));
  }
  return t;
}

/**
 * Compose the LUT effects in a stack (in order) into one per-channel table.
 * Returns null when the stack has no enabled LUT effect, so the caller can skip
 * the per-pixel pass entirely.
 */
export function buildChannelLut(effects: ReadonlyArray<Effect>): ChannelLut | null {
  const active = effects.filter((e) => e.enabled !== false && isLutEffect(e.type));
  if (active.length === 0) return null;

  const lut: ChannelLut = { r: identityTable(), g: identityTable(), b: identityTable() };
  for (const e of active) {
    const table = tableFor(e);
    if (!table) continue;
    // Compose: later effects look up the previous effect's output.
    for (let i = 0; i < 256; i++) {
      lut.r[i] = table[lut.r[i]!]!;
      lut.g[i] = table[lut.g[i]!]!;
      lut.b[i] = table[lut.b[i]!]!;
    }
  }
  return lut;
}

/** Apply a channel LUT to RGBA pixel data in place (alpha untouched). */
export function applyChannelLut(data: Uint8ClampedArray, lut: ChannelLut): void {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut.r[data[i]!]!;
    data[i + 1] = lut.g[data[i + 1]!]!;
    data[i + 2] = lut.b[data[i + 2]!]!;
  }
}
