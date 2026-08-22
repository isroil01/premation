/**
 * Content-Aware Fill — exemplar PatchMatch inpainting + flow propagation.
 *
 * Classical Criminisi / PatchMatch style fill for a masked hole, then warp the
 * filled region forward with optical flow (AE Content-Aware Fill's video mode,
 * without Adobe's neural prior). Pure CPU; works offline on exact frames.
 */

import { computeFlow, lumaOf, sampleFlow } from '@core/rendering/pixelMotionFlow';

export interface InpaintOptions {
  /** Patch half-size (default 4 → 9×9). */
  patchHalf?: number;
  /** Random search iterations per pixel. */
  iterations?: number;
  /** PRNG seed for deterministic fills. */
  seed?: number;
}

/**
 * Fill pixels where `hole[i] !== 0` using nearest known neighbourhood patches.
 * `rgba` is modified in place. Returns count of filled pixels.
 */
export function inpaintPatchMatch(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  hole: Uint8Array,
  opts: InpaintOptions = {},
): number {
  const half = opts.patchHalf ?? 4;
  const iters = opts.iterations ?? 4;
  const n = width * height;
  // nnf: for each hole pixel, (sx, sy) of best source
  const nnx = new Int32Array(n);
  const nny = new Int32Array(n);
  const known: number[] = [];
  const holes: number[] = [];
  for (let i = 0; i < n; i++) {
    if (hole[i]) holes.push(i);
    else known.push(i);
  }
  if (holes.length === 0 || known.length === 0) return 0;

  // Deterministic PRNG so export/scrub fills match.
  let state = (opts.seed ?? (holes.length * 2654435761)) >>> 0;
  const rand = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const randKnown = (): number => known[(rand() * known.length) | 0]!;

  for (const i of holes) {
    const k = randKnown();
    nnx[i] = k % width;
    nny[i] = (k / width) | 0;
  }

  const patchDist = (tx: number, ty: number, sx: number, sy: number): number => {
    let sum = 0;
    let c = 0;
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const ax = tx + dx;
        const ay = ty + dy;
        const bx = sx + dx;
        const by = sy + dy;
        if (ax < 0 || ay < 0 || ax >= width || ay >= height) continue;
        if (bx < 0 || by < 0 || bx >= width || by >= height) continue;
        const ai = ay * width + ax;
        const bi = by * width + bx;
        // Prefer comparing against known pixels only.
        if (hole[ai] && hole[bi]) continue;
        const ap = ai * 4;
        const bp = bi * 4;
        const dr = rgba[ap]! - rgba[bp]!;
        const dg = rgba[ap + 1]! - rgba[bp + 1]!;
        const db = rgba[ap + 2]! - rgba[bp + 2]!;
        sum += dr * dr + dg * dg + db * db;
        c++;
      }
    }
    return c > 0 ? sum / c : 1e12;
  };

  for (let it = 0; it < iters; it++) {
    const forward = it % 2 === 0;
    const order = forward ? holes : holes.slice().reverse();
    for (const i of order) {
      const tx = i % width;
      const ty = (i / width) | 0;
      let bestX = nnx[i]!;
      let bestY = nny[i]!;
      let bestD = patchDist(tx, ty, bestX, bestY);

      // Propagation from neighbours.
      const nbrs: Array<[number, number]> = forward
        ? [[tx - 1, ty], [tx, ty - 1]]
        : [[tx + 1, ty], [tx, ty + 1]];
      for (const [nx, ny] of nbrs) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (!hole[ni]) continue;
        const candX = nnx[ni]! + (tx - nx);
        const candY = nny[ni]! + (ty - ny);
        if (candX < half || candY < half || candX >= width - half || candY >= height - half) continue;
        if (hole[candY * width + candX]) continue;
        const d = patchDist(tx, ty, candX, candY);
        if (d < bestD) {
          bestD = d;
          bestX = candX;
          bestY = candY;
        }
      }

      // Random search.
      let radius = Math.max(width, height);
      while (radius >= 1) {
        const rx = bestX + ((rand() * 2 - 1) * radius) | 0;
        const ry = bestY + ((rand() * 2 - 1) * radius) | 0;
        if (rx >= half && ry >= half && rx < width - half && ry < height - half && !hole[ry * width + rx]) {
          const d = patchDist(tx, ty, rx, ry);
          if (d < bestD) {
            bestD = d;
            bestX = rx;
            bestY = ry;
          }
        }
        radius = (radius / 2) | 0;
      }
      nnx[i] = bestX;
      nny[i] = bestY;
    }
  }

  // Apply: copy centre pixel from matched source.
  for (const i of holes) {
    const sx = nnx[i]!;
    const sy = nny[i]!;
    const sp = (sy * width + sx) * 4;
    const dp = i * 4;
    rgba[dp] = rgba[sp]!;
    rgba[dp + 1] = rgba[sp + 1]!;
    rgba[dp + 2] = rgba[sp + 2]!;
    rgba[dp + 3] = 255;
  }
  return holes.length;
}

