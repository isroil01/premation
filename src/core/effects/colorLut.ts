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

const LUT_EFFECTS: ReadonlySet<EffectType> = new Set<EffectType>(['levels', 'curves', 'posterize']);

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
 * Points are `[inputX, outputY]` pairs in 0–255, sorted by X. Segments are
 * linearly interpolated (a spline is a later refinement — linear already gives
 * the essential tone-curve control, and stays monotone by construction).
 */
function curvesTable(points: ReadonlyArray<[number, number]>): Uint8Array {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return identityTable();
  const t = new Uint8Array(256);
  let seg = 0;
  for (let i = 0; i < 256; i++) {
    while (seg < pts.length - 2 && i > pts[seg + 1]![0]) seg++;
    const [x0, y0] = pts[seg]!;
    const [x1, y1] = pts[seg + 1]!;
    const dx = x1 - x0;
    const f = dx <= 0 ? 0 : (i - x0) / dx;
    t[i] = clamp255(Math.round(y0 + (y1 - y0) * Math.max(0, Math.min(1, f))));
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
  return null;
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
