/**
 * Merge Paths — boolean ops across shape layers (polygon-clipping backed).
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import {
  flattenOutline,
  nodeWorldPolygon,
  booleanPolygons,
  mergeSelectedPaths,
} from './mergePaths';
import type { SceneNode } from '@core/types';

function rect(id: string, x: number, y: number, w: number, h: number): SceneNode {
  return {
    id,
    name: id,
    parent: null,
    children: [],
    transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { __kind: 'shape', x, y, width: w, height: h, shapeType: 'rect' },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ff0000' } },
    ],
  } as unknown as SceneNode;
}

function ringArea(ring: ReadonlyArray<[number, number]>): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
  }
  return Math.abs(a / 2);
}

describe('flattenOutline', () => {
  it('corner-only outlines pass through as their anchors', () => {
    const sq = [
      { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
      { x: 10, y: 0, inX: 10, inY: 0, outX: 10, outY: 0 },
      { x: 10, y: 10, inX: 10, inY: 10, outX: 10, outY: 10 },
      { x: 0, y: 10, inX: 0, inY: 10, outX: 0, outY: 10 },
    ];
    expect(flattenOutline(sq)).toHaveLength(4);
  });

  it('curved segments are subdivided', () => {
    const curved = [
      { x: 0, y: 0, inX: 0, inY: 0, outX: 5, outY: -5 },
      { x: 10, y: 0, inX: 5, inY: -5, outX: 10, outY: 0 },
      { x: 5, y: 10, inX: 5, inY: 10, outX: 5, outY: 10 },
    ];
    expect(flattenOutline(curved, 8).length).toBeGreaterThan(3);
  });
});

describe('nodeWorldPolygon', () => {
  it('a rect layer yields its world-space corners', () => {
    const poly = nodeWorldPolygon(rect('r1', 100, 100, 40, 20))!;
    expect(poly).not.toBeNull();
    const ring = poly[0]!;
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(80);
    expect(Math.max(...xs)).toBeCloseTo(120);
    expect(Math.min(...ys)).toBeCloseTo(90);
    expect(Math.max(...ys)).toBeCloseTo(110);
  });

  it('non-shapes and open strokes return null', () => {
    const open = rect('r2', 0, 0, 10, 10);
    open.components.push({ id: 'r2_g', type: 'Geometry', props: { points: [
      { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
      { x: 5, y: 5, inX: 5, inY: 5, outX: 5, outY: 5 },
      { x: 9, y: 0, inX: 9, inY: 0, outX: 9, outY: 0 },
    ], open: true } });
    expect(nodeWorldPolygon(open)).toBeNull();
  });
});

describe('booleanPolygons', () => {
  const A: [number, number][][] = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
  const B: [number, number][][] = [[[5, 5], [15, 5], [15, 15], [5, 15], [5, 5]]];

  it('union area = a + b − overlap', () => {
    const out = booleanPolygons([A, B], 'union');
    const area = out.reduce((s, poly) => s + ringArea(poly[0]!), 0);
    expect(area).toBeCloseTo(100 + 100 - 25);
  });

  it('intersect area = overlap', () => {
    const out = booleanPolygons([A, B], 'intersect');
    const area = out.reduce((s, poly) => s + ringArea(poly[0]!), 0);
    expect(area).toBeCloseTo(25);
  });

  it('subtract area = a − overlap', () => {
    const out = booleanPolygons([A, B], 'subtract');
    const area = out.reduce((s, poly) => s + ringArea(poly[0]!), 0);
    expect(area).toBeCloseTo(75);
  });

  it('exclude area = a + b − 2·overlap', () => {
    const out = booleanPolygons([A, B], 'exclude');
    const area = out.reduce((s, poly) => s + ringArea(poly[0]!), 0);
    expect(area).toBeCloseTo(150);
  });
});

describe('mergeSelectedPaths', () => {
  it('unions two rect layers into one merged layer with the base style', () => {
    const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
    defaultSceneGraph.addChild(rootId, rect('mp_a', 100, 100, 40, 40));
    defaultSceneGraph.addChild(rootId, rect('mp_b', 120, 100, 40, 40));
    useSelectionStore.getState().set(['mp_a', 'mp_b']);

    const ids = mergeSelectedPaths('union');
    expect(ids).toHaveLength(1);
    expect(defaultSceneGraph.getNode('mp_a')).toBeFalsy();
    expect(defaultSceneGraph.getNode('mp_b')).toBeFalsy();
    const merged = defaultSceneGraph.getNode(ids[0]!)!;
    expect(merged).toBeTruthy();
    const style = merged.components.find((c) => c.type === 'Style');
    expect(style?.props.fill).toBe('#ff0000');
    const geom = merged.components.find((c) => c.type === 'Geometry');
    expect(Array.isArray(geom?.props.points)).toBe(true);
    defaultSceneGraph.removeNode(ids[0]!);
    useSelectionStore.getState().clear();
  });

  it('is a no-op with fewer than two mergeable layers', () => {
    const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
    defaultSceneGraph.addChild(rootId, rect('mp_c', 0, 0, 10, 10));
    useSelectionStore.getState().set(['mp_c']);
    expect(mergeSelectedPaths('union')).toHaveLength(0);
    expect(defaultSceneGraph.getNode('mp_c')).toBeTruthy();
    defaultSceneGraph.removeNode('mp_c');
    useSelectionStore.getState().clear();
  });
});
