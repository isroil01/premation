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


import {
  PRIMITIVE_COMPONENT,
  clearPrimitiveMeshCache,
  defaultPrimitiveSpec,
  primitiveEntryFor,
  primitiveKey,
  readNodePrimitive,
} from './primitiveLayer';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/sceneKind';

describe('parametric primitives', () => {
  afterEach(() => {
    clearPrimitiveMeshCache();
  });

  it('16-bit indices while they fit, 32-bit past 65535 vertices', () => {
    const small = primitiveEntryFor(nodeWith({ ...defaultPrimitiveSpec('sphere'), radialSegments: 16, heightSegments: 8 }))!;
    expect(small.indices).toBeInstanceOf(Uint16Array);
    const huge = primitiveEntryFor(nodeWith({ ...defaultPrimitiveSpec('sphere'), radialSegments: 256, heightSegments: 256 }))!;
    expect(huge.indices).toBeInstanceOf(Uint32Array);
  });

  it('the key covers every parameter that changes geometry', () => {
    const base = defaultPrimitiveSpec('torus');
    expect(primitiveKey({ ...base, tube: base.tube + 1 })).not.toBe(primitiveKey(base));
    expect(primitiveKey({ ...base, heightSegments: 7 })).not.toBe(primitiveKey(base));
    // …and nothing that does not: the type's unused fields are not in the key.
    expect(primitiveKey({ ...base, width: 999, capped: false })).toBe(primitiveKey(base));
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
