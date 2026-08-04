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
 *
 * ── Membership IS the builder table ─────────────────────────────────────────
 *
 * This was a Set beside a separate `tableFor` if-chain that fell through to
 * `return null`. A type in the Set but missing from the chain reported
 * `needs.colorLut`, animated its parameters, and rendered nothing. Lumetri
 * would have been the first to hit it; last run guarded that behaviourally,
 * and this replaces the guard with a shape where the bug cannot be written.
 */
const LUT_BUILDERS: ReadonlyMap<EffectType, (effect: Effect) => ChannelLut> =
  new Map<EffectType, (effect: Effect) => ChannelLut>([
    ['levels', (e) => uniform(levelsTable(
      effectNumber(e, 'inputBlack'),
      effectNumber(e, 'inputWhite'),
      effectNumber(e, 'gamma'),
      effectNumber(e, 'outputBlack'),
      effectNumber(e, 'outputWhite'),
    ))],
    ['curves', (e) => curvesTables(e)],
    ['posterize', (e) => uniform(posterizeTable(effectNumber(e, 'levels')))],
    ['exposure', (e) => uniform(exposureTable(
      effectNumber(e, 'exposure'),
      effectNumber(e, 'offset'),
      effectNumber(e, 'gammaCorrection'),
    ))],
    // Lumetri qualifies on the SHAPE rule above, which is worth spelling out
    // because "eight controls including a white balance" does not sound like a
    // per-channel table. Every one of its controls is:
    //   • exposure / contrast / highlights / shadows / whites / blacks — one tone
    //     transfer applied identically to all three channels;
    //   • temperature / tint — a constant per-channel GAIN, which is the textbook
    //     case of channel-independent.
    // Nothing in it reads a second channel to decide what to do with the first,
    // so it renders on both backends with no bake, like the other four.
    ['lumetri', (e) => lumetriTables(e)],
  ]);

