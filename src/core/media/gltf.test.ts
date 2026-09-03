/**
 * glTF parser — pinned against procedurally BUILT files, not fixtures: the
 * test constructs a spec-correct GLB byte-for-byte (header, padded chunks,
 * accessors with offsets/strides), so a regression in the reader can't hide
 * behind a fixture that was exported by the same wrong assumptions.
 */

import { parseGltf, generateNormals, packGltfToGlb, GltfSidecarError } from './gltf';

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
    // The parser still refuses — it has no baseline to resolve against. What
    // changed is that it NAMES the file and points at the door that can take
    // it (`packGltfToGlb`, reached from Import 3D Model…), instead of only
    // telling the user to go back to their 3D app and export again.
    expect(() => parseGltf(buf as ArrayBuffer)).toThrow(/model\.bin/);
    expect(() => parseGltf(buf as ArrayBuffer)).toThrow(/single \.glb/);
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

// ── PBR map slots ────────────────────────────────────────────────────

/** A one-triangle model whose material carries every map slot. */
function buildMappedGlb(overrides: Record<string, unknown> = {}): ArrayBuffer {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  // Four distinct 1-byte "images" so an off-by-one in textures[].source shows
  // up as the wrong index rather than as a passing test.
  const imgs = new Uint8Array([1, 2, 3, 4]);
  const bin = new Uint8Array(positions.byteLength + 4);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(imgs, positions.byteLength);
  const imgView = (i: number) => ({ buffer: 0, byteOffset: positions.byteLength + i, byteLength: 1 });
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      imgView(0), imgView(1), imgView(2), imgView(3),
    ],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    images: [
      { bufferView: 1, mimeType: 'image/png' },
      { bufferView: 2, mimeType: 'image/png' },
      { bufferView: 3, mimeType: 'image/png' },
      { bufferView: 4, mimeType: 'image/png' },
    ],
    // Deliberately NOT identity-ordered: textures[i].source = 3−i, so a parser
    // that returned the TEXTURE index instead of the IMAGE index fails.
    textures: [{ source: 3 }, { source: 2 }, { source: 1 }, { source: 0 }],
    materials: [{
      name: 'mapped',
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0 },
        metallicRoughnessTexture: { index: 1 },
        metallicFactor: 0.25,
        roughnessFactor: 0.75,
      },
      normalTexture: { index: 2, scale: 0.5 },
      occlusionTexture: { index: 3, strength: 0.4 },
      emissiveTexture: { index: 0 },
      emissiveFactor: [1, 0.5, 0],
      ...overrides,
    }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  return buildGlb(json, bin);
}

