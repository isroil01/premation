/**
 * glTF parser — pinned against procedurally BUILT files, not fixtures: the
 * test constructs a spec-correct GLB byte-for-byte (header, padded chunks,
 * accessors with offsets/strides), so a regression in the reader can't hide
 * behind a fixture that was exported by the same wrong assumptions.
 */

import { parseGltf, generateNormals } from './gltf';

// ── GLB builder ──────────────────────────────────────────────────────

function pad4(n: number): number { return (4 - (n % 4)) % 4; }

function buildGlb(json: unknown, bin: Uint8Array | null): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = pad4(jsonBytes.length);
  const binPad = bin ? pad4(bin.length) : 0;
  const chunks =
    8 + jsonBytes.length + jsonPad +
    (bin ? 8 + bin.length + binPad : 0);
  const total = 12 + chunks;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true); // magic 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  let off = 12;
  dv.setUint32(off, jsonBytes.length + jsonPad, true);
  dv.setUint32(off + 4, 0x4e4f534a, true); // 'JSON'
  u8.set(jsonBytes, off + 8);
  for (let i = 0; i < jsonPad; i++) u8[off + 8 + jsonBytes.length + i] = 0x20; // spaces
  off += 8 + jsonBytes.length + jsonPad;
  if (bin) {
    dv.setUint32(off, bin.length + binPad, true);
    dv.setUint32(off + 4, 0x004e4942, true); // 'BIN\0'
    u8.set(bin, off + 8);
  }
  return out;
}

/** A quad in the XY plane: 4 verts, 2 triangles, uint16 indices, vec2 UVs. */
function quadBin(): { bin: Uint8Array; json: Record<string, unknown> } {
  const positions = new Float32Array([
    -1, -1, 0,   1, -1, 0,   1, 1, 0,   -1, 1, 0,
  ]);
  const normals = new Float32Array([
    0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
  ]);
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
      {
        name: 'red',
        doubleSided: true,
        pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] },
      },
    ],
    meshes: [
      {
        name: 'quad',
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 },
        ],
      },
    ],
    nodes: [
      { name: 'root', children: [1], translation: [1, 2, 3] },
      { name: 'leaf', mesh: 0, rotation: [0, 0, 0.7071068, 0.7071068], scale: [2, 2, 2] },
    ],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  return { bin, json };
}

describe('parseGltf — GLB container', () => {
  it('reads meshes, materials, and the node hierarchy from a built GLB', () => {
    const { bin, json } = quadBin();
    const parsed = parseGltf(buildGlb(json, bin));

    expect(parsed.meshes).toHaveLength(1);
    const prim = parsed.meshes[0]!.primitives[0]!;
    expect(Array.from(prim.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(prim.positions).toHaveLength(12);
    expect(prim.positions[0]).toBe(-1);
    expect(prim.uvs).not.toBeNull();
    expect(prim.uvs![1]).toBe(1);
    expect(prim.material).toBe(0);

    expect(parsed.materials[0]).toMatchObject({
      name: 'red',
      doubleSided: true,
      baseColorFactor: [1, 0, 0, 1],
      baseColorImage: null,
    });

    expect(parsed.roots).toEqual([0]);
    expect(parsed.nodes[0]).toMatchObject({ name: 'root', children: [1], t: [1, 2, 3], mesh: null });
    expect(parsed.nodes[1]!.mesh).toBe(0);
    expect(parsed.nodes[1]!.s).toEqual([2, 2, 2]);
    expect(parsed.nodes[1]!.r[2]).toBeCloseTo(0.7071068);
  });

  it('honours interleaved byteStride and normalized integer accessors', () => {
    // Two vec3 positions interleaved with a normalized u8 vec2 UV at stride 16.
    const bin = new Uint8Array(32);
    const dv = new DataView(bin.buffer);
    const put = (i: number, x: number, y: number, z: number, u: number, v: number): void => {
      dv.setFloat32(i * 16 + 0, x, true);
      dv.setFloat32(i * 16 + 4, y, true);
      dv.setFloat32(i * 16 + 8, z, true);
      dv.setUint8(i * 16 + 12, u);
      dv.setUint8(i * 16 + 13, v);
    };
    put(0, 1, 2, 3, 0, 255);
    put(1, 4, 5, 6, 255, 0);
    const json = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: bin.length }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 32, byteStride: 16 }],
      accessors: [
        { bufferView: 0, byteOffset: 0, componentType: 5126, count: 2, type: 'VEC3' },
        { bufferView: 0, byteOffset: 12, componentType: 5121, normalized: true, count: 2, type: 'VEC2' },
      ],
      meshes: [
        { primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 } }] },
      ],
      nodes: [{ mesh: 0 }],
    };
    const parsed = parseGltf(buildGlb(json, bin));
    const prim = parsed.meshes[0]!.primitives[0]!;
    expect(Array.from(prim.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(prim.uvs![0]).toBeCloseTo(0);
    expect(prim.uvs![1]).toBeCloseTo(1);
    expect(prim.uvs![2]).toBeCloseTo(1);
    // No indices in the file → generated 0..n-1; no normals → generated.
    expect(Array.from(prim.indices)).toEqual([0, 1]);
    expect(prim.normals).toHaveLength(6);
    // No scenes block → parentless nodes are roots.
    expect(parsed.roots).toEqual([0]);
  });

  it('refuses external buffer files with an actionable message', () => {
    const json = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: 4, uri: 'model.bin' }],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(json));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect(() => parseGltf(buf as ArrayBuffer)).toThrow(/export as \.glb/);
  });

  it('parses embedded data: URI buffers in plain .gltf JSON', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(positions.buffer)));
    const json = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: positions.byteLength, uri: `data:application/octet-stream;base64,${b64}` }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(json));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const parsed = parseGltf(buf as ArrayBuffer);
    expect(Array.from(parsed.meshes[0]!.primitives[0]!.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });
});

describe('generateNormals', () => {
  it('produces the face normal for a flat triangle', () => {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const idx = new Uint32Array([0, 1, 2]);
    const n = generateNormals(pos, idx);
    // CCW triangle in xy → +z normal (right-hand rule, glTF space).
    expect(n[2]).toBeCloseTo(1);
    expect(n[5]).toBeCloseTo(1);
    expect(n[8]).toBeCloseTo(1);
  });
});
