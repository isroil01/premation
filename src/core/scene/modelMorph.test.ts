/**
 * Morph targets — the deformation stack's front half. What must not silently
 * break: the delta conversion (a blink that pushes the eyelid the WRONG way
 * after the y-flip), the weighted blend, the weights→morph0 keyframe bake,
 * and the snapshot path swapping blended vertices in under a weight-hashed
 * key (so a held expression re-uploads nothing).
 */

import { parseGltf } from '@core/media/gltf';
import { bakeWeightTracks } from './modelAnimation';
import { morphVertices, morphTag, readMorphWeights, clearMorphMemo } from './modelMorph';
import {
  registerModel,
  clearModelRegistry,
  modelKeyForBytes,
  modelPrimitiveFor,
  MODEL_COMPONENT,
} from './modelMesh';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import SceneGraph from './SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import { buildMorphTriGlb } from '@/__testHelpers__/buildTestGlb';

const COMP = { width: 800, height: 600, background: '#101014' };

describe('glTF morph parsing', () => {
  it('reads targets, mesh weights and the weights channel', () => {
    const parsed = parseGltf(buildMorphTriGlb());
    const prim = parsed.meshes[0]!.primitives[0]!;
    expect(prim.targets).toHaveLength(1);
    expect(Array.from(prim.targets[0]!.positions!.slice(0, 3))).toEqual([0, 1, 0]);
    expect(parsed.meshes[0]!.weights).toEqual([0]);
    const ch = parsed.animations[0]!.channels[0]!;
    expect(ch.path).toBe('weights');
    expect(Array.from(ch.values)).toEqual([0, 1]);
  });

  it('registers CONVERTED deltas (glTF +y → compositor −y)', () => {
    const glb = buildMorphTriGlb();
    const key = modelKeyForBytes(new Uint8Array(glb));
    registerModel(key, glb);
    const entry = modelPrimitiveFor({ modelKey: key, mesh: 0, prim: 0 })!;
    expect(entry.morphTargets).toHaveLength(1);
    expect(entry.morphTargets[0]!.positions![1]).toBe(-1);
    expect(entry.morphDefaults).toEqual([0]);
    clearModelRegistry();
  });
});

describe('bakeWeightTracks', () => {
  it('splits the interleaved stream into morphN tracks', () => {
    const tracks = bakeWeightTracks({
      node: 0,
      path: 'weights',
      interpolation: 'LINEAR',
      times: new Float32Array([0, 1]),
      values: new Float32Array([0.25, 0.5, 0.75, 1]), // 2 targets × 2 keys
    }, 2);
    expect(tracks.map((t) => t.prop)).toEqual(['morph0', 'morph1']);
    expect(tracks[0]!.keyframes.map((k) => k.value)).toEqual([0.25, 0.75]);
    expect(tracks[1]!.keyframes.map((k) => k.value)).toEqual([0.5, 1]);
  });

  it('CUBICSPLINE reads the value element out of the tangent triples', () => {
    const tracks = bakeWeightTracks({
      node: 0,
      path: 'weights',
      interpolation: 'CUBICSPLINE',
      times: new Float32Array([0, 1]),
      // Per key: inTangents(2) values(2) outTangents(2).
      values: new Float32Array([9, 9, 0.25, 0.5, 9, 9, 9, 9, 0.75, 1, 9, 9]),
    }, 2);
    expect(tracks[0]!.keyframes.map((k) => k.value)).toEqual([0.25, 0.75]);
    expect(tracks[1]!.keyframes.map((k) => k.value)).toEqual([0.5, 1]);
  });
});

describe('morphVertices', () => {
  it('blends weighted deltas and leaves untargeted attributes alone', () => {
    // One vertex: pos(0,0,0) nrm(0,0,1) uv(0.5,0.5).
    const base = new Float32Array([0, 0, 0, 0, 0, 1, 0.5, 0.5]);
    const out = morphVertices(base, [
      { positions: new Float32Array([2, 0, 0]), normals: null },
      { positions: new Float32Array([0, 4, 0]), normals: null },
    ], [0.5, 0.25]);
    expect(Array.from(out.slice(0, 3))).toEqual([1, 1, 0]);
    expect(Array.from(out.slice(3, 6))).toEqual([0, 0, 1]);
    expect(Array.from(out.slice(6, 8))).toEqual([0.5, 0.5]);
  });

  it('distinct weights produce distinct tags; equal weights the same tag', () => {
    expect(morphTag([0.5])).toBe(morphTag([0.5]));
    expect(morphTag([0.5])).not.toBe(morphTag([0.6]));
  });
});

// ── Snapshot path ───────────────────────────────────────────────────────────

const meshLayer = (key: string, morph0: number | undefined): SceneNode => ({
  id: 'meshL', name: 'meshL', parent: null, children: [], visible: true, locked: false,
  transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
  components: [
    {
      id: 'meshL_t',
      type: 'Transform',
      props: {
        [SCENE_KIND_PROP]: 'shape',
        x: 0, y: 0, z: 0, rotation: 0, scaleX: 1, scaleY: 1,
        anchorX: 0, anchorY: 0, width: 2, height: 2,
        ...(morph0 !== undefined ? { morph0 } : {}),
      },
    },
    { id: 'meshL_s', type: 'Style', props: { opacity: 100 } },
    { id: 'meshL_model', type: MODEL_COMPONENT, props: { modelKey: key, mesh: 0, prim: 0 } },
  ],
} as unknown as SceneNode);

describe('buildSnapshot — morphed vertices', () => {
  afterEach(() => {
    clearModelRegistry();
    clearMorphMemo();
  });

  const snap = (n: SceneNode) => {
    const g = new SceneGraph();
    g.addNode(n);
    return buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP);
  };

  it('a nonzero weight swaps in blended vertices under a weight-hashed key', () => {
    const glb = buildMorphTriGlb();
    const key = modelKeyForBytes(new Uint8Array(glb));
    registerModel(key, glb);
    const mesh = snap(meshLayer(key, 1)).layers.find((l) => l.id.startsWith('meshL'))!.extrudedMesh!;
    expect(mesh.key.startsWith(`${key}:m0p0:mo-`)).toBe(true);
    // Vertex 0: base (0,0,0) + 1 × delta (0,−1,0).
    expect(mesh.vertices[1]).toBeCloseTo(-1, 5);
  });

  it('weight zero renders the untouched base mesh under the base key', () => {
    const glb = buildMorphTriGlb();
    const key = modelKeyForBytes(new Uint8Array(glb));
    registerModel(key, glb);
    const mesh = snap(meshLayer(key, 0)).layers.find((l) => l.id.startsWith('meshL'))!.extrudedMesh!;
    expect(mesh.key).toBe(`${key}:m0p0`);
    expect(mesh.vertices[1]).toBeCloseTo(0, 5);
  });

  it('readMorphWeights prefers the animated track over the stored prop', () => {
    const node = meshLayer('k', 0.25);
    const animated = new Map([['morph0', 0.75]]);
    expect(readMorphWeights(node, animated, 1)).toEqual([0.75]);
    expect(readMorphWeights(node, null, 1)).toEqual([0.25]);
  });
});
