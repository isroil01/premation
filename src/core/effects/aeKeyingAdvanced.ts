/**
 * Keying & Matte, round four — Color Key, Color Range, Extract, Spill
 * Suppressor, Matte Choker.
 *
 * ## The alpha convention, which is the thing to get right
 *
 * Canvas `ImageData` is STRAIGHT alpha. These kernels therefore write the
 * matte into `data[i+3]` and leave RGB alone — they do NOT premultiply. The
 * renderer's premultiplied invariant is restored downstream by the bake, and
 * a kernel that "helpfully" multiplied RGB here would double-apply it and
 * darken every soft edge. See `project_motion_alpha_invariant`.
 *
 * ## Why these are separate effects rather than one Key with a mode
 *
 * They select on genuinely different axes and fail differently:
 *
 *   · **Color Key** — RGB distance to one colour. Cheap, hard-edged, right for
 *     graphics with a flat background.
 *   · **Color Range** — a soft region in Lab/YUV/RGB space, tolerant of the
 *     lighting gradient a real cyclorama has. This is the one that works on
 *     footage.
 *   · **Extract** — keys on a LUMINANCE band, not a colour. The only one that
 *     can pull a matte from a greyscale pass or a depth render.
 *
 * A single effect with a mode dropdown would have to union their parameter sets
 * and most of the controls would be dead in most modes — the exact shape the
 * dead-control scanner exists to catch.
 */

import { clamp01, clamp255, luma, rgbToHsl, hueDistance, smoothstep } from './colorSpace';

// ── Color Key ───────────────────────────────────────────────────────

/**
 * Color Key — straight RGB distance to a key colour, with a soft shoulder.
 *
 * `tolerance` is the fully-transparent radius and `edgeSoftness` widens the
 * ramp beyond it. Distance is Euclidean in RGB, normalised so tolerance reads
 * as a percentage of the longest possible distance rather than as an opaque
 * 0–255 number the user has to calibrate by eye.
 */
export function colorKeyData(
  data: Uint8ClampedArray,
  key: [number, number, number],
  tolerance: number,
  edgeSoftness: number,
): Uint8ClampedArray {
  const MAX_DIST = Math.sqrt(3 * 255 * 255);
  const tol = clamp01(tolerance / 100) * MAX_DIST;
  const soft = clamp01(edgeSoftness / 100) * MAX_DIST;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a === 0) continue;
    const dr = data[i]! - key[0];
    const dg = data[i + 1]! - key[1];
    const db = data[i + 2]! - key[2];
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    // Inside `tol` → fully keyed; beyond `tol + soft` → fully kept.
    const keep = smoothstep(tol, tol + soft, d);
    // MULTIPLY into existing alpha rather than replacing it: the layer may
    // already carry a matte (its own shape, or an earlier key), and replacing
    // would resurrect pixels something upstream deliberately removed.
    data[i + 3] = a * keep;
  }
  return data;
}

// ── Color Range ─────────────────────────────────────────────────────

/**
 * Color Range — a soft selection in a chosen colour space.
 *
 * `space` 0 = Lab, 1 = YUV, 2 = RGB.
 *
 * Space choice is the whole effect. A greenscreen lit unevenly has a large RGB
 * spread and a small CHROMA spread, so keying in Lab or YUV — where luminance
 * is one axis and can be weighted down — pulls a clean matte where an RGB
 * distance either eats the subject or leaves the corners. `lumaWeight` is that
 * weighting, and defaults low for exactly this reason.
 */
