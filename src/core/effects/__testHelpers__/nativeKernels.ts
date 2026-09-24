/**
 * The TS side of the E4 kernel ports, shared by the parity fixture
 * (`nativeKernelCrossEngine.test.ts`) and the TS bench
 * (`native/engine/tests/bench_effects_ts.mjs`): one entry point per ported
 * effect with the kernel's own arguments by name — the same table as
 * `native/engine/src/effects/kernel_dispatch.cpp` — and the synthetic input.
 */

import { blurRgba, blurDimensions, radialBlurData, channelBlurData, unsharpMaskData } from '../blurs';
import { turbulentNoiseData, addGrainData, medianData } from '../noiseEffects';
import { minimaxData, minimaxOp, minimaxChannel, simpleChokerData } from '../keyingEffects';
import { mosaicData, findEdgesData, embossData } from '../stylize';
import { vibranceData } from '../colorEffects';
import { bilateralBlurData, smartBlurData, cameraLensBlurData } from '../aeBlurAdvanced';
import { sharpenData, addNoiseData } from '../canvas2dEffects';

export type Args = Record<string, number>;

/** Runs the TS kernel for `type` IN PLACE, exactly as kernel_dispatch.cpp does. */
export function runKernel(type: string, a: Args, data: Uint8ClampedArray, w: number, h: number): void {
  const n = (k: string, d: number): number => a[k] ?? d;
  const b = (k: string, d: boolean): boolean => (a[k] ?? (d ? 1 : 0)) !== 0;
  switch (type) {
    case 'gaussian-blur':
    case 'fast-box-blur':
      blurRgba(data, w, h, n('radius', 0), {
        dimensions: blurDimensions(n('dimensions', 0)),
        iterations: type === 'gaussian-blur' ? 3 : n('iterations', 1),
        repeatEdge: b('repeatEdge', true),
      });
      return;
    case 'radial-blur':
      data.set(radialBlurData(data, w, h, n('amount', 0), n('centerX', w / 2), n('centerY', h / 2), n('zoom', 0) !== 0 ? 'zoom' : 'spin', n('quality', 8)));
      return;
    case 'channel-blur':
      channelBlurData(data, w, h, { red: n('red', 0), green: n('green', 0), blue: n('blue', 0), alpha: n('alpha', 0) }, blurDimensions(n('dimensions', 0)), b('repeatEdge', true));
      return;
    case 'unsharp-mask':
      unsharpMaskData(data, w, h, n('amount', 0), n('radius', 0), n('threshold', 0));
      return;
    case 'sharpen':
      data.set(sharpenData(data, w, h, n('amount', 0)));
      return;
    case 'noise':
      addNoiseData(data, w, n('amount', 0), n('evolution', 0), b('mono', true));
      return;
    case 'add-grain':
      addGrainData(data, w, h, n('intensity', 0), n('size', 1), n('saturation', 0), n('seed', 0));
      return;
    case 'turbulent-noise':
      turbulentNoiseData(data, w, h, n('scale', 100), n('complexity', 4), n('evolution', 0), n('contrast', 100), n('brightness', 0), b('invert', false));
      return;
    case 'median':
      data.set(medianData(data, w, h, n('radius', 0)));
      return;
    case 'minimax':
      minimaxData(data, w, h, minimaxOp(n('op', 0)), n('radius', 0), minimaxChannel(n('channel', 0)), blurDimensions(n('direction', 0)));
      return;
    case 'simple-choker':
      simpleChokerData(data, w, h, n('chokePx', 0));
      return;
    case 'mosaic':
      data.set(mosaicData(data, w, h, n('hBlocks', 10), n('vBlocks', 10), b('sharpColors', false)));
      return;
    case 'find-edges':
      data.set(findEdgesData(data, w, h, b('invert', true)));
      return;
    case 'emboss':
      data.set(embossData(data, w, h, n('angleDeg', 45), n('relief', 1), n('contrast', 100), n('blend', 0)));
      return;
    case 'vibrance':
      vibranceData(data, n('vibrance', 0), n('saturation', 0));
      return;
    case 'bilateral-blur':
      data.set(bilateralBlurData(data, w, h, n('radius', 0), n('colorSigma', 30), b('preserveAlpha', false)));
      return;
    case 'smart-blur':
      data.set(smartBlurData(data, w, h, n('radius', 0), n('threshold', 0), n('mode', 0)));
      return;
    case 'camera-lens-blur':
      data.set(cameraLensBlurData(data, w, h, n('radius', 0), n('blades', 0), n('rotation', 0), n('gain', 1), n('threshold', 100)));
      return;
    default:
      throw new Error(`no kernel for ${type}`);
  }
}

/**
 * Synthetic straight-RGBA inputs: smooth gradients, a hard-edged disc, hashed
 * speckle, a fully transparent band (with junk colour, which premultiplying
 * kernels must ignore) and a soft alpha ramp.
 */
export function makeImage(w: number, h: number, salt: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  let s = (0x9e3779b9 ^ salt) >>> 0;
  const rnd = (): number => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s & 0xff;
  };
  const cx = w * 0.4, cy = h * 0.55, rad = Math.min(w, h) * 0.3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const inDisc = (x - cx) * (x - cx) + (y - cy) * (y - cy) < rad * rad;
      const speck = rnd();
      let r = Math.floor((x * 255) / Math.max(1, w - 1));
      let g = Math.floor((y * 255) / Math.max(1, h - 1));
      let b = (x * 7 + y * 13 + salt) & 0xff;
      if (inDisc) { r = 250; g = 40 + (speck & 31); b = 20; }
      if ((speck & 15) === 0) { r = speck; g = 255 - speck; b = speck ^ 0x5a; }
      let a = 255;
      if (y < h * 0.15) a = 0;                                      // transparent band
      else if (x > w * 0.8) a = Math.floor(((w - 1 - x) * 255) / Math.max(1, w * 0.2)); // soft ramp
      else if ((speck & 63) === 1) a = speck;                        // stray partial alpha
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
    }
  }
  return d;
}

