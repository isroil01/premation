/**
 * Create Nulls From Paths — a null on every vertex, following the layer.
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { world2DAt } from '@core/scene/layerSpace';
import { Matrix } from '@motion/scene';
import type { SceneNode } from '@core/types';
import { createNullsFromPath, pathVertices } from './nullsFromPaths';

function triangle(id: string, x: number, y: number, rotation = 0): SceneNode {
  return {
    id, name: 'Tri', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x, y }, rotation, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y, rotation, shapeType: 'path' } },
      { id: `${id}_g`, type: 'Geometry', props: { points: [
        { x: 0, y: -50, inX: 0, inY: -50, outX: 0, outY: -50 },
        { x: 50, y: 50, inX: 50, inY: 50, outX: 50, outY: 50 },
        { x: -50, y: 50, inX: -50, inY: 50, outX: -50, outY: 50 },
      ] } },
    ],
  };
}

beforeEach(() => {
  (defaultSceneGraph as unknown as SceneGraph).clear();
  defaultAnimation.clear();
});

it('reads the vertices, not a flattened outline', () => {
  defaultSceneGraph.addNode(triangle('t', 0, 0));
  expect(pathVertices(defaultSceneGraph.getNode('t')!, 0)).toHaveLength(3);
});

it('lands one null per vertex at its world position, parented to the shape', () => {
  defaultSceneGraph.addNode(triangle('t', 300, 200, 90));
  const ids = createNullsFromPath('t', 0);
  expect(ids).toHaveLength(3);
  for (const id of ids) expect(defaultSceneGraph.getNode(id)?.parent).toBe('t');
  // The first vertex (0,-50) rotated 90° about the layer → world (350, 200).
  const w = Matrix.transformPoint(world2DAt(ids[0]!, 0), { x: 0, y: 0 });
  expect(w.x).toBeCloseTo(350, 3);
  expect(w.y).toBeCloseTo(200, 3);
});

it('does nothing for a non-shape or a primitive with no vertices', () => {
  defaultSceneGraph.addNode({ ...triangle('r', 0, 0), components: [
    { id: 'r_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, shapeType: 'rect', width: 10, height: 10 } },
  ] });
  expect(createNullsFromPath('r', 0)).toEqual([]);
});

describe('points follow nulls', () => {
  it('records a binding per vertex, and the snapshot moves the vertex to the null', async () => {
    defaultSceneGraph.addNode(triangle('t', 300, 200));
    const ids = createNullsFromPath('t', 0, { pointsFollowNulls: true });
    const geom = defaultSceneGraph.getNode('t')!.components.find((c) => c.type === 'Geometry')!;
    expect(geom.props.pointBindings).toEqual(ids.map((nullId, index) => ({ index, nullId })));

    // Drag the first null 40 px right in its local (= shape-local) space.
    const first = defaultSceneGraph.getNode(ids[0]!)!;
    const tc = first.components.find((c) => c.type === 'Transform')!;
    defaultSceneGraph.writeProp(ids[0]!, tc.id, 'x', 40);

    const { buildSnapshot } = await import('@core/rendering/buildSnapshot');
    const snap = buildSnapshot(defaultSceneGraph, defaultAnimation, 0);
    const layer = snap.layers.find((l) => l.id === 't')!;
    expect(layer.pathPoints?.[0]?.x).toBeCloseTo(40, 3);
    expect(layer.pathPoints?.[0]?.y).toBeCloseTo(-50, 3);
    // Unbound-moved vertices stay put.
    expect(layer.pathPoints?.[1]?.x).toBeCloseTo(50, 3);
  });
});
