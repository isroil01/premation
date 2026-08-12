/**
 * Stylize, round four — Cartoon, Brush Strokes, Strobe Light, Color Emboss,
 * Halftone, Kaleidoscope, Vignette, Burn Film.
 *
 * All pure `Uint8ClampedArray` transforms, like `stylize.ts` and `blurs.ts`, so
 * the arithmetic is testable without a DOM. Halftone and Brush Strokes could
 * each have been written as canvas DRAWING (dots and strokes are shapes), and
 * deliberately were not: as kernels they compose with the rest of the bake
 * chain, respect the layer's own alpha, and can be asserted on directly.
 *
 * ## Strobe Light is time-dependent, and that is expensive
 *
 * It reads a resolved `time` param, which puts it in `TIME_DEPENDENT` alongside
 * Timecode. Membership there opts the layer out of raster caching by
 * construction — the resolved time lands in the params, the params are digested
 * by the content hash, so the hash differs every frame. That is correct for a
 * strobe (its whole job is to differ every frame) and ruinous for anything
 * static, which is why the set stays small and why this is the only new member.
 */

import { clamp01, clamp255, luma, rgbToHsl, hslToRgb } from './colorSpace';
import { remap } from './distort';

// ── Cartoon ─────────────────────────────────────────────────────────

/**
 * Cartoon — flatten colour into bands, then ink the edges.
 *
 * Two passes that have to happen in this order and on different data:
 *
 *   1. **Smooth, then quantise.** Posterising raw pixels bands the noise as
 *      well as the shapes, which reads as compression artefacts rather than as
 *      cel shading. A small blur first is what makes the bands follow FORM.
 *   2. **Edges from the ORIGINAL.** The ink lines are a Sobel over the
 *      unsmoothed source. Taking them from the smoothed copy loses exactly the
 *      fine edges the ink is supposed to restore, and the result looks soft
 *      rather than drawn.
 */
export function cartoonData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  smoothness: number,
  levels: number,
  edgeThreshold: number,
  edgeWidth: number,
  edgeOpacity: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  if (w <= 0 || h <= 0) return out;

  const blurR = Math.max(0, Math.min(12, Math.round(smoothness)));
  const smoothed = blurR > 0 ? boxBlurRgb(src, w, h, blurR) : src;

  const n = Math.max(2, Math.min(64, Math.round(levels)));
  const step = 255 / (n - 1);
  const thr = Math.max(0, edgeThreshold);
  const inkW = Math.max(1, Math.round(edgeWidth));
  const inkA = clamp01(edgeOpacity / 100);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      // Quantise the smoothed colour.
      out[o] = Math.round(smoothed[o]! / step) * step;
      out[o + 1] = Math.round(smoothed[o + 1]! / step) * step;
      out[o + 2] = Math.round(smoothed[o + 2]! / step) * step;
      out[o + 3] = src[o + 3]!;

      if (inkA <= 0) continue;
      // Sobel over the ORIGINAL luminance. `inkW` widens the sampling stride
      // rather than dilating afterwards, which keeps this a single pass.
      let gx = 0, gy = 0;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const sx = Math.min(w - 1, Math.max(0, x + i * inkW));
          const sy = Math.min(h - 1, Math.max(0, y + j * inkW));
          const l = luma(src[(sy * w + sx) * 4]!, src[(sy * w + sx) * 4 + 1]!, src[(sy * w + sx) * 4 + 2]!);
          gx += l * SOBEL_X[(j + 1) * 3 + (i + 1)]!;
          gy += l * SOBEL_Y[(j + 1) * 3 + (i + 1)]!;
        }
      }
      const mag = Math.hypot(gx, gy);
      if (mag <= thr) continue;
      // Ink is a MULTIPLY toward black, so it darkens whatever band it crosses
      // instead of drawing a flat black line over it.
      const k = 1 - clamp01((mag - thr) / Math.max(1e-6, thr)) * inkA;
      out[o] = out[o]! * k;
      out[o + 1] = out[o + 1]! * k;
      out[o + 2] = out[o + 2]! * k;
    }
  }
  return out;
}

const SOBEL_X = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
const SOBEL_Y = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

