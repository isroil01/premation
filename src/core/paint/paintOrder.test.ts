/**
 * AE's ordered paint stack — Composite resolved into a z-order.
 *
 * Rule 3a: a one-fill one-stroke fixture cannot tell "inserted behind the
 * previous paint" from "sent to the very back". The ordering fixtures have two
 * of each.
 */

import { paintRenderOrder, type PaintOp } from './paintOrder';
import type { FillPaint } from './fill';
import type { Stroke } from './stroke';

const fill = (color: string, extra: Record<string, unknown> = {}): FillPaint => ({ type: 'solid', color, ...extra } as FillPaint);
const stroke = (color: string, extra: Partial<Stroke> = {}): Stroke => ({
  enabled: true, color, width: 4, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter', ...extra,
});

/** A readable name per op, so an order assertion reads as the picture. */
const names = (ops: PaintOp[]): string[] =>
  ops.map((op) => (op.kind === 'fill' ? `F:${(op.fill as { color: string }).color}` : `S:${op.stroke.color}`));

describe('paintRenderOrder', () => {
  it('the default order IS the original order: every fill, then every stroke, bottom → top', () => {
    expect(names(paintRenderOrder([fill('f0'), fill('f1')], [stroke('s0'), stroke('s1')])))
      .toEqual(['F:f0', 'F:f1', 'S:s0', 'S:s1']);
  });

  it('paints spelling out the default keep that order', () => {
    expect(names(paintRenderOrder([fill('f0', { composite: 'below' })], [stroke('s0', { composite: 'below' })])))
      .toEqual(['F:f0', 'S:s0']);
  });

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

  it('an absent fill still takes its slot (a stroke-only shape with a placeholder fill)', () => {
    const ops = paintRenderOrder([undefined], [stroke('s0')]);
    expect(ops.map((o) => o.kind)).toEqual(['fill', 'stroke']);
  });
});
