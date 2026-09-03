/**
 * A parametric primitive is a MESH LAYER, and an old one is not.
 *
 * Two contracts live here. The first is that a `Primitive` component resolves
 * to a renderer-ready entry in exactly the shape an imported glTF primitive
 * produces — that is the whole reason a sphere depth-sorts, lights and takes
 * Material Options without a line of new renderer code, and it is invisible
 * until it breaks. The second is that layers created BEFORE this existed —
 * the extruded-ellipse "sphere" that was really a capsule — keep resolving
 * through the extrusion path, because a document that opens differently than
 * it was saved is worse than a document that opens looking dated.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { insert3DPrimitive } from './sceneInsert';
import {
  PRIMITIVE_COMPONENT,
  clearPrimitiveMeshCache,
  defaultPrimitiveSpec,
  isPrimitiveMeshNode,
  primitiveEntryFor,
  primitiveKey,
  readNodePrimitive,
  setPrimitiveParam,
  setPrimitiveType,
} from './primitiveLayer';
import { MESH_VERTEX_FLOATS } from '@core/geometry/extrudeMesh';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import { useSelectionStore } from '@stores/selectionStore';
import type { SceneNode } from '@core/types';

/** The id of the layer the last insert selected. */
function lastInsertedId(): string {
  const id = useSelectionStore.getState().ids[0];
  expect(typeof id).toBe('string');
  return id!;
}

const transformProps = (id: string): Record<string, unknown> =>
  (defaultSceneGraph.getNode(id)?.components.find((c) => c.type === 'Transform')?.props ?? {}) as Record<string, unknown>;