/** Separable box blur over RGB, alpha-weighted. Shared by Cartoon and Halftone. */
function boxBlurRgb(src: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  const pass = (from: Uint8ClampedArray, to: Uint8ClampedArray, horiz: boolean): void => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let ar = 0, ag = 0, ab = 0, aa = 0, n = 0;
        for (let d = -r; d <= r; d++) {
          const sx = horiz ? Math.min(w - 1, Math.max(0, x + d)) : x;
          const sy = horiz ? y : Math.min(h - 1, Math.max(0, y + d));
          const o = (sy * w + sx) * 4;
          // Premultiplied accumulation — a transparent neighbour must not
          // contribute its colour. Same reasoning as every blur in this tree.
          const a = from[o + 3]!;
          ar += from[o]! * a; ag += from[o + 1]! * a; ab += from[o + 2]! * a;
          aa += a; n++;
        }
        const o = (y * w + x) * 4;
        if (aa > 0) { to[o] = ar / aa; to[o + 1] = ag / aa; to[o + 2] = ab / aa; }
        to[o + 3] = aa / Math.max(1, n);
      }
    }
  };
  pass(src, tmp, true);
  pass(tmp, out, false);
  return out;
}

// ── Brush Strokes ───────────────────────────────────────────────────

/**
 * Brush Strokes — a painterly smear along a per-cell stroke direction.
 *
 * Implemented as a displaced average: each pixel averages its neighbours along
 * a line whose angle is `direction` plus a deterministic per-cell jitter. That
 * elongated, locally-coherent blur is what reads as brushwork, where an
 * isotropic blur reads as out of focus.
 *
 * The jitter is seeded from the cell coordinates rather than from a running
 * PRNG, so the result is identical wherever the tile boundaries fall — a
 * renderer that splits the frame must not produce a visible seam.
 */
export function brushStrokesData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  direction: number,
  length: number,
  randomness: number,
  cellSize: number,
  density: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const len = Math.max(1, Math.min(32, Math.round(length)));
  const cell = Math.max(1, Math.round(cellSize));
  const jitter = clamp01(randomness / 100) * Math.PI;
  const dens = clamp01(density / 100);
  const base = (direction * Math.PI) / 180;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      // Hash the CELL, not the pixel: every pixel in a cell must share a stroke
      // angle or the smear has no coherence and degrades to noise.
      const cxi = Math.floor(x / cell), cyi = Math.floor(y / cell);
      const hsh = hash2(cxi, cyi);
      const ang = base + (hsh - 0.5) * 2 * jitter;
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const reach = Math.max(1, Math.round(len * (0.4 + 0.6 * hash2(cyi, cxi))));

      let ar = 0, ag = 0, ab = 0, aa = 0, n = 0;
      for (let t = -reach; t <= reach; t++) {
        const sx = Math.min(w - 1, Math.max(0, Math.round(x + dx * t)));
        const sy = Math.min(h - 1, Math.max(0, Math.round(y + dy * t)));
        const so = (sy * w + sx) * 4;
        const a = src[so + 3]!;
        ar += src[so]! * a; ag += src[so + 1]! * a; ab += src[so + 2]! * a;
        aa += a; n++;
      }
      if (aa > 0) {
        const r = ar / aa, g = ag / aa, b = ab / aa;
        // `density` blends the stroke back toward the original, so the effect
        // can be dialled in rather than being all-or-nothing.
        out[o] = src[o]! + (r - src[o]!) * dens;
        out[o + 1] = src[o + 1]! + (g - src[o + 1]!) * dens;
        out[o + 2] = src[o + 2]! + (b - src[o + 2]!) * dens;
      } else {
        out[o] = src[o]!; out[o + 1] = src[o + 1]!; out[o + 2] = src[o + 2]!;
      }
      out[o + 3] = src[o + 3]! + (aa / Math.max(1, n) - src[o + 3]!) * dens;
    }
  }
  return out;
}

