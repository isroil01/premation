/**
 * Pixel Motion — the optical-flow half of frame blending.
 *
 * Frame Mix cross-dissolves the two source frames bracketing the playhead;
 * for slowed footage that reads as a double-exposure strobing at the source
 * rate. Pixel Motion instead estimates WHERE each region moved between the two
 * frames and renders the in-between position: block-matched flow on a coarse
 * grid, then a symmetric warp-and-blend at the sub-frame weight.
 *
 * ── Design constraints, in order ────────────────────────────────────────────
 *
 *  DETERMINISTIC. Pure arithmetic on pixel arrays — no Math.random, no time,
 *  no floating-point rasterization in the estimation. The same two frames
 *  always produce the same flow and the same in-between, so export matches
 *  preview and a scrub back redraws the same frame. The GPU twin of this
 *  search (`pixelMotionFlowGpu.ts`) is admissible under this constraint
 *  because it is INTEGER arithmetic end to end — integer luma, integer SAD,
 *  fixed scan order — and must prove itself bit-equal to this module on a
 *  synthetic pair before it is allowed to serve a single real frame. The
 *  float half (sub-pixel parabola, smoothing) runs HERE either way, on the
 *  exact integers the search produced.
 *
 *  CHEAP ENOUGH ON THE CPU. Flow is estimated at a downscaled size (the
 *  caller picks; ~384px wide is the intended operating point) on a grid, not
 *  per pixel — motion between ADJACENT frames is small and smooth, which is
 *  the one regime block matching is genuinely good at. The full-res cost is
 *  only the final warp, one bilinear pass per output pixel.
 *
 *  HONEST FALLBACK. A block with no texture cannot vote on motion — its SAD
 *  surface is flat and the argmin is noise. Such blocks report zero flow
 *  (blend-in-place, i.e. Frame Mix locally), which degrades exactly to the
 *  old behaviour instead of smearing.
 *
 * This module is pure and unit-tested on synthetic frames. Canvas plumbing,
 * caching and the texture feed live in `pixelMotion.ts`.
 */

export interface FlowField {
  /** Grid dimensions (cols × rows) and spacing in FLOW-RESOLUTION pixels. */
  cols: number;
  rows: number;
  step: number;
  /** Per-grid-point displacement a→b, flow-resolution px. */
  dx: Float32Array;
  dy: Float32Array;
  /**
   * 1 where the block actually measured motion, 0 where it abstained
   * (textureless / no improvement over zero). The warp treats both alike —
   * an abstaining block blends in place either way — but a GLOBAL-motion
   * consumer (stabilization) must not let abstentions vote "the camera is
   * still": on a shot that is mostly flat wall, they would outvote the
   * signal.
   */
  valid: Uint8Array;
}

export interface FlowOptions {
  /** Grid spacing in px (flow resolution). */
  step?: number;
  /** Half-size of the matched block. */
  blockRadius?: number;
  /** Search radius in px around zero displacement. */
  searchRadius?: number;
  /**
   * Minimum relative SAD improvement over "no motion" for a vector to count.
   * Below it the block is textureless or static and reports zero — see the
   * honest-fallback note above.
   */
  minImprovement?: number;
}

/** Rec.601 luma of an RGBA buffer, as float 0..255. The match runs on luma:
 *  a third the memory traffic, and chroma adds nothing to block SAD. */
export function lumaOf(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = data[p]! * 0.299 + data[p + 1]! * 0.587 + data[p + 2]! * 0.114;
  }
  return out;
}

/**
 * Integer Rec.601-weighted luma (×256): `77·R + 150·G + 29·B`, 0..65280.
 *
 * This is the variant Pixel Motion itself feeds `computeFlow`, because every
 * operation on it is EXACT — a GLSL `int` pipeline and this loop produce the
 * same numbers on any hardware, which is what lets the GPU search in
 * `pixelMotionFlowGpu.ts` be bit-equal to the CPU one. SAD only cares about
 * relative differences, so the ×256 scale is invisible downstream (the
 * validity test is a ratio). `lumaOf` stays as-is for the consumers that read
 * luma VALUES (roto brush, content-aware fill, stabilization).
 */
export function lumaIntOf(data: Uint8ClampedArray, w: number, h: number): Int32Array {
  const out = new Int32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = data[p]! * 77 + data[p + 1]! * 150 + data[p + 2]! * 29;
  }
  return out;
}

/** Luma buffer accepted by the flow search. Int32 (from `lumaIntOf`) is the
 *  Pixel Motion path — exact, GPU-twinnable; Float32 (from `lumaOf`) remains
 *  for the tracking-side consumers. Both are deterministic. */
export type LumaArray = Float32Array | Int32Array;

