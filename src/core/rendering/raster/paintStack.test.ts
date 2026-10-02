/**
 * AE's ordered paint stack — Composite and per-paint blend — and the Gradient
 * Stroke's free Start/End geometry.
 *
 * ## The property everything else rests on
 *
 * A layer whose paints use NEITHER feature must render byte-identically. The
 * rasterizer guarantees it structurally: it takes the ordered path only when
 * `hasOrderedPaint` says so, and otherwise runs the original fills-then-strokes
 * branch untouched. So the first thing pinned is that predicate's FALSE side —
 * including for paints that spell the defaults out ('below', 'normal').
 *
 * ## Rule 3a
 *
 * A one-fill one-stroke fixture cannot tell "inserted behind the previous
 * paint" from "sent to the very back". The ordering fixtures have two of each.
 */

import {
  drawPaintStack,
  hasOrderedPaint,
  layerHasOrderedPaint,
  paintRenderOrder,
  strokeGradientFor,
  strokePaintStyle,
  type PaintOp,
} from './vectorDraw';
import { paintCompositeOperation, normalizePaintOpOptions, lottieBlendToPaint, paintBlendToLottie } from '@core/paint/paintBlend';
import type { FillPaint, LinearFill, RadialFill } from '@core/paint/fill';
import type { Stroke } from '@core/paint/stroke';
import type { RenderLayer } from '../RenderBackend';

const fill = (color: string, extra: Record<string, unknown> = {}): FillPaint => ({ type: 'solid', color, ...extra } as FillPaint);
const stroke = (color: string, extra: Partial<Stroke> = {}): Stroke => ({
  enabled: true, color, width: 4, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter', ...extra,
});

/** A readable name per op, so an order assertion reads as the picture. */
const names = (ops: PaintOp[]): string[] =>
  ops.map((op) => (op.kind === 'fill' ? `F:${(op.fill as { color: string }).color}` : `S:${op.stroke.color}`));

describe('byte identity: the ordered path is taken ONLY when asked for', () => {
  it('plain paints, and paints spelling out the defaults, are NOT ordered', () => {
    expect(hasOrderedPaint([fill('a'), fill('b')], [stroke('c')])).toBe(false);
    expect(hasOrderedPaint([fill('a', { composite: 'below', blendMode: 'normal' })], [stroke('c', { composite: 'below', blendMode: 'normal' })])).toBe(false);
    expect(hasOrderedPaint([undefined], [])).toBe(false);
    const layer = { fillPaint: fill('a'), stroke: stroke('b') } as unknown as RenderLayer;
    expect(layerHasOrderedPaint(layer)).toBe(false);
  });

  it('POSITIVE CONTROL: Above, or any blend, is ordered — on a fill or a stroke', () => {
    expect(hasOrderedPaint([fill('a', { composite: 'above' })], [])).toBe(true);
    expect(hasOrderedPaint([], [stroke('c', { blendMode: 'multiply' })])).toBe(true);
    const layer = { fillPaints: [fill('a'), fill('b', { blendMode: 'screen' })] } as unknown as RenderLayer;
    expect(layerHasOrderedPaint(layer)).toBe(true);
  });

  it('the default order IS the original order: every fill, then every stroke, bottom → top', () => {
    expect(names(paintRenderOrder([fill('f0'), fill('f1')], [stroke('s0'), stroke('s1')])))
      .toEqual(['F:f0', 'F:f1', 'S:s0', 'S:s1']);
  });
});

describe('Composite resolves in AE Contents order', () => {
  it('a fill set Above its stroke draws over it', () => {
    expect(names(paintRenderOrder([fill('f0', { composite: 'above' })], [stroke('s0')]))).toEqual(['S:s0', 'F:f0']);
  });

  it('Above lands DIRECTLY in front of the previous paint, not at the front of the stack', () => {
    // Contents top→bottom: s1, s0, f1(above), f0. f1 goes just in front of s0 —
    // still behind s1 — and f0 then goes just behind f1.
    expect(names(paintRenderOrder([fill('f0'), fill('f1', { composite: 'above' })], [stroke('s0'), stroke('s1')])))
      .toEqual(['S:s0', 'F:f0', 'F:f1', 'S:s1']);
  });

  it('a stroke set Above swaps with the stroke listed before it', () => {
    expect(names(paintRenderOrder([], [stroke('s0', { composite: 'above' }), stroke('s1')]))).toEqual(['S:s1', 'S:s0']);
  });

  it('the first paint in Contents has no previous paint, so its Composite changes nothing', () => {
    expect(names(paintRenderOrder([fill('f0')], [stroke('s0', { composite: 'above' })]))).toEqual(['F:f0', 'S:s0']);
  });
});

