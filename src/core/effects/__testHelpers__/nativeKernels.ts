/**
 * The TS side of the E4 kernel ports, shared by the parity fixture
 * (`nativeKernelCrossEngine.test.ts`) and the TS bench
 * (`native/engine/tests/bench_effects_ts.mjs`): one entry point per ported
 * effect with the kernel's own arguments by name — the same table as
 * `native/engine/src/effects/kernel_dispatch.cpp` — and the synthetic input.
 */

import { blurRgba, blurDimensions, radialBlurData, channelBlurData, unsharpMaskData } from '../blurs';
import { turbulentNoiseData, addGrainData, medianData } from '../noiseEffects';
import {
  minimaxData, minimaxOp, minimaxChannel, simpleChokerData, linearColorKeyData, colorMatchMode, lumaKeyData, lumaKeyType,
  shiftChannelsData, channelSource,
} from '../keyingEffects';
import { applyKeyData, chokeAlpha, softenAlpha } from '../keylight';
import {
  irisWipeData, lightWipeData, lineSweepData, gridWipeData, dustAndScratchesData, noiseAlphaData,
} from '../aeTransitionsAdvanced';
import {
  cartoonData, brushStrokesData, strobeLightData, colorEmbossData, halftoneData, kaleidoscopeData, vignetteData,
  burnFilmData,
} from '../aeStylizeAdvanced';
import {
  venetianBlindsData, gradientWipeData, luminanceMapFrom, cardWipeData, cardWipeDirection, radialWipeData,
  radialWipeDirection, blockDissolveData,
} from '../transitions';
import { alphaLevelsData, solidCompositeData, channelCombinerData, removeColorMattingData } from '../aeChannel';
import {
  equalizeData, autoLevelsData, autoContrastData, autoColorData, changeColorData, changeToColorData, leaveColorData,
  tonerData,
} from '../aeColorAdvanced';
import {
  bulgeData, spherizeData, twirlData, cornerPinData, polarCoordinatesData, polarConversion, mirrorData, offsetData,
  opticsCompensationData, meshWarpData, liquifyData,
} from '../distort';
import { colorKeyData, colorRangeData, extractData, spillSuppressorData, matteChokerData } from '../aeKeyingAdvanced';
import { mosaicData, findEdgesData, embossData, roughenEdgesData, scatterData } from '../stylize';
import { waveWarpData, turbulentDisplaceData, curlNoiseData } from '../warp';
import { vibranceData, coloramaData, COLORAMA_PALETTES } from '../colorEffects';
import { photoFilterData, blackAndWhiteData, tritoneData, thresholdData } from '../aeColor';
import { selectiveColorData, selectiveRange, shadowHighlightData } from '../toneEffects';
import { bilateralBlurData, smartBlurData, cameraLensBlurData } from '../aeBlurAdvanced';
import { sharpenData, addNoiseData } from '../canvas2dEffects';

export type Args = Record<string, number>;

