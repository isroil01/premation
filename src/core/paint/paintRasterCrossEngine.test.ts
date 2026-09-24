/**
 * Cross-engine paint-stroke parity (plan E3). `native/engine/src/raster/paint_raster.cpp`
 * ports `drawPaint` (and `paintDabs.ts`) call for call onto the C++ Canvas2D.
 * This test runs the TS `drawPaint` over a spread of strokes — the v1 direct
 * pass, soft edges, single points, erasers of every mode, clones, dabs with
 * spacing / tips / flow / pen dynamics, trim, per-stroke transforms, channels,
 * blend modes, Paint On Transparent, a tip-stamp cache overflow — on a
 * recording canvas, and stores each case's Canvas2D program in
 * `native/engine/tests/data/paint_raster_parity.json`.
 * `native/engine/tests/test_paint_raster.cpp` runs the C++ port on a recording
 * Canvas2D and requires the same program, op for op (same calls, same
 * arguments to the last bit). Pixels are then the Canvas2D's business, which
 * the raster harness gates (`premation-raster --mode replay` can run these
 * programs too: the op grammar is the harness recorder's).
 *
 * `GEN_NATIVE_PAINT_RASTER=1 npx jest paintRasterCrossEngine` rewrites the
 * fixture; without it this test fails when the fixture is stale.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PaintConfig, PaintStroke } from './paintStrokes';
import { beginRecording, recordingCanvas, withRecordingCanvases } from '@core/rendering/raster/__testHelpers__/recordingCanvas';

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/paint_raster_parity.json');

// ── Cases ──────────────────────────────────────────────────────────────

const line = (n: number, x0: number, y0: number, x1: number, y1: number, wobble = 0): Array<{ x: number; y: number }> =>
  Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0 : i / (n - 1);
    return { x: x0 + (x1 - x0) * t + wobble * Math.sin(i * 1.7), y: y0 + (y1 - y0) * t + wobble * Math.cos(i * 1.3) };
  });

const S = (id: string, over: Partial<PaintStroke>): PaintStroke => ({
  id, points: line(6, -30, -10, 28, 14, 3), color: '#e04030', size: 9, opacity: 1, hardness: 1, mode: 'paint', ...over,
});

interface Case { name: string; w: number; h: number; ss: number; paint: PaintConfig }
const C = (name: string, strokes: PaintStroke[], extra: Partial<PaintConfig> = {}, w = 160, h = 120, ss = 2): Case =>
  ({ name, w, h, ss, paint: { strokes, ...extra } });

const ramp = (n: number, a: number, b: number): number[] => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / Math.max(1, n - 1));

const CASES: Case[] = [
  C('v1 hard polyline', [S('a', {})]),
  C('v1 soft polyline', [S('a', { hardness: 0.4, opacity: 0.8 })]),
  C('v1 single point', [S('a', { points: [{ x: 3.25, y: -4.5 }], size: 14, hardness: 0.75 })]),
  C('v1 eraser', [S('a', {}), S('e', { mode: 'erase', points: line(4, -20, 10, 20, -12), size: 6, opacity: 0.6 })]),
  C('v1 self clone', [S('c', { mode: 'clone', cloneOffsetX: 12.5, cloneOffsetY: -7, hardness: 0.6 })]),
  C('dabs: spacing, tip, flow', [S('a', { spacing: 0.25, hardness: 0.7, roundness: 0.6, angle: 30, flow: 0.8, opacity: 0.9 })]),
  C('dabs: hard round, wide spacing', [S('a', { spacing: 1.5, hardness: 1, size: 12 })]),
  C('dabs: pressure dynamics', [S('a', {
    spacing: 0.2, hardness: 0.5, size: 16, points: line(12, -40, 0, 40, 5, 4), pressure: ramp(12, 0.1, 1),
    dynamics: { size: 'pressure', opacity: 'pressure', minSize: 0.2 },
  })]),
  C('dabs: tilt dynamics', [S('a', {
    spacing: 0.3, hardness: 0.8, size: 14, points: line(8, -30, -20, 30, 20, 2), tiltX: ramp(8, -40, 60), tiltY: ramp(8, 30, -10),
    dynamics: { angle: 'tilt', roundness: 'tilt', flow: 'tilt' }, roundness: 0.9,
  })]),
  C('dabs: sub-pixel tips', [S('a', { spacing: 0.1, size: 0.6, hardness: 0.3, points: line(5, -20, 0, 20, 3) })], {}, 160, 120, 1),
  C('trimmed polyline (write-on)', [S('a', { start: 0.2, end: 0.7, hardness: 0.6 })]),
  C('trimmed dabs', [S('a', { start: 0.35, end: 0.9, spacing: 0.3 })]),
  C('stroke transform', [S('a', { transform: { anchorX: 0, anchorY: 0, x: 6, y: -4, scale: 150, rotation: 20 }, hardness: 0.9 })]),
  C('channels alpha', [S('a', { channels: 'alpha', color: '#202020' })]),
  C('channels rgb normal', [S('a', { channels: 'rgb', color: '#40c060' })]),
  C('channels rgb multiply', [S('a', { channels: 'rgb', blend: 'multiply', color: '#40c060' })]),
  C('blend add + screen', [S('a', { blend: 'add' }), S('b', { blend: 'screen', points: line(3, -10, 20, 25, -20), color: '#3050ff' })]),
  C('erase paint only', [
    S('a', {}), S('e', { mode: 'erase', eraseMode: 'paintOnly', points: line(3, 0, -30, 0, 30), size: 5 }),
    S('f', { mode: 'erase', eraseMode: 'layerAndPaint', points: line(3, -30, 0, 30, 0), size: 4, opacity: 0.5 }),
  ]),
  C('last stroke only', [
    S('a', {}), S('b', { points: line(4, -25, 25, 25, -25), color: '#20a0f0' }),
    S('e', { mode: 'erase', eraseMode: 'lastStroke', eraseTargetId: 'a', points: line(3, -5, -30, 5, 30), size: 7, opacity: 0.7 }),
  ]),
  C('buffered clone', [S('c', { mode: 'clone', cloneOffsetX: -9, cloneOffsetY: 4.5, spacing: 0.25, hardness: 0.5 })]),
  C('clone of another layer / time', [
    S('c', { mode: 'clone', cloneOffsetX: 4, cloneOffsetY: 4, cloneSourceId: 'other' }),
    S('d', { mode: 'clone', cloneOffsetX: -4, cloneOffsetY: 2, cloneTime: 1.5 }),
  ]),
  C('paint on transparent, no strokes', [], { onTransparent: true }),
  C('paint on transparent', [S('a', { hardness: 0.5 })], { onTransparent: true }),
  C('stamp cache overflow', [S('a', {
    spacing: 0.02, size: 40, hardness: 0.6, roundness: 0.5, points: line(40, -60, -30, 60, 30, 5), pressure: ramp(40, 0, 1),
    dynamics: { size: 'pressure', angle: 'pressure' },
  })], {}, 200, 140, 1),
  C('skipped strokes', [S('a', { size: 0 }), S('b', { opacity: 0 }), S('c', { points: [] })]),
];

function runCase(c: Case): string[] {
  const ops = beginRecording();
  const { ctx } = recordingCanvas(c.w, c.h);
  // Prelude: the raster's supersample + centring, and some content to erase / clone.
  ctx.scale(c.ss, c.ss);
  ctx.translate(c.w / c.ss / 2, c.h / c.ss / 2);
  ctx.fillStyle = '#3366cc';
  ctx.fillRect(-30, -20, 60, 40);
  withRecordingCanvases(() => {
    // A fresh module per case: paintRaster's scratch canvases and stamp cache
    // are module state, the C++ keeps them per drawPaint pass.
    jest.isolateModules(() => {
      const { drawPaint } = require('./paintRaster') as typeof import('./paintRaster');
      drawPaint(ctx as unknown as CanvasRenderingContext2D, c.paint);
    });
  });
  return ops.map((op) => JSON.stringify(op));
}

test('the C++ paint-stroke parity fixture matches paintRaster.ts', () => {
  const cases = CASES.map((c) => ({ name: c.name, w: c.w, h: c.h, ss: c.ss, paint: c.paint, ops: runCase(c) }));
  // Every drawing case draws something past the prelude.
  for (const c of cases) if (c.name !== 'skipped strokes') expect(c.ops.length).toBeGreaterThan(5);
  const text = `${JSON.stringify({ comment: 'Generated by src/core/paint/paintRasterCrossEngine.test.ts (GEN_NATIVE_PAINT_RASTER=1). Do not edit.', cases }, null, 1)}\n`;
  if (process.env.GEN_NATIVE_PAINT_RASTER === '1') {
    writeFileSync(OUT, text);
    return;
  }
  expect(existsSync(OUT)).toBe(true);
  expect(JSON.parse(readFileSync(OUT, 'utf8'))).toEqual(JSON.parse(text));
});
