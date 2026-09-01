/**
 * glTF 2.0 / GLB parser — pure, dependency-free, decode-only.
 *
 * Reads the subset a compositor needs to DRAW a model: triangle primitives
 * (positions / normals / UV0 / indices), pbrMetallicRoughness materials with a
 * base colour factor and optional base colour texture, embedded images, and
 * the node hierarchy with TRS transforms. Everything else — skins, animations,
 * morph targets, extensions — is deliberately ignored for now (they are later
 * tiers, and ignoring unknown fields is what the glTF spec says to do).
 *
 * Container support: `.glb` (binary container, JSON + BIN chunks) and `.gltf`
 * JSON whose buffers/images are EMBEDDED data: URIs. External .bin/.png URIs
 * are refused with a clear error — this parser runs where there is no baseline
 * to fetch relative files against (browser drop, cloud doc, CLI render), and
 * a model that silently loses its geometry is worse than one that says "please
 * export as .glb".
 *
 * Outputs stay in glTF's own coordinate system (y up, metres); the SCENE-side
 * importer owns the conversion to compositor space, so this file remains a
 * faithful reading of the format that tests can pin against the spec.
 */

export interface GltfPrimitive {
  /** xyz triples, glTF space. */
  positions: Float32Array;
  /** xyz triples, unit-ish; GENERATED (flat, per-face averaged) when absent. */
  normals: Float32Array;
  /** uv pairs (0,0 = top-left of the image, per spec); null when the mesh has none. */
  uvs: Float32Array | null;
  /** Triangle list. Always present (generated 0..n-1 when the file omits it). */
  indices: Uint32Array;
  /** Index into `materials`, or null for the spec's default material. */
  material: number | null;
}

export interface GltfMaterial {
  name: string;
  /** RGBA 0..1 (spec default 1,1,1,1). */
  baseColorFactor: [number, number, number, number];
  /** Index into `images`, or null. (Resolved through textures[].source.) */
  baseColorImage: number | null;
  doubleSided: boolean;
  /** 0..1 (spec defaults: fully metallic, fully rough). */
  metallicFactor: number;
  roughnessFactor: number;
}

export interface GltfImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface GltfNode {
  name: string;
  children: number[];
  mesh: number | null;
  /** Translation (glTF units). */
  t: [number, number, number];
  /** Rotation quaternion, x y z w (glTF order). */
  r: [number, number, number, number];
  s: [number, number, number];
}

export type GltfInterpolation = 'LINEAR' | 'STEP' | 'CUBICSPLINE';

export interface GltfChannel {
  /** Target node index. */
  node: number;
  path: 'translation' | 'rotation' | 'scale';
  /** Keyframe times, seconds, ascending. */
  times: Float32Array;
  /** Values: vec3 triples, or quat x y z w quadruples for 'rotation'. For
   *  CUBICSPLINE this is the raw in-tangent/value/out-tangent triple stream. */
  values: Float32Array;
  interpolation: GltfInterpolation;
}

export interface GltfAnimation {
  name: string;
  channels: GltfChannel[];
}

export interface ParsedGltf {
  meshes: { name: string; primitives: GltfPrimitive[] }[];
  materials: GltfMaterial[];
  images: GltfImage[];
  nodes: GltfNode[];
  /** Root node indices of the default scene (or every parentless node). */
  roots: number[];
  /** TRS animation clips ('weights' morph channels are skipped for now). */
  animations: GltfAnimation[];
}

// ── GLB container ─────────────────────────────────────────────────────

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

/** Parse a .glb or an embedded-only .gltf from raw bytes. */
export function parseGltf(data: ArrayBuffer): ParsedGltf {
  const dv = new DataView(data);
  if (data.byteLength >= 12 && dv.getUint32(0, true) === GLB_MAGIC) {
    const version = dv.getUint32(4, true);
    if (version !== 2) throw new Error(`GLB version ${version} — only glTF 2.0 is supported`);
    let json: unknown = null;
    let bin: Uint8Array | null = null;
    let off = 12;
    while (off + 8 <= data.byteLength) {
      const len = dv.getUint32(off, true);
      const type = dv.getUint32(off + 4, true);
      const body = new Uint8Array(data, off + 8, len);
      if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body));
      else if (type === CHUNK_BIN) bin = body;
      // Spec: chunkLength includes the chunk's own 4-byte padding (JSON pads
      // with spaces, BIN with zeros), so plain accumulation walks correctly.
      off += 8 + len;
    }
    if (!json) throw new Error('GLB has no JSON chunk');
    return parseJson(json as GltfJson, bin);
  }
  // Not GLB — try JSON text.
  const text = new TextDecoder().decode(new Uint8Array(data));
  return parseJson(JSON.parse(text) as GltfJson, null);
}