/** Sum of absolute differences between a block in `a` centred at (ax,ay) and
 *  one in `b` centred at (ax+dx, ay+dy). Out-of-bounds samples clamp. */
function blockSad(
  a: LumaArray, b: LumaArray, w: number, h: number,
  ax: number, ay: number, dx: number, dy: number, r: number,
): number {
  let sad = 0;
  for (let oy = -r; oy <= r; oy++) {
    const ya = Math.min(h - 1, Math.max(0, ay + oy));
    const yb = Math.min(h - 1, Math.max(0, ay + oy + dy));
    for (let ox = -r; ox <= r; ox++) {
      const xa = Math.min(w - 1, Math.max(0, ax + ox));
      const xb = Math.min(w - 1, Math.max(0, ax + ox + dx));
      sad += Math.abs(a[ya * w + xa]! - b[yb * w + xb]!);
    }
  }
  return sad;
}

/** Sub-pixel refinement: fit a parabola through the SAD at best±1 along one
 *  axis. Standard three-point vertex; clamped to ±0.5 so a degenerate fit
 *  cannot fling the vector. */
function parabolic(cm: number, c0: number, cp: number): number {
  const denom = cm - 2 * c0 + cp;
  if (denom <= 1e-9) return 0;
  const off = (0.5 * (cm - cp)) / denom;
  return Math.max(-0.5, Math.min(0.5, off));
}

/** Options with defaults applied — the single place the defaults live, so the
 *  CPU search, the GPU search and the tests all resolve identically. */
export function resolveFlowOptions(opts: FlowOptions = {}): {
  step: number; r: number; s: number; minImp: number;
} {
  return {
    step: Math.max(4, opts.step ?? 8),
    r: Math.max(2, opts.blockRadius ?? 3),
    s: Math.max(2, opts.searchRadius ?? 10),
    minImp: opts.minImprovement ?? 0.06,
  };
}

/**
 * Raw per-cell search results, `SEARCH_STRIDE` numbers per grid cell:
 * [zero, best, bx, by, cxm, cxp, cym, cyp]. This is the seam between the
 * search (CPU here, or the integer GPU pass) and `finalizeFlow` — SADs and
 * integer winner in, float field out. The four parabola SADs are only
 * meaningful when the improvement test passes; an abstaining cell may leave
 * them zero (the CPU search does, to skip four SADs; the GPU one computes
 * them unconditionally — `finalizeFlow` reads them only for valid cells, so
 * the outputs are still identical).
 */
export const SEARCH_STRIDE = 8;

/**
 * The per-cell SAD search half of `computeFlow`: two-stage block match on a
 * regular grid, into a raw `SEARCH_STRIDE`-per-cell buffer.
 *
 * Two-stage: EVEN offsets first (a quarter of the candidates), then a ±1
 * refine around the winner. Exhaustive was ~4× the cost for identical results
 * on real content — adjacent video frames don't carry the single-pixel
 * checkerboards that could hide a minimum between coarse taps, and the
 * parabola in `finalizeFlow` re-centres sub-pixel anyway. Deterministic:
 * fixed scan order, strict less-than (ties keep the earlier candidate; zero
 * displacement is the seed). The GPU twin mirrors this loop statement for
 * statement — any change here must land there too, or the init self-check
 * will (correctly) refuse the GPU path.
 */
export function searchAllCells(
  lumA: LumaArray,
  lumB: LumaArray,
  w: number,
  h: number,
  step: number,
  r: number,
  s: number,
  minImp: number,
): Float64Array {
  const cols = Math.max(1, Math.floor(w / step));
  const rows = Math.max(1, Math.floor(h / step));
  const raw = new Float64Array(cols * rows * SEARCH_STRIDE);

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const ax = Math.min(w - 1, Math.round((gx + 0.5) * step));
      const ay = Math.min(h - 1, Math.round((gy + 0.5) * step));
      const zero = blockSad(lumA, lumB, w, h, ax, ay, 0, 0, r);
      let best = zero;
      let bx = 0;
      let by = 0;
      for (let oy = -s; oy <= s; oy += 2) {
        for (let ox = -s; ox <= s; ox += 2) {
          if (ox === 0 && oy === 0) continue;
          const sad = blockSad(lumA, lumB, w, h, ax, ay, ox, oy, r);
          if (sad < best) {
            best = sad;
            bx = ox;
            by = oy;
          }
        }
      }
      // Refine around the coarse winner — anchored (cx,cy stay fixed for the
      // whole scan) so this is a neighbourhood argmin, not a greedy walk.
      const cx = bx;
      const cy = by;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) continue;
          const sad = blockSad(lumA, lumB, w, h, ax, ay, cx + ox, cy + oy, r);
          if (sad < best) {
            best = sad;
            bx = cx + ox;
            by = cy + oy;
          }
        }
      }
      const o = (gy * cols + gx) * SEARCH_STRIDE;
      raw[o] = zero;
      raw[o + 1] = best;
      raw[o + 2] = bx;
      raw[o + 3] = by;
      // Abstaining cell (same predicate finalizeFlow applies): skip the four
      // parabola SADs — they would never be read.
      if (zero - best < minImp * Math.max(1, zero)) continue;
      raw[o + 4] = blockSad(lumA, lumB, w, h, ax, ay, bx - 1, by, r);
      raw[o + 5] = blockSad(lumA, lumB, w, h, ax, ay, bx + 1, by, r);
      raw[o + 6] = blockSad(lumA, lumB, w, h, ax, ay, bx, by - 1, r);
      raw[o + 7] = blockSad(lumA, lumB, w, h, ax, ay, bx, by + 1, r);
    }
  }
  return raw;
}

