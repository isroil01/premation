/**
 * Edge-aware and optical blurs — Bilateral, Smart Blur, Camera Lens Blur.
 *
 * ## Why these are not just more radii on the existing blurs
 *
 * `blurs.ts` holds the SEPARABLE blurs: gaussian, box, directional, channel.
 * All of them are two 1-D passes and all of them are linear, which is what
 * makes them cheap and what makes them flatten edges.
 *
 * None of the three here is separable, and each breaks separability for a
 * different reason worth knowing:
 *
 *   · **Bilateral** weights by colour distance as well as spatial distance, so
 *     the kernel differs per pixel. Smoothing that keeps edges.
 *   · **Smart Blur** gates on a threshold — pixels too different from the
 *     centre are excluded entirely. Skin-smoothing and cel-shading.
 *   · **Camera Lens Blur** convolves with an IRIS SHAPE and works on
 *     intensity-boosted highlights, which is what produces real bokeh discs
 *     rather than a smear.
 *
 * All three are therefore O(r²) per pixel. Radii are clamped tightly and the
 * cost is documented on each — an unclamped bilateral at r = 60 is minutes per
 * frame, and discovering that as a hang is much worse than discovering it as a
 * capped slider.
 */

import { clamp255, clamp01, luma } from './colorSpace';

/** Largest radius any kernel here will honour. See the file header. */
const MAX_RADIUS = 24;

// ── Bilateral Blur ──────────────────────────────────────────────────

/**
 * Bilateral Blur — Gaussian in space, Gaussian in colour.
 *
 * `w(p,q) = exp(−d²/2σs²) · exp(−Δc²/2σr²)`. The second term is the whole
 * effect: a neighbour on the far side of an edge has a large colour difference,
 * so its weight collapses and the edge survives while the flat regions smooth.
 *
 * `colorSigma` is in 0–255 units of colour distance. Large values degrade to an
 * ordinary Gaussian (every neighbour counts) and small values to a no-op (only
 * the centre counts) — both ends are meaningful, so neither is clamped away.
 */
export function bilateralBlurData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
  colorSigma: number,
  preserveAlpha: boolean,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const r = Math.max(0, Math.min(MAX_RADIUS, Math.round(radius)));
  if (r === 0 || w <= 0 || h <= 0) return new Uint8ClampedArray(src);

  const ss = Math.max(0.5, r / 2);
  const sr = Math.max(1, colorSigma);
  const inv2ss = 1 / (2 * ss * ss);
  const inv2sr = 1 / (2 * sr * sr);

  // Spatial weights depend only on the offset, so they are computed once for
  // the whole window instead of per pixel — the colour term is the only part
  // that has to vary.
  const spatial = new Float32Array((r * 2 + 1) * (r * 2 + 1));
  for (let dy = -r, k = 0; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++, k++) spatial[k] = Math.exp(-(dx * dx + dy * dy) * inv2ss);
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const cr = src[o]!, cg = src[o + 1]!, cb = src[o + 2]!;
      let ar = 0, ag = 0, ab = 0, aa = 0, wsum = 0;

      for (let dy = -r, k = 0; dy <= r; dy++) {
        const sy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++, k++) {
          const sx = Math.min(w - 1, Math.max(0, x + dx));
          const so = (sy * w + sx) * 4;
          const nr = src[so]!, ng = src[so + 1]!, nb = src[so + 2]!;
          const dc = (nr - cr) * (nr - cr) + (ng - cg) * (ng - cg) + (nb - cb) * (nb - cb);
          const wt = spatial[k]! * Math.exp(-dc * inv2sr);
          // Premultiplied accumulation: a neighbour that is 90% transparent
          // must contribute 10% of its colour, not all of it. Skipping this is
          // what makes a naive blur bleed the colour of invisible pixels.
          const sa = src[so + 3]!;
          ar += nr * sa * wt; ag += ng * sa * wt; ab += nb * sa * wt;
          aa += sa * wt; wsum += wt;
        }
      }
      if (aa > 0) { out[o] = ar / aa; out[o + 1] = ag / aa; out[o + 2] = ab / aa; }
      out[o + 3] = preserveAlpha ? src[o + 3]! : aa / Math.max(1e-6, wsum);
    }
  }
  return out;
}

// ── Smart Blur ──────────────────────────────────────────────────────

/**
 * Smart Blur — average only the neighbours WITHIN a threshold.
 *
 * A hard gate rather than bilateral's soft falloff, and the difference is the
 * point: below the threshold everything averages equally (so flat areas go
 * genuinely flat, not just smoother), and above it nothing is averaged at all
 * (so the edge is untouched, not merely preserved). That combination is what
 * produces the posterised, cel-shaded look Smart Blur is used for, which a
 * bilateral cannot reach at any setting.
 *
 * `mode` 0 = normal, 1 = edge only (show the excluded pixels as edges),
 * 2 = overlay edge (the blurred result with those edges drawn back over it).
 */