// ── glTF JSON (typed loosely; unknown fields ignored per spec) ───────

interface GltfJson {
  asset?: { version?: string };
  buffers?: { byteLength: number; uri?: string }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  accessors?: {
    bufferView?: number; byteOffset?: number; componentType: number; normalized?: boolean;
    count: number; type: string;
  }[];
  images?: { uri?: string; mimeType?: string; bufferView?: number }[];
  textures?: { source?: number }[];
  materials?: {
    name?: string; doubleSided?: boolean;
    pbrMetallicRoughness?: {
      baseColorFactor?: number[];
      baseColorTexture?: { index: number };
      metallicFactor?: number;
      roughnessFactor?: number;
    };
  }[];
  meshes?: { name?: string; primitives: GltfJsonPrimitive[] }[];
  nodes?: {
    name?: string; children?: number[]; mesh?: number;
    translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[];
  }[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  animations?: {
    name?: string;
    channels?: { sampler: number; target: { node?: number; path: string } }[];
    samplers?: { input: number; output: number; interpolation?: string }[];
  }[];
}

interface GltfJsonPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
}

const COMPONENT_BYTES: Record<number, number> = {
  5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4,
};
const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16,
};

function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  if (comma < 0) throw new Error('malformed data: URI');
  const meta = uri.slice(0, comma);
  const body = uri.slice(comma + 1);
  if (/;base64$/i.test(meta)) {
    const bin = atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(decodeURIComponent(body));
}

