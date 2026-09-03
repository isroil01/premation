/**
 * Skinned models — the three places a skin silently goes wrong:
 *
 *  • the inverse-bind conjugation (a skin that explodes on import because its
 *    binds stayed in glTF space while the joints moved to compositor space),
 *  • the weighted vertex blend itself,
 *  • the end-to-end pose path through buildSnapshot: joints are ordinary null
 *    layers, so MOVING one must carry its bound vertices, the bind pose must
 *    be byte-identical to the rigid mesh, and a broken skeleton (joint layer
 *    deleted) must fall back to the rigid bind pose rather than half-deform.
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from './SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import {
  registerModel,
  clearModelRegistry,
  modelKeyForBytes,
  modelSkinFor,
  modelPrimitiveFor,
  conjugateGltfMatrix,
  MODEL_COMPONENT,
} from './modelMesh';
import { skinVertices, clearSkinnedMemo } from './modelSkinning';
import { buildSkinnedBarGlb } from '@/__testHelpers__/buildTestGlb';

const COMP = { width: 800, height: 600, background: '#101014' };

describe('conjugateGltfMatrix', () => {
  it('flips translation y/z and leaves x/w alone', () => {
    const t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1];
    expect(conjugateGltfMatrix(t)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, -4, -5, 1]);
  });

  it('turns a glTF z-rotation into the opposite compositor z-rotation', () => {
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    // Rz(30°), column-major.
    const rz = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const out = conjugateGltfMatrix(rz);
    expect(out[0]).toBeCloseTo(c);
    expect(out[1]).toBeCloseTo(-s); // sign flipped → Rz(−30°)
    expect(out[4]).toBeCloseTo(s);
    expect(out[5]).toBeCloseTo(c);
  });
});

describe('registerModel — skins', () => {
  afterEach(() => clearModelRegistry());

  it('registers the skin with conjugated inverse binds and per-vertex attributes', () => {
    const glb = buildSkinnedBarGlb();
    const key = modelKeyForBytes(new Uint8Array(glb));
    registerModel(key, glb);
    const skin = modelSkinFor(key, 0)!;
    expect(skin.joints).toEqual([1, 2]);
    // Joint 1's bind T(0,−1,0) conjugates to T(0,+1,0) in compositor space.
    expect(skin.invBind[16 + 13]).toBe(1);
    const entry = modelPrimitiveFor({ modelKey: key, mesh: 0, prim: 0 })!;
    expect(entry.skinData).not.toBeNull();
    expect(Array.from(entry.skinData!.joints.slice(8, 12))).toEqual([1, 0, 0, 0]);
    expect(entry.skinData!.weights[8]).toBe(1);
  });
});

describe('skinVertices', () => {
  it('blends positions by joint weights and renormalizes normals', () => {
    // One vertex at (0,1,0), normal +x, weighted half/half across two joints:
    // identity and T(10,0,0). Expect the midpoint (5,1,0), normal unchanged.
    const src = new Float32Array([0, 1, 0, 1, 0, 0, 0.5, 0.5]);
    const mats = new Float32Array(32);
    mats.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
    mats.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1], 16);
    const out = skinVertices(
      src,
      { joints: new Uint16Array([0, 1, 0, 0]), weights: new Float32Array([0.5, 0.5, 0, 0]) },
      mats,
    );
    expect(Array.from(out.slice(0, 3))).toEqual([5, 1, 0]);
    expect(Array.from(out.slice(3, 6))).toEqual([1, 0, 0]);
    expect(Array.from(out.slice(6, 8))).toEqual([0.5, 0.5]);
  });
});

// ── End to end: the pose path through buildSnapshot ─────────────────────────

const layer = (
  id: string,
  kind: 'null' | 'shape',
  props: Record<string, unknown>,
  modelProps?: Record<string, unknown>,
): SceneNode => ({
  id, name: id, parent: null, children: [], visible: true, locked: false,
  transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
  components: [
    {
      id: `${id}_t`,
      type: 'Transform',
      props: {
        [SCENE_KIND_PROP]: kind,
        x: 0, y: 0, z: 0, rotation: 0, scaleX: 1, scaleY: 1,
        anchorX: 0, anchorY: 0, width: 2, height: 2,
        ...props,
      },
    },
    { id: `${id}_s`, type: 'Style', props: { opacity: 100 } },
    ...(modelProps ? [{ id: `${id}_model`, type: MODEL_COMPONENT, props: modelProps }] : []),
  ],
} as unknown as SceneNode);

/** Bar scene: root(source) → { joint0 → joint1, mesh }. Tip joint at `tipY`. */
function skinnedScene(key: string, tipY: number, opts: { dropJoints?: boolean } = {}): SceneGraph {
  const g = new SceneGraph();
  const root = layer('root', 'null', {}, { modelKey: key, glbData: 'data:model/gltf-binary;base64,' });
  g.addNode(root);
  const j0 = layer('j0', 'null', {}, opts.dropJoints ? undefined : { modelKey: key, gltfNode: 1 });
  const j1 = layer('j1', 'null', { y: tipY }, opts.dropJoints ? undefined : { modelKey: key, gltfNode: 2 });
  const mesh = layer('meshL', 'shape', {}, { modelKey: key, mesh: 0, prim: 0, skin: 0 });
  g.addChild('root', j0);
  g.addChild('j0', j1);
  g.addChild('root', mesh);
  return g;
}

