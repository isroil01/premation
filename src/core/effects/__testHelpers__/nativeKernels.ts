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
import { floMotionData, lensData, griddlerData, ballActionData, drizzleData } from '../aeDistortRoundFive';
import { jawsData, pixelPollyData, twisterData, cardDanceData } from '../aeTransitionsRoundFive';
import {
  glassData, texturizeData, threadsData, chromaticAberrationData, hexTileData, vectorBlurData,
} from '../aeStylizeRoundFive';
import {
  unmultData, ccCompositeData, compositeBlendMode, ccScatterizeData, radialFastBlurData, radialFastBlurModeOf, crossBlurData,
  scaleWipeData, plasticData,
} from '../aeRoundSix';
import { colorDifferenceKeyData, wireRemovalData, broadcastColorsData, noiseHlsData } from '../aeRoundSevenColor';
import { blockLoadData, kernelConvolveData, glasses3dData, fractalData } from '../aeRoundSevenStylize';
import {
  rippleData, magnifyData, warpData, pageTurnData, splitData, slantData, smearData, rollingShutterData, radialShadowData,
} from '../aeDistortAdvanced';
import { vibranceData, coloramaData, COLORAMA_PALETTES } from '../colorEffects';
import { photoFilterData, blackAndWhiteData, tritoneData, thresholdData } from '../aeColor';
import { selectiveColorData, selectiveRange, shadowHighlightData } from '../toneEffects';
import { bilateralBlurData, smartBlurData, cameraLensBlurData } from '../aeBlurAdvanced';
import { sharpenData, addNoiseData } from '../canvas2dEffects';
import { pathStrokeData } from '../pathStroke';
import { scribbleData } from '../scribble';
import { writeOnBrushData } from '../writeOnBrush';
import {
  ccTilerData, ripplePulseData, radialScaleWipeData, glassWipeData, imageWipeData, type ImageWipeChannel,
} from '../aeRoundSevenDistort';
import { particleSystemsData, bubblesData } from '../aeRoundSevenSimulation';
import { starBurstData, snowfallData, rainfallData, writeOnData, writeOnPathData, lightBurstData } from '../generateRoundFive';
import { pickMaskPaths, unpackMaskPaths } from '../strokePaint';
import type { EffectParams } from '../effects';

/** Kernel arguments by name: numbers (booleans as 0/1), and numeric arrays for the resolved lists (packed mask paths, brush trails, LUT tables). */
export type Args = Record<string, number | number[]>;

