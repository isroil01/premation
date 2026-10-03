/**
 * Create Nulls From Paths — a null on every vertex, following the layer. The
 * builder halves; the engine edit (one entry, nested under the shape, Points
 * Follow Nulls' bindings) is layout/Scene/layerCreateEdits.test.ts.
 */

import { FragmentBuilder } from '@/engine-client/fragmentBuilder';
import { buildNullsFromPath, pathValueVertices } from './nullsFromPaths';

it('reads the vertices of a Path value, not a flattened outline', () => {
  const v = pathValueVertices({
    kind: 'path',
    value: { vertices: [0, -50, 50, 50, -50, 50], inTangents: [0, 0, 0, 0, 0, 0], outTangents: [0, 0, 0, 0, 0, 0], closed: true, featherPoints: [] },
  } as never);
  expect(v).toEqual([{ x: 0, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }]);
  expect(pathValueVertices({ kind: 'scalar', value: 1 })).toEqual([]);
  expect(pathValueVertices(undefined)).toEqual([]);
});

it('lays one null per vertex at the vertex (layer space), in vertex order', () => {
  const b = new FragmentBuilder();
  const ids = buildNullsFromPath(b, 'Tri', [{ x: 0, y: -50 }, { x: 50, y: 50 }]);
  expect(ids).toHaveLength(2);
  expect(b.row(ids[0]!).name).toBe('Tri · Point 1');
  expect(b.component(ids[1]!, 'Transform')!.props).toMatchObject({ __kind: 'null', x: 50, y: 50 });
  // Top level in the fragment: the paste nests them under the shape.
  expect(b.build()!.tops.sort()).toEqual([...ids].sort());
});
