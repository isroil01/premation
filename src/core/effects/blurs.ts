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
/**
 * One separable box-blur pass over PREMULTIPLIED 16-bit planes.
 *
 * The planes are `Uint16Array`s of premultiplied R, G, B and A, one value per
 * pixel — premultiplied R·A is at most 255·255 = 65 025, so 16 bits hold it
 * exactly, and halving the bytes over a `Float32Array` halves what a pass has
 * to stream through the cache; the kernel is memory-bound at 1080p. The
 * running sums are ordinary numbers, so the window never overflows. Each
 * store rounds (+0.5) so six passes do not drift dark — `blurRgba` premultiplies ONCE up front and un-premultiplies
 * ONCE at the end, so the six passes of a Gaussian never touch the multiply
 * again. (Averaging straight RGBA is the classic blur bug: a transparent
 * pixel's unused colour pulls every blurred edge toward black. Weighting each
 * sample by its alpha and dividing back out is what makes an edge fade to
 * transparent instead.)
 *
 * Both directions walk memory in ROW order. The horizontal pass slides a
 * window along each row. The vertical pass keeps one running sum PER COLUMN
 * and slides all of them down together, row by row — so it reads the image
 * exactly as the horizontal pass does, sequentially, instead of striding a
 * full row between samples. That stride was the expensive part on a 1080p
 * frame: every sample a cache miss, for two of every three passes.
 *
 * No closures, no per-sample calls: the previous version allocated an
 * `accumulate` function per scanline and called it twice per pixel through a
 * bounds helper, which costs more than the arithmetic it wrapped.
 */
