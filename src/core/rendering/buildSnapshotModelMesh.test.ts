/**
 * Imported models in the snapshot: a 3D layer carrying a Model component must
 * emit the `extrudedMesh` carrier INSTEAD of its quad (the renderer draws the
 * mesh through the same depth-grouped path as extrusions), and fall back to
 * the plain quad — a visible placeholder — while the registry has not parsed
 * the model yet (project just opened, hydration in flight).
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { registerModel, clearModelRegistry, modelKeyForBytes, MODEL_COMPONENT } from '@core/scene/modelMesh';
import { buildQuadGlb } from '@/__testHelpers__/buildTestGlb';

const COMP = { width: 800, height: 600, background: '#101014' };

function modelLayer(id: string, modelKey: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'shape', x: 400, y: 300, z: 0, rotation: 0, scaleX: 1, scaleY: 1, width: 2, height: 2 },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ff0000ff' } },
      { id: `${id}_model`, type: MODEL_COMPONENT, props: { modelKey, mesh: 0, prim: 0 } },
    ],
  } as unknown as SceneNode;
}

describe('buildSnapshot — imported model meshes', () => {
  afterEach(() => clearModelRegistry());

  it('emits the mesh carrier in place of the quad once the model is registered', () => {
    const glb = buildQuadGlb();
    const key = modelKeyForBytes(new Uint8Array(glb));
    registerModel(key, glb);

    const g = new SceneGraph();
    g.addNode(modelLayer('m1', key));
    const snap = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);

    const emitted = snap.layers.filter((l) => l.id.startsWith('m1'));
    expect(emitted).toHaveLength(1);
    const mesh = emitted[0]!.extrudedMesh;
    expect(mesh).toBeDefined();
    expect(mesh!.key).toBe(`${key}:m0p0`);
    expect(mesh!.vertices).toHaveLength(4 * 8);
    expect(mesh!.indices).toHaveLength(6);
    expect(mesh!.ranges).toHaveLength(1);
    // doubleSided material → role 'front' (two-sided lighting downstream);
    // untextured → the material's base colour as the range fill.
    expect(mesh!.ranges[0]).toMatchObject({ role: 'front', first: 0, count: 6, fill: '#ff0000ff', gain: 1 });
    // The carrier scrubs what the mesh path cannot stage.
    expect(emitted[0]!.motionSamples).toBeUndefined();
    expect(emitted[0]!.effects).toBeUndefined();
  });

  it('an UNREGISTERED model renders the plain quad placeholder, not nothing', () => {
    const g = new SceneGraph();
    g.addNode(modelLayer('m1', 'gltf-deadbeef-0'));
    const snap = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
    const emitted = snap.layers.filter((l) => l.id.startsWith('m1'));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.extrudedMesh).toBeUndefined();
  });

  it('a 2D layer with a Model component keeps its quad (the mesh path is 3D-only)', () => {
    const glb = buildQuadGlb();
    const key = modelKeyForBytes(new Uint8Array(glb));
    registerModel(key, glb);
    const node = modelLayer('m1', key);
    // Strip the z prop → not 3D.
    const t = node.components.find((c) => c.type === 'Transform')!;
    delete (t.props as Record<string, unknown>).z;
    const g = new SceneGraph();
    g.addNode(node);
    const snap = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
    expect(snap.layers.find((l) => l.id.startsWith('m1'))!.extrudedMesh).toBeUndefined();
  });
});
