/**
 * Cross-engine effect-kernel parity (plan E4). The CPU kernels the bake chain
 * runs (blurs, noise, morphology, stylize, the edge-aware blurs) are ported to
 * C++ in `native/engine/src/effects`; this test runs the TypeScript kernels on
 * a few synthetic RGBA buffers and records input + params → output hash in
 * `native/engine/tests/data/effect_kernel_parity.json`, which
 * `native/engine/tests/test_effect_kernels.cpp` replays against the C++ on one
 * thread and on all cores. Byte-exact: every row's FNV-1a 64 must match.
 *
 * `GEN_NATIVE_EFFECT_KERNELS=1 npx jest nativeKernelCrossEngine` rewrites the
 * fixture; without it this test fails when the fixture is stale.
 * `EFFECT_KERNEL_DUMP=<dir>` also writes every output as raw RGBA (for diffing
 * a C++ mismatch by hand).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runKernel, makeImage, type Args } from './__testHelpers__/nativeKernels';

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/effect_kernel_parity.json');

interface Image { name: string; w: number; h: number; salt: number }
const IMAGES: Image[] = [
  { name: 'small', w: 61, h: 47, salt: 1 },
  { name: 'tall', w: 19, h: 83, salt: 7 },
  // Over 512 px on its long edge: the edge-aware blurs take the budget proxy
  // (box downsample → kernel → bilinear upsample) on this one.
  { name: 'wide', w: 600, h: 24, salt: 3 },
];

interface Case { effect: string; image: string; args: Args }
const C = (effect: string, image: string, args: Args): Case => ({ effect, image, args });

// ── Resolved mask paths (strokePaint.ts `packMaskPaths` layout, layer-centred px) ──
interface MaskSpec { pts: Array<[number, number]>; closed?: boolean; mode?: number; inverted?: boolean }
const q = (v: number): number => Math.round(v * 1000) / 1000;
function packMasks(...ms: MaskSpec[]): { maskPathsMeta: number[]; maskPathsXY: number[] } {
  const maskPathsMeta: number[] = [];
  const maskPathsXY: number[] = [];
  for (const m of ms) {
    maskPathsMeta.push(m.pts.length, m.closed === false ? 0 : 1, m.mode ?? 1, m.inverted ? 1 : 0);
    for (const [x, y] of m.pts) maskPathsXY.push(q(x), q(y));
  }
  return { maskPathsMeta, maskPathsXY };
}
/** A star (r1 ≠ r2) or polygon (r1 = r2), `n` points. */
function star(cx: number, cy: number, r1: number, r2: number, n: number, rotDeg: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (rotDeg * Math.PI) / 180 + (i * Math.PI) / n;
    const r = i % 2 === 0 ? r1 : r2;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}
function wave(x0: number, x1: number, y: number, amp: number, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) out.push([x0 + ((x1 - x0) * i) / n, y + Math.sin(i * 0.9) * amp]);
  return out;
}
const MASKS_SMALL = packMasks(
  { pts: star(-4, 2, 17, 8, 5, -90) },
  { pts: star(8, -3, 9, 9, 6, 10), mode: 2 },
  { pts: wave(-26, 24, 12, 5, 14), closed: false },
  // A self-overlapping bow tie: nonzero winding fills both lobes.
  { pts: [[-20, -18], [20, 15], [20, -18], [-20, 15]], mode: 6 },
);
const MASKS_WIDE = packMasks(
  { pts: star(-200, 0, 11, 11, 3, 0) },
  { pts: wave(-280, 250, -2, 6, 40), closed: false, mode: 0 },
  { pts: star(120, 1, 10, 4, 7, 33), mode: 3, inverted: true },
);
const MASKS_TALL = packMasks(
  { pts: [[-7, -30], [6, -12], [-5, 5], [7, 25], [0, 38]], closed: false },
  { pts: star(0, -8, 8.5, 8.5, 4, 45), mode: 5 },
);
/** A Write-on brush trail: `n` dabs along a curl, per-dab size / hardness / opacity / colour. */
function trail(n: number, cx: number, cy: number, r: number): { brushTrailXY: number[]; brushTrailSize: number[]; brushTrailAttr: number[] } {
  const brushTrailXY: number[] = [];
  const brushTrailSize: number[] = [];
  const brushTrailAttr: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(1, n - 1);
    brushTrailXY.push(q(cx + Math.cos(t * 7) * r * t), q(cy + Math.sin(t * 7) * r * t * 0.8));
    brushTrailSize.push(q(2 + 6 * t));
    brushTrailAttr.push(q(30 + 60 * t), q(100 - 50 * t), q(255 * t), q(200 - 150 * t), 90);
  }
  return { brushTrailXY, brushTrailSize, brushTrailAttr };
}

