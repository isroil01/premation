import {
  getNodePaint,
  normalizeStroke,
  readNodePaint,
  strokeBounds,
  strokeDisplayNames,
  updatePaintStroke,
  type PaintStroke,
} from './paintStrokes';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import type { SceneNode } from '@core/types';

describe('normalizeStroke — clone stamp', () => {
  it('accepts clone mode and carries its offsets (defaulting to 0)', () => {
    const s = normalizeStroke({ points: [{ x: 0, y: 0 }], mode: 'clone', cloneOffsetX: 30, cloneOffsetY: -12 }, 'c1');
    expect(s.mode).toBe('clone');
    expect(s.cloneOffsetX).toBe(30);
    expect(s.cloneOffsetY).toBe(-12);
    const d = normalizeStroke({ points: [{ x: 0, y: 0 }], mode: 'clone' }, 'c2');
    expect(d.cloneOffsetX).toBe(0);
    expect(d.cloneOffsetY).toBe(0);
  });

  it('non-clone strokes carry NO offset keys — the field is clone-only', () => {
    const s = normalizeStroke({ points: [{ x: 0, y: 0 }], mode: 'paint', cloneOffsetX: 5 } as never, 'p1');
    expect('cloneOffsetX' in s).toBe(false);
  });
});

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
  test('carries Paint On Transparent', () => {
    const cfg = readNodePaint(node({ onTransparent: true, strokes: [{ id: 's1', points: [{ x: 1, y: 1 }], color: '#f00', size: 6, opacity: 1, hardness: 1, mode: 'paint' }] }));
    expect(cfg?.onTransparent).toBe(true);
  });
});

describe('model v2', () => {
  const pts = [{ x: 0, y: 0 }, { x: 5, y: 0 }];

  test('v1 input normalises to exactly the v1 shape (old documents load unchanged)', () => {
    const v1 = { id: 'p1', points: pts, color: '#ff7ad0', size: 14, opacity: 1, hardness: 1, mode: 'paint' as const };
    expect(normalizeStroke(v1, 'x')).toEqual(v1);
  });

  test('v2 options survive normalisation, clamped', () => {
    const s = normalizeStroke({
      points: pts, start: -1, end: 0.5, angle: 30, roundness: 0, spacing: 0.25, flow: 2,
      channels: 'rgb', blend: 'multiply', inPoint: 1, outPoint: 2, visible: false,
      pressure: [0.2, 0.8], dynamics: { size: 'pressure', minSize: 0.1 },
      transform: { anchorX: 0, anchorY: 0, x: 3, y: 0, scale: 50, rotation: 10 },
    }, 'v2');
    expect(s).toMatchObject({
      start: 0, end: 0.5, angle: 30, roundness: 0.01, spacing: 0.25, flow: 1,
      channels: 'rgb', blend: 'multiply', inPoint: 1, outPoint: 2, visible: false,
      pressure: [0.2, 0.8], dynamics: { size: 'pressure', minSize: 0.1 },
    });
    expect(s.transform?.scale).toBe(50);
  });

  test('per-point input must be parallel to the points', () => {
    expect(normalizeStroke({ points: pts, pressure: [1] }, 'a').pressure).toBeUndefined();
  });

  test('erase and clone options only stick to their own kind', () => {
    expect(normalizeStroke({ points: pts, eraseMode: 'paintOnly' }, 'a').eraseMode).toBeUndefined();
    expect(normalizeStroke({ points: pts, mode: 'erase', eraseMode: 'lastStroke', eraseTargetId: 'b' }, 'a'))
      .toMatchObject({ eraseMode: 'lastStroke', eraseTargetId: 'b' });
    expect(normalizeStroke({ points: pts, cloneSourceId: 'L2' }, 'a').cloneSourceId).toBeUndefined();
    expect(normalizeStroke({ points: pts, mode: 'clone', cloneSourceId: 'L2', cloneLockTime: true }, 'a'))
      .toMatchObject({ cloneSourceId: 'L2', cloneLockTime: true, cloneSourceTime: 0 });
  });

  test('AE names: Brush N / Eraser N / Clone N per kind, a stored name wins', () => {
    const names = strokeDisplayNames([
      { id: 'a', mode: 'paint' }, { id: 'b', mode: 'erase' }, { id: 'c', mode: 'paint' },
      { id: 'd', mode: 'clone' }, { id: 'e', mode: 'paint', name: 'Sky fix' },
    ]);
    expect([...names.values()]).toEqual(['Brush 1', 'Eraser 1', 'Brush 2', 'Clone 1', 'Sky fix']);
  });
});

// Add / remove / Path / Paint on Transparent are engine commands now:
// src/core/engine/__tests__/paintStrokes.test.ts.
describe('the static-value seam', () => {
  const ID = 'paint_mut_layer';
  const makeNode = (): SceneNode => ({
    id: ID, name: ID, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${ID}_fx`, type: 'fx', props: {} }],
  } as unknown as SceneNode);

  beforeEach(() => {
    defaultSceneGraph.clear();
    defaultAnimation.clear();
    defaultSceneGraph.addNode(makeNode());
  });

  test('update merges and an undefined patch key clears', () => {
    defaultSceneGraph.setPaint(ID, { strokes: [normalizeStroke({ points: [{ x: 0, y: 0 }], spacing: 0.25, pressure: [1] }, 'pstroke_1')] });
    updatePaintStroke(ID, 'pstroke_1', { opacity: 0.5, pressure: undefined });
    const s = getNodePaint(ID)!.strokes[0]!;
    expect(s.opacity).toBe(0.5);
    expect(s.spacing).toBe(0.25);
    expect('pressure' in s).toBe(false);
  });
});
