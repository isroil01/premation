/**
 * Cross-engine parity of glTF morph targets and skinning (plan D2w 3D
 * leftovers): `morphedMeshFor` (modelMorph.ts) and `skinnedMeshFor`
 * (modelSkinning.ts) on a registered model, morph then skin as buildSnapshot
 * chains them. The fixture records, per case, the layer's morph weights (the
 * animated values and the Transform props), the imported subtree (root with the
 * file, joint layers with their gltfNode markers, the mesh layer), each joint
 * layer's world matrix, the mesh layer's world matrix, and what the editor
 * produces: the buffer key and every vertex float. The C++ port
 * (`native/engine/src/scene/model_deform.cpp`,
 * tests/test_model_deform_parity.cpp) must match float for float.
 *
 * `GEN_NATIVE_DEFORM=1 npx jest modelDeformCrossEngine` rewrites the fixture.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Matrix4Math, type Matrix4 } from '@motion/scene';
import type { SceneNode } from '@core/types';
import { clearModelRegistry, modelKeyForBytes, modelPrimitiveFor, registerModel, type ModelPrimitiveRef } from './modelMesh';
import { clearMorphMemo, morphedMeshFor } from './modelMorph';
import { clearSkinnedMemo, skinnedMeshFor, type SkinResolvers } from './modelSkinning';

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/model_deform_parity.json');

function pack(parts: ArrayBufferView[]): { bytes: Uint8Array; offsets: number[] } {
  const offsets: number[] = [];
  let n = 0;
  for (const p of parts) {
    offsets.push(n);
    n += p.byteLength;
    n += (4 - (n % 4)) % 4;
  }
  const bytes = new Uint8Array(n);
  parts.forEach((p, i) => bytes.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), offsets[i]!));
  return { bytes, offsets };
}

function glb(json: unknown, bin: Uint8Array): Uint8Array {
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (jsonBytes.length % 4)) % 4;
  if (jpad) {
    const p = new Uint8Array(jsonBytes.length + jpad).fill(0x20);
    p.set(jsonBytes);
    jsonBytes = p;
  }
  const binLen = bin.length + ((4 - (bin.length % 4)) % 4);
  const total = 12 + 8 + jsonBytes.length + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const o = 20 + jsonBytes.length;
  dv.setUint32(o, binLen, true);
  dv.setUint32(o + 4, 0x004e4942, true);
  out.set(bin, o + 8);
  return out;
}

/** A quad strip on two joints with two morph targets (one with normals), unnormalized weights and a stray joint index. */
function riggedGlb(): Uint8Array {
  const positions = Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0.25, 0.5, 2, -0.5);
  const normals = Float32Array.of(0, 0, 1, 0, 0, 1, 0.1, 0, 0.99, 0, 0.2, 0.98, 0, 0, 1);
  const uvs = Float32Array.of(0, 0, 1, 0, 0, 1, 1, 1, 0.5, 0.5);
  const indices = Uint16Array.of(0, 1, 2, 2, 1, 3, 2, 3, 4);
  const joints = Uint8Array.of(0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 7, 0, 0);
  const weights = Float32Array.of(0.6, 0.4, 0, 0, 0.3, 0.3, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0.7, 0.2, 0, 0);
  const t0p = Float32Array.of(0, 0, 0.5, 0, 0.1, 0.5, 0, 0, 0.5, 0.2, 0, 0, 0, -0.3, 0);
  const t1p = Float32Array.of(0.1, 0, 0, 0, 0, 0, -0.2, 0.1, 0, 0, 0, 0.4, 0.3, 0.3, 0.3);
  const t1n = Float32Array.of(0, 0.3, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, -1, 0);
  // Joint 0 at the origin; joint 1 bound one unit up (inverse bind translates down).
  const ibm = Float32Array.of(
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0.5, 1,
  );
  const parts = [positions, normals, uvs, indices, joints, weights, t0p, t1p, t1n, ibm];
  const { bytes, offsets } = pack(parts);
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bytes.length }],
    bufferViews: parts.map((p, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: p.byteLength })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 5, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 5, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 5, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 9, type: 'SCALAR' },
      { bufferView: 4, componentType: 5121, count: 5, type: 'VEC4' },
      { bufferView: 5, componentType: 5126, count: 5, type: 'VEC4' },
      { bufferView: 6, componentType: 5126, count: 5, type: 'VEC3' },
      { bufferView: 7, componentType: 5126, count: 5, type: 'VEC3' },
      { bufferView: 8, componentType: 5126, count: 5, type: 'VEC3' },
      { bufferView: 9, componentType: 5126, count: 2, type: 'MAT4' },
    ],
    meshes: [{
      primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, JOINTS_0: 4, WEIGHTS_0: 5 }, indices: 3, targets: [{ POSITION: 6 }, { POSITION: 7, NORMAL: 8 }] }],
      weights: [0, 0],
    }],
    nodes: [{ mesh: 0, skin: 0 }, { name: 'hip', children: [2] }, { name: 'knee' }],
    skins: [{ joints: [1, 2], inverseBindMatrices: 9 }, { joints: [] }],
  };
  return glb(json, bytes);
}

