/**
 * Cross-engine parity of the CPU effect CHAIN (plan E4): the TS bake path
 * (`runBakeJob` → `applyEffectChain`, effectBake.ts) against the C++ chain in
 * `native/engine/src/effects/effect_chain.cpp`.
 *
 * Each case is a bake job — straight-RGBA layer pixels, an effect stack with
 * its params RESOLVED (`paramsOf`: registry defaults, randomised values inside
 * each param's declared range, or keyframed tracks sampled through
 * `resolveEffectParams`), fill opacity and the mask stack for effect-scoped
 * masks. It runs on the recording canvas
 * (`@core/rendering/raster/__testHelpers__/recordingCanvas`), which logs the
 * chain's Canvas2D program and holds real pixels: every CPU pixel pass reads
 * and writes them through getImageData / putImageData (each put logs the
 * FNV-1a 64 of its bytes), and the chain's own composites (fill opacity, the
 * Compositing-Options / scoped-mask blend, the CSS flush) go through the
 * recorder's reference compositor. `native/engine/tests/test_effect_chain.cpp`
 * must issue the same program op for op and end on the same bytes.
 *
 * `GEN_NATIVE_EFFECT_CHAIN=1 npx jest effectChainCrossEngine` rewrites
 * `native/engine/tests/data/effect_chain_parity.json`; without it this test
 * fails when the fixture is stale.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sampleTrack } from '@motion/animation';
import type { PropertyTrack } from '@motion/animation';
import { EFFECT_DEFS, effectCss, effectOpacityPath, effectPropPath, paramsOf, resolveEffectParams, type Effect } from './effects';
import { isLutEffect } from './colorLut';
import { isColorEffect } from './effectColorMatrix';
import { isCanvas2dProcedural } from './proceduralCanvas2d';
import { hasCanvas2dImplementation } from './canvas2dEffects';
import { runBakeJob } from './bakeWorkerCore';
import type { LayerMask, MaskPath } from './mask';
import { makeImage } from './__testHelpers__/nativeKernels';
import {
  beginRecording, fnv1a64, RecordingCanvas, withRecordingCanvases,
} from '@core/rendering/raster/__testHelpers__/recordingCanvas';

jest.setTimeout(600_000);

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/effect_chain_parity.json');

/**
 * Canvas-drawn effects the C++ chain does not draw yet (see the E4 table in
 * docs/NATIVE_CORE_PLAN.md). The chain reports them and leaves the frame; no
 * case here carries one.
 */
const NOT_NATIVE = new Set<string>([
  'lens-flare', 'vegas', 'numbers', 'timecode', 'audio-spectrum', 'audio-waveform', 'lightning', 'plexus',
]);

type Route = 'lut' | 'css' | 'color' | 'procedural' | 'canvas2d' | 'none';
/** The branch of `applyEffectChain`'s `applyOne` an effect takes. */
function routeOf(e: Effect): Route {
  if (isLutEffect(e.type)) return 'lut';
  if (effectCss(e)) return 'css';
  if (isColorEffect(e.type)) return 'color';
  if (isCanvas2dProcedural(e.type)) return 'procedural';
  if (hasCanvas2dImplementation(e.type)) return 'canvas2d';
  return 'none';
}

// ── Deterministic parameter values ──────────────────────────────────────────

const q3 = (v: number): number => Math.round(v * 1000) / 1000;

function rng(seed: string): () => number {
  let s = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) s = Math.imul(s ^ seed.charCodeAt(i), 16777619) >>> 0;
  s = s || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Values inside each param's declared range (px spans capped for the small fixture images). */
