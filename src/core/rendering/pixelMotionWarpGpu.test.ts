/**
 * The GPU warp path's CPU-side contracts, in jsdom — where there is no
 * WebGL2, which is itself one of the contracts (graceful null, CPU warp).
 *
 * What CAN'T run here is the shader; its closeness to `warpBlend` and its
 * own run-to-run determinism are enforced at runtime by `getGpuWarper`'s
 * init self-check, which refuses the GPU warp for the session on any
 * deviation. What CAN run here: the probe answers null without throwing and
 * is decided once, and `renderPixelMotion` still renders through the CPU
 * warp when the GPU one is unavailable.
 */

import { getGpuWarper, resetGpuWarperForTests } from './pixelMotionWarpGpu';
import { renderPixelMotion, clearPixelMotionCache } from './pixelMotion';

const W = 96;
const H = 96;

/** Band-limited textured RGBA frame — the runtime self-check's shape. */
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

describe('GPU warp availability contract', () => {
  afterEach(() => resetGpuWarperForTests());

  it('returns null where WebGL2 is unavailable, without throwing', () => {
    expect(getGpuWarper()).toBeNull();
    // Decided-once: a second probe answers from the cached decision.
    expect(getGpuWarper()).toBeNull();
  });

  it('renderPixelMotion still renders through the CPU warp', () => {
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
    const res = renderPixelMotion('warp-fallback-test', mk(pattern(0, 0)), mk(pattern(5, 0)), 0.5, out);
    expect(res).not.toBeNull();
    const px = res!.getContext('2d')!.getImageData(0, 0, W, H);
    let nonZero = 0;
    for (let i = 3; i < px.data.length; i += 4) if (px.data[i]! > 0) nonZero++;
    expect(nonZero).toBe(W * H); // fully opaque output, not a failed blit
  });
});
