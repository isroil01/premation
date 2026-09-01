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