describe('parametric primitives', () => {
  const added: string[] = [];
  afterEach(() => {
    for (const id of added.splice(0)) {
      try { defaultSceneGraph.removeNode(id); } catch { /* already gone */ }
    }
    clearPrimitiveMeshCache();
  });

  it('inserts a sphere as a mesh layer, not an extruded ellipse', () => {
    insert3DPrimitive('sphere');
    const id = lastInsertedId();
    added.push(id);
    const node = defaultSceneGraph.getNode(id)!;

    expect(isPrimitiveMeshNode(node)).toBe(true);
    expect(readNodePrimitive(node)?.type).toBe('sphere');
    // The two props that MADE it a capsule are gone — an extruded ellipse and
    // a sphere mesh would otherwise both draw, one inside the other.
    const t = transformProps(id);
    expect(t.shapeType).toBeUndefined();
    expect(t.extrusionDepth).toBeUndefined();
    // …and the legacy marker still says what the layer is.
    expect(t.primitiveType).toBe('sphere');
    // 3D, lit, shadow-casting out of the box (the depth props are what
    // is3DEnabled tests for).
    expect(t.z).toBe(0);
    expect(t.acceptsLights).toBe(true);
  });

  it('resolves to an entry the imported-model carrier accepts', () => {
    insert3DPrimitive('torus');
    const id = lastInsertedId();
    added.push(id);
    const entry = primitiveEntryFor(defaultSceneGraph.getNode(id)!, '#ff8800ff');
    expect(entry).not.toBeNull();
    // Interleaved 8-float vertices, indices in range, no skin/morph state.
    expect(entry!.vertices.length % MESH_VERTEX_FLOATS).toBe(0);
    const vcount = entry!.vertices.length / MESH_VERTEX_FLOATS;
    expect(vcount).toBeGreaterThan(0);
    for (let i = 0; i < entry!.indices.length; i++) expect(entry!.indices[i]!).toBeLessThan(vcount);
    expect(entry!.skinData).toBeNull();
    expect(entry!.morphTargets).toEqual([]);
    expect(entry!.textureUrl).toBeNull();
    // The colour comes from the LAYER, so the colour picker drives it.
    expect(entry!.fill).toBe('#ff8800ff');
  });

  it('16-bit indices while they fit, 32-bit past 65535 vertices', () => {
    const small = primitiveEntryFor(nodeWith({ ...defaultPrimitiveSpec('sphere'), radialSegments: 16, heightSegments: 8 }))!;
    expect(small.indices).toBeInstanceOf(Uint16Array);
    const huge = primitiveEntryFor(nodeWith({ ...defaultPrimitiveSpec('sphere'), radialSegments: 256, heightSegments: 256 }))!;
    expect(huge.indices).toBeInstanceOf(Uint32Array);
  });

  it('re-generates on a parameter change, and the buffer key moves with it', () => {
    insert3DPrimitive('cylinder');
    const id = lastInsertedId();
    added.push(id);
    const before = primitiveEntryFor(defaultSceneGraph.getNode(id)!)!;

    setPrimitiveParam(id, 'radialSegments', 12);
    const after = primitiveEntryFor(defaultSceneGraph.getNode(id)!)!;
    expect(readNodePrimitive(defaultSceneGraph.getNode(id)!)?.radialSegments).toBe(12);
    expect(after.key).not.toBe(before.key);
    expect(after.vertices.length).toBeLessThan(before.vertices.length);

    // Nothing changed → the SAME key, so the GPU buffers are not re-uploaded.
    const again = primitiveEntryFor(defaultSceneGraph.getNode(id)!)!;
    expect(again.key).toBe(after.key);
    expect(again.vertices).toBe(after.vertices);
  });

  it('switching type keeps shared parameters and re-fits the layer box', () => {
    insert3DPrimitive('sphere', { radius: 90 });
    const id = lastInsertedId();
    added.push(id);
    expect(Number(transformProps(id).width)).toBe(180);

    setPrimitiveType(id, 'capsule');
    const spec = readNodePrimitive(defaultSceneGraph.getNode(id)!)!;
    expect(spec.type).toBe('capsule');
    expect(spec.radius).toBe(90);
    expect(transformProps(id).primitiveType).toBe('capsule');
    // A capsule of radius 90 and the sphere's default total height is at
    // least as tall as it is wide — the box follows the mesh, not the old shape.
    expect(Number(transformProps(id).height)).toBeGreaterThanOrEqual(180);
  });

  it('the key covers every parameter that changes geometry', () => {
    const base = defaultPrimitiveSpec('torus');
    expect(primitiveKey({ ...base, tube: base.tube + 1 })).not.toBe(primitiveKey(base));
    expect(primitiveKey({ ...base, heightSegments: 7 })).not.toBe(primitiveKey(base));
    // …and nothing that does not: the type's unused fields are not in the key.
    expect(primitiveKey({ ...base, width: 999, capped: false })).toBe(primitiveKey(base));
  });

  it('cube and plane stay on the paths that already served them', () => {
    insert3DPrimitive('cube');
    const cube = lastInsertedId();
    added.push(cube);
    expect(isPrimitiveMeshNode(defaultSceneGraph.getNode(cube)!)).toBe(false);
    // An extruded square IS a real box — with bevels a box mesh cannot offer.
    expect(transformProps(cube).extrusionDepth).toBe(240);

    insert3DPrimitive('plane');
    const plane = lastInsertedId();
    added.push(plane);
    expect(isPrimitiveMeshNode(defaultSceneGraph.getNode(plane)!)).toBe(false);
    expect(transformProps(plane).extrusionDepth).toBeUndefined();
  });

  it('an old capsule-sphere document stays exactly what it was', () => {
    // What insert3DPrimitive('sphere') used to write: an ellipse profile swept
    // 240px along z. No Primitive component, so nothing here claims it.
    const legacy: SceneNode = {
      id: 'legacy_sphere_1', name: '3D Sphere', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{
        id: 'legacy_sphere_1_t', type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape', x: 100, y: 100, z: 0, rotationX: 0, rotationY: 0,
          width: 240, height: 240, primitiveType: 'sphere', shapeType: 'ellipse', extrusionDepth: 240,
        },
      }],
    } as unknown as SceneNode;
    defaultSceneGraph.addNode(legacy);
    added.push(legacy.id);

    expect(isPrimitiveMeshNode(legacy)).toBe(false);
    expect(readNodePrimitive(legacy)).toBeNull();
    expect(primitiveEntryFor(legacy)).toBeNull();
    // `primitiveType` alone must NOT be enough: it was written for years by a
    // build that meant nothing by it.
    expect(transformProps(legacy.id).shapeType).toBe('ellipse');
  });

  it('a component with only a type still resolves to a whole spec', () => {
    const node = nodeWith({ type: 'cone' } as never);
    const spec = readNodePrimitive(node)!;
    expect(spec).toEqual(defaultPrimitiveSpec('cone'));
  });

  it('refuses a component whose type is not a shape', () => {
    expect(readNodePrimitive(nodeWith({ type: 'dodecahedron' } as never))).toBeNull();
  });
});

/** A detached node carrying `props` on a Primitive component (no graph). */
function nodeWith(props: Record<string, unknown>): SceneNode {
  return {
    id: 'detached_prim', name: 'p', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: 'detached_prim_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape' } },
      { id: 'detached_prim_prim', type: PRIMITIVE_COMPONENT, props },
    ],
  } as unknown as SceneNode;
}
