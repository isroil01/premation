/**
 * Colour Correction, round four — the eight that need the PIXELS.
 *
 * ## Why none of these is a LUT
 *
 * `colorLut.ts` is the free path: a per-channel transfer table, uploaded once,
 * evaluated on both backends with no CPU bake. Its entry rule is strict — each
 * output channel may depend on its own input channel ONLY — and it takes the
 * `Effect` alone, never the image.
 *
 * Every effect here fails that rule, in one of two ways, and the distinction is
 * worth stating because filing one of these as a LUT renders SILENTLY WRONG
 * rather than failing:
 *
 *   · **Needs the histogram.** Equalize, Auto Levels, Auto Contrast and Auto
 *     Color derive their mapping FROM the image. A table built from params
 *     alone cannot express "stretch to whatever this frame's black point is".
 *   · **Cross-channel.** Change Color, Change To Color, Leave Color and Toner
 *     all decide per pixel using hue or luminance, which reads all three
 *     channels to produce each one.
 *
 * So all eight are Canvas2D pixel passes and pay for a bake. That is the
 * correct price for them, not an implementation shortcut.
 *
 * ## Auto-anything and temporal stability
 *
 * The three Auto effects re-derive their mapping every frame. On a shot with
 * changing content that makes the grade BREATHE — the correction moves because
 * the histogram moved, not because the scene did. AE has the same problem and
 * the same answer, which is why each carries a `blend` (Blend With Original)
 * and the clip percentages default low: the intended use is a starting point a
 * human then pins down, not a set-and-forget grade. Said here because the
 * parameter that fixes it is not obviously the parameter that causes it.
 */

import { clamp255, clamp01, luma, rgbToHsl, hslToRgb, hueDistance, smoothstep } from './colorSpace';

/** A per-channel 256-entry map, applied in place. Alpha untouched. */
function applyTables(
  data: Uint8ClampedArray,
  rT: Uint8Array,
  gT: Uint8Array,
  bT: Uint8Array,
  blend: number,
): Uint8ClampedArray {
  // `blend` is Blend With Original as a PERCENT of the original, matching AE:
  // 0 = fully corrected, 100 = untouched. Applied here rather than in each
  // builder so every effect in this file blends identically.
  const k = clamp01(1 - blend / 100);
  if (k <= 0) return data;
  for (let i = 0; i < data.length; i += 4) {
    // A fully transparent pixel has no meaningful colour; leaving it alone
    // keeps the correction from inventing fringe in the transparent region
    // that a later composite would then pull in.
    if (data[i + 3] === 0) continue;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    data[i] = r + (rT[r]! - r) * k;
    data[i + 1] = g + (gT[g]! - g) * k;
    data[i + 2] = b + (bT[b]! - b) * k;
  }
  return data;
}

/** 256-bin histograms of the three channels, ignoring transparent pixels. */
function histograms(data: Uint8ClampedArray): [Uint32Array, Uint32Array, Uint32Array, number] {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    // Transparent pixels carry whatever colour happened to be under them and
    // would drag the black point to garbage — a layer with a large transparent
    // margin is the common case, not an edge case.
    if (data[i + 3] === 0) continue;
    r[data[i]!]!++;
    g[data[i + 1]!]!++;
    b[data[i + 2]!]!++;
    n++;
  }
  return [r, g, b, n];
}

/**
 * The value below which `frac` of the population lies.
 *
 * Only ever returns a bin that actually HAS pixels in it. That guard is not
 * cosmetic: at `frac = 0` the target is 0 and `acc >= 0` is true before any
 * pixel has been counted, so the naive loop returns bin 0 whatever the image
 * contains. Every clip of 0% — which is a perfectly ordinary setting, and the
 * one Auto Contrast defaults near — would then stretch from black instead of
 * from the real black point, and a flat grey frame (min = max) would blow to
 * white rather than staying put.
 */
