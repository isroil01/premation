import { normalizeStroke, strokeBounds, readNodePaint, type PaintStroke } from './paintStrokes';
import type { SceneNode } from '@core/types';

describe('normalizeStroke', () => {
  test('fills defaults', () => {
    const s = normalizeStroke({ points: [{ x: 0, y: 0 }] }, 'id1');
    expect(s).toEqual({ id: 'id1', points: [{ x: 0, y: 0 }], color: '#ffffff', size: 12, opacity: 1, hardness: 1, mode: 'paint' });
  });
  test('clamps opacity/hardness and keeps erase mode', () => {
    const s = normalizeStroke({ points: [{ x: 1, y: 2 }], opacity: 5, hardness: -1, mode: 'erase', size: 8, color: '#ff0000' }, 'id2');
    expect(s.opacity).toBe(1);
    expect(s.hardness).toBe(0);
    expect(s.mode).toBe('erase');
    expect(s.size).toBe(8);
  });
});

describe('strokeBounds', () => {
  test('includes the brush radius', () => {
    const s: PaintStroke = { id: 'a', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], color: '#fff', size: 4, opacity: 1, hardness: 1, mode: 'paint' };
    expect(strokeBounds(s)).toEqual({ x: -2, y: -2, width: 14, height: 4 });
  });
  test('null for no points', () => {
    expect(strokeBounds({ id: 'a', points: [], color: '#fff', size: 4, opacity: 1, hardness: 1, mode: 'paint' })).toBeNull();
  });
});

describe('readNodePaint', () => {
  const node = (paint: unknown): SceneNode => ({
    id: 'n', name: 'n', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'n_fx', type: 'fx', props: { paint } }],
  } as unknown as SceneNode);

  test('null when absent or empty', () => {
    expect(readNodePaint(node(undefined))).toBeNull();
    expect(readNodePaint(node({ strokes: [] }))).toBeNull();
  });
  test('returns strokes with points', () => {
    const cfg = readNodePaint(node({ strokes: [{ id: 's1', points: [{ x: 1, y: 1 }], color: '#f00', size: 6, opacity: 1, hardness: 1, mode: 'paint' }] }));
    expect(cfg?.strokes).toHaveLength(1);
  });
  test('drops strokes with no points', () => {
    expect(readNodePaint(node({ strokes: [{ id: 's', points: [], color: '#f00', size: 6, opacity: 1, hardness: 1, mode: 'paint' }] }))).toBeNull();
  });
});
