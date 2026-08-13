/**
 * Transition, round four — Iris Wipe, Light Wipe, Line Sweep, Grid Wipe — plus
 * the two noise effects that also work on coverage, Dust & Scratches and
 * Noise Alpha.
 *
 * ## Transitions are ALPHA-only reveals
 *
 * Like Linear Wipe, Radial Wipe and Venetian Blinds before them, these compute
 * a coverage value per pixel and multiply it into the existing alpha. They
 * never touch RGB, with one deliberate exception (Light Wipe's leading edge
 * glows, which is the whole point of it), and they never REPLACE alpha —
 * multiplying preserves whatever matte the layer already carried, so a wipe
 * over a keyed subject wipes the subject rather than resurrecting its
 * background.
 *
 * ## `completion` is always 0→100 and always means "how much is GONE"
 *
 * Matching the existing wipes. Getting this backwards on one member of the
 * family is the kind of inconsistency that makes a transition library
 * unusable — every one of these is keyframed 0→100 and must clear the frame in
 * the same direction.
 */

import { clamp01, clamp255, smoothstep } from './colorSpace';

/** Deterministic 0..1 hash of two integers. */
function hash2(a: number, b: number): number {
  let n = (a * 374761393 + b * 668265263) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

// ── Iris Wipe ───────────────────────────────────────────────────────

/**
 * Iris Wipe — a polygonal or circular aperture opening from a point.
 *
 * `points` < 3 gives a circle; 3+ builds a regular polygon by its apothem, the
 * same construction Camera Lens Blur uses for its iris and for the same reason:
 * an exact inside-test that degenerates smoothly to a circle as the count
 * rises, so the control has no discontinuity in the middle of its range.
 *
 * `useInnerRadius` turns the solid iris into a RING, which is what makes the
 * classic "iris out to a ring and away" transition possible in one effect.
 */
export function irisWipeData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  completion: number,
  centerX: number,
  centerY: number,
  points: number,
  rotation: number,
  innerRadius: number,
  useInnerRadius: boolean,
  feather: number,
  invert: boolean,
): Uint8ClampedArray {
  const t = clamp01(completion / 100);
  const cx = w / 2 + centerX;
  const cy = h / 2 + centerY;
  // Reach the far corner at t = 1 so the frame is genuinely clear, not
  // *almost* clear with a sliver in the corners.
  const maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) || 1;
  const outer = t * maxR;
  const inner = useInnerRadius ? Math.min(outer, innerRadius) : 0;
  const n = Math.round(points);
  const rot = (rotation * Math.PI) / 180;
  const feath = Math.max(1e-3, feather);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const a = data[o + 3]!;
      if (a === 0) continue;
      const ox = x + 0.5 - cx, oy = y + 0.5 - cy;
      let d = Math.hypot(ox, oy);
      if (n >= 3) {
        // Normalise the radius by the polygon's edge distance in this
        // direction, so the same `d <= outer` test describes a polygon.
        const ang = Math.atan2(oy, ox) - rot;
        const seg = (Math.PI * 2) / n;
        const local = ang - seg * Math.floor(ang / seg + 0.5);
        d = (d * Math.cos(local)) / Math.cos(Math.PI / n);
      }
      // Inside the aperture is REMOVED (completion = how much is gone).
      let cover = smoothstep(outer - feath, outer + feath, d);
      if (useInnerRadius && inner > 0) {
        // Ring: the hole's centre comes back.
        cover = Math.max(cover, 1 - smoothstep(inner - feath, inner + feath, d));
      }
      if (invert) cover = 1 - cover;
      data[o + 3] = a * clamp01(cover);
    }
  }
  return data;
}

// ── Light Wipe ──────────────────────────────────────────────────────

/**
 * Light Wipe — a wipe whose leading edge BLOOMS before it clears.
 *
 * The one transition here that writes RGB, deliberately: the glow at the front
 * is the effect. Implemented as a band ahead of the wipe boundary that lifts
 * toward `color`, falling off over `intensity`-scaled width, with the clear
 * happening behind it.
 *
 * `shape` 0 = linear (angle), 1 = radial from centre. Both share the same
 * boundary/band maths so the glow behaves identically either way.
 */
