/**
 * Cross-engine glTF model parity (plan D2w 3D leftovers). For a set of model
 * files the fixture records what the editor's import produces from the SAME
 * bytes: the model key (`modelKeyForBytes`), every image (mime, length,
 * FNV-1a 64), and every primitive's renderer entry (`primitiveToEntry`): the
 * interleaved vertices and indices as FNV-1a 64 of their exact bytes, index
 * width, bbox, fill, texture / map image indices, PBR factors, the baked UV
 * transform, and whether it is skinned or morphed. A model the parser refuses
 * records its error.
 *
 * The C++ port (`native/engine/src/scene/gltf_model.cpp`,
 * tests/test_gltf_model_parity.cpp) parses each file from the fixture's
 * base64 and must match field for field, byte for byte.
 *
 * Includes the render-tests `model-maps` / `model-maps-off` goldens' exact GLBs
 * (harness/fixtures/mappedModelGlb.ts): those scenes register the model in
 * memory (no `glbData` in their project document), so the engine cannot load
 * them from the document and this fixture is what pins the parse.
 *
 * `GEN_NATIVE_MODELS=1 npx jest modelCrossEngine` rewrites the fixture;
 * without it this test fails when the fixture is stale.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseGltf } from '@core/media/gltf';
import { modelKeyForBytes, primitiveToEntry } from './modelMesh';
import { buildMappedModelGlb } from '../../../packages/render-tests/harness/fixtures/mappedModelGlb';

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/gltf_model_parity.json');

function fnv1a64(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** Concatenate typed arrays into one buffer, 4-byte aligned; returns the buffer and each part's offset. */
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

function glb(json: unknown, bin: Uint8Array | null): Uint8Array {
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (jsonBytes.length % 4)) % 4;
  if (jpad) {
    const p = new Uint8Array(jsonBytes.length + jpad).fill(0x20);
    p.set(jsonBytes);
    jsonBytes = p;
  }
  const binLen = bin ? bin.length + ((4 - (bin.length % 4)) % 4) : 0;
  const total = 12 + 8 + jsonBytes.length + (bin ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  if (bin) {
    const o = 20 + jsonBytes.length;
    dv.setUint32(o, binLen, true);
    dv.setUint32(o + 4, 0x004e4942, true);
    out.set(bin, o + 8);
  }
  return out;
}

/**
 * An embedded `.gltf` exercising the accessor reader: an interleaved (strided)
 * position/uv view, normalized uint8 UVs, no normals (generated), no indices
 * (generated), a sparse accessor overriding two positions, a LINES primitive
 * (skipped), a matrix node, KHR_texture_transform + emissive strength, a
 * double-sided material, and a primitive with no material.
 */