/**
 * The float half: validity test, sub-pixel parabola, one 3×3 smoothing pass.
 * Runs on the CPU for BOTH search backends, on the exact numbers the search
 * produced — which is what makes the two backends bit-equal fields.
 */
export function finalizeFlow(
  raw: Float64Array,
  cols: number,
  rows: number,
  step: number,
  minImp: number,
): FlowField {
  const dx = new Float32Array(cols * rows);
  const dy = new Float32Array(cols * rows);
  const valid = new Uint8Array(cols * rows);

  for (let i = 0; i < cols * rows; i++) {
    const o = i * SEARCH_STRIDE;
    const zero = raw[o]!;
    const best = raw[o + 1]!;
    // Textureless or genuinely static: no vote. `zero` can itself be 0 on
    // flat synthetic frames — the max(1,…) keeps the ratio meaningful.
    if (zero - best < minImp * Math.max(1, zero)) continue;
    const bx = raw[o + 2]!;
    const by = raw[o + 3]!;
    dx[i] = bx + parabolic(raw[o + 4]!, best, raw[o + 5]!);
    dy[i] = by + parabolic(raw[o + 6]!, best, raw[o + 7]!);
    valid[i] = 1;
  }

  // One 3×3 box-smooth so neighbours share their estimate. Grid vectors are
  // heavily overlapping measurements of the same underlying motion; averaging
  // suppresses the lone wrong match without the cost of a median network.
  const sdx = new Float32Array(dx);
  const sdy = new Float32Array(dy);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const yy = gy + oy;
          const xx = gx + ox;
          if (yy < 0 || yy >= rows || xx < 0 || xx >= cols) continue;
          sx += dx[yy * cols + xx]!;
          sy += dy[yy * cols + xx]!;
          n++;
        }
      }
      sdx[gy * cols + gx] = sx / n;
      sdy[gy * cols + gx] = sy / n;
    }
  }

  return { cols, rows, step, dx: sdx, dy: sdy, valid };
}

/**
 * Block-matched flow a→b on a regular grid.
 *
 * Exhaustive search inside `searchRadius` (adjacent video frames move a few
 * pixels at flow resolution — the honest search space is small), sub-pixel
 * parabola on the winner, then one 3×3 smoothing pass so a single mismatched
 * block cannot punch a hole in the warp. Composed of `searchAllCells` +
 * `finalizeFlow` so the GPU search can substitute the first half.
 */
export function computeFlow(
  lumA: LumaArray,
  lumB: LumaArray,
  w: number,
  h: number,
  opts: FlowOptions = {},
): FlowField {
  const { step, r, s, minImp } = resolveFlowOptions(opts);
  const cols = Math.max(1, Math.floor(w / step));
  const rows = Math.max(1, Math.floor(h / step));
  const raw = searchAllCells(lumA, lumB, w, h, step, r, s, minImp);
  return finalizeFlow(raw, cols, rows, step, minImp);
}

/** Bilinear flow sample at a FLOW-RESOLUTION position. Edge-clamped. */
export function sampleFlow(f: FlowField, x: number, y: number): [number, number] {
  const gx = Math.min(f.cols - 1, Math.max(0, x / f.step - 0.5));
  const gy = Math.min(f.rows - 1, Math.max(0, y / f.step - 0.5));
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(f.cols - 1, x0 + 1);
  const y1 = Math.min(f.rows - 1, y0 + 1);
  const fx = gx - x0;
  const fy = gy - y0;
  const i00 = y0 * f.cols + x0;
  const i10 = y0 * f.cols + x1;
  const i01 = y1 * f.cols + x0;
  const i11 = y1 * f.cols + x1;
  const dx =
    (f.dx[i00]! * (1 - fx) + f.dx[i10]! * fx) * (1 - fy) +
    (f.dx[i01]! * (1 - fx) + f.dx[i11]! * fx) * fy;
  const dy =
    (f.dy[i00]! * (1 - fx) + f.dy[i10]! * fx) * (1 - fy) +
    (f.dy[i01]! * (1 - fx) + f.dy[i11]! * fx) * fy;
  return [dx, dy];
}

