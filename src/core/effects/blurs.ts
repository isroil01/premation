/**
 * Blur kernels — Gaussian, Fast Box and Radial.
 *
 * Pure `Uint8ClampedArray` transforms, deliberately separate from
 * `canvas2dEffects.ts`: the arithmetic here is testable without a DOM, and these
 * three are the ones most likely to need a numeric assertion rather than a
 * "does it draw something" one.
 *
 * ── Why box blur is the primitive, and Gaussian is built from it ────────────
 *
 * `ctx.filter = 'blur(Npx)'` is a real Gaussian and would have been one line —
 * but it is ISOTROPIC, and AE's Gaussian Blur has a Blur Dimensions control
 * (Horizontal / Vertical / Both) that an isotropic filter cannot express. A
 * horizontal-only blur is not a stylistic nicety; it is half of what people
 * reach for the effect for.
 *
 * A separable box blur gives per-axis control for free, and three successive box
 * passes converge on a Gaussian closely enough that the difference is invisible
 * at any radius a designer would use — this is the standard approximation, and
 * the same one AE's own Fast Blur is built on. So one kernel serves both, and
 * `iterations` is the only thing that differs between them.
 *
 * ── Repeat Edge Pixels ──────────────────────────────────────────────────────
 *
 * AE's checkbox, and it matters more than it sounds. With it OFF the blur samples
 * transparent black from beyond the layer bounds, so a full-frame layer develops
 * a dark, fading border — correct, and almost never what you want. With it ON the
 * edge pixel is extended outward (clamp-to-edge), and a full-frame blur stays
 * full-frame. Implemented as a sampling-mode switch rather than by padding the
 * buffer, so the cost is identical either way.
 */

export type BlurDimensions = 'both' | 'horizontal' | 'vertical';

/** AE's Blur Dimensions menu, as stored (a number, so it can be keyframed). */
export function blurDimensions(v: number): BlurDimensions {
  return v === 1 ? 'horizontal' : v === 2 ? 'vertical' : 'both';
}

/**
 * One separable box-blur pass over RGBA, premultiplying as it goes.
 *
 * ── The premultiply is not optional ─────────────────────────────────────────
 *
 * Averaging straight (non-premultiplied) RGBA is the classic blur bug: a fully
 * transparent pixel still carries a colour, and averaging that colour in at
 * equal weight pulls the result toward whatever happened to be in the unused
 * channels — usually black, giving every blurred edge a dark fringe. Weighting
 * each sample by its own alpha, then dividing back out, is what makes a blurred
 * edge fade to transparent rather than to black.
 *
 * This repo's invariant is that surfaces are premultiplied at decode, but this
 * kernel runs on `getImageData` output, which is straight — so it does the
 * multiply itself and undoes it at the end.
 */
function boxBlurPass(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
  horizontal: boolean,
  repeatEdge: boolean,
): void {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const stride = horizontal ? 4 : w * 4;
  const lineStep = horizontal ? w * 4 : 4;
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) {
    dst.set(src);
    return;
  }
  const window = r * 2 + 1;

  for (let line = 0; line < lines; line++) {
    const base = line * lineStep;
    let sumR = 0, sumG = 0, sumB = 0, sumA = 0;

    // The divisor is the WINDOW WIDTH, always — never "however many samples
    // happened to be in range". That is the whole difference the Repeat Edge
    // Pixels checkbox makes:
    //
    //   ON  — an out-of-range sample clamps to the edge pixel, so it contributes
    //         that pixel's alpha and a full-frame layer stays full-frame.
    //   OFF — it contributes a transparent-black sample: nothing to the sums,
    //         but a full slot to the divisor. That is what produces the fading
    //         border, which is correct sampling and exactly what the checkbox
    //         exists to let you turn off.
    //
    // Dividing by an in-range-only count instead makes the two settings
    // identical, because the average of the in-range samples is the same either
    // way — the falloff has to come from the divisor, not from the sum.
    for (let k = -r; k <= r; k++) accumulate(k, 1);

    for (let p = 0; p < len; p++) {
      const o = base + p * stride;
      if (sumA > 0) {
        dst[o] = sumR / sumA;
        dst[o + 1] = sumG / sumA;
        dst[o + 2] = sumB / sumA;
      } else {
        dst[o] = 0; dst[o + 1] = 0; dst[o + 2] = 0;
      }
      dst[o + 3] = sumA / window;

      // Slide: drop the sample leaving the window, add the one entering it.
      accumulate(p - r, -1);
      accumulate(p + r + 1, 1);
    }

    /** Add (`sign` 1) or remove (-1) one sample from the running window. */
    function accumulate(i: number, sign: number): void {
      const idx = sampleIndex(i, len, repeatEdge);
      if (idx < 0) return; // out of range with edges NOT repeated → all zeroes
      const o = base + idx * stride;
      const a = src[o + 3]!;
      sumR += sign * src[o]! * a;
      sumG += sign * src[o + 1]! * a;
      sumB += sign * src[o + 2]! * a;
      sumA += sign * a;
    }
  }
}