/** Deterministic 0..1 hash of two integers. */
function hash2(a: number, b: number): number {
  let n = (a * 374761393 + b * 668265263) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

// ── Strobe Light ────────────────────────────────────────────────────

/**
 * Strobe Light — periodically replace or invert the layer.
 *
 * `operation` 0 = colour (fill with `color`), 1 = invert, 2 = opacity only.
 *
 * The strobe is driven by `time` and `period`, and duty is what makes it usable
 * rather than a bare square wave: a flash occupying 5% of the cycle is a camera
 * pop, one occupying 50% is a nightclub. AE exposes both as Strobe Duration and
 * Strobe Period and so does this.
 *
 * Deterministic in `time` — no accumulated state. A strobe that advanced a
 * counter per call would drift between preview and export, and would differ on
 * any frame the renderer happened to draw twice.
 */
export function strobeLightData(
  data: Uint8ClampedArray,
  time: number,
  period: number,
  duty: number,
  operation: number,
  color: [number, number, number],
  intensity: number,
): Uint8ClampedArray {
  const p = Math.max(1e-3, period);
  const phase = ((time % p) + p) % p / p;
  const on = phase < clamp01(duty / 100);
  if (!on) return data;

  const k = clamp01(intensity / 100);
  if (k <= 0) return data;
  const op = Math.round(operation);

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    if (op === 1) {
      data[i] = data[i]! + (255 - 2 * data[i]!) * k;
      data[i + 1] = data[i + 1]! + (255 - 2 * data[i + 1]!) * k;
      data[i + 2] = data[i + 2]! + (255 - 2 * data[i + 2]!) * k;
    } else if (op === 2) {
      data[i + 3] = data[i + 3]! * (1 - k);
    } else {
      data[i] = data[i]! + (color[0] - data[i]!) * k;
      data[i + 1] = data[i + 1]! + (color[1] - data[i + 1]!) * k;
      data[i + 2] = data[i + 2]! + (color[2] - data[i + 2]!) * k;
    }
  }
  return data;
}

// ── Color Emboss ────────────────────────────────────────────────────

/**
 * Color Emboss — emboss that keeps the colour.
 *
 * Plain Emboss (in `stylize.ts`) collapses to grey because it replaces every
 * channel with the same directional derivative. This one computes that
 * derivative PER CHANNEL and adds it to the original, so the relief appears as
 * a lighting change over the existing colour rather than replacing it. That is
 * the entire difference between the two effects, and the reason AE ships both.
 */
export function colorEmbossData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  direction: number,
  relief: number,
  contrast: number,
  blendWithOriginal: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const a = (direction * Math.PI) / 180;
  const ox = Math.round(Math.cos(a) * Math.max(1, relief));
  const oy = Math.round(Math.sin(a) * Math.max(1, relief));
  const k = Math.max(0, contrast) / 100;
  const blend = clamp01(1 - blendWithOriginal / 100);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const px = Math.min(w - 1, Math.max(0, x - ox));
      const py = Math.min(h - 1, Math.max(0, y - oy));
      const nx = Math.min(w - 1, Math.max(0, x + ox));
      const ny = Math.min(h - 1, Math.max(0, y + oy));
      const pi = (py * w + px) * 4;
      const ni = (ny * w + nx) * 4;
      for (let c = 0; c < 3; c++) {
        // Signed difference across the light direction, scaled and added.
        const d = (src[ni + c]! - src[pi + c]!) * k;
        const v = clamp255(src[o + c]! + d);
        out[o + c] = src[o + c]! + (v - src[o + c]!) * blend;
      }
      out[o + 3] = src[o + 3]!;
    }
  }
  return out;
}

// ── Halftone ────────────────────────────────────────────────────────

/**
 * Halftone — a rotated dot screen.
 *
 * Each pixel belongs to a cell on a grid rotated by `angle`; the cell's mean
 * luminance sets a dot radius, and the pixel is ink if it falls inside the dot.
 *
 * The rotation is the part that matters. An unrotated screen aligns with the
 * pixel grid and produces visible horizontal banding and moiré against any
 * detail in the source; every real halftone is screened at an angle (15°, 45°,
 * 75° for the process colours) for exactly this reason, which is why `angle` is
 * a first-class control defaulting to 45 rather than 0.
 */