describe('parseGltf — PBR texture slots', () => {
  it('resolves every slot through textures[].source to an IMAGE index', () => {
    const m = parseGltf(buildMappedGlb()).materials[0]!;
    expect(m.baseColorImage).toBe(3);
    expect(m.baseColorTexture).toEqual({ image: 3, texCoord: 0, transform: null });
    expect(m.metallicRoughnessTexture?.image).toBe(2);
    expect(m.normalTexture?.image).toBe(1);
    expect(m.occlusionTexture?.image).toBe(0);
    expect(m.emissiveTexture?.image).toBe(3);
  });

  it('keeps the slots’ own scalars (scale, strength, emissive factor)', () => {
    const m = parseGltf(buildMappedGlb()).materials[0]!;
    expect(m.normalScale).toBe(0.5);
    expect(m.occlusionStrength).toBe(0.4);
    expect(m.emissiveFactor).toEqual([1, 0.5, 0]);
    expect(m.emissiveStrength).toBe(1);
    expect(m.metallicFactor).toBe(0.25);
    expect(m.roughnessFactor).toBe(0.75);
  });

  it('applies the spec defaults when the scalars are omitted', () => {
    const m = parseGltf(buildMappedGlb({
      normalTexture: { index: 2 },
      occlusionTexture: { index: 3 },
      emissiveFactor: undefined,
    })).materials[0]!;
    expect(m.normalScale).toBe(1);
    expect(m.occlusionStrength).toBe(1);
    expect(m.emissiveFactor).toEqual([0, 0, 0]);
  });

  it('reads KHR_materials_emissive_strength', () => {
    const m = parseGltf(buildMappedGlb({
      extensions: { KHR_materials_emissive_strength: { emissiveStrength: 4 } },
    })).materials[0]!;
    expect(m.emissiveStrength).toBe(4);
  });

  it('reads KHR_texture_transform, including its texCoord override', () => {
    const m = parseGltf(buildMappedGlb({
      normalTexture: {
        index: 2,
        texCoord: 0,
        extensions: {
          KHR_texture_transform: { offset: [0.25, 0.5], rotation: 1, scale: [2, 4], texCoord: 1 },
        },
      },
    })).materials[0]!;
    expect(m.normalTexture?.transform).toEqual({
      offset: [0.25, 0.5], rotation: 1, scale: [2, 4], texCoord: 1,
    });
    // The extension's texCoord wins over the slot's own — that is what the
    // extension is for.
    expect(m.normalTexture?.texCoord).toBe(1);
  });

  it('drops a slot whose texture points at an image the file does not hold', () => {
    // A material must never carry an image index `images` cannot serve: every
    // consumer downstream indexes it blind.
    const m = parseGltf(buildMappedGlb({
      normalTexture: { index: 99 },
    })).materials[0]!;
    expect(m.normalTexture).toBeNull();
    expect(m.normalScale).toBe(1);
  });

  it('leaves every slot null on a material with no textures at all', () => {
    const m = parseGltf(buildQuadGlbLocal()).materials[0]!;
    expect(m.normalTexture).toBeNull();
    expect(m.metallicRoughnessTexture).toBeNull();
    expect(m.occlusionTexture).toBeNull();
    expect(m.emissiveTexture).toBeNull();
    expect(m.emissiveFactor).toEqual([0, 0, 0]);
  });
});