function randomParams(type: string, seed: number): Record<string, unknown> {
  const def = EFFECT_DEFS.find((d) => d.type === type)!;
  const r = rng(`${type}#${seed}`);
  const out: Record<string, unknown> = {};
  for (const p of def.params) {
    const u = r();
    switch (p.type) {
      case 'number': {
        const d = typeof p.default === 'number' ? p.default : 0;
        let lo = p.min ?? d - 50;
        let hi = p.max ?? d + 50;
        // Wide ranges (centre offsets, seeds, positions) sample near the default,
        // or the effect lands off the small fixture frame and does nothing.
        if (hi - lo > 200) {
          lo = Math.max(lo, d - 40);
          hi = Math.min(hi, d + 40);
        }
        let span = hi - lo;
        if (p.unit === 'px' && span > 60) span = 60;
        out[p.key] = q3(lo + span * u);
        break;
      }
      case 'enum': {
        const opts = p.options ?? [];
        if (opts.length > 0) out[p.key] = opts[Math.min(opts.length - 1, Math.floor(u * opts.length))]!.value;
        break;
      }
      case 'checkbox':
        out[p.key] = u < 0.5;
        break;
      case 'color':
        out[p.key] = `#${Math.floor(u * 0xffffff).toString(16).padStart(6, '0')}`;
        break;
      case 'curve':
        out[p.key] = [[0, q3(u * 40)], [q3(60 + r() * 50), q3(40 + r() * 80)], [q3(150 + r() * 60), q3(140 + r() * 100)], [255, q3(255 - r() * 40)]];
        break;
      default:
        break; // layer / maskPath / resolved: the defaults or the resolved inputs below
    }
  }
  return out;
}

// ── Resolved inputs (what buildSnapshot hands the kernels) ──────────────────

function packMasks(...ms: Array<{ pts: Array<[number, number]>; closed?: boolean; mode?: number; inverted?: boolean }>) {
  const maskPathsMeta: number[] = [];
  const maskPathsXY: number[] = [];
  for (const m of ms) {
    maskPathsMeta.push(m.pts.length, m.closed === false ? 0 : 1, m.mode ?? 1, m.inverted ? 1 : 0);
    for (const [x, y] of m.pts) maskPathsXY.push(q3(x), q3(y));
  }
  return { maskPathsMeta, maskPathsXY };
}
function star(cx: number, cy: number, r1: number, r2: number, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const rr = i % 2 === 0 ? r1 : r2;
    out.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return out;
}
function wave(x0: number, x1: number, y: number, amp: number, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) out.push([x0 + ((x1 - x0) * i) / n, y + Math.sin(i * 0.9) * amp]);
  return out;
}
const MASK_LISTS = {
  ...packMasks({ pts: star(-3, 2, 13, 6, 5) }, { pts: wave(-18, 17, 8, 4, 12), closed: false }),
  pathMaskId: 'mask-1',
  pathMaskIndex: 1,
};
function trail(n: number): Record<string, number[]> {
  const brushTrailXY: number[] = [];
  const brushTrailSize: number[] = [];
  const brushTrailAttr: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(1, n - 1);
    brushTrailXY.push(q3(Math.cos(t * 7) * 14 * t), q3(Math.sin(t * 7) * 10 * t));
    brushTrailSize.push(q3(2 + 5 * t));
    brushTrailAttr.push(q3(30 + 60 * t), q3(100 - 50 * t), q3(255 * t), q3(200 - 150 * t), 90);
  }
  return { brushTrailXY, brushTrailSize, brushTrailAttr };
}
function lut3d(size: number): number[] {
  const out: number[] = [];
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const R = r / (size - 1); const G = g / (size - 1); const B = b / (size - 1);
        out.push(q3(R * 0.8 + G * 0.25), q3(G * G * 0.9 + B * 0.1), q3(Math.sqrt(B) * 0.7 + R * 0.2 + 0.05));
      }
    }
  }
  return out;
}
const SPINE = wave(-16, 15, -2, 5, 9).flatMap(([x, y]) => [q3(x), q3(y)]);

/** Per-type resolved params, merged over every case of that type. */
const RESOLVED: Record<string, Record<string, unknown>> = {
  'path-stroke': MASK_LISTS,
  scribble: MASK_LISTS,
  'write-on': { ...trail(9), writeOnMode: 0 },
  'beam-path': { pathPoints: SPINE },
  'apply-color-lut': { lut: { size: 3, size1d: 0, data: lut3d(3), domainMin: [0, 0, 0], domainMax: [1, 1, 1] }, intensity: 80 },
  'strobe-light': { time: 0.35 },
  'particle-systems': { time: 1.25 },
};

// ── Cases ───────────────────────────────────────────────────────────────────

interface Stored { id: string; type: string; enabled: boolean; params: Record<string, unknown>; opacity?: number; maskId?: string }
interface Case { name: string; image: string; fillOpacity: number; mask?: LayerMask; effects: Stored[] }