describe('drawPaintStack', () => {
  it('draws each op in its own save/restore with its blend as the composite operation', () => {
    const log: string[] = [];
    const ctx = {
      set globalCompositeOperation(v: string) { log.push(`gco:${v}`); },
      set fillStyle(v: string) { log.push(`fillStyle:${v}`); },
      save() { log.push('save'); },
      restore() { log.push('restore'); },
      fill() { log.push('fill'); },
    } as unknown as CanvasRenderingContext2D;
    const ops = paintRenderOrder([fill('#f00', { composite: 'above', blendMode: 'multiply' })], [stroke('#0f0')]);
    drawPaintStack(ctx, ops, () => log.push('trace'), (f) => (f as { color: string }).color, (s) => log.push(`stroke:${s.color}`));
    expect(log).toEqual([
      'save', 'gco:source-over', 'stroke:#0f0', 'restore',
      'save', 'gco:multiply', 'trace', 'fillStyle:#f00', 'fill', 'restore',
    ]);
  });
});

describe('paint blend table', () => {
  it('maps AE modes to Canvas2D operators; Add is additive, unknown falls back to normal', () => {
    expect(paintCompositeOperation('multiply')).toBe('multiply');
    expect(paintCompositeOperation('add')).toBe('lighter');
    expect(paintCompositeOperation('linear-burn')).toBe('source-over');
    expect(paintCompositeOperation(undefined)).toBe('source-over');
  });

  it('normalises defaults AWAY — the cache-key contract', () => {
    expect(normalizePaintOpOptions({ composite: 'below', blendMode: 'normal' })).toEqual({});
    expect(normalizePaintOpOptions({ composite: 'above', blendMode: 'divide' })).toEqual({ composite: 'above' });
    expect(normalizePaintOpOptions({ blendMode: 'overlay' })).toEqual({ blendMode: 'overlay' });
  });

  it('round-trips Lottie `bm` numbers', () => {
    for (let bm = 1; bm <= 16; bm++) expect(paintBlendToLottie(lottieBlendToPaint(bm))).toBe(bm);
    expect(lottieBlendToPaint(0)).toBeUndefined();
    expect(lottieBlendToPaint(17)).toBeUndefined(); // Hard Mix: no Canvas2D operator
  });
});

describe('Gradient Stroke geometry', () => {
  const stops = [{ id: 'a', offset: 0, color: '#ff0000' }, { id: 'b', offset: 1, color: '#0000ff' }];
  const recorder = () => {
    const calls: Array<{ fn: string; args: number[] }> = [];
    const grad = { addColorStop() {} };
    const ctx = {
      createLinearGradient: (...args: number[]) => { calls.push({ fn: 'linear', args }); return grad; },
      createRadialGradient: (...args: number[]) => { calls.push({ fn: 'radial', args }); return grad; },
    } as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
  };

  it('linear: the ramp runs Start → End in centred local px', () => {
    const { ctx, calls } = recorder();
    const paint: LinearFill = { type: 'linear', angle: 90, stops };
    strokeGradientFor(ctx, paint, { startX: 0, startY: 0.5, endX: 1, endY: 0.25 }, 200, 100);
    expect(calls).toEqual([{ fn: 'linear', args: [-100, 0, 100, -25] }]);
  });

  it('radial: Start is the centre, |End − Start| the radius, the highlight the focal point', () => {
    const { ctx, calls } = recorder();
    const paint: RadialFill = { type: 'radial', cx: 0.5, cy: 0.5, radius: 0.5, stops };
    // Centre (0,0), end (50,0) → r = 50. Highlight 50% at 90° from the axis
    // (the axis points →, so 90° points ↓): focal point (0, 25).
    strokeGradientFor(ctx, paint, { startX: 0.5, startY: 0.5, endX: 0.75, endY: 0.5, highlightLength: 0.5, highlightAngle: 90 }, 200, 100);
    const [fx, fy, r0, cx, cy, r] = calls[0]!.args;
    expect(calls[0]!.fn).toBe('radial');
    expect([fx!, fy!, r0, cx, cy, r]).toEqual([expect.closeTo(0, 9), expect.closeTo(25, 9), 0, 0, 0, 50]);
  });

  it('a stroke WITHOUT points keeps the angle model — the existing gradient strokes', () => {
    const { ctx, calls } = recorder();
    const paint: LinearFill = { type: 'linear', angle: 90, stops };
    strokePaintStyle(ctx, stroke('#fff', { paint }), 200, 100);
    // makeCanvasGradient: angle 90 on 200×100 spans the box vertically.
    expect(calls[0]!.fn).toBe('linear');
    const [x0, y0, x1, y1] = calls[0]!.args;
    // `+ 0` folds −0 (cos 90° · half is a signed zero) onto 0 for toEqual.
    expect([x0, y0, x1, y1].map((v) => Math.round(v! * 1e6) / 1e6 + 0)).toEqual([0, -50, 0, 50]);
  });

  it('a solid stroke is its colour string, untouched', () => {
    const { ctx, calls } = recorder();
    expect(strokePaintStyle(ctx, stroke('#abcdef'), 10, 10)).toBe('#abcdef');
    expect(calls).toEqual([]);
  });
});