function percentile(hist: Uint32Array, total: number, frac: number): number {
  if (total <= 0) return 0;
  const target = total * clamp01(frac);
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i]!;
    if (acc >= target && hist[i]! > 0) return i;
  }
  return 255;
}

/** A linear black/white stretch as a table. */
function stretchTable(lo: number, hi: number): Uint8Array {
  const t = new Uint8Array(256);
  // A flat channel (lo === hi) must map to ITSELF, not to a full-range ramp:
  // stretching a constant is a division by zero, and the "obvious" guard of
  // returning identity-black turns a solid colour into solid black.
  const span = hi - lo;
  if (span <= 0) {
    for (let i = 0; i < 256; i++) t[i] = i;
    return t;
  }
  for (let i = 0; i < 256; i++) t[i] = clamp255(((i - lo) / span) * 255);
  return t;
}

/**
 * Identity table.
 *
 * Exported rather than deleted: nothing in this module calls it yet, which
 * `noUnusedLocals` reports as an error, and an unwired helper in new work is
 * more likely to be waiting for its caller than to be genuinely dead.
 */
export function identity(): Uint8Array {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = i;
  return t;
}

// ── Equalize ────────────────────────────────────────────────────────

/**
 * Equalize — redistribute tones so the histogram is flat.
 *
 * `mode` 0 = RGB (each channel equalized independently), 1 = Brightness (one
 * curve from the luminance histogram, applied to all three).
 *
 * The two are genuinely different effects and the distinction is the reason
 * both exist: per-channel equalization moves the channels by different amounts,
 * which SHIFTS HUE — often violently, and that colour-twisted look is exactly
 * what people reach for Equalize RGB to get. Brightness mode preserves the
 * ratio between channels, so it opens up contrast without touching colour.
 * Collapsing them to one control would silently pick a look.
 */
export function equalizeData(
  data: Uint8ClampedArray,
  mode: number,
  amount: number,
  blend: number,
): Uint8ClampedArray {
  const [rh, gh, bh, n] = histograms(data);
  if (n === 0) return data;

  const cdfTable = (hist: Uint32Array): Uint8Array => {
    const t = new Uint8Array(256);
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i]!;
      t[i] = clamp255((acc / n) * 255);
    }
    return t;
  };

  // `amount` dials the equalization toward identity so it can be keyframed up
  // from nothing — a hard on/off would make it unusable as an animated reveal.
  const k = clamp01(amount / 100);
  const mix = (t: Uint8Array): Uint8Array => {
    const out = new Uint8Array(256);
    for (let i = 0; i < 256; i++) out[i] = clamp255(i + (t[i]! - i) * k);
    return out;
  };

  if (Math.round(mode) === 1) {
    const lh = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      lh[Math.round(clamp255(luma(data[i]!, data[i + 1]!, data[i + 2]!)))]!++;
    }
    const t = mix(cdfTable(lh));
    // One curve on all three channels: the SAME table object three times is
    // what makes this hue-preserving, and is the entire difference from RGB
    // mode above.
    return applyTables(data, t, t, t, blend);
  }
  return applyTables(data, mix(cdfTable(rh)), mix(cdfTable(gh)), mix(cdfTable(bh)), blend);
}

// ── Auto Levels / Auto Contrast / Auto Color ────────────────────────

/**
 * Auto Levels — stretch each channel to full range independently.
 *
 * Per-channel is what removes a colour cast (a blue-heavy shot has its blue
 * channel stretched least), and equally what can introduce one on footage
 * that legitimately lacks a colour. Auto Contrast below is the same operation
 * with that behaviour deliberately removed.
 */