/** Bilinear RGBA fetch, edge-clamped, into `px` (length 4). */
function bilinearRgba(
  data: Uint8ClampedArray, w: number, h: number, x: number, y: number, px: Float32Array,
): void {
  const cx = Math.min(w - 1, Math.max(0, x));
  const cy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const p00 = (y0 * w + x0) * 4;
  const p10 = (y0 * w + x1) * 4;
  const p01 = (y1 * w + x0) * 4;
  const p11 = (y1 * w + x1) * 4;
  for (let c = 0; c < 4; c++) {
    px[c] =
      (data[p00 + c]! * (1 - fx) + data[p10 + c]! * fx) * (1 - fy) +
      (data[p01 + c]! * (1 - fx) + data[p11 + c]! * fx) * fy;
  }
}

/**
 * The in-between frame: symmetric warp-and-blend at weight `t` (0 = frame A,
 * 1 = frame B).
 *
 * For each output pixel, the flow (estimated at flow resolution, scaled by
 * `flowScaleX/Y` to output px) says where that region travels between the
 * frames; A is sampled `t` of the way BACK along it and B `1−t` of the way
 * FORWARD, then the two motion-compensated samples cross-fade. Where flow is
 * zero this is exactly Frame Mix — the deliberate degradation.
 *
 * The body is `sampleFlow` + `bilinearRgba` with the flow bilinear unrolled:
 * its x-side terms repeat every row and its y-side terms every column, so
 * they are computed w+h times instead of w·h — and the per-pixel [dx,dy]
 * tuple `sampleFlow` would allocate never exists. The per-pixel EXPRESSIONS
 * are unchanged, so the output is bit-identical to the composed form (pinned
 * by test). The GPU warp (`pixelMotionWarpGpu.ts`) mirrors this math within
 * float tolerance — a change here needs a matching one there, or its
 * self-check will (correctly) refuse the GPU warp.
 */
export function warpBlend(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  w: number,
  h: number,
  flow: FlowField,
  flowScaleX: number,
  flowScaleY: number,
  t: number,
  out: Uint8ClampedArray,
): void {
  const pa = new Float32Array(4);
  const pb = new Float32Array(4);
  const invSX = 1 / flowScaleX;
  const invSY = 1 / flowScaleY;
  const { cols, rows, step } = flow;
  const fdx = flow.dx;
  const fdy = flow.dy;
  const x0s = new Int32Array(w);
  const x1s = new Int32Array(w);
  const fxs = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    const gx = Math.min(cols - 1, Math.max(0, (x * invSX) / step - 0.5));
    const x0 = Math.floor(gx);
    x0s[x] = x0;
    x1s[x] = Math.min(cols - 1, x0 + 1);
    fxs[x] = gx - x0;
  }
  let o = 0;
  for (let y = 0; y < h; y++) {
    const gy = Math.min(rows - 1, Math.max(0, (y * invSY) / step - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(rows - 1, y0 + 1);
    const fy = gy - y0;
    const r0 = y0 * cols;
    const r1 = y1 * cols;
    for (let x = 0; x < w; x++, o += 4) {
      const x0 = x0s[x]!;
      const x1 = x1s[x]!;
      const fx = fxs[x]!;
      const i00 = r0 + x0;
      const i10 = r0 + x1;
      const i01 = r1 + x0;
      const i11 = r1 + x1;
      const fdxv =
        (fdx[i00]! * (1 - fx) + fdx[i10]! * fx) * (1 - fy) +
        (fdx[i01]! * (1 - fx) + fdx[i11]! * fx) * fy;
      const fdyv =
        (fdy[i00]! * (1 - fx) + fdy[i10]! * fx) * (1 - fy) +
        (fdy[i01]! * (1 - fx) + fdy[i11]! * fx) * fy;
      const dx = fdxv * flowScaleX;
      const dy = fdyv * flowScaleY;
      bilinearRgba(a, w, h, x - dx * t, y - dy * t, pa);
      bilinearRgba(b, w, h, x + dx * (1 - t), y + dy * (1 - t), pb);
      out[o] = pa[0]! * (1 - t) + pb[0]! * t;
      out[o + 1] = pa[1]! * (1 - t) + pb[1]! * t;
      out[o + 2] = pa[2]! * (1 - t) + pb[2]! * t;
      out[o + 3] = pa[3]! * (1 - t) + pb[3]! * t;
    }
  }
}
