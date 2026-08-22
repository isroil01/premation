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
 *  no GPU rasterization in the estimation. The same two frames always produce
 *  the same flow and the same in-between, so export matches preview and a
 *  scrub back redraws the same frame. (This was the stated reason the feature
 *  waited; the tracker's landing proved the pattern.)
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

/** Sum of absolute differences between a block in `a` centred at (ax,ay) and
 *  one in `b` centred at (ax+dx, ay+dy). Out-of-bounds samples clamp. */
function blockSad(
  a: Float32Array, b: Float32Array, w: number, h: number,
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

/**
 * Block-matched flow a→b on a regular grid.
 *
 * Exhaustive search inside `searchRadius` (adjacent video frames move a few
 * pixels at flow resolution — the honest search space is small), sub-pixel
 * parabola on the winner, then one 3×3 smoothing pass so a single mismatched
 * block cannot punch a hole in the warp.
 */
export function computeFlow(
  lumA: Float32Array,
  lumB: Float32Array,
  w: number,
  h: number,
  opts: FlowOptions = {},
): FlowField {
  const step = Math.max(4, opts.step ?? 8);
  const r = Math.max(2, opts.blockRadius ?? 3);
  const s = Math.max(2, opts.searchRadius ?? 10);
  const minImp = opts.minImprovement ?? 0.06;
  const cols = Math.max(1, Math.floor(w / step));
  const rows = Math.max(1, Math.floor(h / step));
  const dx = new Float32Array(cols * rows);
  const dy = new Float32Array(cols * rows);
  const valid = new Uint8Array(cols * rows);

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const ax = Math.min(w - 1, Math.round((gx + 0.5) * step));
      const ay = Math.min(h - 1, Math.round((gy + 0.5) * step));
      const zero = blockSad(lumA, lumB, w, h, ax, ay, 0, 0, r);
      let best = zero;
      let bx = 0;
      let by = 0;
      // Two-stage search: EVEN offsets first (a quarter of the candidates),
      // then a ±1 refine around the winner. Exhaustive was ~4× the cost for
      // identical results on real content — adjacent video frames don't carry
      // the single-pixel checkerboards that could hide a minimum between
      // coarse taps, and the parabola below re-centres sub-pixel anyway.
      // Deterministic: fixed scan order, strict less-than (ties keep the
      // earlier candidate; zero displacement is the seed).
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
      // Textureless or genuinely static: no vote. `zero` can itself be 0 on
      // flat synthetic frames — the max(1,…) keeps the ratio meaningful.
      if (zero - best < minImp * Math.max(1, zero)) {
        continue;
      }
      // Sub-pixel: parabola along each axis around the winner.
      const cx0 = best;
      const cxm = blockSad(lumA, lumB, w, h, ax, ay, bx - 1, by, r);
      const cxp = blockSad(lumA, lumB, w, h, ax, ay, bx + 1, by, r);
      const cym = blockSad(lumA, lumB, w, h, ax, ay, bx, by - 1, r);
      const cyp = blockSad(lumA, lumB, w, h, ax, ay, bx, by + 1, r);
      dx[gy * cols + gx] = bx + parabolic(cxm, cx0, cxp);
      dy[gy * cols + gx] = by + parabolic(cym, cx0, cyp);
      valid[gy * cols + gx] = 1;
    }
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
  let o = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++, o += 4) {
      const [fdx, fdy] = sampleFlow(flow, x * invSX, y * invSY);
      const dx = fdx * flowScaleX;
      const dy = fdy * flowScaleY;
      bilinearRgba(a, w, h, x - dx * t, y - dy * t, pa);
      bilinearRgba(b, w, h, x + dx * (1 - t), y + dy * (1 - t), pb);
      out[o] = pa[0]! * (1 - t) + pb[0]! * t;
      out[o + 1] = pa[1]! * (1 - t) + pb[1]! * t;
      out[o + 2] = pa[2]! * (1 - t) + pb[2]! * t;
      out[o + 3] = pa[3]! * (1 - t) + pb[3]! * t;
    }
  }
}