function boxBlurPass(
  src: Uint16Array,
  dst: Uint16Array,
  w: number,
  h: number,
  radius: number,
  horizontal: boolean,
  repeatEdge: boolean,
): void {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) {
    dst.set(src);
    return;
  }
  // The divisor is the WINDOW WIDTH, always — never "however many samples were
  // in range". That is the whole difference Repeat Edge Pixels makes: ON, an
  // out-of-range sample clamps to the edge pixel and a full-frame layer stays
  // full-frame; OFF, it contributes a transparent-black sample — nothing to the
  // sum, a full slot to the divisor — which is the fading border the checkbox
  // exists to let you turn off.
  const inv = 1 / (r * 2 + 1);
  const n = w * h;
  // Planes are interleaved as [R.., G.., B.., A..] in one buffer.
  const G = n, B = 2 * n, A = 3 * n;

  if (horizontal) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sR = 0, sG = 0, sB = 0, sA = 0;
      // Prime the window over [-r, r].
      for (let k = -r; k <= r; k++) {
        let i = k;
        if (i < 0) { if (!repeatEdge) continue; i = 0; }
        else if (i >= w) { if (!repeatEdge) continue; i = w - 1; }
        const o = row + i;
        sR += src[o]!; sG += src[G + o]!; sB += src[B + o]!; sA += src[A + o]!;
      }
      for (let x = 0; x < w; x++) {
        const o = row + x;
        dst[o] = sR * inv + 0.5; dst[G + o] = sG * inv + 0.5; dst[B + o] = sB * inv + 0.5; dst[A + o] = sA * inv + 0.5;
        // Slide: drop x − r, add x + r + 1.
        let iOut = x - r, iIn = x + r + 1;
        let useOut = true, useIn = true;
        if (iOut < 0) { if (repeatEdge) iOut = 0; else useOut = false; }
        if (iIn >= w) { if (repeatEdge) iIn = w - 1; else useIn = false; }
        if (useOut) { const q = row + iOut; sR -= src[q]!; sG -= src[G + q]!; sB -= src[B + q]!; sA -= src[A + q]!; }
        if (useIn) { const q = row + iIn; sR += src[q]!; sG += src[G + q]!; sB += src[B + q]!; sA += src[A + q]!; }
      }
    }
    return;
  }

  // Vertical: one running sum per column, all slid down one row at a time.
  const sums = new Float32Array(w * 4);
  const rowAt = (y: number): number => {
    if (y < 0) return repeatEdge ? 0 : -1;
    if (y >= h) return repeatEdge ? h - 1 : -1;
    return y;
  };
  for (let k = -r; k <= r; k++) {
    const y = rowAt(k);
    if (y < 0) continue;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const o = row + x, c = x * 4;
      sums[c] = sums[c]! + src[o]!; sums[c + 1] = sums[c + 1]! + src[G + o]!; sums[c + 2] = sums[c + 2]! + src[B + o]!; sums[c + 3] = sums[c + 3]! + src[A + o]!;
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const o = row + x, c = x * 4;
      dst[o] = sums[c]! * inv + 0.5; dst[G + o] = sums[c + 1]! * inv + 0.5; dst[B + o] = sums[c + 2]! * inv + 0.5; dst[A + o] = sums[c + 3]! * inv + 0.5;
    }
    const yOut = rowAt(y - r), yIn = rowAt(y + r + 1);
    if (yOut >= 0) {
      const ro = yOut * w;
      for (let x = 0; x < w; x++) { const o = ro + x, c = x * 4; sums[c] = sums[c]! - src[o]!; sums[c + 1] = sums[c + 1]! - src[G + o]!; sums[c + 2] = sums[c + 2]! - src[B + o]!; sums[c + 3] = sums[c + 3]! - src[A + o]!; }
    }
    if (yIn >= 0) {
      const ri = yIn * w;
      for (let x = 0; x < w; x++) { const o = ri + x, c = x * 4; sums[c] = sums[c]! + src[o]!; sums[c + 1] = sums[c + 1]! + src[G + o]!; sums[c + 2] = sums[c + 2]! + src[B + o]!; sums[c + 3] = sums[c + 3]! + src[A + o]!; }
    }
  }
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

  // Premultiply once into planar 16-bit. Four planes in one buffer, pixel-major
  // within each plane, so every pass reads sequentially.
  const n = w * h;
  const planes = [new Uint16Array(n * 4), new Uint16Array(n * 4)];
  const p0 = planes[0]!;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const a = data[o + 3]!;
    p0[i] = data[o]! * a;
    p0[n + i] = data[o + 1]! * a;
    p0[2 * n + i] = data[o + 2]! * a;
    p0[3 * n + i] = a;
  }

  let cur = 0;
  for (let i = 0; i < iterations; i++) {
    if (dimensions !== 'vertical') {
      boxBlurPass(planes[cur]!, planes[1 - cur]!, w, h, perPass, true, repeatEdge);
      cur = 1 - cur;
    }
    if (dimensions !== 'horizontal') {
      boxBlurPass(planes[cur]!, planes[1 - cur]!, w, h, perPass, false, repeatEdge);
      cur = 1 - cur;
    }
  }

  // Un-premultiply back into the caller's straight RGBA buffer.
  const out = planes[cur]!;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const a = out[3 * n + i]!;
    if (a > 0) {
      const ia = 1 / a;
      data[o] = out[i]! * ia;
      data[o + 1] = out[n + i]! * ia;
      data[o + 2] = out[2 * n + i]! * ia;
    } else {
      data[o] = 0; data[o + 1] = 0; data[o + 2] = 0;
    }
    data[o + 3] = a;
  }
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

/**
 * Blur ONE channel, as an independent scalar field.
 *
 * ── Why this does not call `blurRgba` ───────────────────────────────────────
 *
 * `boxBlurPass` weights every colour sample by that sample's ALPHA, which is
 * what stops a blur dragging the colour of transparent pixels into the visible
 * edge — correct, and essential, for an ordinary blur. It is wrong here in both
 * directions: blurring the ALPHA channel by a weight derived from alpha is
 * circular, and blurring red alone through an alpha weight makes the red radius
 * depend on the layer's transparency rather than on the red slider.
 *
 * Channel Blur's contract is that each slider is independent, so its per-channel
 * pass has to be an unweighted mean. Hence a second, smaller kernel rather than
 * a flag on the first — the two genuinely compute different things.
 */