export function isLutEffect(type: EffectType): boolean {
  return LUT_BUILDERS.has(type);
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

/**
 * Read one Curves control-point param, or null when it would not change
 * anything.
 *
 * Null covers BOTH "absent or malformed" and "still the identity ramp", and
 * conflating them is deliberate: `defaultParams` fills all four curve params
 * in, so an untouched per-channel curve arrives as a real, well-formed
 * `[[0,0],[255,255]]` and a presence check would never skip it. The identity
 * check is what makes the ordinary case — an RGB curve and three untouched
 * channels — cost what it did before the channels existed.
 */
function curvePoints(effect: Effect, key: string): [number, number][] | null {
  const raw = (effect.params as Record<string, unknown> | undefined)?.[key];
  if (!Array.isArray(raw)) return null;
  const pts = raw
    .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number'))
    .map((p) => [p[0], p[1]] as [number, number]);
  if (pts.length < 2) return null;
  const isIdentityRamp =
    pts.length === 2 &&
    pts[0]![0] === 0 && pts[0]![1] === 0 &&
    pts[1]![0] === 255 && pts[1]![1] === 255;
  return isIdentityRamp ? null : pts;
}

/**
 * Curves, per channel.
 *
 * The composite curve (`points`) runs FIRST on all three, then each channel's
 * own curve composes on top of that channel's result — the same order AE uses,
 * and the reason it is the only order that behaves: a per-channel curve is
 * authored against what the composite already did, so running it first would
 * make the composite silently re-grade the correction you just made.
 *
 * A channel with no curve of its own is left at the composite's output rather
 * than reset to identity.
 */
function curvesTables(effect: Effect): ChannelLut {
  const composite = curvePoints(effect, 'points');
  const base = composite ? curvesTable(composite) : identityTable();
  const perChannel = (key: string): Uint8Array => {
    const pts = curvePoints(effect, key);
    if (!pts) return base;
    const own = curvesTable(pts);
    const out = new Uint8Array(256);
    for (let i = 0; i < 256; i++) out[i] = own[base[i]!]!;
    return out;
  };
  return {
    r: perChannel('redPoints'),
    g: perChannel('greenPoints'),
    b: perChannel('bluePoints'),
  };
}

/** The same table on all three channels — the shape most LUT effects have. */
function uniform(t: Uint8Array): ChannelLut {
  return { r: t, g: t, b: t };
}

/**
 * A tone-range weight: 1 at `edge`, falling to ~0 over `width`.
 *
 * Gaussian rather than linear so the four tone controls overlap smoothly and a
 * Shadows push does not leave a visible seam where its influence stops.
 */
function toneWeight(x: number, edge: 0 | 1, width: number): number {
  const d = (edge === 0 ? x : 1 - x) / width;
  return Math.exp(-d * d);
}

/**
 * Lumetri "Basic Correction", as per-channel transfer tables.
 *
 * The chain, in the order it must run:
 *
 *   1. white balance   a per-channel gain (temperature warms R / cools B, tint
 *                      trades G against magenta). FIRST, because everything
 *                      after it is a tone decision that should be made on
 *                      already-neutral material — which is exactly why a
 *                      colourist sets WB before touching exposure.
 *   2. exposure        multiplicative, in STOPS (2^n), like Exposure's gain.
 *   3. contrast        a pivot around mid-grey, so it tilts rather than lifts.
 *   4. tone ranges     shadows / highlights (wide) and blacks / whites (narrow)
 *                      as additive, weighted pushes.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 *
 * Premiere's Lumetri computes Highlights/Shadows against a pixel's LUMINANCE,
 * which needs all three channels and would disqualify this from the LUT family
 * entirely. This applies the same tone transfer per channel instead. On neutral
 * and near-neutral material the two agree; on a heavily saturated pixel this
 * one moves the dominant channel further than a luma-weighted version would,
 * which reads as a slight saturation shift alongside the tone move.
 *
 * That trade is deliberate and is the reason the effect is worth having here:
 * the luma-accurate version costs every layer carrying it a full CPU bake, and
 * this is a grading control people leave switched on for the whole comp. If the
 * exact Premiere response is ever needed it belongs as a SEPARATE pixel-pass
 * effect, not as a change here — moving this out of `LUT_EFFECTS` would silently
 * make every existing project that uses it slower.
 */
function lumetriTables(effect: Effect): ChannelLut {
  const exposure = effectNumber(effect, 'exposure');
  const contrast = effectNumber(effect, 'contrast');
  const highlights = effectNumber(effect, 'highlights') / 100;
  const shadows = effectNumber(effect, 'shadows') / 100;
  const whites = effectNumber(effect, 'whites') / 100;
  const blacks = effectNumber(effect, 'blacks') / 100;
  const temperature = effectNumber(effect, 'temperature') / 100;
  const tint = effectNumber(effect, 'tint') / 100;

  const gain = Math.pow(2, exposure);
  const k = 1 + contrast / 100;
  // ±0.3 at full deflection: enough to correct a badly-lit plate, not so much
  // that the slider's usable range is its first fifth.
  const wb: [number, number, number] = [
    1 + 0.3 * temperature,
    1 - 0.3 * tint,
    1 - 0.3 * temperature,
  ];

  const build = (channelGain: number): Uint8Array => {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      let x = (i / 255) * channelGain * gain;
      x = x < 0 ? 0 : x > 1 ? 1 : x;
      x = (x - 0.5) * k + 0.5;
      x = x < 0 ? 0 : x > 1 ? 1 : x;
      // Additive, weighted by where the input sits. Scaled by 0.5 so ±100 is a
      // strong correction rather than a clipped frame.
      x += 0.5 * (
        shadows * toneWeight(x, 0, 0.35) +
        blacks * toneWeight(x, 0, 0.15) +
        highlights * toneWeight(x, 1, 0.35) +
        whites * toneWeight(x, 1, 0.15)
      );
      x = x < 0 ? 0 : x > 1 ? 1 : x;
      t[i] = clamp255(Math.round(x * 255));
    }
    return t;
  };

  return { r: build(wb[0]), g: build(wb[1]), b: build(wb[2]) };
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
  // One lookup decides both membership and content, so the "listed but
  // unhandled" arm this loop used to need no longer exists.
  const active = effects
    .filter((e) => e.enabled !== false)
    .map((e) => LUT_BUILDERS.get(e.type)?.(e))
    .filter((t): t is ChannelLut => t !== undefined);
  if (active.length === 0) return null;

  const lut: ChannelLut = { r: identityTable(), g: identityTable(), b: identityTable() };
  for (const tables of active) {
    // Compose: later effects look up the previous effect's output, per channel.
    for (let i = 0; i < 256; i++) {
      lut.r[i] = tables.r[lut.r[i]!]!;
      lut.g[i] = tables.g[lut.g[i]!]!;
      lut.b[i] = tables.b[lut.b[i]!]!;
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