export function halftoneData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  cellSize: number,
  angle: number,
  contrast: number,
  ink: [number, number, number],
  paper: [number, number, number],
  colorize: boolean,
  blendWithOriginal: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const cell = Math.max(2, Math.round(cellSize));
  const a = (angle * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const k = Math.max(0.01, contrast / 100);
  const blend = clamp01(1 - blendWithOriginal / 100);

  // Cell means, computed once in ROTATED space. Sampling per pixel would
  // recompute the same mean `cell²` times.
  const means = new Map<number, { l: number; r: number; g: number; b: number; n: number }>();
  const cellIndex = (x: number, y: number): [number, number] => {
    const rx = x * ca + y * sa;
    const ry = -x * sa + y * ca;
    return [Math.floor(rx / cell), Math.floor(ry / cell)];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const [cx, cy] = cellIndex(x, y);
      const key = cx * 65536 + cy;
      let m = means.get(key);
      if (!m) { m = { l: 0, r: 0, g: 0, b: 0, n: 0 }; means.set(key, m); }
      m.l += luma(src[o]!, src[o + 1]!, src[o + 2]!);
      m.r += src[o]!; m.g += src[o + 1]!; m.b += src[o + 2]!;
      m.n++;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const rx = x * ca + y * sa;
      const ry = -x * sa + y * ca;
      const cx = Math.floor(rx / cell), cy = Math.floor(ry / cell);
      const m = means.get(cx * 65536 + cy)!;
      const mean = m.l / m.n / 255;
      // Darker cell → bigger dot. √ because dot AREA should track luminance,
      // and area goes as r²; using the radius directly makes midtones far too
      // dark, which is the classic naive-halftone look.
      const radius = Math.sqrt(clamp01((1 - mean) * k)) * (cell * 0.72);
      const dx = rx - (cx * cell + cell / 2);
      const dy = ry - (cy * cell + cell / 2);
      const inside = Math.hypot(dx, dy) <= radius;

      const inkR = colorize ? m.r / m.n : ink[0];
      const inkG = colorize ? m.g / m.n : ink[1];
      const inkB = colorize ? m.b / m.n : ink[2];
      const tr = inside ? inkR : paper[0];
      const tg = inside ? inkG : paper[1];
      const tb = inside ? inkB : paper[2];
      out[o] = src[o]! + (tr - src[o]!) * blend;
      out[o + 1] = src[o + 1]! + (tg - src[o + 1]!) * blend;
      out[o + 2] = src[o + 2]! + (tb - src[o + 2]!) * blend;
      out[o + 3] = src[o + 3]!;
    }
  }
  return out;
}

// ── Kaleidoscope ────────────────────────────────────────────────────

/**
 * Kaleidoscope — fold the frame into a mirrored wedge.
 *
 * An inverse map: the destination's angle about the centre is folded into a
 * single wedge of `2π/segments`, alternating segments being MIRRORED so
 * adjacent wedges meet without a seam. Folding without the mirror gives a
 * rotational repeat, which is a different (and much cheaper-looking) effect —
 * the mirror is what makes it a kaleidoscope.
 */
export function kaleidoscopeData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  segments: number,
  centerX: number,
  centerY: number,
  rotation: number,
  sourceAngle: number,
  zoom: number,
): Uint8ClampedArray {
  const n = Math.max(1, Math.min(64, Math.round(segments)));
  if (n === 1) return data;
  const cx = w / 2 + centerX;
  const cy = h / 2 + centerY;
  const rot = (rotation * Math.PI) / 180;
  const srcA = (sourceAngle * Math.PI) / 180;
  const seg = (Math.PI * 2) / n;
  const scale = Math.max(0.01, zoom / 100);

  return remap(data, w, h, (dx, dy) => {
    const ox = dx - cx, oy = dy - cy;
    const r = Math.hypot(ox, oy) / scale;
    let ang = Math.atan2(oy, ox) - rot;
    // Fold into [0, seg), then mirror every other wedge.
    let a = ((ang % seg) + seg) % seg;
    const idx = Math.floor(((ang % (seg * 2)) + seg * 2) % (seg * 2) / seg);
    if (idx === 1) a = seg - a;
    ang = a + srcA;
    return { x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r };
  });
}

// ── Vignette ────────────────────────────────────────────────────────

/**
 * Vignette — darken (or brighten) toward the edges.
 *
 * `roundness` blends the falloff between elliptical (following the frame's
 * aspect) and circular. A vignette that is always circular looks wrong on a
 * wide frame — the corners darken long before the sides — and one that always
 * follows the aspect cannot do the round lens falloff. Both are wanted, so the
 * shape is a control.
 *
 * Multiplies the layer's own alpha region only; it does not paint into
 * transparent areas, so a vignette on a title does not draw a dark box.
 */