export function autoLevelsData(
  data: Uint8ClampedArray,
  blackClip: number,
  whiteClip: number,
  blend: number,
): Uint8ClampedArray {
  const [rh, gh, bh, n] = histograms(data);
  if (n === 0) return data;
  const lo = clamp01(blackClip / 100);
  const hi = 1 - clamp01(whiteClip / 100);
  return applyTables(
    data,
    stretchTable(percentile(rh, n, lo), percentile(rh, n, hi)),
    stretchTable(percentile(gh, n, lo), percentile(gh, n, hi)),
    stretchTable(percentile(bh, n, lo), percentile(bh, n, hi)),
    blend,
  );
}

/**
 * Auto Contrast — stretch all three channels by the SAME amount.
 *
 * One black point and one white point, taken across the combined population, so
 * the ratio between channels is untouched and no colour cast is created or
 * removed. This is the safe one, and the reason to keep it separate from Auto
 * Levels rather than exposing a "preserve colour" checkbox: the checkbox would
 * imply the two are variants of one operation, when the choice is really which
 * failure you would rather have.
 */
export function autoContrastData(
  data: Uint8ClampedArray,
  blackClip: number,
  whiteClip: number,
  blend: number,
): Uint8ClampedArray {
  const [rh, gh, bh, n] = histograms(data);
  if (n === 0) return data;
  const all = new Uint32Array(256);
  for (let i = 0; i < 256; i++) all[i] = rh[i]! + gh[i]! + bh[i]!;
  const total = n * 3;
  const lo = percentile(all, total, clamp01(blackClip / 100));
  const hi = percentile(all, total, 1 - clamp01(whiteClip / 100));
  const t = stretchTable(lo, hi);
  return applyTables(data, t, t, t, blend);
}

/**
 * Auto Color — stretch per channel, then pull the midtones toward neutral grey.
 *
 * The midtone pull is what separates this from Auto Levels: a stretch fixes the
 * ENDS of each channel, but a cast that lives in the middle of the range
 * survives it untouched. `snapNeutral` is that correction as a gamma per
 * channel, chosen so each channel's median lands on the combined median.
 */
export function autoColorData(
  data: Uint8ClampedArray,
  blackClip: number,
  whiteClip: number,
  snapNeutral: number,
  blend: number,
): Uint8ClampedArray {
  const [rh, gh, bh, n] = histograms(data);
  if (n === 0) return data;
  const lo = clamp01(blackClip / 100);
  const hi = 1 - clamp01(whiteClip / 100);

  const build = (hist: Uint32Array): Uint8Array => {
    const table = stretchTable(percentile(hist, n, lo), percentile(hist, n, hi));
    return table;
  };
  const rT = build(rh), gT = build(gh), bT = build(bh);

  const strength = clamp01(snapNeutral / 100);
  if (strength > 0) {
    // Medians AFTER the stretch — correcting toward a target measured before it
    // would fight the stretch rather than finish it.
    const medOf = (hist: Uint32Array, table: Uint8Array): number => {
      const post = new Uint32Array(256);
      for (let i = 0; i < 256; i++) post[table[i]!] = post[table[i]!]! + hist[i]!;
      return percentile(post, n, 0.5);
    };
    const mr = medOf(rh, rT), mg = medOf(gh, gT), mb = medOf(bh, bT);
    const target = (mr + mg + mb) / 3;
    const gammaFor = (median: number): number => {
      // Solve m^(1/γ) = t in 0..1. Guarded away from the ends where the log is
      // undefined and the correction is meaningless anyway.
      const m = clamp01(median / 255), t = clamp01(target / 255);
      if (m <= 0.001 || m >= 0.999 || t <= 0.001 || t >= 0.999) return 1;
      const g = Math.log(m) / Math.log(t);
      return Math.min(3, Math.max(1 / 3, g));
    };
    const warp = (table: Uint8Array, gamma: number): void => {
      const g = 1 + (gamma - 1) * strength;
      if (Math.abs(g - 1) < 1e-4) return;
      for (let i = 0; i < 256; i++) table[i] = clamp255(Math.pow(table[i]! / 255, 1 / g) * 255);
    };
    warp(rT, gammaFor(mr));
    warp(gT, gammaFor(mg));
    warp(bT, gammaFor(mb));
  }
  return applyTables(data, rT, gT, bT, blend);
}