export function lightWipeData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  completion: number,
  shape: number,
  angle: number,
  centerX: number,
  centerY: number,
  width: number,
  color: [number, number, number],
  intensity: number,
  feather: number,
): Uint8ClampedArray {
  const t = clamp01(completion / 100);
  const radial = Math.round(shape) === 1;
  const cx = w / 2 + centerX;
  const cy = h / 2 + centerY;
  const a = (angle * Math.PI) / 180;
  const nx = Math.cos(a), ny = Math.sin(a);
  const span = radial
    ? (Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) || 1)
    : Math.abs(w * nx) + Math.abs(h * ny);
  const front = t * (span + width);
  const band = Math.max(1e-3, width);
  const glow = clamp01(intensity / 100);
  const feath = Math.max(1e-3, feather);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const al = data[o + 3]!;
      if (al === 0) continue;
      const d = radial
        ? Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        : (x + 0.5 - (w / 2 - (nx * span) / 2)) * nx + (y + 0.5 - (h / 2 - (ny * span) / 2)) * ny;

      // Behind the front: cleared. Within `band` ahead of it: glowing.
      const cover = smoothstep(front - feath, front + feath, d);
      data[o + 3] = al * clamp01(cover);
      if (glow > 0 && cover > 0) {
        const ahead = d - front;
        if (ahead >= 0 && ahead <= band) {
          const k = (1 - ahead / band) * glow;
          data[o] = data[o]! + (color[0] - data[o]!) * k;
          data[o + 1] = data[o + 1]! + (color[1] - data[o + 1]!) * k;
          data[o + 2] = data[o + 2]! + (color[2] - data[o + 2]!) * k;
        }
      }
    }
  }
  return data;
}

// ── Line Sweep ──────────────────────────────────────────────────────

/**
 * Line Sweep — parallel lines that clear in sequence, offset along the sweep.
 *
 * Each line has its own start time staggered by its position, so the frame
 * clears as a travelling comb rather than all at once. `stagger` controls how
 * much of the total duration is spent on that offset: at 0 every line clears
 * together (a plain wipe), at 100 the last line only starts as the first
 * finishes. That range is what makes one effect cover both looks.
 */
export function lineSweepData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  completion: number,
  lineCount: number,
  angle: number,
  stagger: number,
  feather: number,
  invert: boolean,
): Uint8ClampedArray {
  const t = clamp01(completion / 100);
  const n = Math.max(1, Math.min(512, Math.round(lineCount)));
  const a = (angle * Math.PI) / 180;
  const nx = Math.cos(a), ny = Math.sin(a);
  const stag = clamp01(stagger / 100);
  const feath = Math.max(1e-3, feather / 100);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const al = data[o + 3]!;
      if (al === 0) continue;
      // Position across the lines (which line am I in) and along them.
      const across = ((x + 0.5) * -ny + (y + 0.5) * nx) / Math.max(1, Math.abs(w * ny) + Math.abs(h * nx));
      const along = ((x + 0.5) * nx + (y + 0.5) * ny) / Math.max(1, Math.abs(w * nx) + Math.abs(h * ny));
      const line = Math.floor(clamp01(across) * n);
      // Each line's window is shortened by the stagger so they still all finish
      // by t = 1; otherwise a staggered sweep would never fully clear.
      const start = (line / Math.max(1, n)) * stag;
      const localT = clamp01((t - start) / Math.max(1e-6, 1 - stag));
      // Cleared where `along` is behind this line's own front.
      let cover = smoothstep(localT - feath, localT + feath, clamp01(along));
      if (invert) cover = 1 - cover;
      data[o + 3] = al * clamp01(cover);
    }
  }
  return data;
}

// ── Grid Wipe ───────────────────────────────────────────────────────

/**
 * Grid Wipe — tiles that open outward from their own centres.
 *
 * `shape` 0 = rectangle, 1 = diamond, 2 = circle. Each tile grows its own
 * aperture, so the frame dissolves as a mesh rather than as a front. `random`
 * offsets each tile's start deterministically, which is what stops the grid
 * reading as mechanical — but is seeded from the tile index so the pattern is
 * stable across re-renders.
 */