/** Runs the TS kernel for `type` IN PLACE, exactly as kernel_dispatch.cpp does. */
export function runKernel(type: string, a: Args, data: Uint8ClampedArray, w: number, h: number): void {
  const n = (k: string, d: number): number => {
    const v = a[k];
    return typeof v === 'number' ? v : d;
  };
  const b = (k: string, d: boolean): boolean => n(k, d ? 1 : 0) !== 0;
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
    case 'ripple':
      data.set(rippleData(data, w, h, n('centerX', 0), n('centerY', 0), n('radius', 0), n('amplitude', 10), n('frequency', 4), n('phase', 0), n('decay', 0)));
      return;
    case 'magnify':
      data.set(magnifyData(data, w, h, n('centerX', 0), n('centerY', 0), n('magnification', 200), n('radius', 50), n('shape', 0), n('feather', 0)));
      return;
    case 'warp':
      data.set(warpData(data, w, h, n('style', 0), n('bend', 50), n('horizontal', 0), n('vertical', 0), n('axis', 0)));
      return;
    case 'page-turn':
      data.set(pageTurnData(data, w, h, n('amount', 30), n('angle', 45), n('radius', 20), n('backOpacity', 100), n('shading', 50)));
      return;
    case 'split':
      data.set(splitData(data, w, h, n('offset', 20), n('angle', 0), n('centerX', 0), n('centerY', 0)));
      return;
    case 'slant':
      data.set(slantData(data, w, h, n('slant', 20), n('axis', 0), n('floor', 0.5)));
      return;
    case 'smear':
      data.set(smearData(data, w, h, n('fromX', 0), n('fromY', 0), n('toX', 10), n('toY', 0), n('radius', 30), n('elasticity', 100)));
      return;
    case 'rolling-shutter':
      data.set(rollingShutterData(data, w, h, n('sweep', 10), n('wobble', 0), n('direction', 0), b('vertical', false)));
      return;
    case 'radial-shadow':
      data.set(radialShadowData(data, w, h, n('lightX', 0), n('lightY', 0), n('projection', 20), rgb('color', [0, 0, 0]), n('opacity', 50), n('softness', 0), n('renderMode', 0)));
      return;
    case 'color-difference-key': {
      const [kr, kg, kb] = key();
      data.set(colorDifferenceKeyData(data, w, h, kr, kg, kb, n('matteInBlack', 0), n('matteInWhite', 255), n('matteGamma', 1), n('viewMode', 0)));
      return;
    }
    case 'wire-removal':
      data.set(wireRemovalData(data, w, h, n('pointAX', -100), n('pointAY', 0), n('pointBX', 100), n('pointBY', 0), n('thickness', 4), n('slope', 50)));
      return;
    case 'broadcast-colors':
      data.set(broadcastColorsData(data, w, h, n('standard', 0), n('how', 0), n('maxSignalAmplitude', 110)));
      return;
    case 'noise-hls':
      data.set(noiseHlsData(data, w, h, n('noiseType', 0), n('hue', 0), n('lightness', 0), n('saturation', 0), n('grainSize', 1), n('noisePhase', 0)));
      return;
    case 'block-load':
      data.set(blockLoadData(data, w, h, n('completion', 100), n('scans', 4), n('blockSize', 64)));
      return;
    case 'kernel': {
      const k = ['k00', 'k01', 'k02', 'k10', 'k11', 'k12', 'k20', 'k21', 'k22'].map((key2) => n(key2, key2 === 'k11' ? 1 : 0));
      data.set(kernelConvolveData(data, w, h, k, n('divisor', 1), n('offset', 0)));
      return;
    }
    case '3d-glasses':
      data.set(glasses3dData(data, w, h, n('convergenceOffset', 8), n('view', 0), n('balance', 50), b('swapLeftRight', false)));
      return;
    case 'fractal':
      data.set(fractalData(w, h, n('setType', 0), n('centerX', -0.5), n('centerY', 0), n('magnification', 1), n('iterations', 64), n('juliaX', -0.7), n('juliaY', 0.27), n('colorPhase', 0), n('colorCycles', 2), n('insideR', 0), n('insideG', 0), n('insideB', 0)));
      return;
    case 'unmult':
      data.set(unmultData(data, w, h, n('threshold', 0), n('boost', 100)));
      return;
    case 'cc-composite':
      data.set(ccCompositeData(data, data, w, h, n('opacity', 100), compositeBlendMode(n('blendMode', 0)), b('rgbOnly', false)));
      return;
    case 'cc-scatterize':
      data.set(ccScatterizeData(data, w, h, n('amount', 0), n('windX', 0), n('windY', 0), n('twist', 0), n('seed', 1)));
      return;
    case 'radial-fast-blur':
      data.set(radialFastBlurData(data, w, h, n('amount', 20), n('centerX', 0), n('centerY', 0), radialFastBlurModeOf(n('mode', 0))));
      return;
    case 'cross-blur':
      data.set(crossBlurData(data, w, h, n('radiusX', 15), n('radiusY', 15), b('repeatEdges', true)));
      return;
    case 'scale-wipe':
      data.set(scaleWipeData(data, w, h, n('completion', 0), n('stretch', 10), n('direction', 0), n('centerX', 0), n('centerY', 0)));
      return;
    case 'plastic':
      data.set(plasticData(data, w, h, n('surfaceBump', 25), n('softness', 5), n('lightAngle', 45), n('lightIntensity', 100), n('specular', 50)));
      return;
    case 'glass':
      data.set(glassData(data, w, h, n('bumpSoftness', 3), n('height', 50), n('displacement', 20), n('lightAngle', 45), n('lightIntensity', 100), n('shininess', 50)));
      return;
    case 'texturize':
      data.set(texturizeData(data, w, h, n('pattern', 1), n('contrast', 50), n('scale', 100), n('lightAngle', 45)));
      return;
    case 'threads':
      data.set(threadsData(data, w, h, n('thickness', 6), n('spacing', 2), n('depth', 50)));
      return;
    case 'chromatic-aberration':
      data.set(chromaticAberrationData(data, w, h, n('amount', 5), n('aberrationMode', 0), n('angle', 0), n('falloff', 50), n('centerX', 0), n('centerY', 0)));
      return;
    case 'hex-tile':
      data.set(hexTileData(data, w, h, n('radius', 12), n('border', 30)));
      return;
    case 'vector-blur':
      data.set(vectorBlurData(data, w, h, n('amount', 8), n('angleOffset', 0), n('smoothness', 2)));
      return;
    case 'flo-motion':
      data.set(floMotionData(data, w, h, n('knot1X', -50), n('knot1Y', 0), n('knot1Amount', 50), n('knot2X', 50), n('knot2Y', 0), n('knot2Amount', -50), n('falloff', 30)));
      return;
    case 'lens':
      data.set(lensData(data, w, h, n('centerX', 0), n('centerY', 0), n('size', 60), n('convergence', 50)));
      return;
    case 'griddler':
      data.set(griddlerData(data, w, h, n('tileSize', 24), n('horizontalScale', 90), n('verticalScale', 90), n('rotation', 0)));
      return;
    case 'ball-action':
      data.set(ballActionData(data, w, h, n('grid', 12), n('ballSize', 90), n('scatter', 0), n('seed', 0)));
      return;
    case 'drizzle':
      data.set(drizzleData(data, w, h, n('dripRate', 30), n('rippleHeight', 4), n('spreading', 60), n('evolution', 0), n('seed', 0)));
      return;
    case 'jaws':
      data.set(jawsData(data, w, h, n('completion', 0), n('direction', 0), n('teethHeight', 20), n('teethWidth', 30)));
      return;
    case 'pixel-polly':
      data.set(pixelPollyData(data, w, h, n('completion', 0), n('cellSize', 12), n('gravity', 50), n('spin', 180), n('centerX', 0), n('centerY', 0), n('seed', 0)));
      return;
    case 'twister':
      data.set(twisterData(data, w, h, n('completion', 0), n('centerY', 0), n('twist', 180)));
      return;
    case 'card-dance':
      data.set(cardDanceData(data, w, h, n('rows', 4), n('columns', 6), n('amount', 50), n('cardRotation', 30), n('phase', 0)));
      return;
    default:
      if (runGenerateKernel(type, a, n, b, rgb, data, w, h)) return;
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


type Num = (k: string, d: number) => number;
type Bool = (k: string, d: boolean) => boolean;
type Rgb3 = (name: string, d: [number, number, number]) => [number, number, number];

/**
 * The E4 second batch — kernel_dispatch_generate.cpp's table: the path / paint
 * effects, the generators and the round-seven kernels. False for any other type.
 */
function runGenerateKernel(
  type: string, a: Args, n: Num, b: Bool, rgb: Rgb3, data: Uint8ClampedArray, w: number, h: number,
): boolean {
  const arr = (k: string): number[] => {
    const v = a[k];
    return Array.isArray(v) ? v : [];
  };
  const maskParams = (): EffectParams => ({
    maskPathsMeta: arr('maskPathsMeta'),
    maskPathsXY: arr('maskPathsXY'),
    // A non-empty id: the pick is `pathMaskIndex` as resolved by buildSnapshot.
    pathMaskId: 'mask',
    pathMaskIndex: n('pathMaskIndex', 0),
  }) as unknown as EffectParams;
  switch (type) {
    case 'path-stroke':
      data.set(pathStrokeData(data, w, h, pickMaskPaths(maskParams(), w, h, b('allMasks', false)), {
        rgb: rgb('color', [255, 255, 255]), brushSize: n('brushSize', 10), hardness: n('hardness', 75),
        opacity: n('opacity', 100), start: n('start', 0), end: n('end', 100), spacing: n('spacing', 15),
        paintStyle: n('paintStyle', 0), sequential: b('sequential', false),
      }));
      return true;
    case 'scribble': {
      const p = maskParams();
      const masks = unpackMaskPaths(p.maskPathsMeta, p.maskPathsXY, w, h);
      data.set(scribbleData(data, w, h, masks, pickMaskPaths(p, w, h, false), {
        mode: n('mode', 0), fillType: n('fillType', 0), edgeWidth: n('edgeWidth', 10), endCap: n('endCap', 1),
        join: n('join', 1), miterLimit: n('miterLimit', 4), rgb: rgb('color', [255, 255, 255]),
        opacity: n('opacity', 100), angle: n('angle', 45), strokeWidth: n('strokeWidth', 2),
        curviness: n('curviness', 50), curvinessVariation: n('curvinessVariation', 0), spacing: n('spacing', 5),
        spacingVariation: n('spacingVariation', 0), pathOverlap: n('pathOverlap', 0),
        pathOverlapVariation: n('pathOverlapVariation', 0), start: n('start', 0), end: n('end', 100),
        sequential: b('sequential', true), seed: n('seed', 0), wiggleState: n('wiggleState', 0),
        smoothWiggle: b('smoothWiggle', false), composite: n('composite', 0),
      }));
      return true;
    }
    case 'write-on':
      if (Math.round(n('mode', 0)) !== 0) {
        const flat = arr('pathPoints');
        data.set(flat.length >= 4
          ? writeOnPathData(data, w, h, flat, n('completion', 100), n('brushSize', 8), rgb('color', [255, 255, 255]), n('taper', 0))
          : writeOnData(
            data, w, h, n('startX', -100), n('startY', 0), n('endX', 100), n('endY', 0), n('completion', 100),
            n('brushSize', 8), rgb('color', [255, 255, 255]), n('wobble', 0), n('taper', 0),
          ));
        return true;
      }
      data.set(writeOnBrushData(
        data, w, h,
        { xy: arr('brushTrailXY'), size: arr('brushTrailSize'), attr: arr('brushTrailAttr'), filled: b('filled', false) },
        {
          brushX: n('brushX', 0), brushY: n('brushY', 0), rgb: rgb('color', [255, 255, 255]), size: n('size', 8),
          hardness: n('hardness', 75), opacity: n('opacity', 100), paintTimeProps: n('paintTimeProps', 0),
          brushTimeProps: n('brushTimeProps', 0), paintStyle: n('paintStyle', 0),
        },
      ));
      return true;
    case 'star-burst':
      data.set(starBurstData(data, w, h, n('phase', 0), n('amount', 50), n('size', 2), rgb('color', [255, 255, 255]), n('blend', 0), n('seed', 0)));
      return true;
    case 'snowfall':
      data.set(snowfallData(data, w, h, n('amount', 50), n('size', 2), n('evolution', 0), n('wind', 0), n('opacity', 100), rgb('color', [255, 255, 255]), n('seed', 0)));
      return true;
    case 'rainfall':
      data.set(rainfallData(data, w, h, n('amount', 50), n('length', 20), n('angle', 10), n('evolution', 0), n('opacity', 60), rgb('color', [207, 230, 255]), n('seed', 0)));
      return true;
    case 'light-burst':
      data.set(lightBurstData(data, w, h, n('centerX', 0), n('centerY', 0), n('intensity', 100), n('rayLength', 50)));
      return true;
    case 'cc-tiler':
      data.set(ccTilerData(data, w, h, n('scale', 100), n('centerX', 0), n('centerY', 0), n('blendWithOriginal', 0)));
      return true;
    case 'ripple-pulse':
      data.set(ripplePulseData(data, w, h, n('centerX', 0), n('centerY', 0), n('pulseRadius', 0), n('amplitude', 40), n('width', 60), b('renderBump', true)));
      return true;
    case 'radial-scale-wipe':
      data.set(radialScaleWipeData(data, w, h, n('completion', 0), n('centerX', 0), n('centerY', 0), b('reverse', false)));
      return true;
    case 'glass-wipe':
      data.set(glassWipeData(data, w, h, n('completion', 0), n('displacement', 40), n('softness', 30)));
      return true;
    case 'image-wipe':
      data.set(imageWipeData(data, w, h, n('completion', 0), n('borderSoftness', 20), n('gradientChannel', 0) as ImageWipeChannel, b('invertGradient', false)));
      return true;
    case 'particle-systems': {
      const [br, bg, bb] = rgb('birth', [255, 226, 122]);
      const [dr, dg, db] = rgb('death', [255, 59, 0]);
      data.set(particleSystemsData(data, w, h, n('time', 0), {
        birthRate: n('birthRate', 10), longevity: n('longevity', 2), producerX: n('producerX', 0),
        producerY: n('producerY', 0), producerRadiusX: n('producerRadiusX', 5), producerRadiusY: n('producerRadiusY', 5),
        animation: n('animation', 0), direction: n('direction', 0), spread: n('spread', 30), velocity: n('velocity', 50),
        velocityVariation: n('velocityVariation', 20), gravity: n('gravity', 0), resistance: n('resistance', 0),
        birthSize: n('birthSize', 4), deathSize: n('deathSize', 1), sizeVariation: n('sizeVariation', 0),
        birthR: br, birthG: bg, birthB: bb, deathR: dr, deathG: dg, deathB: db,
        opacity: n('opacity', 100), blend: n('blend', 0), seed: n('seed', 0),
      }));
      return true;
    }
    case 'cc-bubbles': {
      const [cr, cg, cb] = rgb('color', [255, 255, 255]);
      data.set(bubblesData(
        data, w, h, n('bubbleAmount', 100), n('bubbleSpeed', 300), n('wobbleAmplitude', 10), n('wobbleFrequency', 2),
        n('bubbleSize', 12), n('sizeVariation', 40), n('shading', 0), cr, cg, cb, n('opacity', 80), n('evolution', 0),
        n('seed', 1),
      ));
      return true;
    }
    default:
      return false;
  }
}