// ── Change Color ────────────────────────────────────────────────────

/**
 * Change Color — shift hue/saturation/lightness of pixels NEAR a target colour.
 *
 * Selection is a soft radius in hue with independent saturation and lightness
 * tolerances, because a hue-only test selects the whole red family including
 * near-black and near-white pixels whose hue is numerically red but visually
 * meaningless. Excluding those is what stops the effect crawling into shadows.
 */
export function changeColorData(
  data: Uint8ClampedArray,
  target: [number, number, number],
  hueTol: number,
  satTol: number,
  lightTol: number,
  softness: number,
  hueShift: number,
  satScale: number,
  lightScale: number,
  invert: boolean,
): Uint8ClampedArray {
  const [th, ts, tl] = rgbToHsl(target[0], target[1], target[2]);
  const hT = clamp01(hueTol / 100) * 0.5;
  const sT = clamp01(satTol / 100);
  const lT = clamp01(lightTol / 100);
  const soft = clamp01(softness / 100);

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const [h, s, l] = rgbToHsl(data[i]!, data[i + 1]!, data[i + 2]!);
    // Three independent soft tests multiplied together. Multiplying rather than
    // taking a min means a pixel marginal on two axes is selected less than one
    // marginal on a single axis, which is what makes the edge look like a
    // matte rather than a stencil.
    const dh = 1 - smoothstep(hT * (1 - soft), hT, hueDistance(h, th));
    const ds = 1 - smoothstep(sT * (1 - soft), sT, Math.abs(s - ts));
    const dl = 1 - smoothstep(lT * (1 - soft), lT, Math.abs(l - tl));
    let m = dh * ds * dl;
    if (invert) m = 1 - m;
    if (m <= 0) continue;

    const nh = (h + hueShift / 360 + 1) % 1;
    const ns = clamp01(s * (1 + satScale / 100));
    const nl = clamp01(l * (1 + lightScale / 100));
    const [r2, g2, b2] = hslToRgb(nh, ns, nl);
    data[i] = data[i]! + (r2 - data[i]!) * m;
    data[i + 1] = data[i + 1]! + (g2 - data[i + 1]!) * m;
    data[i + 2] = data[i + 2]! + (b2 - data[i + 2]!) * m;
  }
  return data;
}

// ── Change To Color ─────────────────────────────────────────────────

/**
 * Change To Color — map one colour ONTO another, preserving shading.
 *
 * The difference from Change Color, and the reason both exist: this one takes a
 * destination colour rather than a hue rotation, and transfers the source
 * pixel's own lightness onto it. Recolouring a blue shirt red keeps every fold
 * and highlight, where a flat replacement would give a red silhouette.
 */
export function changeToColorData(
  data: Uint8ClampedArray,
  from: [number, number, number],
  to: [number, number, number],
  hueTol: number,
  satTol: number,
  lightTol: number,
  softness: number,
  preserveLightness: boolean,
): Uint8ClampedArray {
  const [fh, fs, fl] = rgbToHsl(from[0], from[1], from[2]);
  const [dh, ds, dl] = rgbToHsl(to[0], to[1], to[2]);
  const hT = clamp01(hueTol / 100) * 0.5;
  const sT = clamp01(satTol / 100);
  const lT = clamp01(lightTol / 100);
  const soft = clamp01(softness / 100);

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const [h, s, l] = rgbToHsl(data[i]!, data[i + 1]!, data[i + 2]!);
    const mh = 1 - smoothstep(hT * (1 - soft), hT, hueDistance(h, fh));
    const ms = 1 - smoothstep(sT * (1 - soft), sT, Math.abs(s - fs));
    const ml = 1 - smoothstep(lT * (1 - soft), lT, Math.abs(l - fl));
    const m = mh * ms * ml;
    if (m <= 0) continue;

    // Carry the pixel's OWN lightness, offset so the matched colour lands
    // exactly on the destination. Without the offset every shaded pixel drifts
    // toward the target's lightness and the shading flattens out.
    const nl = preserveLightness ? clamp01(l + (dl - fl)) : dl;
    const [r2, g2, b2] = hslToRgb(dh, ds, nl);
    data[i] = data[i]! + (r2 - data[i]!) * m;
    data[i + 1] = data[i + 1]! + (g2 - data[i + 1]!) * m;
    data[i + 2] = data[i + 2]! + (b2 - data[i + 2]!) * m;
  }
  return data;
}

