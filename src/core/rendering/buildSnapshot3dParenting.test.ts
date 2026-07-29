/**
 * 3D parenting — a child inherits its parent's FULL 3D transform.
 *
 * `worldTransformOf` composes parent chains as 2×3 affines (x / y / rotation /
 * scaleX / scaleY), so on its own a child inherited none of its parent's `z`,
 * `rotationX` or `rotationY`: a 3D null dollying away in Z left its children
 * exactly where they were, which is the opposite of what parenting is for.
 *
 * The rules pinned here:
 *   • 3D child of a 3D parent  → full 4×4 chain (position, depth, 3D rotation).
 *   • 3D child of a 2D parent  → the parent's transform is FLATTENED to 2D
 *                                first (AE's rule), i.e. exactly the old
 *                                behaviour, since a 2D parent has no depth.
 *   • no 3D ancestor           → byte-identical to the pre-existing 2D path.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { Matrix4Math } from '@motion/scene';

const COMP = { width: 800, height: 600, background: '#101014' };

function node(
  id: string,
  kind: string,
  props: Record<string, unknown>,
  parent: string | null = null,
): SceneNode {
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, rotation: 0, width: 100, height: 100, ...props } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

/** A 3D layer: numeric z / rotationX / rotationY are what is3DEnabled tests. */
const three = (p: Record<string, unknown> = {}) => ({ z: 0, rotationX: 0, rotationY: 0, ...p });

function snap(nodes: SceneNode[]) {
  const g = new SceneGraph();
  // `addChild` — not `addNode` with a `parent` field — is what links the tree.
  // A bare parent id leaves the parent's child list empty, so flattenScene
  // never reaches the child and it is silently absent from the snapshot.
  for (const n of nodes) {
    if (n.parent) g.addChild(n.parent, n);
    else g.addNode(n);
  }
  return buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP as never);
}

const byId = (s: ReturnType<typeof snap>, id: string) => s.layers.find((l) => l.id === id);
/** Where the layer's own origin lands in world space. */
const originOf = (s: ReturnType<typeof snap>, id: string) =>
  Matrix4Math.transformPoint(byId(s, id)!.world3d as never, { x: 0, y: 0, z: 0 });

describe('a 3D null can exist at all', () => {
  it('a null layer accepts the 3D switch', async () => {
    const { canBe3D } = await import('@core/scene/threeD');
    expect(canBe3D(node('n', 'null', three()))).toBe(true);
    // …and the kinds that never participate still do not.
    expect(canBe3D(node('c', 'camera', three()))).toBe(false);
    expect(canBe3D(node('g', 'group', three()))).toBe(false);
  });
});

describe('3D child of a 3D parent', () => {
  it("inherits the parent's DEPTH — the bug that made 3D nulls useless", () => {
    const flat = snap([
      node('rig', 'null', { x: 400, y: 300, ...three({ z: 0 }) }),
      node('kid', 'shape', { x: 50, y: 0, ...three() }, 'rig'),
    ]);
    const deep = snap([
      node('rig', 'null', { x: 400, y: 300, ...three({ z: 500 }) }),
      node('kid', 'shape', { x: 50, y: 0, ...three() }, 'rig'),
    ]);
    expect(originOf(flat, 'kid').z).toBeCloseTo(0, 6);
    expect(originOf(deep, 'kid').z).toBeCloseTo(500, 6);
  });

  it("inherits the parent's 3D ROTATION, swinging the child through depth", () => {
    const s = snap([
      node('rig', 'null', { x: 400, y: 300, ...three({ rotationY: 90 }) }),
      node('kid', 'shape', { x: 100, y: 0, ...three() }, 'rig'),
    ]);
    // The child sits 100px along the parent's local +X. Rotated 90° about Y,
    // that axis now points along −Z, so the offset has moved into depth.
    const o = originOf(s, 'kid');
    expect(o.x).toBeCloseTo(400, 4);
    expect(Math.abs(o.z)).toBeCloseTo(100, 4);
  });

  it("inherits the parent's position and scale as before", () => {
    const s = snap([
      node('rig', 'null', { x: 300, y: 200, scaleX: 2, scaleY: 2, ...three() }),
      node('kid', 'shape', { x: 50, y: 25, ...three() }, 'rig'),
    ]);
    const o = originOf(s, 'kid');
    expect(o.x).toBeCloseTo(300 + 50 * 2, 4);
    expect(o.y).toBeCloseTo(200 + 25 * 2, 4);
  });

  it('composes through a THREE-deep chain', () => {
    const s = snap([
      node('a', 'null', { x: 100, y: 100, ...three({ z: 100 }) }),
      node('b', 'null', { x: 50, y: 0, ...three({ z: 200 }) }, 'a'),
      node('c', 'shape', { x: 25, y: 0, ...three({ z: 300 }) }, 'b'),
    ]);
    const o = originOf(s, 'c');
    expect(o.x).toBeCloseTo(175, 4);
    expect(o.y).toBeCloseTo(100, 4);
    expect(o.z).toBeCloseTo(600, 4);
  });

  it('a moving parent moves the child (the whole point of a rig)', () => {
    const at = (z: number) =>
      originOf(
        snap([
          node('rig', 'null', { x: 400, y: 300, ...three({ z }) }),
          node('kid', 'shape', { x: 0, y: 0, ...three() }, 'rig'),
        ]),
        'kid',
      ).z;
    expect(at(0)).toBeCloseTo(0, 6);
    expect(at(-250)).toBeCloseTo(-250, 6);
    expect(at(900)).toBeCloseTo(900, 6);
  });
});