const IMAGES: Record<string, { w: number; h: number; salt: number }> = {
  small: { w: 37, h: 29, salt: 5 },
  chain: { w: 53, h: 41, salt: 11 },
};

let seq = 0;
function fx(type: string, params: Record<string, unknown> = {}, extra: Partial<Stored> = {}): Stored {
  const e = { id: `fx${seq++}`, type, enabled: true, params: { ...(RESOLVED[type] ?? {}), ...params } } as unknown as Effect;
  return { id: e.id, type, enabled: extra.enabled ?? true, params: paramsOf(e) as Record<string, unknown>, ...extra };
}

function maskPath(id: string, pts: Array<[number, number]>, extra: Partial<MaskPath> = {}): MaskPath {
  return {
    id, mode: 'add', closed: true, feather: 0, opacity: 1, expansion: 0, inverted: false,
    points: pts.map(([x, y]) => ({ x, y, inX: x, inY: y, outX: x, outY: y })),
    ...extra,
  };
}
const MASKS: LayerMask = {
  paths: [
    maskPath('m-hard', [[-20, -14], [6, -16], [9, 4], [-12, 12]]),
    maskPath('m-soft', star(4, 3, 15, 7, 4).map(([x, y]) => [q3(x), q3(y)]), { feather: 6, opacity: 0.7 }),
    maskPath('m-inv', [[-8, -8], [10, -6], [2, 12]], { inverted: true, expansion: 2 }),
  ],
};

/** A keyframed stack sampled at `t` through `resolveEffectParams`. */
function animated(t: number): Stored[] {
  const effects = [
    fx('gaussian-blur', { blurriness: 1 }),
    fx('vibrance', { vibrance: 10 }),
    fx('fill', { color: '#2080ff', opacity: 40 }),
    fx('twirl', { angle: 30, radius: 15 }),
    fx('levels', { gamma: 1 }),
  ] as unknown as Effect[];
  const track = (prop: string, kfs: Array<[number, number, string?]>): PropertyTrack => ({
    nodeId: 'layer', prop,
    keyframes: kfs.map(([kt, value, easing]) => ({ t: kt, value, ...(easing ? { easing } : {}) })) as PropertyTrack['keyframes'],
  });
  const tracks: PropertyTrack[] = [
    track(effectPropPath(effects[0]!.id, 'blurriness'), [[0, 0.5, 'easeInOut'], [1, 7.25]]),
    track(effectPropPath(effects[1]!.id, 'vibrance'), [[0, -40], [0.5, 60, 'step'], [1.5, 10]]),
    track(effectPropPath(effects[2]!.id, 'color_g'), [[0, 0.1], [2, 0.9]]),
    track(effectPropPath(effects[3]!.id, 'angle'), [[0, 0], [1, 220, 'easeOut']]),
    track(effectOpacityPath(effects[3]!.id), [[0, 100], [1.2, 35]]),
    track(effectPropPath(effects[4]!.id, 'gamma'), [[0, 0.6], [1.5, 2.2]]),
  ];
  const sample = (prop: string): number | undefined => {
    const tr = tracks.find((x) => x.prop === prop);
    return tr ? sampleTrack(tr, t) : undefined;
  };
  return resolveEffectParams(effects, sample, t).map((e) => ({ ...(e as unknown as Stored), params: paramsOf(e) as Record<string, unknown> }));
}

