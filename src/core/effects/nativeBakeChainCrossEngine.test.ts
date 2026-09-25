/**
 * Cross-engine parity of WHOLE CPU-baked effect chains (plan D2w / E4 wiring).
 *
 * `native/engine/src/scene/bake_chain.cpp` ports the bake a layer raster takes
 * — Canvas2DVectorRasterizer's mask matte, then `applyEffectChain` over the
 * raster canvas with `scaleEffectLengths` — call for call onto the C++ Canvas2D.
 * This test runs the TypeScript bake on a recording canvas for synthetic layers
 * (fill opacity with the style silhouette, the drawn styles, CSS-filter batching,
 * LUT / colour-matrix / cube-LUT passes, the procedural generators, pixel
 * kernels, effect-scoped masks and Compositing-Options opacity) and stores each
 * Canvas2D program in `native/engine/tests/data/bake_chain_parity.json`;
 * `native/engine/tests/test_bake_chain.cpp` requires the C++ to issue the same
 * program op for op, with every `putImageData` carrying the same FNV-1a 64 of
 * its bytes — so the pixel passes' parameter mapping is pinned too.
 *
 * The recording canvases (recordingCanvas.ts / recording_canvas.hpp) hold real
 * pixels: the layer is seeded with a synthetic frame and every pixel pass runs on it.
 *
 * `GEN_NATIVE_BAKE_CHAIN=1 npx jest nativeBakeChainCrossEngine` rewrites the
 * fixture; without it this test fails when the fixture is stale.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Effect } from './effects';
import { packMaskPaths } from './strokePaint';

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/bake_chain_parity.json');

type Rec = typeof import('@core/rendering/raster/__testHelpers__/recordingCanvas');

/** The synthetic frame (straight RGBA) — test_bake_chain.cpp computes the same. */
function pattern(w: number, h: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = (x * 7 + y * 3) & 255;
      d[i + 1] = (x * 5 + y * 11 + ((x * y) % 17)) & 255;
      d[i + 2] = (255 - x * 3 - y * 2) & 255;
      d[i + 3] = (x + y) % 9 === 0 ? 0 : (x * 13 + y * 29 + 64) & 255;
    }
  }
  return d;
}

const E = (type: string, params: Record<string, unknown>, extra: Partial<Effect> = {}): Effect =>
  ({ id: `fx-${type}`, type, enabled: true, params, ...extra } as unknown as Effect);

const MASK = {
  paths: [
    {
      id: 'scope', mode: 'add', closed: true, feather: 6, opacity: 0.8, expansion: 0, inverted: false,
      points: [
        { x: -30, y: -20, inX: -30, inY: -20, outX: -30, outY: -20 },
        { x: 30, y: -20, inX: 30, inY: -20, outX: 30, outY: -20 },
        { x: 20, y: 25, inX: 30, inY: 25, outX: 10, outY: 25 },
      ],
    },
  ],
};

const CUBE = {
  size: 2, size1d: 0, domainMin: [0, 0, 0], domainMax: [1, 1, 1],
  data: [0, 0, 0.1, 1, 0, 0, 0, 1, 0, 1, 1, 0.2, 0, 0.3, 1, 1, 0, 1, 0, 1, 1, 0.9, 0.95, 1],
};

/** buildSnapshot's all-masks hand-off for MASK (effect_handoff.cpp in the engine). */
function packedMask(pick: number): Record<string, unknown> {
  const { meta, xy } = packMaskPaths(MASK.paths as never);
  return { maskPathsMeta: meta, maskPathsXY: xy, pathMaskIndex: pick };
}

interface Case { name: string; width: number; height: number; pad: number; ss: number; effects: Effect[]; fillOpacity?: number; mask?: unknown }