const CASES: Case[] = [
  C('gaussian-blur', 'small', { radius: 6 }),
  C('gaussian-blur', 'small', { radius: 2.7, dimensions: 1, repeatEdge: 0 }),
  C('gaussian-blur', 'tall', { radius: 40, dimensions: 2 }),
  C('gaussian-blur', 'wide', { radius: 300 }),
  C('fast-box-blur', 'small', { radius: 5, iterations: 1 }),
  C('fast-box-blur', 'small', { radius: 9.5, iterations: 4, repeatEdge: 0 }),
  C('fast-box-blur', 'wide', { radius: 0.9, iterations: 2 }),
  C('radial-blur', 'small', { amount: 25, centerX: 30.5, centerY: 20, quality: 12 }),
  C('radial-blur', 'small', { amount: 60, centerX: 10, centerY: 40, zoom: 1, quality: 9 }),
  C('radial-blur', 'tall', { amount: -140, zoom: 0, quality: 64 }),
  C('channel-blur', 'small', { red: 3, green: 0, blue: 7.6, alpha: 2, dimensions: 0, repeatEdge: 1 }),
  C('channel-blur', 'tall', { red: 1, green: 12, blue: 0, alpha: 30, dimensions: 2, repeatEdge: 0 }),
  C('unsharp-mask', 'small', { amount: 150, radius: 3, threshold: 4 }),
  C('unsharp-mask', 'wide', { amount: 60, radius: 12, threshold: 0 }),
  C('sharpen', 'small', { amount: 0.8 }),
  C('sharpen', 'tall', { amount: 2.35 }),
  C('noise', 'small', { amount: 0.3, evolution: 7, mono: 1 }),
  C('noise', 'wide', { amount: 0.75, evolution: -12345, mono: 0 }),
  C('add-grain', 'small', { intensity: 40, size: 1.5, saturation: 0, seed: 3 }),
  C('add-grain', 'small', { intensity: 90, size: 0.3, saturation: 65, seed: 2.25 }),
  C('turbulent-noise', 'small', { scale: 12, complexity: 5, evolution: 1.3, contrast: 120, brightness: -5, invert: 0 }),
  C('turbulent-noise', 'wide', { scale: 40, complexity: 8, evolution: 4.9, contrast: 100, brightness: 10, invert: 1 }),
  C('median', 'small', { radius: 1 }),
  C('median', 'small', { radius: 4 }),
  C('median', 'tall', { radius: 8 }),
  C('minimax', 'small', { op: 0, radius: 3, channel: 0, direction: 0 }),
  C('minimax', 'small', { op: 2, radius: 2, channel: 1, direction: 0 }),
  C('minimax', 'tall', { op: 3, radius: 5, channel: 3, direction: 2 }),
  C('minimax', 'wide', { op: 1, radius: 9, channel: 4, direction: 1 }),
  C('simple-choker', 'small', { chokePx: 2 }),
  C('simple-choker', 'small', { chokePx: -3.4 }),
  C('simple-choker', 'tall', { chokePx: 11 }),
  C('mosaic', 'small', { hBlocks: 7, vBlocks: 5, sharpColors: 0 }),
  C('mosaic', 'tall', { hBlocks: 4, vBlocks: 13.6, sharpColors: 1 }),
  C('mosaic', 'wide', { hBlocks: 80, vBlocks: 3 }),
  C('find-edges', 'small', { invert: 1 }),
  C('find-edges', 'tall', { invert: 0 }),
  C('emboss', 'small', { angleDeg: 45, relief: 2, contrast: 150, blend: 0 }),
  C('emboss', 'tall', { angleDeg: 200, relief: 3.6, contrast: 80, blend: 35 }),
  C('vibrance', 'small', { vibrance: 60, saturation: 0 }),
  C('vibrance', 'wide', { vibrance: -40, saturation: 25 }),
  C('bilateral-blur', 'small', { radius: 3, colorSigma: 25, preserveAlpha: 0 }),
  C('bilateral-blur', 'tall', { radius: 5, colorSigma: 80, preserveAlpha: 1 }),
  C('bilateral-blur', 'wide', { radius: 6, colorSigma: 40 }),
  C('smart-blur', 'small', { radius: 3, threshold: 25, mode: 0 }),
  C('smart-blur', 'small', { radius: 4, threshold: 12, mode: 1 }),
  C('smart-blur', 'tall', { radius: 2, threshold: 40, mode: 2 }),
  C('smart-blur', 'wide', { radius: 5, threshold: 30, mode: 0 }),
  C('camera-lens-blur', 'small', { radius: 4, blades: 0, rotation: 0, gain: 1, threshold: 100 }),
  C('camera-lens-blur', 'small', { radius: 5, blades: 6, rotation: 15, gain: 3, threshold: 70 }),
  C('camera-lens-blur', 'wide', { radius: 7, blades: 5, rotation: 33, gain: 2, threshold: 50 }),
  C('photo-filter', 'small', { filterR: 236, filterG: 138, filterB: 0, density: 40, preserveLuminosity: 1 }),
  C('photo-filter', 'tall', { filterR: 0, filterG: 90, filterB: 255, density: 100, preserveLuminosity: 0 }),
  C('black-and-white', 'small', { reds: 0.4, yellows: 0.6, greens: 0.4, cyans: 0.6, blues: 0.2, magentas: 0.8 }),
  C('black-and-white', 'tall', { reds: 1.2, yellows: -0.3, greens: 0.1, cyans: 0.9, blues: 0.5, magentas: 0.35, useTint: 1, tintR: 225, tintG: 180, tintB: 120 }),
  C('tritone', 'small', { shadowsR: 20, shadowsG: 10, shadowsB: 60, midtonesR: 200, midtonesG: 120, midtonesB: 80, highlightsR: 255, highlightsG: 250, highlightsB: 220, blend: 0 }),
  C('tritone', 'wide', { blend: 45 }),
  C('threshold', 'small', { level: 128 }),
  C('threshold', 'tall', { level: 77.5 }),
  C('selective-color', 'small', { range: 0, cyan: -40, magenta: 20, yellow: 10, black: 5, relative: 1 }),
  C('selective-color', 'small', { range: 7, cyan: 15, magenta: -25, yellow: 30, black: -10, relative: 0 }),
  C('selective-color', 'tall', { range: 8, black: 60, relative: 1 }),
  C('selective-color', 'wide', { range: 4, cyan: 50, yellow: -50 }),
  C('shadow-highlight', 'small', { shadowAmount: 50, highlightAmount: 0, radius: 6, tonalWidth: 50 }),
  C('shadow-highlight', 'wide', { shadowAmount: 35, highlightAmount: 40, radius: 20, tonalWidth: 30 }),
  C('colorama', 'small', { palette: 1, phaseShift: 45, cycleRepetitions: 1, blendWithOriginal: 0 }),
  C('colorama', 'tall', { palette: 0, phaseShift: -90, cycleRepetitions: 2.5, blendWithOriginal: 0.3 }),
  C('colorama', 'wide', { palette: 4, phaseShift: 0, cycleRepetitions: 1 }),
  C('keylight', 'small', { keyR: 20, keyG: 200, keyB: 40, balance: 0.5, gain: 1.1, clipBlack: 0.05, clipWhite: 0.9, despill: 0.6 }),
  C('keylight', 'small', { keyR: 10, keyG: 30, keyB: 220, balance: 0.3, gain: 1.4, clipBlack: 0, clipWhite: 1, despill: 1, choke: 2, matteSoftness: 3 }),
  C('keylight', 'tall', { keyR: 250, keyG: 40, keyB: 20, balance: 0.8, gain: 0.9, clipBlack: 0.2, clipWhite: 0.2, despill: 0, choke: -4, matteSoftness: 7.6 }),
  C('keylight', 'wide', { choke: 12, matteSoftness: 30 }),
  C('linear-color-key', 'small', { keyR: 250, keyG: 40, keyB: 20, matchOn: 0, tolerance: 20, softness: 15 }),
  C('linear-color-key', 'small', { keyR: 30, keyG: 180, keyB: 90, matchOn: 1, tolerance: 8, softness: 20, keepMatched: 1 }),
  C('linear-color-key', 'tall', { keyR: 90, keyG: 120, keyB: 200, matchOn: 2, tolerance: 25, softness: 10 }),
  C('luma-key', 'small', { keyType: 0, threshold: 100, tolerance: 10, softness: 30 }),
  C('luma-key', 'small', { keyType: 1, threshold: 180, tolerance: 0, softness: 0 }),
  C('luma-key', 'tall', { keyType: 2, threshold: 128, tolerance: 40, softness: 25 }),
  C('luma-key', 'wide', { keyType: 3, threshold: 60, tolerance: 20, softness: 50 }),
  C('shift-channels', 'small', { alphaFrom: 4, redFrom: 2, greenFrom: 3, blueFrom: 1 }),
  C('shift-channels', 'tall', { alphaFrom: 5, redFrom: 0, greenFrom: 6, blueFrom: 4 }),
  C('color-key', 'small', { keyR: 250, keyG: 40, keyB: 20, tolerance: 12, edgeSoftness: 10 }),
  C('color-key', 'wide', { keyR: 128, keyG: 128, keyB: 128, tolerance: 30, edgeSoftness: 0 }),
  C('color-range', 'small', { keyR: 250, keyG: 40, keyB: 20, space: 0, minTol: 5, maxTol: 30, lumaWeight: 50 }),
  C('color-range', 'tall', { keyR: 60, keyG: 200, keyB: 100, space: 1, minTol: 0, maxTol: 45, lumaWeight: 20 }),
  C('color-range', 'wide', { space: 2, minTol: 10, maxTol: 10, lumaWeight: 100 }),
  C('extract', 'small', { channel: 0, black: 40, white: 220, blackSoft: 20, whiteSoft: 10 }),
  C('extract', 'tall', { channel: 2, black: 100, white: 120, blackSoft: 0, whiteSoft: 30, invert: 1 }),
  C('extract', 'wide', { channel: 4, black: 10, white: 250, blackSoft: 5, whiteSoft: 5 }),
  C('spill-suppressor', 'small', { keyR: 20, keyG: 200, keyB: 40, amount: 80, preserveLuma: 1 }),
  C('spill-suppressor', 'tall', { keyR: 20, keyG: 60, keyB: 220, amount: 100, preserveLuma: 0 }),
  C('spill-suppressor', 'wide', { keyR: 230, keyG: 30, keyB: 30, amount: 45 }),
  C('matte-choker', 'small', { spread: 2, choke: 1, softness: 2, iterations: 1 }),
  C('matte-choker', 'tall', { spread: 0, choke: 3, softness: 4.4, iterations: 3 }),
  C('matte-choker', 'wide', { spread: 5, choke: 0, softness: 0, iterations: 2 }),
  C('bulge', 'small', { centerX: 30, centerY: 24.5, radius: 20, height: 60 }),
  C('bulge', 'tall', { centerX: 5, centerY: 60, radius: 30, height: -80 }),
  C('spherize', 'small', { centerX: 25, centerY: 20, radius: 22, amount: 70 }),
  C('spherize', 'wide', { centerX: 300, centerY: 12, radius: 200, amount: -50 }),
  C('twirl', 'small', { centerX: 30.5, centerY: 23.5, radius: 25, angle: 120 }),
  C('twirl', 'tall', { centerX: 9, centerY: 40, radius: 60, angle: -300 }),
  C('corner-pin', 'small', { tlx: 5, tly: 3, trx: 55, try: 8, brx: 58, bry: 44, blx: 2, bly: 40 }),
  C('corner-pin', 'tall', { tlx: -4, tly: 10, trx: 22, try: -3, brx: 15, bry: 90, blx: 1, bly: 70 }),
  C('polar-coordinates', 'small', { interpolation: 100, conversion: 0 }),
  C('polar-coordinates', 'small', { interpolation: 60, conversion: 1 }),
  C('polar-coordinates', 'wide', { interpolation: 35, conversion: 0 }),
  C('mirror', 'small', { centerX: 30, centerY: 23, angle: 30 }),
  C('mirror', 'tall', { centerX: 9, centerY: 50, angle: 250 }),
  C('offset', 'small', { shiftX: 40.5, shiftY: 10, blend: 0 }),
  C('offset', 'wide', { shiftX: -120, shiftY: 30.25, blend: 40 }),
  C('optics-compensation', 'small', { fov: 60, reverse: 0, centerX: 0, centerY: 0 }),
  C('optics-compensation', 'tall', { fov: 120, reverse: 1, centerX: 3, centerY: -10 }),
  C('optics-compensation', 'wide', { fov: 179, reverse: 0, centerX: -50, centerY: 4 }),
  C('mesh-warp', 'small', { mx5: 6, my5: -4, mx6: -3.5, my6: 2, mx9: 4, my9: 7, mx10: -8, my10: -2.25, mx0: 2, my15: -3 }),
  C('mesh-warp', 'wide', { mx1: 40, my2: 5, mx13: -60, my14: -8 }),
  C('liquify', 'small', { centerX: 30, centerY: 24, radius: 20, pushX: 6, pushY: -3, twirl: 0, pinch: 0 }),
  C('liquify', 'tall', { centerX: 10, centerY: 40, radius: 25, pushX: 0, pushY: 5, twirl: 90, pinch: -30 }),
  C('equalize', 'small', { mode: 0, amount: 100, blend: 0 }),
  C('equalize', 'tall', { mode: 1, amount: 70, blend: 25 }),
  C('equalize', 'wide', { mode: 0, amount: 40, blend: 0 }),
  C('auto-levels', 'small', { blackClip: 0.1, whiteClip: 0.1, blend: 0 }),
  C('auto-levels', 'wide', { blackClip: 5, whiteClip: 12, blend: 30 }),
  C('auto-contrast', 'small', { blackClip: 2, whiteClip: 2, blend: 0 }),
  C('auto-contrast', 'tall', { blackClip: 10, whiteClip: 0, blend: 50 }),
  C('auto-color', 'small', { blackClip: 0.5, whiteClip: 0.5, snapNeutral: 0, blend: 0 }),
  C('auto-color', 'small', { blackClip: 1, whiteClip: 3, snapNeutral: 100, blend: 0 }),
  C('auto-color', 'wide', { blackClip: 4, whiteClip: 4, snapNeutral: 60, blend: 20 }),
  C('change-color', 'small', { targetR: 250, targetG: 40, targetB: 20, hueTol: 20, satTol: 60, lightTol: 60, softness: 30, hueShift: 120, satScale: 10, lightScale: -5 }),
  C('change-color', 'tall', { targetR: 30, targetG: 200, targetB: 60, hueTol: 40, satTol: 100, lightTol: 100, softness: 0, hueShift: -45, invert: 1 }),
  C('change-to-color', 'small', { fromR: 250, fromG: 40, fromB: 20, toR: 20, toG: 90, toB: 250, hueTol: 25, softness: 40, preserveLightness: 1 }),
  C('change-to-color', 'wide', { fromR: 200, fromG: 200, fromB: 40, toR: 255, toG: 0, toB: 128, hueTol: 50, satTol: 80, lightTol: 90, preserveLightness: 0 }),
  C('leave-color', 'small', { targetR: 250, targetG: 40, targetB: 20, tolerance: 15, softness: 20, amount: 100 }),
  C('leave-color', 'tall', { targetR: 20, targetG: 20, targetB: 240, tolerance: 40, softness: 0, amount: 60 }),
  C('toner', 'small', { blend: 0 }),
  C('toner', 'wide', { blackR: 10, blackG: 0, blackB: 30, whiteR: 255, whiteG: 240, whiteB: 200, blend: 35 }),
  C('venetian-blinds', 'small', { completion: 0.4, direction: 30, width: 9, feather: 0 }),
  C('venetian-blinds', 'wide', { completion: 0.65, direction: -100, width: 17.5, feather: 3 }),
  C('gradient-wipe', 'small', { completion: 0.35, softness: 0.1 }),
  C('gradient-wipe', 'tall', { completion: 0.7, softness: 0, invert: 1 }),
  C('card-wipe', 'small', { completion: 0.45, rows: 3, columns: 5, flipOrder: 0 }),
  C('card-wipe', 'small', { completion: 0.3, rows: 4, columns: 4, flipOrder: 4 }),
  C('card-wipe', 'wide', { completion: 0.6, rows: 2, columns: 12, flipOrder: 3 }),
  C('radial-wipe', 'small', { completion: 0.3, startAngle: 45, direction: 0, feather: 0 }),
  C('radial-wipe', 'tall', { completion: 0.55, startAngle: -400, direction: 1, centerX: 5, centerY: 30, feather: 20 }),
  C('radial-wipe', 'wide', { completion: 0.8, startAngle: 90, direction: 2, feather: 5 }),
  C('block-dissolve', 'small', { completion: 0.5, blockWidth: 4, blockHeight: 3, feather: 0, seed: 1 }),
  C('block-dissolve', 'wide', { completion: 0.35, blockWidth: 10, blockHeight: 6.6, feather: 2, seed: 17 }),
  C('alpha-levels', 'small', { inBlack: 20, inWhite: 200, gamma: 1.6, outBlack: 10, outWhite: 240 }),
  C('alpha-levels', 'tall', { inBlack: 100, inWhite: 90, gamma: 0.4, outBlack: 255, outWhite: 0 }),
  C('solid-composite', 'small', { colorR: 30, colorG: 60, colorB: 200, sourceOpacity: 80, solidOpacity: 50, mode: 0 }),
  C('solid-composite', 'small', { colorR: 250, colorG: 200, colorB: 10, sourceOpacity: 100, solidOpacity: 100, mode: 1 }),
  C('solid-composite', 'tall', { colorR: 90, colorG: 10, colorB: 140, sourceOpacity: 60, solidOpacity: 30, mode: 2 }),
  C('solid-composite', 'wide', { colorR: 40, colorG: 40, colorB: 40, sourceOpacity: 100, solidOpacity: 70, mode: 3 }),
  C('channel-combiner', 'small', { mode: 0 }),
  C('channel-combiner', 'small', { mode: 1 }),
  C('channel-combiner', 'tall', { mode: 2 }),
  C('channel-combiner', 'tall', { mode: 3 }),
  C('channel-combiner', 'wide', { mode: 4 }),
  C('channel-combiner', 'wide', { mode: 5 }),
  C('channel-combiner', 'small', { mode: 6 }),
  C('channel-combiner', 'tall', { mode: 7 }),
  C('remove-color-matting', 'small', { bgR: 0, bgG: 0, bgB: 0, threshold: 5, amount: 100 }),
  C('remove-color-matting', 'wide', { bgR: 255, bgG: 255, bgB: 255, threshold: 0, amount: 60 }),
  C('cartoon', 'small', { smoothness: 3, levels: 6, edgeThreshold: 40, edgeWidth: 1, edgeOpacity: 100 }),
  C('cartoon', 'tall', { smoothness: 0, levels: 3, edgeThreshold: 10, edgeWidth: 2, edgeOpacity: 60 }),
  C('cartoon', 'wide', { smoothness: 7.6, levels: 12, edgeThreshold: 80, edgeWidth: 3, edgeOpacity: 0 }),
  C('brush-strokes', 'small', { direction: 45, length: 8, randomness: 30, cellSize: 6, density: 100 }),
  C('brush-strokes', 'wide', { direction: -120, length: 20, randomness: 90, cellSize: 3.4, density: 55 }),
  C('strobe-light', 'small', { time: 0.1, period: 0.5, duty: 50, operation: 0, colorR: 255, colorG: 240, colorB: 200, intensity: 70 }),
  C('strobe-light', 'tall', { time: -0.7, period: 0.3, duty: 90, operation: 1, intensity: 100 }),
  C('strobe-light', 'wide', { time: 2.25, period: 1, duty: 40, operation: 2, intensity: 45 }),
  C('color-emboss', 'small', { direction: 45, relief: 2, contrast: 150, blendWithOriginal: 0 }),
  C('color-emboss', 'tall', { direction: 200, relief: 4.6, contrast: 80, blendWithOriginal: 40 }),
  C('halftone', 'small', { cellSize: 6, angle: 45, contrast: 100 }),
  C('halftone', 'tall', { cellSize: 5, angle: -15, contrast: 140, colorize: 1, blendWithOriginal: 20 }),
  C('halftone', 'wide', { cellSize: 9.5, angle: 0, contrast: 60, inkR: 20, inkG: 10, inkB: 90, paperR: 250, paperG: 245, paperB: 230 }),
  C('kaleidoscope', 'small', { segments: 6, centerX: 2, centerY: -3, rotation: 20, sourceAngle: 10, zoom: 100 }),
  C('kaleidoscope', 'wide', { segments: 11, centerX: 0, centerY: 0, rotation: -45, sourceAngle: 0, zoom: 150 }),
  C('vignette', 'small', { amount: 60, size: 40, feather: 50, roundness: 100 }),
  C('vignette', 'wide', { amount: -40, size: 20, feather: 80, roundness: 30, centerX: 100, centerY: -5 }),
  C('burn-film', 'small', { burn: 40, centerX: 0, centerY: 0, randomness: 50, seed: 3 }),
  C('burn-film', 'wide', { burn: 75, centerX: -150, centerY: 6, burnColorR: 20, burnColorG: 0, burnColorB: 0, randomness: 100, seed: -7 }),
  C('iris-wipe', 'small', { completion: 40, points: 6, rotation: 10, feather: 2 }),
  C('iris-wipe', 'tall', { completion: 60, centerX: 3, centerY: -10, points: 0, innerRadius: 8, useInnerRadius: 1, feather: 1, invert: 1 }),
  C('iris-wipe', 'wide', { completion: 25, points: 3, rotation: -30, feather: 0 }),
  C('light-wipe', 'small', { completion: 40, shape: 0, angle: 30, width: 12, colorR: 255, colorG: 230, colorB: 180, intensity: 80, feather: 2 }),
  C('light-wipe', 'wide', { completion: 55, shape: 1, centerX: 40, centerY: 2, width: 60, intensity: 100, feather: 5 }),
  C('line-sweep', 'small', { completion: 45, lineCount: 8, angle: 20, stagger: 50, feather: 5 }),
  C('line-sweep', 'tall', { completion: 70, lineCount: 3, angle: 100, stagger: 0, feather: 0, invert: 1 }),
  C('grid-wipe', 'small', { completion: 40, columns: 6, rows: 4, shape: 0, random: 50, feather: 5 }),
  C('grid-wipe', 'wide', { completion: 55, columns: 30, rows: 2, shape: 1, random: 100, feather: 0 }),
  C('grid-wipe', 'tall', { completion: 35, columns: 2, rows: 9, shape: 2, random: 0, feather: 10, invert: 1 }),
  C('dust-scratches', 'small', { radius: 2, threshold: 20 }),
  C('dust-scratches', 'tall', { radius: 5, threshold: 0 }),
  C('dust-scratches', 'wide', { radius: 8, threshold: 60 }),
  C('noise-alpha', 'small', { amount: 50, uniform: 1, seed: 3, phase: 0, clipResult: 1 }),
  C('noise-alpha', 'wide', { amount: 90, uniform: 0, seed: -8, phase: 5, clipResult: 0 }),
  C('wave-warp', 'small', { waveHeight: 6, waveWidth: 20, direction: 90, phase: 30 }),
  C('wave-warp', 'wide', { waveHeight: -9.5, waveWidth: 33, direction: 200, phase: 0 }),
  C('turbulent-displace', 'small', { amount: 8, size: 12, complexity: 3, evolution: 40 }),
  C('turbulent-displace', 'wide', { amount: 25, size: 60, complexity: 6, evolution: -130 }),
  C('curl-noise', 'small', { amount: 5, size: 10, complexity: 2, evolution: 15 }),
  C('curl-noise', 'tall', { amount: 12, size: 30, complexity: 4.7, evolution: 250 }),
  C('roughen-edges', 'small', { border: 8, scale: 60, complexity: 3, evolution: 20, seed: 3 }),
  C('roughen-edges', 'wide', { border: 20, scale: 150, complexity: 5, evolution: -90, seed: 11, edgeSharpness: 2 }),
  C('scatter', 'small', { amount: 4, grain: 0, seed: 1, evolution: 0 }),
  C('scatter', 'tall', { amount: 9.5, grain: 1, seed: 7, evolution: 3 }),
  C('scatter', 'wide', { amount: 12, grain: 2, seed: -2, evolution: 0.5 }),
  C('ripple', 'small', { centerX: 2, centerY: -3, radius: 0, amplitude: 4, frequency: 3, phase: 30, decay: 1 }),
  C('ripple', 'wide', { centerX: -100, centerY: 0, radius: 250, amplitude: -8, frequency: 6.5, phase: -90, decay: 0 }),
  C('magnify', 'small', { centerX: 0, centerY: 0, magnification: 200, radius: 15, shape: 0, feather: 5 }),
  C('magnify', 'tall', { centerX: 2, centerY: 10, magnification: 60, radius: 12, shape: 1, feather: 0 }),
  C('warp', 'small', { style: 0, bend: 40, horizontal: 5, vertical: -5, axis: 0 }),
  C('warp', 'small', { style: 2, bend: -60, axis: 1 }),
  C('warp', 'tall', { style: 4, bend: 70, horizontal: -10 }),
  C('warp', 'wide', { style: 6, bend: 35, vertical: 12, axis: 0 }),
  C('page-turn', 'small', { amount: 75, angle: 45, radius: 8, backOpacity: 80, shading: 50 }),
  C('page-turn', 'wide', { amount: 65, angle: 20, radius: 30, backOpacity: 20, shading: 100 }),
  C('split', 'small', { offset: 12, angle: 30, centerX: 3, centerY: 0 }),
  C('slant', 'small', { slant: 15, axis: 0, floor: 0.5 }),
  C('slant', 'tall', { slant: -9.5, axis: 1, floor: 1 }),
  C('smear', 'small', { fromX: -5, fromY: 3, toX: 8, toY: -2, radius: 20, elasticity: 60 }),
  C('rolling-shutter', 'small', { sweep: 10, wobble: 3, direction: 0, vertical: 0 }),
  C('rolling-shutter', 'tall', { sweep: -6, wobble: 0, direction: 1, vertical: 1 }),
  C('radial-shadow', 'small', { lightX: -10, lightY: -15, projection: 30, colorR: 0, colorG: 0, colorB: 40, opacity: 60, softness: 2, renderMode: 0 }),
  C('radial-shadow', 'wide', { lightX: 200, lightY: -40, projection: 10, opacity: 80, softness: 0, renderMode: 1 }),
  C('color-difference-key', 'small', { keyR: 20, keyG: 200, keyB: 40, matteInBlack: 10, matteInWhite: 240, matteGamma: 1.3, viewMode: 0 }),
  C('color-difference-key', 'tall', { keyR: 250, keyG: 30, keyB: 30, matteGamma: 0.7, viewMode: 1 }),
  C('wire-removal', 'small', { pointAX: -25, pointAY: -5, pointBX: 20, pointBY: 10, thickness: 5, slope: 50 }),
  C('wire-removal', 'wide', { pointAX: -250, pointAY: 3, pointBX: 280, pointBY: -2, thickness: 3.5, slope: 20 }),
  C('broadcast-colors', 'small', { standard: 0, how: 0, maxSignalAmplitude: 100 }),
  C('broadcast-colors', 'small', { standard: 1, how: 1, maxSignalAmplitude: 95 }),
  C('broadcast-colors', 'tall', { standard: 0, how: 2, maxSignalAmplitude: 90 }),
  C('broadcast-colors', 'wide', { standard: 1, how: 3, maxSignalAmplitude: 105 }),
  C('noise-hls', 'small', { noiseType: 0, hue: 20, lightness: 15, saturation: 30, grainSize: 1, noisePhase: 0 }),
  C('noise-hls', 'wide', { noiseType: 1, hue: 50, lightness: 0, saturation: 60, grainSize: 3.5, noisePhase: 7.9 }),
  C('block-load', 'small', { completion: 40, scans: 4, blockSize: 16 }),
  C('block-load', 'wide', { completion: 75, scans: 3, blockSize: 32 }),
  C('kernel', 'small', { k00: 0, k01: -1, k02: 0, k10: -1, k11: 5, k12: -1, k20: 0, k21: -1, k22: 0, divisor: 1, offset: 0 }),
  C('kernel', 'tall', { k00: 1, k01: 2, k02: 1, k10: 2, k11: 4, k12: 2, k20: 1, k21: 2, k22: 1, divisor: 16, offset: 10 }),
  C('3d-glasses', 'small', { convergenceOffset: 8, view: 0, balance: 50 }),
  C('3d-glasses', 'small', { convergenceOffset: 5, view: 3, balance: 30, swapLeftRight: 1 }),
  C('3d-glasses', 'tall', { convergenceOffset: 3, view: 4 }),
  C('3d-glasses', 'wide', { convergenceOffset: 11, view: 5 }),
  C('3d-glasses', 'wide', { convergenceOffset: 6, view: 1 }),
  C('3d-glasses', 'tall', { convergenceOffset: 6, view: 2 }),
  C('fractal', 'small', { setType: 0, centerX: -0.5, centerY: 0, magnification: 1, iterations: 64, colorPhase: 30, colorCycles: 2 }),
  C('fractal', 'wide', { setType: 1, centerX: 0, centerY: 0, magnification: 2, iterations: 100, juliaX: -0.7, juliaY: 0.27, colorCycles: 3, insideR: 20, insideG: 0, insideB: 40 }),
  C('unmult', 'small', { threshold: 0, boost: 100 }),
  C('unmult', 'tall', { threshold: 30, boost: 250 }),
  C('cc-composite', 'small', { opacity: 70, blendMode: 3 }),
  C('cc-composite', 'small', { opacity: 100, blendMode: 5, rgbOnly: 1 }),
  C('cc-composite', 'tall', { opacity: 50, blendMode: 4 }),
  C('cc-composite', 'wide', { opacity: 80, blendMode: 10 }),
  C('cc-composite', 'wide', { opacity: 60, blendMode: 2 }),
  C('cc-scatterize', 'small', { amount: 20, windX: 0, windY: 0, twist: 0, seed: 1 }),
  C('cc-scatterize', 'wide', { amount: 40, windX: 30, windY: -10, twist: 90, seed: 7 }),
  C('radial-fast-blur', 'small', { amount: 30, centerX: 0, centerY: 0, mode: 0 }),
  C('radial-fast-blur', 'tall', { amount: 60, centerX: 3, centerY: -20, mode: 1 }),
  C('radial-fast-blur', 'wide', { amount: 45, centerX: 100, centerY: 0, mode: 2 }),
  C('cross-blur', 'small', { radiusX: 5, radiusY: 2, repeatEdges: 1 }),
  C('cross-blur', 'tall', { radiusX: 0, radiusY: 7.4, repeatEdges: 0 }),
  C('scale-wipe', 'small', { completion: 30, stretch: 10, direction: 0 }),
  C('scale-wipe', 'wide', { completion: 55, stretch: 4, direction: 200, centerX: -50, centerY: 5 }),
  C('plastic', 'small', { surfaceBump: 25, softness: 5, lightAngle: 45, lightIntensity: 100, specular: 50 }),
  C('plastic', 'tall', { surfaceBump: 80, softness: 0, lightAngle: 200, lightIntensity: 70, specular: 90 }),
  C('glass', 'small', { bumpSoftness: 3, height: 50, displacement: 20, lightAngle: 45, lightIntensity: 100, shininess: 50 }),
  C('glass', 'wide', { bumpSoftness: 0, height: 120, displacement: 60, lightAngle: 250, lightIntensity: 60, shininess: 100 }),
  C('texturize', 'small', { pattern: 0, contrast: 50, scale: 100, lightAngle: 45 }),
  C('texturize', 'small', { pattern: 1, contrast: 80, scale: 60, lightAngle: 135 }),
  C('texturize', 'tall', { pattern: 2, contrast: 40, scale: 150, lightAngle: -30 }),
  C('texturize', 'wide', { pattern: 3, contrast: 100, scale: 40, lightAngle: 90 }),
  C('threads', 'small', { thickness: 6, spacing: 2, depth: 50 }),
  C('threads', 'wide', { thickness: 3, spacing: 0, depth: 100 }),
  C('chromatic-aberration', 'small', { amount: 5, aberrationMode: 0, falloff: 50 }),
  C('chromatic-aberration', 'wide', { amount: 3.5, aberrationMode: 1, angle: 30 }),
  C('hex-tile', 'small', { radius: 6, border: 30 }),
  C('hex-tile', 'wide', { radius: 4.5, border: 0 }),
  C('vector-blur', 'small', { amount: 8, angleOffset: 0, smoothness: 2 }),
  C('vector-blur', 'tall', { amount: 15, angleOffset: 60, smoothness: 0 }),
  C('flo-motion', 'small', { knot1X: -10, knot1Y: 0, knot1Amount: 60, knot2X: 12, knot2Y: 5, knot2Amount: -40, falloff: 30 }),
  C('flo-motion', 'wide', { knot1X: -200, knot1Y: 3, knot1Amount: 100, knot2X: 150, knot2Y: -2, knot2Amount: 0, falloff: 80 }),
  C('lens', 'small', { centerX: 0, centerY: 0, size: 60, convergence: 50 }),
  C('lens', 'wide', { centerX: -150, centerY: 2, size: 90, convergence: 10 }),
  C('griddler', 'small', { tileSize: 10, horizontalScale: 90, verticalScale: 80, rotation: 15 }),
  C('griddler', 'tall', { tileSize: 6.5, horizontalScale: 120, verticalScale: 60, rotation: -40 }),
  C('ball-action', 'small', { grid: 8, ballSize: 90, scatter: 40, seed: 2 }),
  C('ball-action', 'wide', { grid: 6, ballSize: 140, scatter: 100, seed: 9 }),
  C('drizzle', 'small', { dripRate: 50, rippleHeight: 4, spreading: 30, evolution: 40, seed: 1 }),
  C('drizzle', 'wide', { dripRate: 100, rippleHeight: 6, spreading: 120, evolution: -75, seed: 4 }),
  C('jaws', 'small', { completion: 40, direction: 0, teethHeight: 8, teethWidth: 10 }),
  C('jaws', 'wide', { completion: 60, direction: 100, teethHeight: 5, teethWidth: 30 }),
  C('pixel-polly', 'small', { completion: 30, cellSize: 6, gravity: 50, spin: 180, seed: 3 }),
  C('pixel-polly', 'wide', { completion: 70, cellSize: 5, gravity: -20, spin: 400, centerX: 100, centerY: 0, seed: 1 }),
  C('twister', 'small', { completion: 40, centerY: 0, twist: 180 }),
  C('twister', 'tall', { completion: 25, centerY: -10, twist: -360 }),
  C('card-dance', 'small', { rows: 4, columns: 6, amount: 50, cardRotation: 30, phase: 10 }),
  C('card-dance', 'wide', { rows: 2, columns: 20, amount: 80, cardRotation: -60, phase: 55 }),
  // ── E4 second batch: path / paint effects ──
  C('path-stroke', 'small', { ...MASKS_SMALL, brushSize: 6, hardness: 50, spacing: 20, start: 10, end: 85, colorR: 250, colorG: 30, colorB: 90 }),
  C('path-stroke', 'small', { ...MASKS_SMALL, allMasks: 1, sequential: 1, brushSize: 4.5, hardness: 100, opacity: 70, start: 20, end: 90, paintStyle: 1 }),
  C('path-stroke', 'wide', { ...MASKS_WIDE, allMasks: 1, brushSize: 3, hardness: 20, spacing: 0, start: 95, end: 5, paintStyle: 2 }),
  C('path-stroke', 'tall', { ...MASKS_TALL, brushSize: 9, hardness: 0, start: 40, end: 40, paintStyle: 1, colorR: 10, colorG: 200, colorB: 255 }),
  C('path-stroke', 'tall', { ...MASKS_TALL, pathMaskIndex: 1, brushSize: 2, spacing: 35, opacity: 55 }),
  C('scribble', 'small', { ...MASKS_SMALL, mode: 0, fillType: 0, angle: 30, spacing: 3, spacingVariation: 1, curviness: 60, curvinessVariation: 30, pathOverlap: 20, pathOverlapVariation: 40, strokeWidth: 1.5, seed: 4, start: 5, end: 80 }),
  C('scribble', 'small', { ...MASKS_SMALL, mode: 2, fillType: 1, edgeWidth: 6, endCap: 1, join: 0, miterLimit: 3, angle: -60, spacing: 2.5, composite: 1, colorR: 20, colorG: 40, colorB: 220, opacity: 80 }),
  C('scribble', 'wide', { ...MASKS_WIDE, mode: 1, fillType: 4, edgeWidth: 5, endCap: 2, join: 2, angle: 90, spacing: 2, curviness: 0, wiggleState: 2.4, smoothWiggle: 1, sequential: 0, composite: 2, start: 10, end: 70 }),
  C('scribble', 'tall', { ...MASKS_TALL, mode: 1, fillType: 2, edgeWidth: 4, endCap: 0, join: 1, angle: 0, spacing: 1.5, pathOverlap: -30, strokeWidth: 3, wiggleState: 3.7 }),
  C('scribble', 'small', { ...MASKS_SMALL, mode: 1, fillType: 3, edgeWidth: 3, endCap: 1, join: 1, angle: 135, spacing: 2, strokeWidth: 1, seed: -3, pathOverlap: 50 }),
  C('scribble', 'wide', { ...MASKS_WIDE, mode: 0, pathMaskIndex: 1, fillType: 5, edgeWidth: 8, endCap: 1, join: 0, angle: 12, spacing: 3, strokeWidth: 2.5, composite: 1 }),
  C('write-on', 'small', { ...trail(12, 0, 0, 18), size: 5, hardness: 60, colorR: 255, colorG: 220, colorB: 40 }),
  C('write-on', 'small', { ...trail(9, -5, 3, 20), filled: 1, paintTimeProps: 1, brushTimeProps: 3, opacity: 70 }),
  C('write-on', 'wide', { ...trail(30, -150, 0, 200), filled: 1, paintTimeProps: 2, brushTimeProps: 2, paintStyle: 1, size: 4 }),
  C('write-on', 'tall', { brushX: 3, brushY: -10, size: 12, hardness: 90, paintStyle: 2, opacity: 80 }),
];
function fnv1a64(bytes: Uint8Array | Uint8ClampedArray): string {
  // 64-bit FNV-1a in two 32-bit halves (BigInt per byte is slow at 57 kB).
  let hi = 0xcbf29ce4, lo = 0x84222325;
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]!) >>> 0;
    // × 0x100000001b3 = × (2^40 + 0x1b3)
    const loMul = lo * 0x1b3;
    const carry = Math.floor(loMul / 4294967296);
    const newLo = loMul >>> 0;
    hi = (Math.imul(hi, 0x1b3) + carry + ((lo << 8) >>> 0)) >>> 0;
    lo = newLo;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