/**
 * Propagate a filled frame to the next using flow, then re-inpaint residual holes.
 */
export function propagateFillFrame(
  prevRgba: Uint8ClampedArray,
  nextRgba: Uint8ClampedArray,
  width: number,
  height: number,
  hole: Uint8Array,
  opts?: InpaintOptions,
): number {
  const prevL = lumaOf(prevRgba, width, height);
  const nextL = lumaOf(nextRgba, width, height);
  const flow = computeFlow(prevL, nextL, width, height, { step: 4 });
  // Warp previous filled colours into next hole (bilinear).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!hole[i]) continue;
      const [dx, dy] = sampleFlow(flow, x, y);
      const sx = x - dx;
      const sy = y - dy;
      if (sx < 0 || sy < 0 || sx >= width - 1 || sy >= height - 1) continue;
      const x0 = sx | 0;
      const y0 = sy | 0;
      const fx = sx - x0;
      const fy = sy - y0;
      const sample = (xx: number, yy: number, ch: number) =>
        prevRgba[(yy * width + xx) * 4 + ch]!;
      const dp = i * 4;
      for (let ch = 0; ch < 3; ch++) {
        nextRgba[dp + ch] =
          sample(x0, y0, ch) * (1 - fx) * (1 - fy) +
          sample(x0 + 1, y0, ch) * fx * (1 - fy) +
          sample(x0, y0 + 1, ch) * (1 - fx) * fy +
          sample(x0 + 1, y0 + 1, ch) * fx * fy;
      }
      nextRgba[dp + 3] = 255;
      hole[i] = 0;
    }
  }
  const residual = new Uint8Array(width * height);
  for (let i = 0; i < residual.length; i++) residual[i] = hole[i] ? 255 : 0;
  return inpaintPatchMatch(nextRgba, width, height, residual, { ...opts, iterations: opts?.iterations ?? 5 });
}

/**
 * Bidirectional temporal fill: forward then backward residual polish.
 */
export function propagateFillBidirectional(
  frames: Uint8ClampedArray[],
  width: number,
  height: number,
  holes: Uint8Array[],
  opts?: InpaintOptions,
): number {
  if (frames.length === 0) return 0;
  let filled = 0;
  for (let i = 0; i < frames.length; i++) {
    if (i === 0) filled += inpaintPatchMatch(frames[0]!, width, height, holes[0]!, opts);
    else filled += propagateFillFrame(frames[i - 1]!, frames[i]!, width, height, holes[i]!, opts);
  }
  for (let i = frames.length - 2; i >= 0; i--) {
    const residual = holes[i]!.slice();
    if (residual.some((v) => v)) {
      filled += propagateFillFrame(frames[i + 1]!, frames[i]!, width, height, residual, opts);
    }
  }
  return filled;
}