/**
 * Index into a scanline.
 *
 * Returns -1 for "sample transparent black" when the edge is not repeated — the
 * caller still counts it toward the divisor, which is what makes the border fade.
 */
function sampleIndex(i: number, len: number, repeatEdge: boolean): number {
  if (i >= 0 && i < len) return i;
  if (!repeatEdge) return -1;
  return i < 0 ? 0 : len - 1;
}

/**
 * Blur RGBA in place.
 *
 * `iterations` is what separates the two effects built on this: 1 is a box blur
 * (AE's Fast Box Blur at Iterations 1), 3 converges on a Gaussian. The radius is
 * divided across iterations so that N passes and 1 pass of the same nominal
 * radius produce a comparable amount of blur rather than N times as much.
 */
export function blurRgba(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
  opts: { dimensions?: BlurDimensions; iterations?: number; repeatEdge?: boolean } = {},
): Uint8ClampedArray {
  const dimensions = opts.dimensions ?? 'both';
  const iterations = Math.max(1, Math.min(10, Math.round(opts.iterations ?? 1)));
  const repeatEdge = opts.repeatEdge ?? true;
  if (radius <= 0 || w <= 0 || h <= 0) return data;

  // Three box passes of r/√3 ≈ one Gaussian of r. Generalised: spreading the
  // radius over the passes keeps the visual weight roughly constant as
  // Iterations changes, which is what makes that control usable.
  const perPass = radius / Math.sqrt(iterations);

  // Ping-pong between the caller's buffer and one scratch. Held in a 2-slot
  // array rather than two `let`s so the swap does not need a destructuring
  // assignment — TS narrows `Uint8ClampedArray`'s buffer type parameter
  // differently for an ImageData-owned array and a freshly constructed one, and
  // swapping the two directly is a variance error rather than a real problem.
  const buf: Uint8ClampedArray[] = [data, new Uint8ClampedArray(data.length)];
  let cur = 0;
  for (let i = 0; i < iterations; i++) {
    if (dimensions !== 'vertical') {
      boxBlurPass(buf[cur]!, buf[1 - cur]!, w, h, perPass, true, repeatEdge);
      cur = 1 - cur;
    }
    if (dimensions !== 'horizontal') {
      boxBlurPass(buf[cur]!, buf[1 - cur]!, w, h, perPass, false, repeatEdge);
      cur = 1 - cur;
    }
  }

  // An odd number of passes leaves the result in the scratch; copy it back so
  // the caller's buffer always holds the answer.
  if (cur !== 0) data.set(buf[cur]!);
  return data;
}

/**
 * Radial Blur — AE's spin and zoom, about an arbitrary centre.
 *
 * Backward-mapped like the warps in `warp.ts`: for each DESTINATION pixel, walk
 * a short arc (spin) or ray (zoom) through the source and average. Forward
 * scattering would leave holes wherever the mapping expands.
 *
 * `amount` is degrees of sweep for spin, and percent of scale travel for zoom.
 */
export function radialBlurData(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  amount: number,
  centerX: number,
  centerY: number,
  mode: 'spin' | 'zoom',
  quality: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  if (amount === 0 || w <= 0 || h <= 0) {
    out.set(src);
    return out;
  }
  // Samples along the arc/ray. More is smoother and strictly linear in cost;
  // AE calls this Antialiasing (Best Quality) rather than a number.
  const steps = Math.max(2, Math.min(64, Math.round(quality)));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - centerX;
      const dy = y - centerY;
      let r = 0, g = 0, b = 0, a = 0, n = 0;

      for (let s = 0; s < steps; s++) {
        // t runs 0→1 across the sweep, so the destination pixel itself is one
        // end of the trail rather than its middle — matching AE, where the
        // subject stays put and smears outward.
        const t = s / (steps - 1);
        let sx: number, sy: number;
        if (mode === 'spin') {
          const ang = (amount * Math.PI) / 180 * t;
          const cos = Math.cos(ang), sin = Math.sin(ang);
          sx = centerX + dx * cos - dy * sin;
          sy = centerY + dx * sin + dy * cos;
        } else {
          const scale = 1 + (amount / 100) * t;
          sx = centerX + dx / scale;
          sy = centerY + dy / scale;
        }

        const xi = Math.round(sx);
        const yi = Math.round(sy);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
        const o = (yi * w + xi) * 4;
        const sa = src[o + 3]!;
        // Premultiplied accumulation, same reason as the box kernel: averaging
        // straight colour across a transparent sample fringes the result.
        r += src[o]! * sa; g += src[o + 1]! * sa; b += src[o + 2]! * sa; a += sa;
        n++;
      }

      const d = (y * w + x) * 4;
      if (n === 0 || a === 0) {
        out[d] = 0; out[d + 1] = 0; out[d + 2] = 0; out[d + 3] = 0;
      } else {
        out[d] = r / a;
        out[d + 1] = g / a;
        out[d + 2] = b / a;
        out[d + 3] = a / n;
      }
    }
  }
  return out;
}