/** Runs the TS kernel for `type` IN PLACE, exactly as kernel_dispatch.cpp does. */
export function runKernel(type: string, a: Args, data: Uint8ClampedArray, w: number, h: number): void {
  const n = (k: string, d: number): number => a[k] ?? d;
  const b = (k: string, d: boolean): boolean => (a[k] ?? (d ? 1 : 0)) !== 0;
  const key = (): [number, number, number] => [n('keyR', 0), n('keyG', 255), n('keyB', 0)];
  const rgb = (name: string, d: [number, number, number]): [number, number, number] =>
    [n(`${name}R`, d[0]), n(`${name}G`, d[1]), n(`${name}B`, d[2])];
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
    case 'photo-filter':
      photoFilterData(data, n('filterR', 255), n('filterG', 128), n('filterB', 0), n('density', 25), b('preserveLuminosity', true));
      return;
    case 'black-and-white':
      blackAndWhiteData(
        data,
        { reds: n('reds', 0.4), yellows: n('yellows', 0.6), greens: n('greens', 0.4), cyans: n('cyans', 0.6), blues: n('blues', 0.2), magentas: n('magentas', 0.8) },
        b('useTint', false) ? [n('tintR', 0), n('tintG', 0), n('tintB', 0)] : null,
      );
      return;
    case 'tritone':
      tritoneData(
        data,
        [n('shadowsR', 0), n('shadowsG', 0), n('shadowsB', 0)],
        [n('midtonesR', 128), n('midtonesG', 128), n('midtonesB', 128)],
        [n('highlightsR', 255), n('highlightsG', 255), n('highlightsB', 255)],
        n('blend', 0),
      );
      return;
    case 'threshold':
      thresholdData(data, n('level', 128));
      return;
    case 'selective-color':
      selectiveColorData(data, selectiveRange(n('range', 0)), n('cyan', 0), n('magenta', 0), n('yellow', 0), n('black', 0), b('relative', true));
      return;
    case 'shadow-highlight':
      shadowHighlightData(data, w, h, n('shadowAmount', 0), n('highlightAmount', 0), n('radius', 0), n('tonalWidth', 50));
      return;
    case 'colorama': {
      const idx = Math.max(0, Math.min(COLORAMA_PALETTES.length - 1, Math.round(n('palette', 0))));
      coloramaData(data, COLORAMA_PALETTES[idx]!.stops, n('phaseShift', 0), n('cycleRepetitions', 1), n('blendWithOriginal', 0));
      return;
    }
    case 'keylight': {
      const hex = `#${key().map((c) => c.toString(16).padStart(2, '0')).join('')}`;
      applyKeyData(data, {
        screenColor: hex, balance: n('balance', 0.5), gain: n('gain', 1),
        clipBlack: n('clipBlack', 0), clipWhite: n('clipWhite', 1), despill: n('despill', 0.5),
      });
      chokeAlpha(data, w, h, n('choke', 0));
      softenAlpha(data, w, h, n('matteSoftness', 0));
      return;
    }
    case 'linear-color-key':
      linearColorKeyData(data, key(), colorMatchMode(n('matchOn', 0)), n('tolerance', 10), n('softness', 0), b('keepMatched', false));
      return;
    case 'luma-key':
      lumaKeyData(data, lumaKeyType(n('keyType', 0)), n('threshold', 128), n('tolerance', 0), n('softness', 0));
      return;
    case 'shift-channels':
      shiftChannelsData(data, channelSource(n('alphaFrom', 0)), channelSource(n('redFrom', 1)), channelSource(n('greenFrom', 2)), channelSource(n('blueFrom', 3)));
      return;
    case 'color-key':
      colorKeyData(data, key(), n('tolerance', 10), n('edgeSoftness', 0));
      return;
    case 'color-range':
      colorRangeData(data, key(), n('space', 0), n('minTol', 0), n('maxTol', 20), n('lumaWeight', 50));
      return;
    case 'extract':
      extractData(data, n('channel', 0), n('black', 0), n('white', 255), n('blackSoft', 0), n('whiteSoft', 0), b('invert', false));
      return;
    case 'spill-suppressor':
      spillSuppressorData(data, key(), n('amount', 50), b('preserveLuma', true));
      return;
    case 'matte-choker':
      data.set(matteChokerData(data, w, h, n('spread', 0), n('choke', 0), n('softness', 0), n('iterations', 1)));
      return;
    case 'bulge':
      data.set(bulgeData(data, w, h, n('centerX', w / 2), n('centerY', h / 2), n('radius', 50), n('height', 50)));
      return;
    case 'spherize':
      data.set(spherizeData(data, w, h, n('centerX', w / 2), n('centerY', h / 2), n('radius', 50), n('amount', 50)));
      return;
    case 'twirl':
      data.set(twirlData(data, w, h, n('centerX', w / 2), n('centerY', h / 2), n('radius', 50), n('angle', 90)));
      return;
    case 'corner-pin':
      data.set(cornerPinData(data, w, h, [n('tlx', 0), n('tly', 0), n('trx', w), n('try', 0), n('brx', w), n('bry', h), n('blx', 0), n('bly', h)]));
      return;
    case 'polar-coordinates':
      data.set(polarCoordinatesData(data, w, h, n('interpolation', 100), polarConversion(n('conversion', 0))));
      return;
    case 'mirror':
      data.set(mirrorData(data, w, h, n('centerX', w / 2), n('centerY', h / 2), n('angle', 0)));
      return;
    case 'offset':
      offsetData(data, w, h, n('shiftX', w / 2), n('shiftY', h / 2), n('blend', 0));
      return;
    case 'optics-compensation':
      data.set(opticsCompensationData(data, w, h, n('fov', 0), b('reverse', false), n('centerX', 0), n('centerY', 0)));
      return;
    case 'mesh-warp': {
      const offsets = Array.from({ length: 16 }, (_, i) => ({ x: n(`mx${i}`, 0), y: n(`my${i}`, 0) }));
      data.set(meshWarpData(data, w, h, offsets));
      return;
    }
    case 'liquify':
      data.set(liquifyData(data, w, h, n('centerX', w / 2), n('centerY', h / 2), n('radius', 50), n('pushX', 0), n('pushY', 0), n('twirl', 0), n('pinch', 0)));
      return;
    case 'equalize':
      equalizeData(data, n('mode', 0), n('amount', 100), n('blend', 0));
      return;
    case 'auto-levels':
      autoLevelsData(data, n('blackClip', 0.1), n('whiteClip', 0.1), n('blend', 0));
      return;
    case 'auto-contrast':
      autoContrastData(data, n('blackClip', 0.1), n('whiteClip', 0.1), n('blend', 0));
      return;
    case 'auto-color':
      autoColorData(data, n('blackClip', 0.1), n('whiteClip', 0.1), n('snapNeutral', 0), n('blend', 0));
      return;
    case 'change-color':
      changeColorData(data, rgb('target', [255, 0, 0]), n('hueTol', 15), n('satTol', 50), n('lightTol', 50), n('softness', 20), n('hueShift', 0), n('satScale', 0), n('lightScale', 0), b('invert', false));
      return;
    case 'change-to-color':
      changeToColorData(data, rgb('from', [255, 0, 0]), rgb('to', [0, 0, 255]), n('hueTol', 15), n('satTol', 50), n('lightTol', 50), n('softness', 20), b('preserveLightness', true));
      return;
    case 'leave-color':
      leaveColorData(data, rgb('target', [255, 0, 0]), n('tolerance', 15), n('softness', 20), n('amount', 100));
      return;
    case 'toner':
      tonerData(data, rgb('black', [0, 0, 0]), rgb('shadows', [60, 40, 90]), rgb('midtones', [140, 120, 100]), rgb('highlights', [220, 210, 180]), rgb('white', [255, 255, 255]), n('blend', 0));
      return;
    case 'venetian-blinds':
      venetianBlindsData(data, w, h, n('completion', 0), n('direction', 0), n('width', 20), n('feather', 0));
      return;
    case 'gradient-wipe':
      gradientWipeData(data, luminanceMapFrom(data), n('completion', 0), n('softness', 0), b('invert', false));
      return;
    case 'card-wipe':
      cardWipeData(data, w, h, n('completion', 0), n('rows', 4), n('columns', 6), cardWipeDirection(n('flipOrder', 0)));
      return;
    case 'radial-wipe':
      radialWipeData(data, w, h, n('completion', 0), n('startAngle', 0), radialWipeDirection(n('direction', 0)), n('centerX', w / 2), n('centerY', h / 2), n('feather', 0));
      return;
    case 'block-dissolve':
      blockDissolveData(data, w, h, n('completion', 0), n('blockWidth', 8), n('blockHeight', 8), n('feather', 0), n('seed', 0));
      return;
    case 'alpha-levels':
      alphaLevelsData(data, n('inBlack', 0), n('inWhite', 255), n('gamma', 1), n('outBlack', 0), n('outWhite', 255));
      return;
    case 'solid-composite':
      solidCompositeData(data, rgb('color', [255, 255, 255]), n('sourceOpacity', 100), n('solidOpacity', 100), n('mode', 0));
      return;
    case 'channel-combiner':
      channelCombinerData(data, n('mode', 0));
      return;
    case 'remove-color-matting':
      removeColorMattingData(data, rgb('bg', [0, 0, 0]), n('threshold', 0), n('amount', 100));
      return;
    case 'cartoon':
      data.set(cartoonData(data, w, h, n('smoothness', 3), n('levels', 6), n('edgeThreshold', 40), n('edgeWidth', 1), n('edgeOpacity', 100)));
      return;
    case 'brush-strokes':
      data.set(brushStrokesData(data, w, h, n('direction', 45), n('length', 8), n('randomness', 30), n('cellSize', 6), n('density', 100)));
      return;
    case 'strobe-light':
      strobeLightData(data, n('time', 0), n('period', 0.5), n('duty', 50), n('operation', 0), rgb('color', [255, 255, 255]), n('intensity', 100));
      return;
    case 'color-emboss':
      data.set(colorEmbossData(data, w, h, n('direction', 45), n('relief', 2), n('contrast', 100), n('blendWithOriginal', 0)));
      return;
    case 'halftone':
      data.set(halftoneData(data, w, h, n('cellSize', 8), n('angle', 45), n('contrast', 100), rgb('ink', [0, 0, 0]), rgb('paper', [255, 255, 255]), b('colorize', false), n('blendWithOriginal', 0)));
      return;
    case 'kaleidoscope':
      data.set(kaleidoscopeData(data, w, h, n('segments', 6), n('centerX', 0), n('centerY', 0), n('rotation', 0), n('sourceAngle', 0), n('zoom', 100)));
      return;
    case 'vignette':
      vignetteData(data, w, h, n('amount', 50), n('size', 50), n('feather', 50), n('roundness', 100), n('centerX', 0), n('centerY', 0));
      return;
    case 'burn-film':
      burnFilmData(data, w, h, n('burn', 0), n('centerX', 0), n('centerY', 0), rgb('burnColor', [0, 0, 0]), rgb('charColor', [60, 30, 10]), n('randomness', 50), n('seed', 0));
      return;
    case 'iris-wipe':
      irisWipeData(data, w, h, n('completion', 0), n('centerX', 0), n('centerY', 0), n('points', 6), n('rotation', 0), n('innerRadius', 0), b('useInnerRadius', false), n('feather', 0), b('invert', false));
      return;
    case 'light-wipe':
      lightWipeData(data, w, h, n('completion', 0), n('shape', 0), n('angle', 0), n('centerX', 0), n('centerY', 0), n('width', 40), rgb('color', [255, 255, 255]), n('intensity', 100), n('feather', 0));
      return;
    case 'line-sweep':
      lineSweepData(data, w, h, n('completion', 0), n('lineCount', 8), n('angle', 0), n('stagger', 50), n('feather', 0), b('invert', false));
      return;
    case 'grid-wipe':
      gridWipeData(data, w, h, n('completion', 0), n('columns', 8), n('rows', 6), n('shape', 0), n('random', 50), n('feather', 0), b('invert', false));
      return;
    case 'dust-scratches':
      data.set(dustAndScratchesData(data, w, h, n('radius', 2), n('threshold', 20)));
      return;
    case 'noise-alpha':
      noiseAlphaData(data, w, n('amount', 50), b('uniform', true), n('seed', 0), n('phase', 0), b('clipResult', true));
      return;
    case 'wave-warp':
      data.set(waveWarpData(data, w, h, n('waveHeight', 10), n('waveWidth', 40), n('direction', 90), n('phase', 0)));
      return;
    case 'turbulent-displace':
      data.set(turbulentDisplaceData(data, w, h, n('amount', 20), n('size', 40), n('complexity', 3), n('evolution', 0)));
      return;
    case 'curl-noise':
      data.set(curlNoiseData(data, w, h, n('amount', 20), n('size', 40), n('complexity', 3), n('evolution', 0)));
      return;
    case 'roughen-edges': {
      // roughenEdgesData + applyRoughenEdges' Edge Sharpness pass.
      const border = n('border', 8);
      if (border <= 0) return;
      const out = roughenEdgesData(data, w, h, border, n('scale', 100), n('complexity', 3), n('evolution', 0), n('seed', 0));
      const sharp = Math.max(0, n('edgeSharpness', 0));
      if (sharp > 0) {
        for (let i = 3; i < out.length; i += 4) {
          const al = out[i]! / 255;
          out[i] = Math.round(255 * Math.min(1, Math.max(0, (al - 0.5) * (1 + sharp * 2) + 0.5)));
        }
      }
      data.set(out);
      return;
    }
    case 'scatter': {
      const grain = n('grain', 0);
      data.set(scatterData(data, w, h, n('amount', 5), grain >= 2 ? 'vertical' : grain >= 1 ? 'horizontal' : 'both', n('seed', 0), n('evolution', 0)));
      return;
    }
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

