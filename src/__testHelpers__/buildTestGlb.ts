/**
 * Test-only: build a spec-correct GLB in memory (header, padded chunks, one
 * red doubly-sided quad with UVs, a two-node hierarchy). Shared by the parser
 * tests, the import-layout tests and the snapshot-emission tests so they all
 * agree on one fixture — and none of them needs a binary checked into git.
 */

function pad4(n: number): number { return (4 - (n % 4)) % 4; }

export function buildGlbBytes(json: unknown, bin: Uint8Array | null): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = pad4(jsonBytes.length);
  const binPad = bin ? pad4(bin.length) : 0;
  const total = 12 + 8 + jsonBytes.length + jsonPad + (bin ? 8 + bin.length + binPad : 0);
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  let off = 12;
  dv.setUint32(off, jsonBytes.length + jsonPad, true);
  dv.setUint32(off + 4, 0x4e4f534a, true);
  u8.set(jsonBytes, off + 8);
  for (let i = 0; i < jsonPad; i++) u8[off + 8 + jsonBytes.length + i] = 0x20;
  off += 8 + jsonBytes.length + jsonPad;
  if (bin) {
    dv.setUint32(off, bin.length + binPad, true);
    dv.setUint32(off + 4, 0x004e4942, true);
    u8.set(bin, off + 8);
  }
  return out;
}

/**
 * A skinned bar: 4 vertices along +Y (glTF space), the bottom pair bound to
 * joint node 1 (at the origin) and the top pair to joint node 2 (bind pose at
 * y=1, inverse bind T(0,−1,0)). Node 0 carries the mesh + skin. Moving the
 * tip joint must carry the top vertices and leave the bottom ones alone.
 */
export function buildSkinnedBarGlb(): ArrayBuffer {
  const positions = new Float32Array([-0.1, 0, 0, 0.1, 0, 0, -0.1, 2, 0, 0.1, 2, 0]);
  const joints = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const indices = new Uint16Array([0, 1, 2, 1, 3, 2]);
  const ibm = new Float32Array(32);
  ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0); // joint 0: identity
  ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1], 16); // joint 1: T(0,−1,0)
  const posOff = 0;
  const jntOff = posOff + positions.byteLength;
  const wgtOff = jntOff + joints.byteLength;
  const idxOff = wgtOff + weights.byteLength;
  const ibmOff = idxOff + indices.byteLength;
  const bin = new Uint8Array(ibmOff + ibm.byteLength);
  bin.set(new Uint8Array(positions.buffer), posOff);
  bin.set(joints, jntOff);
  bin.set(new Uint8Array(weights.buffer), wgtOff);
  bin.set(new Uint8Array(indices.buffer), idxOff);
  bin.set(new Uint8Array(ibm.buffer), ibmOff);
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: posOff, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: jntOff, byteLength: joints.byteLength },
      { buffer: 0, byteOffset: wgtOff, byteLength: weights.byteLength },
      { buffer: 0, byteOffset: idxOff, byteLength: indices.byteLength },
      { buffer: 0, byteOffset: ibmOff, byteLength: ibm.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 1, componentType: 5121, count: 4, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 4, type: 'VEC4' },
      { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' },
      { bufferView: 4, componentType: 5126, count: 2, type: 'MAT4' },
    ],
    meshes: [
      { name: 'bar', primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 }, indices: 3 }] },
    ],
    skins: [{ joints: [1, 2], inverseBindMatrices: 4 }],
    nodes: [
      { name: 'skin-mesh', mesh: 0, skin: 0 },
      { name: 'root-joint', children: [2] },
      { name: 'tip-joint', translation: [0, 1, 0] },
    ],
    scenes: [{ nodes: [0, 1] }],
    scene: 0,
  };
  return buildGlbBytes(json, bin);
}

/**
 * A morphing triangle: one target that lifts every vertex +1 in glTF y
 * (compositor −1), mesh default weight 0, and a 1s 'weights' animation
 * ramping 0 → 1. Exercises target parsing, the delta conversion, and the
 * weights→morph0 keyframe bake.
 */
export function buildMorphTriGlb(): ArrayBuffer {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const deltas = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  const animTimes = new Float32Array([0, 1]);
  const animVals = new Float32Array([0, 1]);
  const posOff = 0;
  const delOff = posOff + positions.byteLength;
  const idxOff = delOff + deltas.byteLength;
  const tOff = idxOff + indices.byteLength + 2; // u16×3 = 6 bytes → pad 2 to align 4
  const vOff = tOff + animTimes.byteLength;
  const bin = new Uint8Array(vOff + animVals.byteLength);
  bin.set(new Uint8Array(positions.buffer), posOff);
  bin.set(new Uint8Array(deltas.buffer), delOff);
  bin.set(new Uint8Array(indices.buffer), idxOff);
  bin.set(new Uint8Array(animTimes.buffer), tOff);
  bin.set(new Uint8Array(animVals.buffer), vOff);
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: posOff, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: delOff, byteLength: deltas.byteLength },
      { buffer: 0, byteOffset: idxOff, byteLength: indices.byteLength },
      { buffer: 0, byteOffset: tOff, byteLength: animTimes.byteLength },
      { buffer: 0, byteOffset: vOff, byteLength: animVals.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
      { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR' },
      { bufferView: 4, componentType: 5126, count: 2, type: 'SCALAR' },
    ],
    meshes: [{
      name: 'face',
      primitives: [{ attributes: { POSITION: 0 }, indices: 2, targets: [{ POSITION: 1 }] }],
      weights: [0],
    }],
    nodes: [{ name: 'face', mesh: 0 }],
    animations: [{
      name: 'blink',
      samplers: [{ input: 3, output: 4, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 0, path: 'weights' } }],
    }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  return buildGlbBytes(json, bin);
}

/** A red 2×2 quad (z=0, glTF space) under root→leaf nodes with TRS. */
export function buildQuadGlb(): ArrayBuffer {
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const posOff = 0;
  const nrmOff = posOff + positions.byteLength;
  const uvOff = nrmOff + normals.byteLength;
  const idxOff = uvOff + uvs.byteLength;
  const bin = new Uint8Array(idxOff + indices.byteLength);
  bin.set(new Uint8Array(positions.buffer), posOff);
  bin.set(new Uint8Array(normals.buffer), nrmOff);
  bin.set(new Uint8Array(uvs.buffer), uvOff);
  bin.set(new Uint8Array(indices.buffer), idxOff);
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: posOff, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: nrmOff, byteLength: normals.byteLength },
      { buffer: 0, byteOffset: uvOff, byteLength: uvs.byteLength },
      { buffer: 0, byteOffset: idxOff, byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    materials: [
      { name: 'red', doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } },
    ],
    meshes: [
      { name: 'quad', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] },
    ],
    nodes: [
      { name: 'root', children: [1], translation: [0, 0, 0] },
      { name: 'leaf', mesh: 0 },
    ],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  return buildGlbBytes(json, bin);
}