// ── Leave Color ─────────────────────────────────────────────────────

/**
 * Leave Color — desaturate everything EXCEPT what matches the target.
 *
 * The selective-colour "one red umbrella" shot. Implemented as the complement
 * of the same soft selection the two above use, so the three agree about what
 * "close to this colour" means — three different tolerance models across three
 * neighbouring effects is a support burden with no upside.
 */
export function leaveColorData(
  data: Uint8ClampedArray,
  target: [number, number, number],
  tolerance: number,
  softness: number,
  amount: number,
): Uint8ClampedArray {
  const [th] = rgbToHsl(target[0], target[1], target[2]);
  const tol = clamp01(tolerance / 100) * 0.5;
  const soft = clamp01(softness / 100);
  const strength = clamp01(amount / 100);

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    const [h] = rgbToHsl(r, g, b);
    const keep = 1 - smoothstep(tol * (1 - soft), tol, hueDistance(h, th));
    const drain = (1 - keep) * strength;
    if (drain <= 0) continue;
    const y = luma(r, g, b);
    data[i] = r + (y - r) * drain;
    data[i + 1] = g + (y - g) * drain;
    data[i + 2] = b + (y - b) * drain;
  }
  return data;
}

// ── Toner ───────────────────────────────────────────────────────────

/**
 * Toner — remap the tonal range through five colour stops.
 *
 * Black → Shadows → Midtones → Highlights → White, positioned at 0, ¼, ½, ¾, 1
 * of luminance and interpolated linearly. This is the duotone/split-tone grade;
 * Tritone (three stops) is the same idea and is kept separate because five
 * stops is what makes a believable film emulation and three is what makes a
 * poster.
 */
export function tonerData(
  data: Uint8ClampedArray,
  black: [number, number, number],
  shadows: [number, number, number],
  midtones: [number, number, number],
  highlights: [number, number, number],
  white: [number, number, number],
  blend: number,
): Uint8ClampedArray {
  const stops = [black, shadows, midtones, highlights, white];
  // Precomputed 256-entry ramp: the interpolation is identical for every pixel,
  // so doing it per pixel would be four multiplies and a branch wasted on each.
  const rT = new Uint8Array(256), gT = new Uint8Array(256), bT = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const p = (i / 255) * 4;
    const idx = Math.min(3, Math.floor(p));
    const f = p - idx;
    const a = stops[idx]!, b = stops[idx + 1]!;
    rT[i] = clamp255(a[0] + (b[0] - a[0]) * f);
    gT[i] = clamp255(a[1] + (b[1] - a[1]) * f);
    bT[i] = clamp255(a[2] + (b[2] - a[2]) * f);
  }
  const k = clamp01(1 - blend / 100);
  if (k <= 0) return data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    // Indexed by LUMINANCE, not per channel — that is what makes this a tone
    // map rather than three unrelated curves, and why it cannot be a LUT.
    const y = Math.round(clamp255(luma(r, g, b)));
    data[i] = r + (rT[y]! - r) * k;
    data[i + 1] = g + (gT[y]! - g) * k;
    data[i + 2] = b + (bT[y]! - b) * k;
  }
  return data;
}
