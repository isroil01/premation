/**
 * The GPU flow path's CPU-side halves, in jsdom — where there is no WebGL2,
 * which is itself one of the contracts (graceful null, CPU fallback).
 *
 * What CAN'T run here is the shader; its bit-equality with the CPU search is
 * enforced at runtime by the estimator's init self-check (see
 * `pixelMotionFlowGpu.ts`), which refuses the GPU path outright on any
 * deviation. What CAN run here is everything around it: the readback decode
 * (`flowFromSearchTexels`) must reproduce `computeFlow` exactly when fed a
 * CPU-packed readback — including the GPU's habit of computing parabola SADs
 * for cells the CPU search abstains on.
 */

import {
  computeFlow,
  lumaIntOf,
  resolveFlowOptions,
  searchAllCells,
  SEARCH_STRIDE,
} from './pixelMotionFlow';
import {
  DISPLACEMENT_BIAS,
  flowFromSearchTexels,
  getGpuFlowEstimator,
  resetGpuFlowEstimatorForTests,
} from './pixelMotionFlowGpu';
import { renderPixelMotion, clearPixelMotionCache } from './pixelMotion';

const W = 96;
const H = 96;

/** Band-limited textured RGBA frame with per-channel structure — the same
 *  shape as the runtime self-check's pattern. Band-limited on purpose: the
 *  coarse even-offset search stage cannot lock onto per-pixel noise (the
 *  caveat documented on `searchAllCells`), and real video content is smooth. */
function pattern(shiftX: number, shiftY: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = x - shiftX;
      const sy = y - shiftY;
      const o = (y * W + x) * 4;
      d[o] = 128 + 60 * Math.sin(sx * 0.31) * Math.cos(sy * 0.23) + 40 * Math.sin((sx + sy) * 0.11);
      d[o + 1] = 128 + 70 * Math.cos(sx * 0.17) * Math.sin(sy * 0.29) + 30 * Math.cos((sx - sy) * 0.13);
      d[o + 2] = 128 + 50 * Math.sin(sx * 0.23 + sy * 0.19);
      d[o + 3] = 255;
    }
  }
  return d;
}

/** Pack a raw search buffer the way the two RGBA32UI attachments come back. */
function packAsTexels(raw: Float64Array): { att0: Uint32Array; att1: Uint32Array } {
  const cells = raw.length / SEARCH_STRIDE;
  const att0 = new Uint32Array(cells * 4);
  const att1 = new Uint32Array(cells * 4);
  for (let i = 0; i < cells; i++) {
    const o = i * SEARCH_STRIDE;
    att0[i * 4] = raw[o]!;
    att0[i * 4 + 1] = raw[o + 1]!;
    att0[i * 4 + 2] = raw[o + 2]! + DISPLACEMENT_BIAS;
    att0[i * 4 + 3] = raw[o + 3]! + DISPLACEMENT_BIAS;
    att1[i * 4] = raw[o + 4]!;
    att1[i * 4 + 1] = raw[o + 5]!;
    att1[i * 4 + 2] = raw[o + 6]!;
    att1[i * 4 + 3] = raw[o + 7]!;
  }
  return { att0, att1 };
}

describe('flowFromSearchTexels', () => {
  const lumA = lumaIntOf(pattern(0, 0), W, H);
  const lumB = lumaIntOf(pattern(-3, 2), W, H); // negative x exercises the bias
  const { step, r, s, minImp } = resolveFlowOptions();
  const cols = Math.floor(W / step);
  const rows = Math.floor(H / step);

  it('decoding a CPU-packed readback reproduces computeFlow exactly', () => {
    const raw = searchAllCells(lumA, lumB, W, H, step, r, s, minImp);
    const { att0, att1 } = packAsTexels(raw);
    const decoded = flowFromSearchTexels(att0, att1, cols, rows, step, minImp);
    const reference = computeFlow(lumA, lumB, W, H);
    expect(Array.from(decoded.dx)).toEqual(Array.from(reference.dx));
    expect(Array.from(decoded.dy)).toEqual(Array.from(reference.dy));
    expect(Array.from(decoded.valid)).toEqual(Array.from(reference.valid));
  });

  it('parabola SADs on abstaining cells are ignored, as the GPU relies on', () => {
    // The GPU search computes parabola SADs unconditionally; the CPU search
    // leaves them zero for abstaining cells. Emulate the GPU by searching
    // with an always-pass improvement threshold, then finalizing with the
    // real one — the fields must still be identical.
    const rawGpuStyle = searchAllCells(lumA, lumB, W, H, step, r, s, -1);
    const { att0, att1 } = packAsTexels(rawGpuStyle);
    const decoded = flowFromSearchTexels(att0, att1, cols, rows, step, minImp);
    const reference = computeFlow(lumA, lumB, W, H);
    expect(Array.from(decoded.dx)).toEqual(Array.from(reference.dx));
    expect(Array.from(decoded.dy)).toEqual(Array.from(reference.dy));
    expect(Array.from(decoded.valid)).toEqual(Array.from(reference.valid));
  });
});

describe('integer-luma flow (the Pixel Motion path)', () => {
  it('recovers a known translation to within a pixel', () => {
    const f = computeFlow(lumaIntOf(pattern(0, 0), W, H), lumaIntOf(pattern(4, -3), W, H), W, H);
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let gy = 3; gy < f.rows - 3; gy++) {
      for (let gx = 3; gx < f.cols - 3; gx++) {
        sx += f.dx[gy * f.cols + gx]!;
        sy += f.dy[gy * f.cols + gx]!;
        n++;
      }
    }
    expect(Math.abs(sx / n - 4)).toBeLessThan(1);
    expect(Math.abs(sy / n + 3)).toBeLessThan(1);
  });

  it('two runs produce the identical field', () => {
    const mk = (): ReturnType<typeof computeFlow> =>
      computeFlow(lumaIntOf(pattern(0, 0), W, H), lumaIntOf(pattern(2, 5), W, H), W, H);
    const f1 = mk();
    const f2 = mk();
    expect(Array.from(f1.dx)).toEqual(Array.from(f2.dx));
    expect(Array.from(f1.dy)).toEqual(Array.from(f2.dy));
    expect(Array.from(f1.valid)).toEqual(Array.from(f2.valid));
  });
});

describe('GPU availability contract', () => {
  afterEach(() => resetGpuFlowEstimatorForTests());

  it('returns null where WebGL2 is unavailable, without throwing', () => {
    expect(getGpuFlowEstimator()).toBeNull();
    // Decided-once: a second probe answers from the cached decision.
    expect(getGpuFlowEstimator()).toBeNull();
  });

  it('renderPixelMotion still renders through the CPU fallback', () => {
    clearPixelMotionCache();
    const mk = (d: Uint8ClampedArray): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(W, H);
      img.data.set(d);
      ctx.putImageData(img, 0, 0);
      return c;
    };
    const out = document.createElement('canvas');
    const res = renderPixelMotion('gpu-fallback-test', mk(pattern(0, 0)), mk(pattern(5, 0)), 0.5, out);
    expect(res).not.toBeNull();
    const px = res!.getContext('2d')!.getImageData(0, 0, W, H);
    let nonZero = 0;
    for (let i = 3; i < px.data.length; i += 4) if (px.data[i]! > 0) nonZero++;
    expect(nonZero).toBe(W * H); // fully opaque output, not a failed blit
  });
});