function parseJson(g: GltfJson, glbBin: Uint8Array | null): ParsedGltf {
  // Buffers: GLB BIN chunk, or embedded data: URIs. External files refused.
  const buffers: Uint8Array[] = (g.buffers ?? []).map((b, i) => {
    if (b.uri === undefined) {
      if (!glbBin) throw new Error(`buffer ${i} has no URI and there is no GLB BIN chunk`);
      return glbBin;
    }
    if (b.uri.startsWith('data:')) return decodeDataUri(b.uri);
    throw new Error(`buffer ${i} references an external file ("${b.uri}") — export as .glb (binary) instead`);
  });

  const viewBytes = (viewIndex: number): { bytes: Uint8Array; stride: number | undefined } => {
    const v = (g.bufferViews ?? [])[viewIndex];
    if (!v) throw new Error(`missing bufferView ${viewIndex}`);
    const buf = buffers[v.buffer];
    if (!buf) throw new Error(`bufferView ${viewIndex} references missing buffer ${v.buffer}`);
    return {
      bytes: buf.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength),
      stride: v.byteStride,
    };
  };

  /** Read an accessor as float32s (integers normalized per flag), tightly packed. */
  const readAccessorF32 = (index: number): Float32Array => {
    const a = (g.accessors ?? [])[index];
    if (!a) throw new Error(`missing accessor ${index}`);
    const comps = TYPE_COMPONENTS[a.type];
    const compBytes = COMPONENT_BYTES[a.componentType];
    if (!comps || !compBytes) throw new Error(`accessor ${index}: unsupported type ${a.type}/${a.componentType}`);
    const out = new Float32Array(a.count * comps);
    if (a.bufferView === undefined) return out; // spec: zeros
    const { bytes, stride } = viewBytes(a.bufferView);
    const elemBytes = comps * compBytes;
    const step = stride && stride > 0 ? stride : elemBytes;
    const base = (bytes.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const dv = new DataView(bytes.buffer, 0);
    for (let e = 0; e < a.count; e++) {
      const at = base + e * step;
      for (let c = 0; c < comps; c++) {
        const o = at + c * compBytes;
        let v: number;
        switch (a.componentType) {
          case 5126: v = dv.getFloat32(o, true); break;
          case 5125: v = dv.getUint32(o, true); break;
          case 5123: v = dv.getUint16(o, true); if (a.normalized) v /= 65535; break;
          case 5122: v = dv.getInt16(o, true); if (a.normalized) v = Math.max(v / 32767, -1); break;
          case 5121: v = dv.getUint8(o); if (a.normalized) v /= 255; break;
          case 5120: v = dv.getInt8(o); if (a.normalized) v = Math.max(v / 127, -1); break;
          default: throw new Error(`accessor ${index}: componentType ${a.componentType}`);
        }
        out[e * comps + c] = v;
      }
    }
    return out;
  };

  const readIndices = (index: number): Uint32Array => {
    const raw = readAccessorF32(index);
    const out = new Uint32Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw[i]!;
    return out;
  };

  // Images.
  const images: GltfImage[] = (g.images ?? []).map((im, i) => {
    if (im.bufferView !== undefined) {
      const { bytes } = viewBytes(im.bufferView);
      return { bytes: bytes.slice(), mimeType: im.mimeType ?? 'image/png' };
    }
    if (im.uri?.startsWith('data:')) {
      const m = /^data:([^;,]+)/.exec(im.uri);
      return { bytes: decodeDataUri(im.uri), mimeType: m?.[1] ?? 'image/png' };
    }
    throw new Error(`image ${i} references an external file — export as .glb (binary) instead`);
  });

  // Materials (through textures[].source to an image index).
  const materials: GltfMaterial[] = (g.materials ?? []).map((m, i) => {
    const pbr = m.pbrMetallicRoughness ?? {};
    const f = pbr.baseColorFactor ?? [1, 1, 1, 1];
    const texIndex = pbr.baseColorTexture?.index;
    const image = texIndex !== undefined ? (g.textures ?? [])[texIndex]?.source ?? null : null;
    return {
      name: m.name ?? `material ${i}`,
      baseColorFactor: [f[0] ?? 1, f[1] ?? 1, f[2] ?? 1, f[3] ?? 1],
      baseColorImage: image !== null && image !== undefined && images[image] ? image : null,
      doubleSided: m.doubleSided === true,
      // Spec defaults are 1/1 (fully metallic, fully rough) — honoured, not
      // softened: an exporter that MEANT non-metal writes metallicFactor 0.
      metallicFactor: typeof pbr.metallicFactor === 'number' ? pbr.metallicFactor : 1,
      roughnessFactor: typeof pbr.roughnessFactor === 'number' ? pbr.roughnessFactor : 1,
    };
  });

  // Meshes → triangle primitives.
  const meshes = (g.meshes ?? []).map((mesh, mi) => ({
    name: mesh.name ?? `mesh ${mi}`,
    primitives: mesh.primitives
      // Mode 4 (TRIANGLES) is the default; points/lines/strips are skipped —
      // a compositor draws surfaces, and a skipped wire is visibly absent
      // where a wrongly-triangulated one is silently wrong.
      .filter((p) => (p.mode ?? 4) === 4 && p.attributes.POSITION !== undefined)
      .map((p): GltfPrimitive => {
        const positions = readAccessorF32(p.attributes.POSITION!);
        const uvsAttr = p.attributes.TEXCOORD_0;
        const uvs = uvsAttr !== undefined ? readAccessorF32(uvsAttr) : null;
        const indices = p.indices !== undefined
          ? readIndices(p.indices)
          : new Uint32Array(Array.from({ length: positions.length / 3 }, (_, i) => i));
        const normalsAttr = p.attributes.NORMAL;
        const normals = normalsAttr !== undefined
          ? readAccessorF32(normalsAttr)
          : generateNormals(positions, indices);
        return {
          positions,
          normals,
          uvs,
          indices,
          material: p.material ?? null,
        };
      }),
  }));

  // Nodes with TRS (matrix decomposed when given).
  const nodes: GltfNode[] = (g.nodes ?? []).map((n, i) => {
    let t: [number, number, number] = [0, 0, 0];
    let r: [number, number, number, number] = [0, 0, 0, 1];
    let s: [number, number, number] = [1, 1, 1];
    if (n.matrix && n.matrix.length === 16) {
      const d = decomposeMatrix(n.matrix);
      t = d.t; r = d.r; s = d.s;
    } else {
      if (n.translation) t = [n.translation[0] ?? 0, n.translation[1] ?? 0, n.translation[2] ?? 0];
      if (n.rotation) r = [n.rotation[0] ?? 0, n.rotation[1] ?? 0, n.rotation[2] ?? 0, n.rotation[3] ?? 1];
      if (n.scale) s = [n.scale[0] ?? 1, n.scale[1] ?? 1, n.scale[2] ?? 1];
    }
    return {
      name: n.name ?? `node ${i}`,
      children: n.children ?? [],
      mesh: n.mesh ?? null,
      t, r, s,
    };
  });

  // Animations → flat channels with decoded time/value streams.
  const animations: GltfAnimation[] = (g.animations ?? []).map((an, ai) => {
    const channels: GltfChannel[] = [];
    for (const ch of an.channels ?? []) {
      const s = (an.samplers ?? [])[ch.sampler];
      if (!s || ch.target.node === undefined) continue;
      const path = ch.target.path;
      if (path !== 'translation' && path !== 'rotation' && path !== 'scale') continue; // 'weights' = morphs, later tier
      const interpolation: GltfInterpolation =
        s.interpolation === 'STEP' || s.interpolation === 'CUBICSPLINE' ? s.interpolation : 'LINEAR';
      channels.push({
        node: ch.target.node,
        path,
        times: readAccessorF32(s.input),
        values: readAccessorF32(s.output),
        interpolation,
      });
    }
    return { name: an.name ?? `clip ${ai}`, channels };
  });

  const sceneRoots = g.scenes?.[g.scene ?? 0]?.nodes;
  let roots: number[];
  if (sceneRoots && sceneRoots.length > 0) {
    roots = sceneRoots;
  } else {
    // No scene: every node nobody claims as a child is a root.
    const claimed = new Set<number>();
    for (const n of nodes) for (const c of n.children) claimed.add(c);
    roots = nodes.map((_, i) => i).filter((i) => !claimed.has(i));
  }

  return { meshes, materials, images, nodes, roots, animations };
}