function buildCases(): Case[] {
  seq = 0;
  const cases: Case[] = [];
  // 1. Every effect the chain can draw, alone: at its registry defaults and at two
  //    random points of its declared ranges.
  for (const def of EFFECT_DEFS) {
    if (NOT_NATIVE.has(def.type)) continue;
    for (let s = 0; s < 3; s++) {
      const e = fx(def.type, s === 0 ? {} : randomParams(def.type, s));
      if (routeOf(e as unknown as Effect) === 'none' && s > 0) continue;
      cases.push({ name: `${def.type}#${s}`, image: 'small', fillOpacity: 1, effects: [e] });
    }
  }
  // 2. Stacks: every route interleaved, in stack order.
  const stacks: Array<[string, Stored[], number?, LayerMask?]> = [
    ['css-lut-kernel-colour-drawn', [
      fx('blur', { amount: 2.5 }), fx('levels', { inputBlack: 20, inputWhite: 230, gamma: 1.4 }),
      fx('gaussian-blur', { blurriness: 3 }), fx('brightness', { amount: 120 }), fx('drop-shadow'),
      fx('tint', { amount: 60, mapBlack: '#102040', mapWhite: '#ffe0c0' }), fx('fill', { color: '#44ff88', opacity: 35 }),
      fx('noise', { amount: 20, evolution: 3 }),
    ]],
    ['fill-opacity-styles', [fx('glow', { radius: 5 }), fx('sharpen', { amount: 60 }), fx('circle', { radius: 12, feather: 4 })], 0.35],
    ['fill-opacity-zero', [fx('drop-shadow', { distance: 3 }), fx('vibrance', { vibrance: 50 })], 0],
    ['effect-opacity', [
      fx('mosaic', { horizontalBlocks: 6, verticalBlocks: 5 }, { opacity: 55 }),
      fx('find-edges', {}, { opacity: 0 }),
      fx('emboss', { relief: 2 }, { opacity: 100 }),
      fx('saturate', { amount: 40 }, { opacity: 30 }),
    ]],
    ['scoped-masks', [
      fx('gaussian-blur', { blurriness: 4 }, { maskId: 'm-hard' }),
      fx('invert', { amount: 100 }, { maskId: 'm-soft' }),
      fx('twirl', { angle: 90, radius: 18 }, { maskId: 'm-inv', opacity: 60 }),
      fx('posterize', { levels: 4 }, { maskId: 'no-such-mask' }),
    ], 1, MASKS],
    ['procedural', [
      fx('median', { radius: 1 }), fx('gradient-ramp', { angle: 30, blend: 60 }), fx('bulge', { height: 40, radius: 14 }),
      fx('fractal-noise', { scale: 12 }), fx('threshold', { level: 100 }),
    ]],
    ['disabled-and-inert', [
      fx('vignette', { amount: 60 }, { enabled: false }), fx('displacement-map'), fx('echo'),
      fx('hue-saturation', { hue: 40, saturation: 20, lightness: -10 }), fx('ripple', { amplitude: 6 }, { enabled: false }),
      fx('kaleidoscope', { segments: 5 }),
    ]],
    ['lut-family', [
      fx('curves', { points: [[0, 10], [90, 60], [200, 230], [255, 250]], redPoints: [[0, 0], [128, 150], [255, 255]] }),
      fx('posterize', { levels: 6 }), fx('exposure', { exposure: 0.6, offset: -0.02, gammaCorrection: 1.2 }),
      fx('lumetri', { exposure: 0.3, contrast: 20, highlights: -30, shadows: 25, whites: 10, blacks: -10, temperature: 30, tint: -15 }),
      fx('color-balance', { shadowRed: 30, midtoneGreen: -20, highlightBlue: 40 }),
      fx('gamma-pedestal-gain', { gamma: 1.3, redGain: 0.9, bluePedestal: 0.05 }),
      fx('color-offset', { redPhase: 90, overflow: 1 }), fx('threshold-rgb', { redLevel: 100, greenLevel: 140, blueLevel: 60 }),
      fx('cineon-converter', { conversionType: 2 }),
    ]],
    ['colour-matrix', [
      fx('channel-mixer', { redRed: 80, redGreen: 30, blueConst: 10, monochrome: false }),
      fx('tint', { amount: 100 }), fx('channel-mixer', { monochrome: true, redGreen: 40 }),
    ]],
    ['css-batch', [fx('hue-rotate', { amount: 45 }), fx('sepia', { amount: 50 }), fx('grayscale', { amount: 30 }), fx('contrast', { amount: 140 })]],
    ['drawn-between-kernels', [
      fx('checkerboard', { width: 9, height: 7, opacity: 60 }), fx('fast-box-blur', { blurRadius: 2, iterations: 2 }),
      fx('grid', { width: 8, height: 6, thickness: 1.5 }), fx('unsharp-mask', { amount: 80, radius: 2 }),
      fx('linear-wipe', { completion: 30, wipeAngle: 20, feather: 6 }), fx('light-sweep', { position: 40, sweepWidth: 20 }),
      fx('radio-waves', { waveCount: 3 }), fx('channel-blur', { redBlurriness: 3, alphaBlurriness: 2 }),
      fx('ellipse', { ellipseWidth: 30, ellipseHeight: 20, rotation: 15 }), fx('light-rays', { rayCount: 7 }),
    ]],
    ['styles-over-faded-fill', [
      fx('stroke', { width: 3, position: 'outside' }), fx('inner-shadow', { distance: 3, softness: 2 }),
      fx('satin', { size: 3, distance: 4 }), fx('bevel', { size: 3, depth: 150 }), fx('inner-glow', { size: 2 }),
      fx('stroke', { width: 2, position: 'center', color: '#ff0000' }), fx('stroke', { width: 2, position: 'inside' }),
    ], 0.4],
    ['drawn-passes', [
      fx('four-color-gradient', { blend: 60 }), fx('directional-blur', { length: 6, direction: 30 }),
      fx('transform', { scale: 80, rotation: 10, positionX: 3 }), fx('beam', { length: 70, thickness: 3 }),
      fx('cc-repetile', { expandLeft: 5, expandUp: 3.5, tiling: 2 }), fx('satin', { size: 2, distance: 3, invert: true }, { opacity: 70 }),
      fx('cc-repetile', { expandRight: 4, expandDown: 2, tiling: 1 }),
    ]],
    ['paths-and-brushes', [
      fx('path-stroke', { brushSize: 4, color: '#ff00aa', end: 70 }), fx('scribble', { strokeWidth: 1.5, angle: 30 }),
      fx('write-on', { brushSize: 5 }), fx('beam-path', { coreWidth: 3, glowSpread: 4 }),
    ]],
  ];
  for (const [name, effects, fill, mask] of stacks) {
    cases.push({ name: `stack:${name}`, image: 'chain', fillOpacity: fill ?? 1, ...(mask ? { mask } : {}), effects });
  }
  for (const t of [0, 0.37, 1.2]) cases.push({ name: `animated@${t}`, image: 'chain', fillOpacity: 1, effects: animated(t) });
  return cases;
}