export function colorRangeData(
  data: Uint8ClampedArray,
  key: [number, number, number],
  space: number,
  minTol: number,
  maxTol: number,
  lumaWeight: number,
): Uint8ClampedArray {
  const mode = Math.round(space);
  const wl = clamp01(lumaWeight / 100);

  // Project a colour into the working space, scaled so all three axes are
  // comparable and a single tolerance number means something.
  const project = (r: number, g: number, b: number): [number, number, number] => {
    if (mode === 2) return [r, g, b];
    const y = luma(r, g, b);
    if (mode === 1) {
      // YUV chroma axes.
      return [y, (b - y) * 0.565, (r - y) * 0.713];
    }
    // Lab, approximated through its opponent axes. The perceptual non-linearity
    // matters far less here than the luminance/chroma SPLIT does, and a full
    // CIELAB round-trip per pixel would cost two cube roots for a matte whose
    // softness is being dialled by hand anyway.
    return [y, (r - g) * 0.5, (g - b) * 0.5];
  };

  const [ky, ku, kv] = project(key[0], key[1], key[2]);
  const MAX_DIST = 255;
  const lo = clamp01(minTol / 100) * MAX_DIST;
  const hi = Math.max(lo + 1e-6, clamp01(maxTol / 100) * MAX_DIST);

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a === 0) continue;
    const [py, pu, pv] = project(data[i]!, data[i + 1]!, data[i + 2]!);
    const dy = (py - ky) * wl;
    const du = pu - ku;
    const dv = pv - kv;
    const d = Math.sqrt(dy * dy + du * du + dv * dv);
    data[i + 3] = a * smoothstep(lo, hi, d);
  }
  return data;
}

// ── Extract ─────────────────────────────────────────────────────────

/**
 * Extract — key on a luminance BAND rather than a colour.
 *
 * Keeps pixels whose channel value falls inside `[black, white]`, with a soft
 * ramp of `blackSoft`/`whiteSoft` at each end. `channel` 0 = luminance,
 * 1 = red, 2 = green, 3 = blue, 4 = alpha.
 *
 * Two soft edges rather than one shared softness because the two ends are
 * almost never symmetric in practice — pulling a matte off a dark background
 * wants a wide toe and a hard shoulder.
 */
export function extractData(
  data: Uint8ClampedArray,
  channel: number,
  black: number,
  white: number,
  blackSoft: number,
  whiteSoft: number,
  invert: boolean,
): Uint8ClampedArray {
  const ch = Math.round(channel);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a === 0) continue;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    const v =
      ch === 1 ? r : ch === 2 ? g : ch === 3 ? b : ch === 4 ? a : luma(r, g, b);
    // Rising edge at the black end, falling edge at the white end; their
    // product is the band. Expressed as two smoothsteps so the two softness
    // controls are genuinely independent.
    const up = smoothstep(black - blackSoft, black + blackSoft, v);
    const down = 1 - smoothstep(white - whiteSoft, white + whiteSoft, v);
    let m = clamp01(up * down);
    if (invert) m = 1 - m;
    data[i + 3] = a * m;
  }
  return data;
}

// ── Spill Suppressor ────────────────────────────────────────────────

/**
 * Spill Suppressor — remove the key colour's bounce from the retained subject.
 *
 * After any key, the edge pixels and the shiny parts of the subject still carry
 * the screen's colour. This pulls that channel down toward the average of the
 * other two wherever it dominates, which is the classic despill and is why the
 * result reads as neutral rather than as a magenta edge.
 *
 * Operates on RGB and never touches alpha — it runs AFTER a key, on what
 * survived, and a despill that also ate coverage would be indistinguishable
 * from the key being too aggressive.
 */
export function spillSuppressorData(
  data: Uint8ClampedArray,
  key: [number, number, number],
  amount: number,
  preserveLuma: boolean,
): Uint8ClampedArray {
  const [kh] = rgbToHsl(key[0], key[1], key[2]);
  const strength = clamp01(amount / 100);
  if (strength <= 0) return data;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    const [h, s] = rgbToHsl(r, g, b);
    // Only pixels whose HUE is near the key's are spilled. Weighting by
    // saturation as well stops the suppressor bleaching neutral greys, which
    // have a numerically-defined but meaningless hue.
    const near = (1 - smoothstep(0.08, 0.25, hueDistance(h, kh))) * clamp01(s * 2) * strength;
    if (near <= 0) continue;

    const before = luma(r, g, b);
    // Pull the dominant channel down to the mean of the other two — the
    // standard despill, and the reason it is subtractive rather than a hue
    // rotation is that rotating moves the spill somewhere else instead of
    // removing it.
    let nr = r, ng = g, nb = b;
    const mean2 = (x: number, y: number): number => (x + y) / 2;
    if (kh > 0.25 && kh < 0.45) ng = g + (Math.min(g, mean2(r, b)) - g) * near;
    else if (kh >= 0.45 && kh < 0.75) nb = b + (Math.min(b, mean2(r, g)) - b) * near;
    else nr = r + (Math.min(r, mean2(g, b)) - r) * near;

    if (preserveLuma) {
      // Despilling removes energy, so the subject darkens. Scaling back to the
      // original luma is what keeps a despilled edge from reading as a dark
      // outline — the artefact people usually blame on the key.
      const after = luma(nr, ng, nb);
      if (after > 1e-3) {
        const k = before / after;
        nr *= k; ng *= k; nb *= k;
      }
    }
    data[i] = clamp255(nr);
    data[i + 1] = clamp255(ng);
    data[i + 2] = clamp255(nb);
  }
  return data;
}