export function gridWipeData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  completion: number,
  columns: number,
  rows: number,
  shape: number,
  random: number,
  feather: number,
  invert: boolean,
): Uint8ClampedArray {
  const t = clamp01(completion / 100);
  const cols = Math.max(1, Math.min(256, Math.round(columns)));
  const rws = Math.max(1, Math.min(256, Math.round(rows)));
  const sh = Math.round(shape);
  const rnd = clamp01(random / 100);
  const feath = Math.max(1e-3, feather / 100);
  const cw = w / cols, chh = h / rws;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const al = data[o + 3]!;
      if (al === 0) continue;
      const ci = Math.min(cols - 1, Math.floor(x / cw));
      const ri = Math.min(rws - 1, Math.floor(y / chh));
      // Stagger start, then compress the remaining window so every tile still
      // completes by t = 1 — same reasoning as Line Sweep's stagger.
      const start = hash2(ci, ri) * rnd;
      const localT = clamp01((t - start) / Math.max(1e-6, 1 - rnd));

      // Position within the tile, −1..1 from its centre.
      const u = ((x + 0.5) - (ci * cw + cw / 2)) / (cw / 2);
      const v = ((y + 0.5) - (ri * chh + chh / 2)) / (chh / 2);
      const d = sh === 1 ? Math.abs(u) + Math.abs(v)
        : sh === 2 ? Math.hypot(u, v)
        : Math.max(Math.abs(u), Math.abs(v));
      // The aperture grows to √2 so a circle/diamond still clears the corners.
      const r = localT * 1.4143;
      let cover = smoothstep(r - feath, r + feath, d);
      if (invert) cover = 1 - cover;
      data[o + 3] = al * clamp01(cover);
    }
  }
  return data;
}

// ── Dust & Scratches ────────────────────────────────────────────────

/**
 * Dust & Scratches — a median that only fires where it is NEEDED.
 *
 * The distinction from plain Median (in `stylize.ts`) is `threshold`, and it is
 * the whole effect: a median replaces every pixel and therefore softens all
 * detail. This one computes the median but only ADOPTS it where the pixel
 * differs from it by more than the threshold — so isolated specks and hairline
 * scratches (which differ wildly from their neighbourhood) are removed while
 * genuine texture (which does not) survives untouched.
 *
 * Setting `threshold` to 0 degrades to exactly Median, which is the correct
 * behaviour and a useful sanity check.
 */
export function dustAndScratchesData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
  threshold: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src);
  const r = Math.max(1, Math.min(8, Math.round(radius)));
  const thr = Math.max(0, threshold);
  const win: number[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (src[o + 3] === 0) continue;
      for (let c = 0; c < 3; c++) {
        win.length = 0;
        for (let dy = -r; dy <= r; dy++) {
          const sy = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy > r * r) continue;
            const sx = Math.min(w - 1, Math.max(0, x + dx));
            win.push(src[(sy * w + sx) * 4 + c]!);
          }
        }
        win.sort((p, q) => p - q);
        const med = win[win.length >> 1]!;
        // Only adopt the median where the pixel is an outlier.
        out[o + c] = Math.abs(src[o + c]! - med) > thr ? med : src[o + c]!;
      }
    }
  }
  return out;
}

// ── Noise Alpha ─────────────────────────────────────────────────────

/**
 * Noise Alpha — noise in the COVERAGE channel, not the colour.
 *
 * Distinct from Noise, which disturbs RGB. Perturbing alpha instead is what
 * produces a dissolve, a grain-eaten edge, or a film-burn-style hold — none of
 * which are reachable by adding noise to colour, because a fully opaque pixel
 * stays fully opaque no matter what you do to its RGB.
 *
 * `uniform` picks the distribution: uniform noise reads as digital dropout,
 * squared (`false`) clusters toward the transparent end and reads as organic
 * decay. `seed` keeps it deterministic across re-renders, and `phase` is what
 * animates it — advancing the phase re-rolls the field, so keyframing it gives
 * boiling grain while leaving it static gives a fixed texture.
 */
export function noiseAlphaData(
  data: Uint8ClampedArray,
  w: number,
  amount: number,
  uniform: boolean,
  seed: number,
  phase: number,
  clipResult: boolean,
): Uint8ClampedArray {
  const amt = clamp01(amount / 100);
  if (amt <= 0) return data;
  const sd = Math.round(seed);
  const ph = Math.round(phase);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const a = data[i + 3]!;
    if (a === 0) continue;
    const x = p % w, y = (p / w) | 0;
    let n = hash2(x + sd + ph * 7919, y - sd + ph * 104729);
    // Squared distribution clusters toward 0, i.e. toward transparent.
    if (!uniform) n = n * n;
    const v = a * (1 - amt * n);
    // `clipResult` keeps the noise inside the layer's existing coverage;
    // without it the effect can only ever REMOVE coverage, which makes it
    // useless for building a matte up from a soft edge.
    data[i + 3] = clipResult ? Math.min(a, clamp255(v)) : clamp255(v);
  }
  return data;
}
