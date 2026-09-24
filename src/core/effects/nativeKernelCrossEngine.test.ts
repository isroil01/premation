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
