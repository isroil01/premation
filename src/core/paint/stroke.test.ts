import { normalizeStroke, readNodeStroke, defaultStroke } from './stroke';
import type { SceneNode } from '@core/types';

const node = (fxProps: Record<string, unknown> | null): SceneNode =>
  ({ id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false,
     transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
     components: fxProps ? [{ id: 'fx', type: 'fx', props: fxProps }] : [] } as unknown as SceneNode);

describe('normalizeStroke', () => {
  test('fills defaults for a partial stroke', () => {
    const s = normalizeStroke({ width: 8 });
    expect(s).toEqual({ enabled: true, color: '#ffffff', width: 8, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter' });
  });

  test('clamps width ≥ 0 and opacity 0..1', () => {
    expect(normalizeStroke({ width: -5 }).width).toBe(0);
    expect(normalizeStroke({ width: 3, opacity: 2 }).opacity).toBe(1);
    expect(normalizeStroke({ width: 3, opacity: -1 }).opacity).toBe(0);
  });

  test('rejects invalid enum values, keeps valid ones', () => {
    const s = normalizeStroke({ width: 2, align: 'sideways' as never, cap: 'round', join: 'bevel' });
    expect(s.align).toBe('center');
    expect(s.cap).toBe('round');
    expect(s.join).toBe('bevel');
  });

  test('filters the dash array to finite non-negative numbers', () => {
    expect(normalizeStroke({ width: 2, dash: [8, -1, NaN, 4] as number[] }).dash).toEqual([8, 4]);
  });

  test('non-object → full default', () => {
    expect(normalizeStroke(undefined)).toEqual(defaultStroke());
  });
});

describe('readNodeStroke', () => {
  test('returns a normalized stroke when enabled with width > 0', () => {
    const s = readNodeStroke(node({ stroke: { width: 6, color: '#ff0000' } }));
    expect(s?.width).toBe(6);
    expect(s?.color).toBe('#ff0000');
  });

  test('undefined when disabled', () => {
    expect(readNodeStroke(node({ stroke: { width: 6, enabled: false } }))).toBeUndefined();
  });

  test('undefined when width is 0', () => {
    expect(readNodeStroke(node({ stroke: { width: 0 } }))).toBeUndefined();
  });

  test('undefined when no fx/stroke', () => {
    expect(readNodeStroke(node(null))).toBeUndefined();
  });
});
