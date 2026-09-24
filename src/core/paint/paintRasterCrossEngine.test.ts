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

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/paint_raster_parity.json');

// ── A recording canvas (the harness grammar, normalised) ────────────────

type Op = unknown[];

/** Canonical colour: rgba(r,g,b,a) with JS number formatting. */
function canonColor(s: string): string {
  const t = s.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(t);
  if (m) {
    const h = m[1]!;
    const x = (i: number, n: number): number => parseInt(h.slice(i, i + n), 16);
    if (h.length === 3 || h.length === 4) {
      return `rgba(${x(0, 1) * 17},${x(1, 1) * 17},${x(2, 1) * 17},${h.length === 4 ? (x(3, 1) * 17) / 255 : 1})`;
    }
    return `rgba(${x(0, 2)},${x(2, 2)},${x(4, 2)},${h.length === 8 ? x(6, 2) / 255 : 1})`;
  }
  m = /^rgba?\(([^)]*)\)$/.exec(t);
  if (m) {
    const p = m[1]!.split(',').map((v) => Number(v.trim()));
    return `rgba(${p[0]},${p[1]},${p[2]},${p[3] ?? 1})`;
  }
  throw new Error(`fixture colour not canonicalisable: ${s}`);
}

interface Session { ops: Op[]; nextCanvas: number; nextGrad: number }
let session: Session;

class FakeGradient {
  constructor(readonly id: number) {}
  addColorStop(offset: number, color: string): void {
    session.ops.push([-1, 'stop', this.id, offset, canonColor(color)]);
  }
}

type M = [number, number, number, number, number, number];

class FakeContext {
  private m: M = [1, 0, 0, 1, 0, 0];
  private stack: Array<{ m: M; fill: unknown; stroke: unknown }> = [];
  private fill_: unknown = '#000';
  private stroke_: unknown = '#000';
  constructor(readonly canvas: FakeCanvas) {}
  private get id(): number { return this.canvas.id(); }
  private call(name: string, ...args: unknown[]): void { session.ops.push([this.id, 'call', name, ...args]); }
  private set(name: string, v: unknown): void { session.ops.push([this.id, 'set', name, v]); }
  private style(v: unknown): unknown { return v instanceof FakeGradient ? { $g: v.id } : canonColor(String(v)); }

  save(): void { this.stack.push({ m: [...this.m] as M, fill: this.fill_, stroke: this.stroke_ }); this.call('save'); }
  restore(): void {
    const s = this.stack.pop();
    if (s) { this.m = s.m; this.fill_ = s.fill; this.stroke_ = s.stroke; }
    this.call('restore');
  }
  translate(x: number, y: number): void {
    const [a, b, c, d, e, f] = this.m;
    this.m = [a, b, c, d, a * x + c * y + e, b * x + d * y + f];
    this.call('translate', x, y);
  }
  scale(x: number, y: number): void {
    const [a, b, c, d, e, f] = this.m;
    this.m = [a * x, b * x, c * y, d * y, e, f];
    this.call('scale', x, y);
  }
  rotate(t: number): void {
    const [a, b, c, d, e, f] = this.m;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    this.m = [a * cos + c * sin, b * cos + d * sin, c * cos - a * sin, d * cos - b * sin, e, f];
    this.call('rotate', t);
  }
  setTransform(a: number | { a: number; b: number; c: number; d: number; e: number; f: number }, b?: number, c?: number, d?: number, e?: number, f?: number): void {
    this.m = typeof a === 'number' ? [a, b!, c!, d!, e!, f!] : [a.a, a.b, a.c, a.d, a.e, a.f];
    this.call('setTransform', ...this.m);
  }
  getTransform(): { a: number; b: number; c: number; d: number; e: number; f: number } {
    const [a, b, c, d, e, f] = this.m;
    return { a, b, c, d, e, f };
  }
  set fillStyle(v: unknown) { this.fill_ = v; this.set('fillStyle', this.style(v)); }
  get fillStyle(): unknown { return this.fill_; }
  set strokeStyle(v: unknown) { this.stroke_ = v; this.set('strokeStyle', this.style(v)); }
  get strokeStyle(): unknown { return this.stroke_; }
  set lineWidth(v: number) { this.set('lineWidth', v); }
  set lineCap(v: string) { this.set('lineCap', v); }
  set lineJoin(v: string) { this.set('lineJoin', v); }
  set globalAlpha(v: number) { this.set('globalAlpha', v); }
  set globalCompositeOperation(v: string) { this.set('globalCompositeOperation', v); }
  set filter(v: string) { this.set('filter', v); }
  beginPath(): void { this.call('beginPath'); }
  moveTo(x: number, y: number): void { this.call('moveTo', x, y); }
  lineTo(x: number, y: number): void { this.call('lineTo', x, y); }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void { this.call('arc', x, y, r, a0, a1, ccw); }
  fill(rule: string = 'nonzero'): void { this.call('fill', rule); }
  stroke(): void { this.call('stroke'); }
  fillRect(x: number, y: number, w: number, h: number): void { this.call('fillRect', x, y, w, h); }
  clearRect(x: number, y: number, w: number, h: number): void { this.call('clearRect', x, y, w, h); }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): FakeGradient {
    const g = new FakeGradient(session.nextGrad++);
    session.ops.push([this.id, 'grad', g.id, 'radial', x0, y0, r0, x1, y1, r1]);
    return g;
  }
  drawImage(img: FakeCanvas, ...a: number[]): void {
    const src = { $c: img.id() };
    if (a.length === 2) this.call('drawImage', src, 0, 0, img.width, img.height, a[0], a[1], img.width, img.height);
    else if (a.length === 4) this.call('drawImage', src, 0, 0, img.width, img.height, a[0], a[1], a[2], a[3]);
    else this.call('drawImage', src, ...a);
  }
}

class FakeCanvas {
  width = 300;
  height = 150;
  private ctx: FakeContext | null = null;
  private cid = -1;
  id(): number {
    if (this.cid < 0) {
      this.cid = session.nextCanvas++;
      session.ops.push([this.cid, 'canvas', this.width, this.height]);
    }
    return this.cid;
  }
  getContext(): FakeContext {
    this.id();
    this.ctx ??= new FakeContext(this);
    return this.ctx;
  }
}

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
  session = { ops: [], nextCanvas: 0, nextGrad: 0 };
  const root = new FakeCanvas();
  root.width = c.w;
  root.height = c.h;
  const ctx = root.getContext();
  // Prelude: the raster's supersample + centring, and some content to erase / clone.
  ctx.scale(c.ss, c.ss);
  ctx.translate(c.w / c.ss / 2, c.h / c.ss / 2);
  ctx.fillStyle = '#3366cc';
  ctx.fillRect(-30, -20, 60, 40);
  const create = document.createElement.bind(document);
  const spy = jest.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
    (tag === 'canvas' ? new FakeCanvas() : create(tag))) as typeof document.createElement);
  try {
    // A fresh module per case: paintRaster's scratch canvases and stamp cache
    // are module state, the C++ keeps them per drawPaint pass.
    jest.isolateModules(() => {
      const { drawPaint } = require('./paintRaster') as typeof import('./paintRaster');
      drawPaint(ctx as unknown as CanvasRenderingContext2D, c.paint);
    });
  } finally {
    spy.mockRestore();
  }
  return session.ops.map((op) => JSON.stringify(op));
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