function embeddedGltf(): Uint8Array {
  // Interleaved: x y z (f32) + u v (u8 normalized, padded to 4) = 16 bytes per vertex.
  const verts = 6;
  const inter = new ArrayBuffer(verts * 16);
  const dv = new DataView(inter);
  const pos = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0],
    [1, 0, 0], [1, 1, 0.25], [0, 1, 0],
  ];
  pos.forEach((p, i) => {
    dv.setFloat32(i * 16, p[0]!, true);
    dv.setFloat32(i * 16 + 4, p[1]!, true);
    dv.setFloat32(i * 16 + 8, p[2]!, true);
    dv.setUint8(i * 16 + 12, i * 40);
    dv.setUint8(i * 16 + 13, 255 - i * 33);
  });
  const sparseIdx = Uint16Array.of(1, 4);
  const sparseVal = Float32Array.of(1.5, -0.25, 0.125, 2, 2.5, -1);
  const linePos = Float32Array.of(0, 0, 0, 3, 3, 3);
  // A second, indexed primitive (int16 normalized positions, uint8 indices, explicit normals).
  const qpos = Int16Array.of(-32767, -32767, 0, 32767, -32767, 0, 32767, 32767, 0, -32767, 32767, 0);
  const qnrm = Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
  const qidx = Uint8Array.of(0, 1, 2, 0, 2, 3);
  const { bytes, offsets } = pack([new Uint8Array(inter), sparseIdx, sparseVal, linePos, qpos, qnrm, qidx]);
  const json = {
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_texture_transform', 'KHR_materials_emissive_strength'],
    buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${b64(bytes)}` }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: inter.byteLength, byteStride: 16 },
      { buffer: 0, byteOffset: offsets[1], byteLength: sparseIdx.byteLength },
      { buffer: 0, byteOffset: offsets[2], byteLength: sparseVal.byteLength },
      { buffer: 0, byteOffset: offsets[3], byteLength: linePos.byteLength },
      { buffer: 0, byteOffset: offsets[4], byteLength: qpos.byteLength },
      { buffer: 0, byteOffset: offsets[5], byteLength: qnrm.byteLength },
      { buffer: 0, byteOffset: offsets[6], byteLength: qidx.byteLength },
    ],
    accessors: [
      {
        bufferView: 0, byteOffset: 0, componentType: 5126, count: verts, type: 'VEC3',
        sparse: { count: 2, indices: { bufferView: 1, componentType: 5123 }, values: { bufferView: 2 } },
      },
      { bufferView: 0, byteOffset: 12, componentType: 5121, normalized: true, count: verts, type: 'VEC2' },
      { bufferView: 3, componentType: 5126, count: 2, type: 'VEC3' },
      { bufferView: 4, componentType: 5122, normalized: true, count: 4, type: 'VEC3' },
      { bufferView: 5, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 6, componentType: 5121, count: 6, type: 'SCALAR' },
    ],
    images: [{ uri: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' }],
    textures: [{ source: 0 }],
    materials: [
      {
        name: 'tt',
        doubleSided: true,
        pbrMetallicRoughness: {
          baseColorFactor: [0.8, 0.4, 0.2, 0.5],
          baseColorTexture: {
            index: 0,
            extensions: { KHR_texture_transform: { offset: [0.25, 0.5], rotation: 0.3, scale: [2, 0.5] } },
          },
          metallicFactor: 0.25,
        },
        emissiveFactor: [0.5, 0.25, 0],
        emissiveTexture: { index: 0 },
        extensions: { KHR_materials_emissive_strength: { emissiveStrength: 3 } },
      },
    ],
    meshes: [
      {
        name: 'm',
        primitives: [
          { attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 },
          { attributes: { POSITION: 2 }, mode: 1 },
          { attributes: { POSITION: 3, NORMAL: 4 }, indices: 5 },
        ],
      },
    ],
    nodes: [{ mesh: 0, matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1] }],
    scenes: [{ nodes: [0] }],
  };
  return new TextEncoder().encode(JSON.stringify(json));
}

/** A skinned + morphed GLB (the entry flags them; the C++ port reports them unported). */
function skinnedGlb(): Uint8Array {
  const positions = Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0);
  const normals = Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1);
  const joints = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  const weights = Float32Array.of(0.5, 0.25, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0);
  const morph = Float32Array.of(0, 0, 0.5, 0, 0, 0.5, 0, 0, 0.5);
  const ibm = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const { bytes, offsets } = pack([positions, normals, joints, weights, morph, ibm]);
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bytes.length }],
    bufferViews: [positions, normals, joints, weights, morph, ibm].map((p, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: p.byteLength })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5121, count: 3, type: 'VEC4' },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 4, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 5, componentType: 5126, count: 1, type: 'MAT4' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, JOINTS_0: 2, WEIGHTS_0: 3 }, targets: [{ POSITION: 4 }] }], weights: [0.3] }],
    nodes: [{ mesh: 0, skin: 0 }, { name: 'joint' }],
    skins: [{ joints: [1], inverseBindMatrices: 5 }],
  };
  return glb(json, bytes);
}

/** A file that needs Draco: refused by both parsers. */
function dracoGlb(): Uint8Array {
  return glb({ asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'], meshes: [] }, null);
}

const MODELS: { name: string; bytes: () => Uint8Array }[] = [
  { name: 'model-maps', bytes: () => new Uint8Array(buildMappedModelGlb(true)) },
  { name: 'model-maps-off', bytes: () => new Uint8Array(buildMappedModelGlb(false)) },
  { name: 'embedded-gltf', bytes: embeddedGltf },
  { name: 'skinned-morphed', bytes: skinnedGlb },
  { name: 'draco-required', bytes: dracoGlb },
];

interface PrimRow {
  mesh: number;
  prim: number;
  key: string;
  vertexCount: number;
  indexCount: number;
  index32: boolean;
  verticesFnv: string;
  indicesFnv: string;
  bbox: number[];
  fill: string;
  textureImage: number | null;
  doubleSided: boolean;
  metallic: number;
  roughness: number;
  maps: { normal: number | null; metallicRoughness: number | null; occlusion: number | null; emissive: number | null };
  normalScale: number;
  occlusionStrength: number;
  emissive: number[];
  uvTransform: number[] | null;
  skinned: boolean;
  morphTargets: number;
  morphDefaults: number[];
}

interface ModelRow {
  name: string;
  bytes: string;
  modelKey: string;
  error?: string;
  images?: { mimeType: string; length: number; fnv: string }[];
  primitives?: PrimRow[];
}

function generate(): ModelRow[] {
  return MODELS.map((m): ModelRow => {
    const bytes = m.bytes();
    const modelKey = modelKeyForBytes(bytes);
    const row: ModelRow = { name: m.name, bytes: b64(bytes), modelKey };
    let parsed;
    try {
      parsed = parseGltf(bytes.slice().buffer);
    } catch (e) {
      row.error = (e as Error).message;
      return row;
    }
    // Fake session URLs that name their image: primitiveToEntry resolves slots through them.
    const urls = parsed.images.map((_, i) => `img:${i}`);
    const idx = (u: string | null): number | null => (u ? Number(u.slice(4)) : null);
    row.images = parsed.images.map((im) => ({ mimeType: im.mimeType, length: im.bytes.length, fnv: fnv1a64(im.bytes) }));
    row.primitives = [];
    parsed.meshes.forEach((mesh, mi) => {
      mesh.primitives.forEach((_p, pi) => {
        const e = primitiveToEntry(parsed, modelKey, mi, pi, urls)!;
        row.primitives!.push({
          mesh: mi,
          prim: pi,
          key: e.key,
          vertexCount: e.vertices.length / 8,
          indexCount: e.indices.length,
          index32: e.indices instanceof Uint32Array,
          verticesFnv: fnv1a64(e.vertices),
          indicesFnv: fnv1a64(e.indices),
          bbox: [e.bbox.minX, e.bbox.minY, e.bbox.minZ, e.bbox.maxX, e.bbox.maxY, e.bbox.maxZ],
          fill: e.fill,
          textureImage: idx(e.textureUrl),
          doubleSided: e.doubleSided,
          metallic: e.metallic,
          roughness: e.roughness,
          maps: {
            normal: idx(e.maps.normal),
            metallicRoughness: idx(e.maps.metallicRoughness),
            occlusion: idx(e.maps.occlusion),
            emissive: idx(e.maps.emissive),
          },
          normalScale: e.normalScale,
          occlusionStrength: e.occlusionStrength,
          emissive: [...e.emissive],
          uvTransform: e.uvTransform ? [e.uvTransform.offsetX, e.uvTransform.offsetY, e.uvTransform.scaleX, e.uvTransform.scaleY, e.uvTransform.rotation] : null,
          skinned: e.skinData !== null,
          morphTargets: e.morphTargets.length,
          morphDefaults: e.morphDefaults,
        });
      });
    });
    return row;
  });
}

test('the C++ glTF model parity fixture matches parseGltf + primitiveToEntry', () => {
  const models = generate();
  const text = `${JSON.stringify({ comment: 'Generated by src/core/scene/modelCrossEngine.test.ts (GEN_NATIVE_MODELS=1). Do not edit.', models })}\n`;
  if (process.env.GEN_NATIVE_MODELS === '1') {
    writeFileSync(OUT, text);
    return;
  }
  expect(existsSync(OUT)).toBe(true);
  expect((JSON.parse(readFileSync(OUT, 'utf8')) as { models: ModelRow[] }).models).toEqual(models);
  // The goldens' GLBs parse, carry their maps, and the refused file says why.
  const maps = models.find((m) => m.name === 'model-maps')!;
  expect(maps.primitives![0]!.maps.normal).not.toBeNull();
  expect(models.find((m) => m.name === 'draco-required')!.error).toMatch(/KHR_draco_mesh_compression/);
  expect(models.find((m) => m.name === 'embedded-gltf')!.primitives!.length).toBe(2); // the LINES primitive is skipped
});