/** Minimal untextured model, for the "nothing set" case above. */
function buildQuadGlbLocal(): ArrayBuffer {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bin = new Uint8Array(positions.buffer.slice(0));
  return buildGlb({
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    materials: [{ name: 'plain', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    nodes: [{ mesh: 0 }],
  }, bin);
}

// ── External .gltf + sidecars → one GLB ──────────────────────────────

/** The .gltf half of an external-file export: one triangle, one texture. */
function externalGltfJson(bufferUri: string, imageUri: string): unknown {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  return {
    asset: { version: '2.0' },
    buffers: [{ byteLength: positions.byteLength + uvs.byteLength, uri: bufferUri }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: uvs.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    images: [{ uri: imageUri }],
    textures: [{ source: 0 }],
    materials: [{ name: 'm', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
}

function externalBufferBytes(): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const out = new Uint8Array(positions.byteLength + uvs.byteLength);
  out.set(new Uint8Array(positions.buffer), 0);
  out.set(new Uint8Array(uvs.buffer), positions.byteLength);
  return out;
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe('packGltfToGlb — a .gltf plus the files it points at', () => {
  const gltfBytes = (uriB = 'scene.bin', uriI = 'textures/albedo.png') =>
    new TextEncoder().encode(JSON.stringify(externalGltfJson(uriB, uriI)));

  const resolveAll = (uri: string): Uint8Array | null => {
    if (uri === 'scene.bin') return externalBufferBytes();
    if (uri === 'textures/albedo.png') return PNG_BYTES;
    return null;
  };

  it('folds the buffer and the image into a GLB the ordinary parser reads', () => {
    const glb = packGltfToGlb(gltfBytes(), resolveAll);
    // A real GLB: magic, version 2, and a BIN chunk (not base64 in the JSON).
    const dv = new DataView(glb);
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
    expect(dv.getUint32(4, true)).toBe(2);

    const parsed = parseGltf(glb);
    expect(Array.from(parsed.meshes[0]!.primitives[0]!.positions))
      .toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(parsed.meshes[0]!.primitives[0]!.uvs!)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(Array.from(parsed.images[0]!.bytes)).toEqual(Array.from(PNG_BYTES));
    expect(parsed.images[0]!.mimeType).toBe('image/png');
    expect(parsed.materials[0]!.baseColorImage).toBe(0);
  });

  it('names EVERY missing file, not just the first', () => {
    let err: unknown;
    try { packGltfToGlb(gltfBytes(), () => null); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GltfSidecarError);
    expect((err as GltfSidecarError).missing).toEqual(['scene.bin', 'textures/albedo.png']);
    // The message must be actionable — it is the only thing the user sees.
    expect((err as GltfSidecarError).message).toContain('scene.bin');
    expect((err as GltfSidecarError).message).toContain('textures/albedo.png');
  });

  it('resolves percent-encoded URIs against the DECODED file name', () => {
    const glb = packGltfToGlb(gltfBytes('my%20model.bin', 'textures/albedo.png'), (uri) =>
      uri === 'my model.bin' ? externalBufferBytes() : (uri === 'textures/albedo.png' ? PNG_BYTES : null));
    expect(parseGltf(glb).meshes[0]!.primitives[0]!.positions.length).toBe(9);
  });

  it('re-points every bufferView at the single merged buffer', () => {
    // Two buffers in, one out: the second's views must shift by the first's
    // (4-byte aligned) length or the geometry decodes as noise.
    const positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const json = {
      asset: { version: '2.0' },
      buffers: [
        { byteLength: positions.byteLength, uri: 'a.bin' },
        { byteLength: indices.byteLength, uri: 'b.bin' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
        { buffer: 1, byteOffset: 0, byteLength: indices.byteLength },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      nodes: [{ mesh: 0 }],
    };
    const glb = packGltfToGlb(new TextEncoder().encode(JSON.stringify(json)), (uri) =>
      uri === 'a.bin' ? new Uint8Array(positions.buffer.slice(0))
        : uri === 'b.bin' ? new Uint8Array(indices.buffer.slice(0)) : null);
    const prim = parseGltf(glb).meshes[0]!.primitives[0]!;
    expect(Array.from(prim.positions)).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0]);
    expect(Array.from(prim.indices)).toEqual([0, 1, 2]);
  });

  it('embeds data: URIs too, so a half-embedded file needs no second path', () => {
    const b64 = Buffer.from(externalBufferBytes()).toString('base64');
    const glb = packGltfToGlb(
      gltfBytes(`data:application/octet-stream;base64,${b64}`, 'textures/albedo.png'),
      (uri) => (uri === 'textures/albedo.png' ? PNG_BYTES : null),
    );
    expect(parseGltf(glb).meshes[0]!.primitives[0]!.positions.length).toBe(9);
  });

  it('hands a .glb straight back rather than refusing it', () => {
    const glb = buildQuadGlbLocal();
    const out = packGltfToGlb(new Uint8Array(glb), () => null);
    expect(new Uint8Array(out)).toEqual(new Uint8Array(glb));
  });

  it('infers an image mime type from the sidecar’s extension', () => {
    const glb = packGltfToGlb(gltfBytes('scene.bin', 'albedo.jpg'), (uri) =>
      uri === 'scene.bin' ? externalBufferBytes() : PNG_BYTES);
    expect(parseGltf(glb).images[0]!.mimeType).toBe('image/jpeg');
  });
});

describe('parseGltf — a .gltf handed over WITHOUT its sidecars', () => {
  it('refuses with the file name, not with a shrug', () => {
    const bytes = gltfWithExternalBuffer();
    let err: unknown;
    try { parseGltf(bytes); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GltfSidecarError);
    expect((err as GltfSidecarError).missing).toEqual(['scene.bin']);
    expect((err as GltfSidecarError).message).toContain('Import 3D Model');
  });
});

function gltfWithExternalBuffer(): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(externalGltfJson('scene.bin', 'a.png')));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