const CASES: Case[] = [
  { name: 'fill-opacity-only', width: 40, height: 30, pad: 0, ss: 1, effects: [], fillOpacity: 0.5 },
  {
    name: 'fill-opacity-styles', width: 60, height: 40, pad: 8, ss: 1, fillOpacity: 0,
    effects: [
      E('stroke', { width: 4, color: '#ff2d55', opacity: 100, position: 'outside' }),
      E('inner-shadow', { distance: 5, angle: 120, softness: 6, color: '#102030', opacity: 70 }),
    ],
  },
  {
    name: 'styles-inside-center-glow', width: 50, height: 36, pad: 10, ss: 2,
    effects: [
      E('stroke', { width: 3, color: '#00ff88', opacity: 90, position: 1 }),
      E('inner-glow', { size: 5, color: '#ffd070', opacity: 60 }),
      E('glow', { radius: 8, spread: 25, color: '#78b4ff', intensity: 80 }),
      E('stroke', { width: 2.5, color: '#abcdef', opacity: 50, position: 'center' }, { id: 'fx-stroke-2' }),
    ],
  },
  {
    name: 'css-batch-and-matrix', width: 48, height: 32, pad: 0, ss: 1,
    effects: [
      E('brightness', { amount: 120 }),
      E('contrast', { amount: 80 }),
      E('hue-saturation', { hue: 30, saturation: -20, lightness: 10 }),
      E('tint', { amount: 60, mapBlack: '#200010', mapWhite: '#f0f0ff' }),
      E('saturate', { amount: 140 }),
      E('grayscale', { amount: 30 }),
      E('sepia', { amount: 50 }),
      E('invert', { amount: 20 }),
      E('drop-shadow', { distance: 7, angle: 135, softness: 4, spread: 10, color: '#000000', opacity: 55 }),
      E('channel-mixer', { redRed: 90, redGreen: 10, greenGreen: 100, blueBlue: 80, blueRed: 20 }),
    ],
  },
  {
    name: 'scoped-mask-and-opacity', width: 70, height: 50, pad: 0, ss: 1, mask: MASK,
    effects: [
      E('hue-rotate', { amount: 160 }, { maskId: 'scope' } as Partial<Effect>),
      E('gaussian-blur', { blurriness: 6 }, { opacity: 40 } as Partial<Effect>),
      E('levels', { inputBlack: 20, inputWhite: 235, gamma: 1.2, outputBlack: 0, outputWhite: 255 }),
      E('curves', { points: [[0, 0], [100, 140], [255, 255]], redPoints: [[0, 20], [255, 240]] }, { opacity: 0 } as Partial<Effect>),
    ],
  },
  {
    name: 'generators-and-cube', width: 64, height: 48, pad: 0, ss: 1,
    effects: [
      E('gradient-ramp', { blend: 70, colorA: '#ff0000', colorB: '#0000ff', angle: 30 }),
      E('fractal-noise', { scale: 12 }),
      E('four-color-gradient', { blend: 60, colorTL: '#ff0000', colorTR: '#00ff00', colorBL: '#0000ff', colorBR: '#ffff00' }),
      E('apply-color-lut', { lut: CUBE, intensity: 75 }),
      E('lumetri', { exposure: 0.5, contrast: 20, temperature: 15 }),
    ],
  },
  {
    name: 'pixel-kernels-scaled', width: 40, height: 28, pad: 4, ss: 2,
    effects: [
      E('noise', { amount: 30, evolution: 3 }),
      E('emboss', { direction: 45, relief: 2, contrast: 150 }),
      E('twirl', { angle: 90, radius: 20 }),
      E('find-edges', { invert: true }),
      E('fill', { color: '#ff8800', opacity: 60 }),
      E('checkerboard', { width: 8, height: 6, opacity: 50 }),
      E('linear-wipe', { completion: 40, wipeAngle: 30, feather: 5 }),
    ],
  },
  {
    // The four that force a bake on their own; their mask geometry resolved the
    // way buildSnapshot hands it off (packMaskPaths / pathMaskIndex).
    name: 'paint-effects', width: 70, height: 50, pad: 6, ss: 1, mask: MASK,
    effects: [
      E('path-stroke', { pathMaskId: 'scope', color: '#ffd166', brushSize: 5, brushHardness: 60, opacity: 100, start: 10, end: 85, spacing: 15, paintStyle: 1, ...packedMask(0) }),
      E('scribble', { pathMaskId: 'scope', color: '#ff7a1a', strokeWidth: 2, spacing: 5, angle: 45, randomSeed: 7, wiggleState: 0, ...packedMask(0) }),
      E('vegas', { segments: 6, length: 40, width: 3, hardness: 100, threshold: 128, color: '#7dd3fc', opacity: 100 }),
      E('plexus', { pointCount: 20, spread: 90, drift: 10, evolution: 3, maxDistance: 30, lineWidth: 1, lineOpacity: 70, triangles: true, triangleOpacity: 12, pointSize: 2, seed: 5 }),
    ],
  },
  { name: 'layer-mask-then-chain', width: 70, height: 50, pad: 3, ss: 1, mask: MASK, fillOpacity: 0.25, effects: [E('stroke', { width: 2, color: '#ffffff', opacity: 100 })] },
];

