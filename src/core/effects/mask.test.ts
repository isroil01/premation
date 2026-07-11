import {
  rectangleMask,
  ellipseMask,
  maskSegments,
  readNodeMask,
  type LayerMask,
} from './mask';
import type { SceneNode } from '@core/types';

function nodeWithFx(props?: Record<string, unknown>): SceneNode {
  const components = props ? [{ type: 'fx', props }] : [];
  return { components } as unknown as SceneNode;
}

describe('mask presets', () => {
  test('rectangleMask spans the layer bounds as 4 corner anchors', () => {
    const m = rectangleMask(200, 100);
    expect(m.closed).toBe(true);
    expect(m.mode).toBe('add');
    expect(m.inverted).toBe(false);
    expect(m.points).toHaveLength(4);
    expect(m.points.map((p) => [p.x, p.y])).toEqual([
      [-100, -50], [100, -50], [100, 50], [-100, 50],
    ]);
    // Corners: handles coincide with the anchor (straight edges).
    for (const p of m.points) {
      expect([p.inX, p.inY, p.outX, p.outY]).toEqual([p.x, p.y, p.x, p.y]);
    }
  });

  test('ellipseMask is a 4-point cubic circle with offset handles', () => {
    const m = ellipseMask(200, 100);
    expect(m.points).toHaveLength(4);
    const top = m.points[0]!;
    expect([top.x, top.y]).toEqual([0, -50]);
    // Handles are offset horizontally by the cubic-circle constant.
    const k = 0.5522847498307936;
    expect(top.outX).toBeCloseTo(100 * k);
    expect(top.inX).toBeCloseTo(-100 * k);
  });
});

describe('maskSegments', () => {
  test('a closed 4-point path yields 4 segments (wraps to the start)', () => {
    const segs = maskSegments(rectangleMask(200, 100));
    expect(segs).toHaveLength(4);
    // Last segment returns to the first anchor.
    expect([segs[3]!.x1, segs[3]!.y1]).toEqual([-100, -50]);
  });

  test('an open path yields one fewer segment', () => {
    const m = rectangleMask(200, 100);
    m.closed = false;
    expect(maskSegments(m)).toHaveLength(3);
  });

  test('straight edges have control points at the endpoints', () => {
    const [s] = maskSegments(rectangleMask(200, 100));
    expect([s!.cx1, s!.cy1]).toEqual([s!.x0, s!.y0]);
    expect([s!.cx2, s!.cy2]).toEqual([s!.x1, s!.y1]);
  });

  test('degenerate paths produce no segments', () => {
    expect(maskSegments({ ...rectangleMask(10, 10), points: [] })).toEqual([]);
  });
});

describe('readNodeMask', () => {
  test('returns undefined with no fx / empty mask', () => {
    expect(readNodeMask(nodeWithFx())).toBeUndefined();
    expect(readNodeMask(nodeWithFx({ mask: { paths: [] } }))).toBeUndefined();
  });

  test('returns a stored non-empty mask', () => {
    const mask: LayerMask = { paths: [rectangleMask(50, 50)] };
    expect(readNodeMask(nodeWithFx({ mask }))).toBe(mask);
  });
});