describe('buildSnapshot — skinned pose', () => {
  afterEach(() => {
    clearModelRegistry();
    clearSkinnedMemo();
  });

  const snap = (g: SceneGraph) =>
    buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);

  it('at bind pose the skinned vertices equal the rigid mesh', () => {
    const glb = buildSkinnedBarGlb();
    const key = modelKeyForBytes(new Uint8Array(glb));
    registerModel(key, glb);
    // Bind: glTF tip at y=1 → compositor y=−1.
    const s = snap(skinnedScene(key, -1));
    const mesh = s.layers.find((l) => l.id.startsWith('meshL'))!.extrudedMesh!;
    expect(mesh.key.startsWith(`${key}:m0p0:sk-`)).toBe(true);
    const rigid = modelPrimitiveFor({ modelKey: key, mesh: 0, prim: 0 })!.vertices;
    for (let i = 0; i < rigid.length; i++) {
      expect(mesh.vertices[i]!).toBeCloseTo(rigid[i]!, 4);
    }
  });

  it('moving the tip joint layer carries its bound vertices and no others', () => {
    const glb = buildSkinnedBarGlb();
    const key = modelKeyForBytes(new Uint8Array(glb));
    registerModel(key, glb);
    // Tip dragged from bind −1 to +4: its skin matrix becomes T(0,+5,0).
    const s = snap(skinnedScene(key, 4));
    const mesh = s.layers.find((l) => l.id.startsWith('meshL'))!.extrudedMesh!;
    // Bottom pair (joint 0, unmoved): converted positions (±0.1, 0, 0).
    expect(mesh.vertices[0]).toBeCloseTo(-0.1, 4);
    expect(mesh.vertices[1]).toBeCloseTo(0, 4);
    // Top pair (joint 1): converted bind (±0.1, −2, 0) carried +5 → y=3.
    expect(mesh.vertices[2 * 8 + 1]).toBeCloseTo(3, 4);
    expect(mesh.vertices[3 * 8 + 1]).toBeCloseTo(3, 4);
    expect(mesh.vertices[3 * 8]).toBeCloseTo(0.1, 4);
  });

  it('a deleted joint layer falls back to the rigid bind pose', () => {
    const glb = buildSkinnedBarGlb();
    const key = modelKeyForBytes(new Uint8Array(glb));
    registerModel(key, glb);
    const s = snap(skinnedScene(key, 4, { dropJoints: true }));
    const mesh = s.layers.find((l) => l.id.startsWith('meshL'))!.extrudedMesh!;
    expect(mesh.key).toBe(`${key}:m0p0`);
  });
});