// ── Matte Choker ────────────────────────────────────────────────────

/**
 * Matte Choker — close holes in a matte, then shrink it back.
 *
 * A two-pass spread-then-choke on ALPHA only. The point is the asymmetry: the
 * spread bridges gaps in a noisy matte, and the choke pulls the (now solid)
 * edge back to roughly where it started. Doing only one of the two either
 * inflates the subject or leaves the holes.
 *
 * `softness` blurs between the passes so the recovered edge is not a staircase.
 * Separable box passes rather than a true circular kernel — at these radii the
 * difference is invisible on a matte and the cost is O(r) instead of O(r²).
 */
export function matteChokerData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  spread: number,
  choke: number,
  softness: number,
  iterations: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src);
  if (w <= 0 || h <= 0) return out;
  const passes = Math.max(1, Math.min(5, Math.round(iterations)));

  // Alpha extracted once; every pass below is a scalar-field operation and
  // carrying RGB through them would be pure waste.
  // Annotated, not inferred. `new Float32Array(n)` infers
  // `Float32Array<ArrayBuffer>` under TS 5.7's typed-array generics, while the
  // morph/blur helpers below hand back `<ArrayBufferLike>` — so reassigning
  // this binding to their result is a type error unless it is widened here.
  let alpha: Float32Array<ArrayBufferLike> = new Float32Array(w * h);
  for (let p = 0, i = 3; p < alpha.length; p++, i += 4) alpha[p] = src[i]!;

  for (let n = 0; n < passes; n++) {
    if (spread > 0) alpha = morph(alpha, w, h, spread, true);
    if (softness > 0) alpha = boxBlurAlpha(alpha, w, h, softness);
    if (choke > 0) alpha = morph(alpha, w, h, choke, false);
  }

  for (let p = 0, i = 3; p < alpha.length; p++, i += 4) out[i] = clamp255(alpha[p]!);
  return out;
}

/** Separable max (dilate) or min (erode) over a square window. */
function morph(a: Float32Array, w: number, h: number, radius: number, dilate: boolean): Float32Array {
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(a.length);
  const out = new Float32Array(a.length);
  const pick = dilate ? Math.max : Math.min;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = a[row + x]!;
      for (let d = 1; d <= r; d++) {
        // Clamp at the border rather than treating outside as 0. Treating it as
        // empty would erode the matte inward from every frame edge, which
        // silently crops any subject that touches it.
        v = pick(v, a[row + Math.max(0, x - d)]!, a[row + Math.min(w - 1, x + d)]!);
      }
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = tmp[y * w + x]!;
      for (let d = 1; d <= r; d++) {
        v = pick(v, tmp[Math.max(0, y - d) * w + x]!, tmp[Math.min(h - 1, y + d) * w + x]!);
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Separable box blur over a scalar field. */
function boxBlurAlpha(a: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(a.length);
  const out = new Float32Array(a.length);
  const span = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += a[row + Math.min(w - 1, Math.max(0, x + d))]!;
      tmp[row + x] = s / span;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += tmp[Math.min(h - 1, Math.max(0, y + d)) * w + x]!;
      out[y * w + x] = s / span;
    }
  }
  return out;
}