interface NodeSpec {
  id: string;
  parent: string | null;
  children: string[];
  components: { id: string; type: string; props: Record<string, unknown> }[];
}

interface Case {
  name: string;
  /** Mesh layer Transform props (morph sliders' stored values). */
  transform: Record<string, number>;
  /** The layer's animated values (a track per morph slider). */
  animated: Record<string, number>;
  skin?: number;
  /** Joint layer world matrices (column-major), null = unresolvable. */
  jointWorlds: Record<string, number[] | null>;
  layerWorld: number[];
  /** Drop the knee's gltfNode marker (a joint layer the map cannot find). */
  noKneeMarker?: boolean;
}

const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const compose = (x: number, y: number, z: number, rx: number, ry: number, rz: number, s: number): number[] =>
  Array.from(Matrix4Math.compose({ position: { x, y, z }, rotation: { x: rx, y: ry, z: rz }, scale: { x: s, y: s, z: s }, anchor: { x: 0, y: 0, z: 0 } }));

const CASES: Case[] = [
  { name: 'no weights, no skin', transform: { morph0: 0, morph1: 0 }, animated: {}, jointWorlds: {}, layerWorld: I4 },
  { name: 'stored weight', transform: { morph0: 0.5, morph1: 0 }, animated: {}, jointWorlds: {}, layerWorld: I4 },
  { name: 'animated weights override', transform: { morph0: 0.5 }, animated: { morph0: 0.25, morph1: -1.37 }, jointWorlds: {}, layerWorld: I4 },
  { name: 'huge weight (quantize wraps)', transform: {}, animated: { morph1: 700000.3 }, jointWorlds: {}, layerWorld: I4 },
  {
    name: 'skinned at rest', transform: {}, animated: {}, skin: 0,
    jointWorlds: { hip: I4, knee: compose(0, 1, 0, 0, 0, 0, 1) }, layerWorld: I4,
  },
  {
    name: 'skinned, posed, placed layer', transform: {}, animated: {}, skin: 0,
    jointWorlds: { hip: compose(120, 40, -30, 0.2, 0.1, 0.3, 50), knee: compose(130, 90, -10, 0.9, -0.4, 0.2, 50) },
    layerWorld: compose(100, 50, 0, 0, 0.3, 0, 50),
  },
  {
    name: 'morph then skin', transform: { morph0: 0.75 }, animated: { morph1: 0.4 }, skin: 0,
    jointWorlds: { hip: compose(10, 0, 0, 0, 0, 0.5, 2), knee: compose(0, 20, 5, 0.3, 0, 0, 2) },
    layerWorld: compose(3, 4, 5, 0.1, 0.2, 0.3, 1.5),
  },
  { name: 'a joint layer without a world', transform: {}, animated: {}, skin: 0, jointWorlds: { hip: I4, knee: null }, layerWorld: I4 },
  { name: 'a joint layer the map cannot find', transform: { morph1: 0.5 }, animated: {}, skin: 0, jointWorlds: { hip: I4, knee: I4 }, layerWorld: I4, noKneeMarker: true },
  { name: 'singular layer matrix', transform: {}, animated: {}, skin: 0, jointWorlds: { hip: I4, knee: I4 }, layerWorld: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  { name: 'a skin with no joints', transform: {}, animated: {}, skin: 1, jointWorlds: {}, layerWorld: I4 },
  { name: 'a skin index out of range', transform: {}, animated: {}, skin: 4, jointWorlds: {}, layerWorld: I4 },
];

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

function generate() {
  const bytes = riggedGlb();
  const modelKey = modelKeyForBytes(bytes);
  clearModelRegistry();
  clearMorphMemo();
  clearSkinnedMemo();
  registerModel(modelKey, bytes.slice().buffer);
  const glbData = `data:model/gltf-binary;base64,${b64(bytes)}`;
  const rows = CASES.map((c) => {
    const ref: ModelPrimitiveRef = { modelKey, mesh: 0, prim: 0, ...(c.skin !== undefined ? { skin: c.skin } : {}) };
    const entry = modelPrimitiveFor(ref)!;
    const nodes: NodeSpec[] = [
      { id: 'root', parent: null, children: ['hip', 'mesh'], components: [{ id: 'root_m', type: 'Model', props: { modelKey, glbData } }] },
      { id: 'hip', parent: 'root', children: ['knee'], components: [{ id: 'hip_m', type: 'Model', props: { modelKey, gltfNode: 1 } }] },
      { id: 'knee', parent: 'hip', children: [], components: [{ id: 'knee_m', type: 'Model', props: c.noKneeMarker ? { modelKey } : { modelKey, gltfNode: 2 } }] },
      {
        id: 'mesh', parent: 'root', children: [],
        components: [
          { id: 'mesh_t', type: 'Transform', props: { ...c.transform } },
          { id: 'mesh_m', type: 'Model', props: { modelKey, mesh: 0, prim: 0, ...(c.skin !== undefined ? { skin: c.skin } : {}) } },
        ],
      },
    ];
    const byId = new Map(nodes.map((n) => [n.id, { ...n, name: n.id, visible: true, locked: false } as unknown as SceneNode]));
    const resolvers: SkinResolvers = {
      nodeById: byId,
      parentOf: (id) => nodes.find((n) => n.id === id)?.parent ?? null,
      jointWorld: (id) => (c.jointWorlds[id] ? (c.jointWorlds[id]!.slice() as unknown as Matrix4) : null),
    };
    const animated = new Map(Object.entries(c.animated));
    const meshNode = byId.get('mesh')!;
    const morphed = entry.morphTargets.length > 0 ? morphedMeshFor(meshNode, entry, animated) : null;
    const skinned = entry.skinData
      ? skinnedMeshFor(meshNode, ref, entry, c.layerWorld.slice() as unknown as Matrix4, resolvers, new Map(), morphed ?? undefined)
      : null;
    const deformed = skinned ?? morphed;
    return {
      name: c.name,
      nodes,
      animated: c.animated,
      jointWorlds: c.jointWorlds,
      layerWorld: c.layerWorld,
      morphed: morphed ? { key: morphed.key, tag: morphed.tag, vertices: Array.from(morphed.vertices) } : null,
      skinned: skinned ? { key: skinned.key, vertices: Array.from(skinned.vertices) } : null,
      deformedKey: deformed ? deformed.key : entry.key,
    };
  });
  return { bytes: b64(bytes), modelKey, rows };
}

test('the C++ model deform parity fixture matches morphedMeshFor + skinnedMeshFor', () => {
  const fixture = generate();
  const text = `${JSON.stringify({ comment: 'Generated by src/core/scene/modelDeformCrossEngine.test.ts (GEN_NATIVE_DEFORM=1). Do not edit.', ...fixture })}\n`;
  if (process.env.GEN_NATIVE_DEFORM === '1') {
    writeFileSync(OUT, text);
    return;
  }
  expect(existsSync(OUT)).toBe(true);
  expect(JSON.parse(readFileSync(OUT, 'utf8'))).toEqual(JSON.parse(text));
  expect(fixture.rows.filter((r) => r.skinned).length).toBeGreaterThanOrEqual(3);
  expect(fixture.rows.some((r) => r.morphed && r.skinned)).toBe(true);
});