export function vignetteData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  amount: number,
  size: number,
  feather: number,
  roundness: number,
  centerX: number,
  centerY: number,
): Uint8ClampedArray {
  const amt = amount / 100;
  if (amt === 0) return data;
  const cx = w / 2 + centerX;
  const cy = h / 2 + centerY;
  const round = clamp01(roundness / 100);
  const halfW = w / 2, halfH = h / 2;
  // Elliptical uses per-axis normalisation; circular uses the half-diagonal.
  const diag = Math.hypot(halfW, halfH) || 1;
  const inner = clamp01(size / 100);
  const feath = Math.max(1e-3, clamp01(feather / 100));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (data[o + 3] === 0) continue;
      const ex = (x + 0.5 - cx) / halfW;
      const ey = (y + 0.5 - cy) / halfH;
      const dEllipse = Math.hypot(ex, ey);
      const dCircle = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / diag;
      const d = dEllipse + (dCircle - dEllipse) * round;
      // Smooth ramp from `inner` outward over `feather`.
      const t = clamp01((d - inner) / feath);
      const s = t * t * (3 - 2 * t);
      const k = 1 - amt * s;
      data[o] = clamp255(data[o]! * k);
      data[o + 1] = clamp255(data[o + 1]! * k);
      data[o + 2] = clamp255(data[o + 2]! * k);
    }
  }
  return data;
}

// ── Burn Film ───────────────────────────────────────────────────────

/**
 * Burn Film — the frame blowing out, as film caught in the gate.
 *
 * Three stacked behaviours driven by one `burn` amount, which is what makes it
 * a single believable event rather than three sliders:
 *
 *   · the hot spot grows from `centerX/centerY`, blowing to `burnColor`;
 *   · everything else lifts and desaturates as the emulsion cooks;
 *   · the edge of the hot spot rings darker before it goes, because the
 *     emulsion chars before it clears — without that ring it reads as a plain
 *     white wipe.
 *
 * `randomness` breaks the hot spot's outline with a deterministic hash so it is
 * not a clean circle; the hash is seeded from position and `seed` only, never
 * from a running counter, so re-rendering the same frame gives the same burn.
 */
export function burnFilmData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  burn: number,
  centerX: number,
  centerY: number,
  burnColor: [number, number, number],
  charColor: [number, number, number],
  randomness: number,
  seed: number,
): Uint8ClampedArray {
  const t = clamp01(burn / 100);
  if (t <= 0) return data;
  const cx = w / 2 + centerX;
  const cy = h / 2 + centerY;
  const maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) || 1;
  const hot = t * maxR * 1.15;
  const jitter = clamp01(randomness / 100);
  const sd = Math.round(seed);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (data[o + 3] === 0) continue;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      // Deterministic per-pixel wobble on the burn front.
      const n = (hash2(x + sd, y - sd) - 0.5) * jitter * maxR * 0.18;
      const front = d - n;

      // Global cook: everything lifts and desaturates as the burn advances.
      const cook = t * 0.55;
      if (cook > 0) {
        const [hh, ss, ll] = rgbToHsl(data[o]!, data[o + 1]!, data[o + 2]!);
        const [r2, g2, b2] = hslToRgb(hh, ss * (1 - cook * 0.7), clamp01(ll + cook * 0.25));
        data[o] = r2; data[o + 1] = g2; data[o + 2] = b2;
      }

      if (front <= hot) {
        // Fully blown — cleared to the burn colour, and transparent at the core
        // so what is behind shows through as it would through burnt-out film.
        data[o] = burnColor[0]; data[o + 1] = burnColor[1]; data[o + 2] = burnColor[2];
        data[o + 3] = clamp255(data[o + 3]! * clamp01((front / Math.max(1e-6, hot)) * 0.35));
      } else if (front <= hot * 1.18) {
        // The char ring, just outside the hole.
        const k = 1 - clamp01((front - hot) / Math.max(1e-6, hot * 0.18));
        data[o] = data[o]! + (charColor[0] - data[o]!) * k;
        data[o + 1] = data[o + 1]! + (charColor[1] - data[o + 1]!) * k;
        data[o + 2] = data[o + 2]! + (charColor[2] - data[o + 2]!) * k;
      }
    }
  }
  return data;
}