function toBase64(d: Uint8ClampedArray): string {
  return Buffer.from(d.buffer, d.byteOffset, d.byteLength).toString('base64');
}

function generate(): { images: Array<Image & { rgba: string; fnv: string }>; rows: Array<Case & { fnv: string }> } {
  const byName = new Map(IMAGES.map((im) => [im.name, im]));
  const dump = process.env.EFFECT_KERNEL_DUMP;
  if (dump) mkdirSync(dump, { recursive: true });
  const rows = CASES.map((c, i) => {
    const im = byName.get(c.image)!;
    const data = makeImage(im.w, im.h, im.salt);
    runKernel(c.effect, c.args, data, im.w, im.h);
    if (dump) writeFileSync(path.join(dump, `${i}-${c.effect}.rgba`), data);
    return { ...c, fnv: fnv1a64(data) };
  });
  const images = IMAGES.map((im) => {
    const d = makeImage(im.w, im.h, im.salt);
    return { ...im, rgba: toBase64(d), fnv: fnv1a64(d) };
  });
  return { images, rows };
}

test('fnv1a64 matches the reference constants', () => {
  expect(fnv1a64(new Uint8Array(0))).toBe('cbf29ce484222325');
  expect(fnv1a64(new TextEncoder().encode('a'))).toBe('af63dc4c8601ec8c');
  expect(fnv1a64(new TextEncoder().encode('foobar'))).toBe('85944171f73967e8');
});

test('the C++ effect-kernel parity fixture matches the TS kernels', () => {
  const fixture = generate();
  // Every case changes its input: a kernel that silently no-ops is not parity.
  const inputFnv = new Map(fixture.images.map((im) => [im.name, im.fnv]));
  for (const r of fixture.rows) expect([r.effect, r.fnv]).not.toEqual([r.effect, inputFnv.get(r.image)]);
  const text = `${JSON.stringify({ comment: 'Generated by src/core/effects/nativeKernelCrossEngine.test.ts (GEN_NATIVE_EFFECT_KERNELS=1). Do not edit.', ...fixture })}\n`;
  if (process.env.GEN_NATIVE_EFFECT_KERNELS === '1') {
    writeFileSync(OUT, text);
    return;
  }
  expect(existsSync(OUT)).toBe(true);
  expect(JSON.parse(readFileSync(OUT, 'utf8'))).toEqual(JSON.parse(text));
});