function generate() {
  const out: unknown[] = [];
  for (const c of CASES) {
    jest.isolateModules(() => {
      // Fresh modules per case: canvas2dEffects.ts pools its scratch canvases by
      // role, and a pooled context keeps its state from the previous case.
      const rec = require('@core/rendering/raster/__testHelpers__/recordingCanvas') as Rec;
      const { applyEffectChain } = require('./effectBake') as typeof import('./effectBake');
      const { scaleEffectLengths, migrateEffect } = require('./effects') as typeof import('./effects');
      const { paintMaskMatte } = require('./mask') as typeof import('./mask');
      const effects = c.effects.map(migrateEffect);
      const bw = c.width + 2 * c.pad;
      const bh = c.height + 2 * c.pad;
      const w = Math.max(1, Math.round(bw * c.ss));
      const h = Math.max(1, Math.round(bh * c.ss));
      const ops = rec.beginRecording();
      const { ctx } = rec.recordingCanvas(w, h);
      const g = ctx as unknown as CanvasRenderingContext2D;
      // The layer content: a synthetic straight-RGBA frame (the recorders hold
      // real pixels, so every pixel pass runs on it on both engines).
      g.putImageData({ data: pattern(w, h), width: w, height: h } as unknown as ImageData, 0, 0);
      const spec = {
        width: c.width, height: c.height, effects,
        ...(c.fillOpacity !== undefined ? { fillOpacity: c.fillOpacity } : {}),
        ...(c.mask ? { mask: c.mask } : {}),
      };
      rec.withRecordingCanvases(() => {
        // Canvas2DVectorRasterizer.drawPath's bake branch.
        const mask = c.mask as { paths: unknown[] } | undefined;
        if (mask && mask.paths.length > 0) {
          const matte = document.createElement('canvas');
          matte.width = w; matte.height = h;
          const mc = matte.getContext('2d')!;
          mc.setTransform(1, 0, 0, 1, bw / 2, bh / 2);
          paintMaskMatte(mc, mask as never, c.width, c.height);
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.globalCompositeOperation = 'destination-in';
          g.drawImage(matte, 0, 0);
          g.globalCompositeOperation = 'source-over';
        }
        g.setTransform(1, 0, 0, 1, 0, 0);
        applyEffectChain(g, w, h, scaleEffectLengths(effects, c.ss), (sw, sh) => {
          const s = document.createElement('canvas');
          s.width = sw; s.height = sh;
          return s;
        }, c.fillOpacity ?? 1, mask as never);
      });
      out.push({ name: c.name, bw, bh, ss: c.ss, w, h, spec, ops: ops.map((op) => JSON.stringify(op)) });
    });
  }
  return out;
}

test('the C++ bake-chain parity fixture matches effectBake.ts', () => {
  const cases = generate();
  const text = `${JSON.stringify({ comment: 'Generated by src/core/effects/nativeBakeChainCrossEngine.test.ts (GEN_NATIVE_BAKE_CHAIN=1). Do not edit.', cases }, null, 1)}\n`;
  if (process.env.GEN_NATIVE_BAKE_CHAIN === '1') {
    writeFileSync(OUT, text);
    return;
  }
  expect(existsSync(OUT)).toBe(true);
  expect(JSON.parse(readFileSync(OUT, 'utf8'))).toEqual(JSON.parse(text));
});