function run(c: Case, pixels: Uint8ClampedArray, w: number, h: number): { ops: string[]; hash: string } {
  const ops = beginRecording();
  const out = withRecordingCanvases(() => runBakeJob(
    { w, h, pixels, effects: c.effects as unknown as Effect[], fillOpacity: c.fillOpacity, ...(c.mask ? { mask: c.mask } : {}) },
    (cw, ch) => {
      const canvas = new RecordingCanvas();
      canvas.width = cw;
      canvas.height = ch;
      return canvas as unknown as HTMLCanvasElement;
    },
  ));
  return { ops: ops.map((op) => JSON.stringify(op)), hash: fnv1a64(out) };
}

function generate() {
  const images: Record<string, { w: number; h: number; b64: string }> = {};
  const data: Record<string, Uint8ClampedArray> = {};
  for (const [name, { w, h, salt }] of Object.entries(IMAGES)) {
    data[name] = makeImage(w, h, salt);
    images[name] = { w, h, b64: Buffer.from(data[name]!).toString('base64') };
  }
  const cases = buildCases().map((c) => {
    const { w, h } = IMAGES[c.image]!;
    return { ...c, routes: c.effects.map((e) => routeOf(e as unknown as Effect)), ...run(c, data[c.image]!, w, h) };
  });
  return { images, cases };
}

test('the C++ effect-chain parity fixture matches the TS bake path', () => {
  const { images, cases } = generate();
  // Guards on the fixture itself: every route is exercised, and the stacks do real work.
  const routes = new Set(cases.flatMap((c) => c.routes));
  for (const r of ['lut', 'css', 'color', 'procedural', 'canvas2d', 'none'] as const) expect(routes.has(r)).toBe(true);
  const text = `${JSON.stringify({
    comment: 'Generated by src/core/effects/effectChainCrossEngine.test.ts (GEN_NATIVE_EFFECT_CHAIN=1). Do not edit.',
    images,
    cases,
  })}\n`;
  if (process.env.GEN_NATIVE_EFFECT_CHAIN === '1') {
    writeFileSync(OUT, text);
    return;
  }
  expect(existsSync(OUT)).toBe(true);
  expect(JSON.parse(readFileSync(OUT, 'utf8'))).toEqual(JSON.parse(text));
});