export function smartBlurData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
  threshold: number,
  mode: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const r = Math.max(0, Math.min(MAX_RADIUS, Math.round(radius)));
  if (r === 0 || w <= 0 || h <= 0) return new Uint8ClampedArray(src);
  const thr = Math.max(0, threshold);
  const m = Math.round(mode);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const cl = luma(src[o]!, src[o + 1]!, src[o + 2]!);
      let ar = 0, ag = 0, ab = 0, aa = 0, n = 0, rejected = 0, total = 0;

      for (let dy = -r; dy <= r; dy++) {
        const sy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue; // circular window
          const sx = Math.min(w - 1, Math.max(0, x + dx));
          const so = (sy * w + sx) * 4;
          total++;
          if (Math.abs(luma(src[so]!, src[so + 1]!, src[so + 2]!) - cl) > thr) { rejected++; continue; }
          const sa = src[so + 3]!;
          ar += src[so]! * sa; ag += src[so + 1]! * sa; ab += src[so + 2]! * sa;
          aa += sa; n++;
        }
      }

      // `n` is never 0: the centre pixel always passes its own threshold test.
      const edge = total > 0 ? rejected / total : 0;
      let rr: number, gg: number, bb: number;
      if (aa > 0) { rr = ar / aa; gg = ag / aa; bb = ab / aa; }
      else { rr = src[o]!; gg = src[o + 1]!; bb = src[o + 2]!; }

      if (m === 1) {
        const v = clamp255(edge * 255);
        out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = src[o + 3]!;
      } else if (m === 2) {
        // Darken by edge strength — the classic ink-line overlay.
        const k = 1 - clamp01(edge);
        out[o] = rr * k; out[o + 1] = gg * k; out[o + 2] = bb * k;
        out[o + 3] = src[o + 3]!;
      } else {
        out[o] = rr; out[o + 1] = gg; out[o + 2] = bb;
        out[o + 3] = n > 0 ? aa / n : src[o + 3]!;
      }
    }
  }
  return out;
}

// ── Camera Lens Blur ────────────────────────────────────────────────

/**
 * Camera Lens Blur — convolution with an iris shape, in boosted intensity.
 *
 * Two things separate real bokeh from a Gaussian, and both are implemented here
 * because either one alone still looks like a smear:
 *
 *   1. **The kernel is a polygon**, not a bell. Every point of light becomes a
 *      hard-edged disc or hexagon — the shape of the aperture.
 *   2. **Highlights bloom.** The convolution happens on values raised by
 *      `gain` past white; averaging in that space lets a small bright spot
 *      dominate its neighbourhood and come back as a bright disc. Averaging in
 *      display space would just dim it, which is exactly why a plain blur
 *      cannot fake this.
 *
 * `blades` < 3 means a circular iris; 3+ builds that polygon. `rotation` turns
 * it, which matters as soon as the shape has corners.
 */
export function cameraLensBlurData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
  blades: number,
  rotation: number,
  gain: number,
  threshold: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const r = Math.max(0, Math.min(MAX_RADIUS, Math.round(radius)));
  if (r === 0 || w <= 0 || h <= 0) return new Uint8ClampedArray(src);

  // Build the iris mask once.
  const size = r * 2 + 1;
  const mask = new Float32Array(size * size);
  const n = Math.round(blades);
  const rot = (rotation * Math.PI) / 180;
  let maskSum = 0;
  for (let dy = -r, k = 0; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++, k++) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      let inside: boolean;
      if (n < 3) inside = dist <= r;
      else {
        // Regular n-gon by its apothem: a point is inside when its projection
        // onto every edge normal is within the inradius. Cheaper and more exact
        // than a point-in-polygon walk, and it degenerates cleanly to a circle
        // as n grows, which is the behaviour a blades slider should have.
        const ang = Math.atan2(dy, dx) - rot;
        const seg = (Math.PI * 2) / n;
        const local = ang - seg * Math.floor(ang / seg + 0.5);
        inside = dist * Math.cos(local) <= r * Math.cos(Math.PI / n);
      }
      const v = inside ? 1 : 0;
      mask[k] = v;
      maskSum += v;
    }
  }
  if (maskSum <= 0) return new Uint8ClampedArray(src);

  // Highlight boost. Pixels above `threshold` are pushed up by `gain` before
  // convolution and pulled back after, so bright points survive averaging.
  const thr = clamp01(threshold / 100);
  const g = Math.max(1, gain);
  const boost = (v: number, l: number): number => (l > thr ? v * (1 + (g - 1) * (l - thr) / Math.max(1e-6, 1 - thr)) : v);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let ar = 0, ag = 0, ab = 0, aa = 0, wsum = 0;
      for (let dy = -r, k = 0; dy <= r; dy++) {
        const sy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++, k++) {
          const wt = mask[k]!;
          if (wt === 0) continue;
          const so = (sy * w + Math.min(w - 1, Math.max(0, x + dx))) * 4;
          const sa = src[so + 3]!;
          const nr = src[so]!, ng = src[so + 1]!, nb = src[so + 2]!;
          const l = luma(nr, ng, nb) / 255;
          ar += boost(nr, l) * sa * wt; ag += boost(ng, l) * sa * wt; ab += boost(nb, l) * sa * wt;
          aa += sa * wt; wsum += wt;
        }
      }
      if (aa > 0) {
        // Undo the boost on the average. Dividing by the same factor the
        // brightest contributor was scaled by would over-darken, so the inverse
        // is applied to the RESULT's own luminance — which is what keeps a
        // bokeh disc bright without blowing the whole frame out.
        const mr = ar / aa, mg = ag / aa, mb = ab / aa;
        const ml = luma(mr, mg, mb) / 255;
        const k2 = ml > 1 ? 1 / ml : 1;
        out[o] = clamp255(mr * k2); out[o + 1] = clamp255(mg * k2); out[o + 2] = clamp255(mb * k2);
      }
      out[o + 3] = aa / Math.max(1e-6, wsum);
    }
  }
  return out;
}
