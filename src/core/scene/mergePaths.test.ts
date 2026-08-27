/**
 * Merge Paths — boolean ops across shape layers (polygon-clipping backed).
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import {
  flattenOutline,
  nodeWorldPolygon,
  booleanPolygons,
  mergeSelectedPaths,
  liveMergeSelectedPaths,
  readLiveBoolean,
  isBooleanOperand,
  evaluateLiveBoolean,
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
  beforeAll(() => {
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  });

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

  it('subtracts a contained rect as a hole (one layer, two subpaths), not two fills', () => {
    const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
    defaultSceneGraph.addChild(rootId, rect('mp_outer', 100, 100, 80, 80));
    defaultSceneGraph.addChild(rootId, rect('mp_inner', 100, 100, 30, 30));
    useSelectionStore.getState().set(['mp_outer', 'mp_inner']);

    const ids = mergeSelectedPaths('subtract');
    expect(ids).toHaveLength(1);
    const merged = defaultSceneGraph.getNode(ids[0]!)!;
    const geom = merged.components.find((c) => c.type === 'Geometry');
    const runs = geom?.props.subpaths as Array<{ points: unknown[]; open?: boolean }> | undefined;
    expect(runs).toHaveLength(2);
    expect(runs![0]!.open).toBe(false);
    expect(runs![1]!.open).toBe(false);
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

describe('liveMergeSelectedPaths', () => {
  beforeAll(() => {
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  });

  it('keeps sources as hidden operands and wires a live boolean result', () => {
    const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
    defaultSceneGraph.addChild(rootId, rect('lm_a', 100, 100, 40, 40));
    defaultSceneGraph.addChild(rootId, rect('lm_b', 120, 100, 40, 40));
    useSelectionStore.getState().set(['lm_a', 'lm_b']);

    const ids = liveMergeSelectedPaths('union');
    expect(ids).toHaveLength(1);
    const a = defaultSceneGraph.getNode('lm_a')!;
    const b = defaultSceneGraph.getNode('lm_b')!;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(isBooleanOperand(a)).toBe(true);
    expect(isBooleanOperand(b)).toBe(true);
    expect(a.visible).toBe(false);
    expect(b.visible).toBe(false);

    const result = defaultSceneGraph.getNode(ids[0]!)!;
    const live = readLiveBoolean(result);
    expect(live).toEqual({ op: 'union', sources: ['lm_a', 'lm_b'] });

    const ev = evaluateLiveBoolean(
      result,
      (id) => defaultSceneGraph.getNode(id),
      () => undefined,
      () => undefined,
    );
    expect(ev).not.toBeNull();
    expect(ev!.points.length).toBeGreaterThanOrEqual(3);
    expect(ev!.width).toBeGreaterThan(40);

    defaultSceneGraph.removeNode(ids[0]!);
    defaultSceneGraph.removeNode('lm_a');
    defaultSceneGraph.removeNode('lm_b');
    useSelectionStore.getState().clear();
  });

  it('keeps a subtract hole as a second closed subpath', () => {
    const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
    defaultSceneGraph.addChild(rootId, rect('lm_outer', 100, 100, 80, 80));
    defaultSceneGraph.addChild(rootId, rect('lm_inner', 100, 100, 24, 24));
    useSelectionStore.getState().set(['lm_outer', 'lm_inner']);
    const [id] = liveMergeSelectedPaths('subtract');
    const result = defaultSceneGraph.getNode(id!)!;
    const ev = evaluateLiveBoolean(
      result,
      (nid) => defaultSceneGraph.getNode(nid),
      () => undefined,
      () => undefined,
    );
    expect(ev?.subpaths).toHaveLength(2);
    defaultSceneGraph.removeNode(id!);
    defaultSceneGraph.removeNode('lm_outer');
    defaultSceneGraph.removeNode('lm_inner');
    useSelectionStore.getState().clear();
  });

  it('re-evaluates when an operand moves (animated-style sample)', () => {
    const rootId = defaultSceneGraph.getRoots()[0]?.id ?? 'comp_root';
    defaultSceneGraph.addChild(rootId, rect('lm_c', 100, 100, 40, 40));
    defaultSceneGraph.addChild(rootId, rect('lm_d', 120, 100, 40, 40));
    useSelectionStore.getState().set(['lm_c', 'lm_d']);
    const [id] = liveMergeSelectedPaths('intersect');
    const result = defaultSceneGraph.getNode(id!)!;

    const atRest = evaluateLiveBoolean(
      result,
      (nid) => defaultSceneGraph.getNode(nid),
      () => undefined,
      () => undefined,
    )!;
    const moved = evaluateLiveBoolean(
      result,
      (nid) => defaultSceneGraph.getNode(nid),
      (nid) => (prop) => {
        if (nid === 'lm_d' && prop === 'x') return 200; // pull B far away → no overlap
        return undefined;
      },
      () => undefined,
    );
    expect(atRest.width).toBeGreaterThan(0);
    // No intersection when B is moved away.
    expect(moved).toBeNull();

    defaultSceneGraph.removeNode(id!);
    defaultSceneGraph.removeNode('lm_c');
    defaultSceneGraph.removeNode('lm_d');
    useSelectionStore.getState().clear();
  });
});