// ── The chain bench's cases (premation-effects --chain) ─────────────────────
//
// The bench comp's baked layers at 1920×1080: every effect the C++ chain draws,
// alone, at its registry defaults and at the first randomised point above (the
// parity cases' "#1", which moves pixels on most effects), plus the multi-effect
// stacks a real baked layer carries (fill opacity, scoped masks, opacity blends,
// grades, distortions, generators) with masks sized for the frame.

const BENCH_OUT = path.resolve(__dirname, '../../../native/engine/tests/data/effect_chain_bench.json');

function benchCases(): Array<{ name: string; fillOpacity: number; mask?: LayerMask; effects: Stored[] }> {
  seq = 0;
  const out: Array<{ name: string; fillOpacity: number; mask?: LayerMask; effects: Stored[] }> = [];
  for (const def of EFFECT_DEFS) {
    if (NOT_NATIVE.has(def.type)) continue;
    const base = fx(def.type);
    if (routeOf(base as unknown as Effect) === 'none') continue;
    out.push({ name: `${def.type}@default`, fillOpacity: 1, effects: [base] });
    out.push({ name: `${def.type}@active`, fillOpacity: 1, effects: [fx(def.type, randomParams(def.type, 1))] });
  }
  const frameMasks: LayerMask = {
    paths: [
      maskPath('face', [[-420, -300], [380, -320], [460, 260], [-360, 330]], { feather: 40 }),
      maskPath('sky', [[-960, -540], [960, -540], [960, -120], [-960, -60]], { feather: 0, opacity: 0.8 }),
    ],
  };
  out.push(
    { name: 'stack:title-card', fillOpacity: 0.5, effects: [fx('drop-shadow', { distance: 12, softness: 24 }), fx('glow', { radius: 20 }), fx('fill', { color: '#ffcc33', opacity: 70 })] },
    { name: 'stack:graded-footage', fillOpacity: 1, mask: frameMasks, effects: [
      fx('levels', { inputBlack: 12, inputWhite: 240, gamma: 1.1 }),
      fx('curves', { points: [[0, 8], [96, 80], [180, 200], [255, 250]] }),
      fx('vibrance', { vibrance: 30 }),
      fx('gaussian-blur', { blurriness: 12 }, { maskId: 'face' }),
      fx('add-grain', { intensity: 30 }),
    ] },
    { name: 'stack:stylised', fillOpacity: 1, effects: [
      fx('median', { radius: 2 }), fx('find-edges', { blendWithOriginal: 60 }), fx('posterize', { levels: 6 }),
      fx('unsharp-mask', { amount: 80, radius: 3 }, { opacity: 50 }),
    ] },
    { name: 'stack:distort', fillOpacity: 1, effects: [
      fx('turbulent-displace', { amount: 30, size: 80 }), fx('twirl', { angle: 120, radius: 300 }),
      fx('chromatic-aberration', { amount: 6 }),
    ] },
    { name: 'stack:generators', fillOpacity: 1, effects: [fx('fractal-noise', { scale: 12 }), fx('cell-pattern', { size: 60 }), fx('radial-fast-blur', { amount: 30 })] },
    { name: 'stack:keyed-plate', fillOpacity: 1, mask: frameMasks, effects: [
      fx('keylight', { screenColor: '#20c040' }), fx('spill-suppressor', { amount: 60 }), fx('matte-choker', { choke: 2, softness: 3 }),
      fx('color-balance', { highlightBlue: 20 }, { maskId: 'sky' }),
    ] },
  );
  return out;
}

test('the C++ effect-chain bench cases are current', () => {
  const text = `${JSON.stringify({
    comment: 'Generated by src/core/effects/effectChainCrossEngine.test.ts (GEN_NATIVE_EFFECT_CHAIN=1). Do not edit. Run: premation-effects --chain <this file>.',
    width: 1920,
    height: 1080,
    cases: benchCases(),
  })}\n`;
  if (process.env.GEN_NATIVE_EFFECT_CHAIN === '1') {
    writeFileSync(BENCH_OUT, text);
    return;
  }
  expect(existsSync(BENCH_OUT)).toBe(true);
  expect(JSON.parse(readFileSync(BENCH_OUT, 'utf8'))).toEqual(JSON.parse(text));
});