/** Area-weighted vertex normals for a mesh that ships none. */
export function generateNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i]! * 3, b = indices[i + 1]! * 3, c = indices[i + 2]! * 3;
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const j of [a, b, c]) {
      out[j] = out[j]! + nx; out[j + 1] = out[j + 1]! + ny; out[j + 2] = out[j + 2]! + nz;
    }
  }
  for (let i = 0; i < out.length; i += 3) {
    const len = Math.hypot(out[i]!, out[i + 1]!, out[i + 2]!) || 1;
    out[i] = out[i]! / len; out[i + 1] = out[i + 1]! / len; out[i + 2] = out[i + 2]! / len;
  }
  return out;
}

/** Column-major 4×4 → TRS (uniform-enough decomposition; glTF forbids skew). */
function decomposeMatrix(m: number[]): {
  t: [number, number, number];
  r: [number, number, number, number];
  s: [number, number, number];
} {
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  let sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  // A negative determinant means one axis is mirrored; put it on z.
  const det =
    m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) -
    m[4]! * (m[1]! * m[10]! - m[2]! * m[9]!) +
    m[8]! * (m[1]! * m[6]! - m[2]! * m[5]!);
  if (det < 0) sz = -sz;
  const r00 = m[0]! / (sx || 1), r01 = m[4]! / (sy || 1), r02 = m[8]! / (sz || 1);
  const r10 = m[1]! / (sx || 1), r11 = m[5]! / (sy || 1), r12 = m[9]! / (sz || 1);
  const r20 = m[2]! / (sx || 1), r21 = m[6]! / (sy || 1), r22 = m[10]! / (sz || 1);
  // Rotation matrix → quaternion (Shepperd's method).
  const trace = r00 + r11 + r22;
  let qx: number, qy: number, qz: number, qw: number;
  if (trace > 0) {
    const s4 = Math.sqrt(trace + 1) * 2;
    qw = s4 / 4; qx = (r21 - r12) / s4; qy = (r02 - r20) / s4; qz = (r10 - r01) / s4;
  } else if (r00 > r11 && r00 > r22) {
    const s4 = Math.sqrt(1 + r00 - r11 - r22) * 2;
    qw = (r21 - r12) / s4; qx = s4 / 4; qy = (r01 + r10) / s4; qz = (r02 + r20) / s4;
  } else if (r11 > r22) {
    const s4 = Math.sqrt(1 + r11 - r00 - r22) * 2;
    qw = (r02 - r20) / s4; qx = (r01 + r10) / s4; qy = s4 / 4; qz = (r12 + r21) / s4;
  } else {
    const s4 = Math.sqrt(1 + r22 - r00 - r11) * 2;
    qw = (r10 - r01) / s4; qx = (r02 + r20) / s4; qy = (r12 + r21) / s4; qz = s4 / 4;
  }
  return { t: [m[12]!, m[13]!, m[14]!], r: [qx, qy, qz, qw], s: [sx, sy, sz] };
}