describe('3D child of a 2D parent — the parent flattens first (AE rule)', () => {
  it("inherits the 2D parent's x/y and nothing else, as before", () => {
    const s = snap([
      // No z / rotationX / rotationY ⇒ a 2D layer.
      node('flatRig', 'null', { x: 300, y: 200 }),
      node('kid', 'shape', { x: 50, y: 25, ...three({ z: 400 }) }, 'flatRig'),
    ]);
    const o = originOf(s, 'kid');
    expect(o.x).toBeCloseTo(350, 4);
    expect(o.y).toBeCloseTo(225, 4);
    // The child keeps its OWN depth; a 2D parent has none to give.
    expect(o.z).toBeCloseTo(400, 4);
  });

  it('a 3D grandparent still reaches through a 2D parent below it', () => {
    // The 2D layer's WORLD affine already subsumes the 3D grandparent's x/y,
    // so it must REPLACE the accumulated chain rather than multiply into it —
    // otherwise the grandparent is applied twice.
    const s = snap([
      node('deepRig', 'null', { x: 200, y: 100, ...three({ z: 500 }) }),
      node('flatMid', 'null', { x: 50, y: 0 }, 'deepRig'),
      node('kid', 'shape', { x: 10, y: 0, ...three() }, 'flatMid'),
    ]);
    const o = originOf(s, 'kid');
    expect(o.x).toBeCloseTo(260, 4); // 200 + 50 + 10, applied ONCE
    expect(o.y).toBeCloseTo(100, 4);
  });
});

describe('regression — nothing without a 3D ancestor moves', () => {
  it('an unparented 3D layer is unchanged', () => {
    const s = snap([node('solo', 'shape', { x: 250, y: 175, ...three({ z: 120 }) })]);
    const o = originOf(s, 'solo');
    expect(o).toEqual({ x: 250, y: 175, z: 120 });
  });

  it('a 2D child of a 2D parent still composes through the 2D path', () => {
    const s = snap([
      node('p', 'null', { x: 100, y: 100 }),
      node('c', 'shape', { x: 40, y: 20 }, 'p'),
    ]);
    const l = byId(s, 'c')!;
    expect(l.world3d).toBeUndefined(); // 2D draw path untouched
    expect(l.x).toBeCloseTo(140, 4);
    expect(l.y).toBeCloseTo(120, 4);
  });

  it('a 2D child of a 3D parent stays on the 2D path (no depth to inherit)', () => {
    const s = snap([
      node('rig', 'null', { x: 100, y: 100, ...three({ z: 700 }) }),
      node('c', 'shape', { x: 40, y: 20 }, 'rig'),
    ]);
    const l = byId(s, 'c')!;
    expect(l.world3d).toBeUndefined();
    expect(l.x).toBeCloseTo(140, 4);
  });

  it('a parent cycle does not hang the renderer', () => {
    const a = node('a', 'null', { x: 10, y: 10, ...three() }, 'b');
    const b = node('b', 'null', { x: 20, y: 20, ...three() }, 'a');
    expect(() => snap([a, b])).not.toThrow();
  });
});