function blurOneChannel(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  channel: number,
  radius: number,
  dimensions: BlurDimensions,
  repeatEdge: boolean,
): void {
  const r = Math.round(radius);
  if (r <= 0) return;

  const scratch = new Uint8ClampedArray(w * h);
  const read = (i: number): number => data[i * 4 + channel]!;

  const pass = (horizontal: boolean): void => {
    const len = horizontal ? w : h;
    const lines = horizontal ? h : w;
    for (let line = 0; line < lines; line++) {
      for (let i = 0; i < len; i++) {
        let sum = 0;
        let count = 0;
        for (let k = -r; k <= r; k++) {
          let j = i + k;
          if (j < 0 || j >= len) {
            // Off the end: clamp to the edge sample, or count a zero. Counting
            // it either way is what makes the non-repeat mode fade at the
            // border rather than just sampling a shorter window.
            if (!repeatEdge) { count++; continue; }
            j = j < 0 ? 0 : len - 1;
          }
          const idx = horizontal ? line * w + j : j * w + line;
          sum += read(idx);
          count++;
        }
        const idx = horizontal ? line * w + i : i * w + line;
        scratch[idx] = count > 0 ? sum / count : read(idx);
      }
    }
    for (let i = 0; i < w * h; i++) data[i * 4 + channel] = scratch[i]!;
  };

  if (dimensions !== 'vertical') pass(true);
  if (dimensions !== 'horizontal') pass(false);
}

/**
 * Channel Blur — a separate blur radius for red, green, blue and alpha.
 *
 * Two jobs justify it, and neither is reachable with an ordinary blur:
 *
 *   • Blurring ALPHA ALONE softens a matte's edge without touching the image
 *     inside it. That is the standard way to take the aliasing off a key, and
 *     doing it with a normal blur would soften the picture too.
 *   • Blurring one COLOUR channel more than the others reproduces chromatic
 *     aberration and cheap-lens softness, which is most of what makes composited
 *     footage sit in a plate instead of floating on it.
 *
 * Each channel is an independent unweighted blur — see `blurOneChannel` for why
 * that cannot share the main blur's alpha-weighted kernel.
 */
export function channelBlurData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  radii: { red: number; green: number; blue: number; alpha: number },
  dimensions: BlurDimensions,
  repeatEdge: boolean,
): Uint8ClampedArray {
  blurOneChannel(data, w, h, 0, radii.red, dimensions, repeatEdge);
  blurOneChannel(data, w, h, 1, radii.green, dimensions, repeatEdge);
  blurOneChannel(data, w, h, 2, radii.blue, dimensions, repeatEdge);
  blurOneChannel(data, w, h, 3, radii.alpha, dimensions, repeatEdge);
  return data;
}

/**
 * Unsharp Mask — raise local contrast by subtracting a blurred copy.
 *
 * The classic sharpening operator, and a strictly better one than the existing
 * `sharpen`, which is a fixed 3×3 kernel: that kernel's radius is one pixel and
 * cannot change, so on a 4K frame it sharpens grain instead of detail. Here the
 * RADIUS chooses the scale of the detail being enhanced, which is the control
 * that makes sharpening usable at more than one resolution.
 *
 * The operator is `out = src + amount · (src − blur(src))`. The difference term
 * is the detail the blur removed, so adding it back scaled up exaggerates
 * exactly what the blur destroyed and leaves flat areas alone.
 *
 * ── Threshold ───────────────────────────────────────────────────────────────
 *
 * `threshold` is what separates a sharpen from a grain amplifier: differences
 * smaller than it are left untouched, so film grain and sensor noise — which are
 * low-amplitude everywhere — stay put while real edges get the boost. Sharpening
 * a noisy plate without it makes the noise the sharpest thing in frame.
 *
 * Reuses `blurRgba`, whose alpha weighting is right for this one: the blurred
 * copy is a stand-in for the image, and it should no more drag transparent
 * colour inward here than it does anywhere else.
 */
export function unsharpMaskData(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  amount: number,
  radius: number,
  threshold: number,
): Uint8ClampedArray {
  const k = amount / 100;
  if (k === 0 || radius <= 0) return data;

  // Three iterations so the reference blur is a Gaussian rather than a box —
  // a box blur's flat kernel leaves ringing at the scale of its own width, and
  // an unsharp mask amplifies precisely that.
  const blurred = blurRgba(new Uint8ClampedArray(data), w, h, radius, { iterations: 3, repeatEdge: true });

  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = data[i + c]!;
      const d = v - blurred[i + c]!;
      if (Math.abs(d) <= threshold) continue;
      data[i + c] = v + d * k;
    }
    // Alpha is deliberately untouched: sharpening a matte's edge is Channel
    // Blur's business, and doing it here would make every sharpen quietly
    // harden the layer's outline.
  }
  return data;
}
