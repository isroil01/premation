/**
 * glTF 2.0 / GLB parser — pure, dependency-free, decode-only.
 *
 * Reads the subset a compositor needs to DRAW a model: triangle primitives
 * (positions / normals / UV0 / indices, plus JOINTS_0/WEIGHTS_0), materials
 * with a base colour factor and optional base colour texture, embedded images,
 * the node hierarchy with TRS transforms, TRS animation clips, and skins with
 * inverse bind matrices. Everything else — morph targets, extensions — is
 * deliberately ignored for now (they are later tiers, and ignoring unknown
 * fields is what the glTF spec says to do).
 *
 * Container support: `.glb` (binary container, JSON + BIN chunks) and `.gltf`
 * JSON whose buffers/images are EMBEDDED data: URIs. External .bin/.png URIs
 * are refused BY THE PARSER with a clear error — it runs where there is no
 * baseline to fetch relative files against (browser drop, cloud doc, CLI
 * render), and a model that silently loses its geometry is worse than one that
 * says which file is missing.
 *
 * The way to import a `.gltf` WITH sidecars is `packGltfToGlb` below: hand it
 * the .gltf bytes plus a resolver over the other files the user selected and it
 * rewrites the whole set into one self-contained GLB (single BIN chunk), which
 * is then exactly the format the rest of the pipeline already parses,
 * registers, persists in the document and re-parses on open. Nothing
 * downstream learns a second shape; the sidecar case ends at import.
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
  /** JOINTS_0: 4 joint indices per vertex (into the skin's joints), or null. */
  joints: Float32Array | null;
  /** WEIGHTS_0: 4 weights per vertex (raw; may not sum to 1), or null. */
  weights: Float32Array | null;
  /** Morph targets: per-vertex POSITION/NORMAL deltas (glTF space). */
  targets: { positions: Float32Array | null; normals: Float32Array | null }[];
}

/**
 * KHR_texture_transform: the affine remap a material applies to the UVs it
 * feeds one texture slot. Parsed here (it is three numbers and a flag) even
 * though only the base-colour slot's transform is honoured downstream — see
 * `ModelPrimitiveEntry.uvTransform`.
 */
export interface GltfTextureTransform {
  offset: [number, number];
  /** Radians, clockwise about the UV origin — the extension's convention. */
  rotation: number;
  scale: [number, number];
  /** The extension may re-point the slot at another TEXCOORD set. */
  texCoord: number | null;
}

/** One texture slot on a material, already resolved to an image index. */
export interface GltfTextureRef {
  /** Index into `images`. */
  image: number;
  /** TEXCOORD_n the material samples this slot with (spec default 0). */
  texCoord: number;
  /** KHR_texture_transform for this slot, or null. */
  transform: GltfTextureTransform | null;
}

export interface GltfMaterial {
  name: string;
  /** RGBA 0..1 (spec default 1,1,1,1). */
  baseColorFactor: [number, number, number, number];
  /** Index into `images`, or null. (Resolved through textures[].source.) */
  baseColorImage: number | null;
  /** The same slot with its texCoord / KHR_texture_transform intact. */
  baseColorTexture: GltfTextureRef | null;
  doubleSided: boolean;
  /** 0..1 (spec defaults: fully metallic, fully rough). */
  metallicFactor: number;
  roughnessFactor: number;
  /** Tangent-space normal map (G = +Y, glTF's OpenGL convention). */
  normalTexture: GltfTextureRef | null;
  /** `normalTexture.scale` (spec default 1) — scales the map's xy. */
  normalScale: number;
  /** Packed ORM-style map: G = roughness, B = metallic (spec fixed channels). */
  metallicRoughnessTexture: GltfTextureRef | null;
  /** Ambient occlusion; R channel. Very often the SAME image as the MR map. */
  occlusionTexture: GltfTextureRef | null;
  /** `occlusionTexture.strength` (spec default 1). */
  occlusionStrength: number;
  emissiveTexture: GltfTextureRef | null;
  /** RGB 0..1 (spec default 0,0,0 — no emission). */
  emissiveFactor: [number, number, number];
  /** KHR_materials_emissive_strength multiplier (default 1). */
  emissiveStrength: number;
}

export interface GltfImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface GltfNode {
  name: string;
  children: number[];
  mesh: number | null;
  /** Index into `skins` when this node's mesh is skinned, or null. */
  skin: number | null;
  /** Per-instance morph weight overrides, or null (use the mesh's). */
  weights: number[] | null;
  /** Translation (glTF units). */
  t: [number, number, number];
  /** Rotation quaternion, x y z w (glTF order). */
  r: [number, number, number, number];
  s: [number, number, number];
}

export interface GltfSkin {
  /** Node indices acting as joints, in JOINTS_0 order. */
  joints: number[];
  /** 16 floats per joint (column-major, glTF space), or null → identity. */
  inverseBindMatrices: Float32Array | null;
}

export type GltfInterpolation = 'LINEAR' | 'STEP' | 'CUBICSPLINE';

export interface GltfChannel {
  /** Target node index. */
  node: number;
  path: 'translation' | 'rotation' | 'scale' | 'weights';
  /** Keyframe times, seconds, ascending. */
  times: Float32Array;
  /** Values: vec3 triples, quat x y z w quadruples for 'rotation', or
   *  targetCount floats per key for 'weights'. For CUBICSPLINE this is the
   *  raw in-tangent/value/out-tangent triple stream. */
  values: Float32Array;
  interpolation: GltfInterpolation;
}

export interface GltfAnimation {
  name: string;
  channels: GltfChannel[];
}

export interface ParsedGltf {
  meshes: { name: string; primitives: GltfPrimitive[]; weights: number[]; targetNames: string[] }[];
  materials: GltfMaterial[];
  images: GltfImage[];
  nodes: GltfNode[];
  /** Root node indices of the default scene (or every parentless node). */
  roots: number[];
  /** TRS animation clips ('weights' morph channels are skipped for now). */
  animations: GltfAnimation[];
  skins: GltfSkin[];
}

// ── GLB container ─────────────────────────────────────────────────────

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

/**
 * A `.gltf` whose companion files were not supplied.
 *
 * Carries the URIs verbatim so the caller can NAME them — "missing
 * scene.bin" is actionable, "export as .glb" is a shrug. Thrown both by the
 * parser (which never resolves anything) and by `packGltfToGlb` (which
 * resolves what it was given and reports what it could not).
 */
export class GltfSidecarError extends Error {
  constructor(readonly missing: string[], where?: string) {
    const list = missing.map((u) => `“${u}”`).join(', ');
    super(
      `This .gltf keeps its data in separate files (${list})${where ? ` — ${where}` : ''}. `
      + 'Select the .gltf together with its .bin and texture files (File ▸ Import 3D Model…), '
      + 'or re-export the model as a single .glb.',
    );
    this.name = 'GltfSidecarError';
  }
}

/** Bytes a sidecar URI resolves to, or null when the file was not supplied. */
export type GltfSidecarResolver = (uri: string) => Uint8Array | null;

function pad4(n: number): number { return (4 - (n % 4)) % 4; }

/** Guess an image mime type from a sidecar file's extension. */
function mimeForUri(uri: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(uri)?.[1]?.toLowerCase();
  switch (ext) {
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'ktx2': return 'image/ktx2';
    case 'basis': return 'image/basis';
    case 'avif': return 'image/avif';
    default: return 'image/png';
  }
}

/**
 * Fold a `.gltf` plus its sidecars into ONE self-contained GLB.
 *
 * Every buffer (external file or data: URI) and every externally-referenced
 * image is concatenated into a single BIN chunk; bufferViews are re-pointed at
 * buffer 0 with their offsets shifted, and each embedded image gains a fresh
 * bufferView. The result is byte-for-byte an ordinary .glb, so it hashes into a
 * modelKey, registers, persists in the document and re-parses on open through
 * exactly the paths a real .glb already takes.
 *
 * Base64 was the cheaper thing to write (rewrite each `uri` as a data: URI and
 * keep the JSON) and is rejected here on weight: the document already stores
 * the model as a data: URL, so base64-inside-base64 would be 1.78× the source
 * bytes against a real GLB's 1.33×, on every save and autosave.
 *
 * Already-GLB input is returned unchanged rather than refused — the caller
 * hands over whatever the user picked, and "it was already fine" is not an
 * error.
 *
 * @throws GltfSidecarError naming EVERY unresolved uri, not just the first —
 * one round trip through the file picker should be enough.
 */
export function packGltfToGlb(gltfBytes: Uint8Array, resolve: GltfSidecarResolver): ArrayBuffer {
  if (gltfBytes.byteLength >= 12
    && new DataView(gltfBytes.buffer, gltfBytes.byteOffset, 12).getUint32(0, true) === GLB_MAGIC) {
    return gltfBytes.slice().buffer;
  }
  let g: GltfJson;
  try {
    g = JSON.parse(new TextDecoder().decode(gltfBytes)) as GltfJson;
  } catch {
    throw new Error('not a glTF file — the .gltf could not be read as JSON');
  }

  const missing: string[] = [];
  const fetchUri = (uri: string): Uint8Array => {
    if (uri.startsWith('data:')) return decodeDataUri(uri);
    // Exporters percent-encode spaces and non-ASCII in `uri`; the file the user
    // picked is named in the DECODED form.
    let decoded = uri;
    try { decoded = decodeURIComponent(uri); } catch { /* keep the raw form */ }
    const bytes = resolve(decoded) ?? resolve(uri);
    if (!bytes) {
      missing.push(decoded);
      return new Uint8Array(0);
    }
    return bytes;
  };

  const buffers = (g.buffers ?? []).map((b, i) => {
    // Only GLB's buffer 0 may omit `uri` (it IS the BIN chunk). A JSON .gltf
    // that does so is malformed, and folding it in as zero bytes would produce
    // a GLB whose geometry silently decodes to the origin — refuse instead.
    if (b.uri === undefined) throw new Error(`buffer ${i} of this .gltf has no uri — the file is malformed`);
    return fetchUri(b.uri);
  });
  // Images that live outside a bufferView become new views at the tail.
  const extraImages = (g.images ?? []).map((im) =>
    im.bufferView === undefined && im.uri !== undefined
      ? { bytes: fetchUri(im.uri), mimeType: im.mimeType ?? mimeForUri(im.uri) }
      : null,
  );
  if (missing.length > 0) throw new GltfSidecarError([...new Set(missing)]);

  // Lay the blob out, 4-byte aligned so every re-pointed accessor stays legal.
  const bufferAt: number[] = [];
  let cursor = 0;
  for (const b of buffers) {
    cursor += pad4(cursor);
    bufferAt.push(cursor);
    cursor += b.length;
  }
  const imageAt: number[] = [];
  for (const im of extraImages) {
    if (!im) { imageAt.push(-1); continue; }
    cursor += pad4(cursor);
    imageAt.push(cursor);
    cursor += im.bytes.length;
  }
  const bin = new Uint8Array(cursor);
  buffers.forEach((b, i) => bin.set(b, bufferAt[i]!));
  extraImages.forEach((im, i) => { if (im) bin.set(im.bytes, imageAt[i]!); });

  const views = (g.bufferViews ?? []).map((v) => ({
    ...v,
    buffer: 0,
    byteOffset: bufferAt[v.buffer]! + (v.byteOffset ?? 0),
  }));
  const images = (g.images ?? []).map((im, i) => {
    const extra = extraImages[i];
    if (!extra) return im;
    views.push({ buffer: 0, byteOffset: imageAt[i]!, byteLength: extra.bytes.length });
    const { uri: _dropped, ...rest } = im;
    return { ...rest, bufferView: views.length - 1, mimeType: extra.mimeType };
  });

  const json: GltfJson = {
    ...g,
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    ...(g.images ? { images } : {}),
  };
  return buildGlb(new TextEncoder().encode(JSON.stringify(json)), bin);
}

/** Header + padded JSON chunk + padded BIN chunk. */
function buildGlb(jsonBytes: Uint8Array, bin: Uint8Array): ArrayBuffer {
  const jsonPad = pad4(jsonBytes.length);
  const binPad = pad4(bin.length);
  const total = 12 + 8 + jsonBytes.length + jsonPad + (bin.length > 0 ? 8 + bin.length + binPad : 0);
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length + jsonPad, true);
  dv.setUint32(16, CHUNK_JSON, true);
  u8.set(jsonBytes, 20);
  // JSON pads with SPACES, BIN with zeros — the spec is explicit, and a parser
  // that trims on whitespace would choke on NULs.
  for (let i = 0; i < jsonPad; i++) u8[20 + jsonBytes.length + i] = 0x20;
  if (bin.length > 0) {
    const at = 20 + jsonBytes.length + jsonPad;
    dv.setUint32(at, bin.length + binPad, true);
    dv.setUint32(at + 4, CHUNK_BIN, true);
    u8.set(bin, at + 8);
  }
  return out;
}

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
  images?: { uri?: string; mimeType?: string; bufferView?: number; name?: string }[];
  textures?: { source?: number }[];
  materials?: {
    name?: string; doubleSided?: boolean;
    pbrMetallicRoughness?: {
      baseColorFactor?: number[];
      baseColorTexture?: GltfJsonTextureInfo;
      metallicFactor?: number;
      roughnessFactor?: number;
      metallicRoughnessTexture?: GltfJsonTextureInfo;
    };
    normalTexture?: GltfJsonTextureInfo & { scale?: number };
    occlusionTexture?: GltfJsonTextureInfo & { strength?: number };
    emissiveTexture?: GltfJsonTextureInfo;
    emissiveFactor?: number[];
    extensions?: {
      KHR_materials_emissive_strength?: { emissiveStrength?: number };
    };
  }[];
  meshes?: {
    name?: string;
    primitives: GltfJsonPrimitive[];
    weights?: number[];
    /** Where every exporter puts blend-shape names — see `readTargetNames`. */
    extras?: { targetNames?: unknown };
  }[];
  nodes?: {
    name?: string; children?: number[]; mesh?: number; skin?: number; weights?: number[];
    translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[];
  }[];
  skins?: { joints?: number[]; inverseBindMatrices?: number }[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  animations?: {
    name?: string;
    channels?: { sampler: number; target: { node?: number; path: string } }[];
    samplers?: { input: number; output: number; interpolation?: string }[];
  }[];
}

/** The spec's `textureInfo` shape, plus the one extension we read off it. */
interface GltfJsonTextureInfo {
  index: number;
  texCoord?: number;
  extensions?: {
    KHR_texture_transform?: {
      offset?: number[];
      rotation?: number;
      scale?: number[];
      texCoord?: number;
    };
  };
}

interface GltfJsonPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: Record<string, number>[];
  extras?: { targetNames?: unknown };
}

/**
 * Morph target names, from `extras.targetNames`.
 *
 * The spec has no first-class place for them, and every tool in practice
 * (Blender, Maya, three.js, FBX2glTF, VRM) writes this exact array — on the
 * MESH, with a handful of older exporters writing it on the first PRIMITIVE
 * instead, so both are read. Names are what makes a morph slider mean
 * something ("browInnerUp"), so dropping them left the UI with nothing but
 * ordinals. Non-strings are filtered rather than coerced: a bad extras block
 * should cost the names, not produce `[object Object]` labels.
 */
function readTargetNames(mesh: {
  extras?: { targetNames?: unknown };
  primitives: GltfJsonPrimitive[];
}): string[] {
  const raw = mesh.extras?.targetNames ?? mesh.primitives[0]?.extras?.targetNames;
  if (!Array.isArray(raw)) return [];
  return raw.map((n) => (typeof n === 'string' ? n : ''));
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
    throw new GltfSidecarError([b.uri], `buffer ${i}`);
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
    throw new GltfSidecarError([im.uri ?? `image ${i}`], `image ${i}`);
  });

  /**
   * `textureInfo` → a slot resolved to an IMAGE index.
   *
   * Returns null when the slot is absent, when textures[].source is missing, or
   * when the image itself failed to materialise — a material must never point
   * at an image index the `images` array does not hold, because every consumer
   * downstream indexes it blind.
   */
  const textureRef = (t: GltfJsonTextureInfo | undefined): GltfTextureRef | null => {
    if (!t || typeof t.index !== 'number') return null;
    const image = (g.textures ?? [])[t.index]?.source;
    if (image === undefined || image === null || !images[image]) return null;
    const kt = t.extensions?.KHR_texture_transform;
    const transform: GltfTextureTransform | null = kt
      ? {
          offset: [kt.offset?.[0] ?? 0, kt.offset?.[1] ?? 0],
          rotation: typeof kt.rotation === 'number' ? kt.rotation : 0,
          scale: [kt.scale?.[0] ?? 1, kt.scale?.[1] ?? 1],
          texCoord: typeof kt.texCoord === 'number' ? kt.texCoord : null,
        }
      : null;
    return { image, texCoord: transform?.texCoord ?? t.texCoord ?? 0, transform };
  };

  // Materials (through textures[].source to an image index).
  const materials: GltfMaterial[] = (g.materials ?? []).map((m, i) => {
    const pbr = m.pbrMetallicRoughness ?? {};
    const f = pbr.baseColorFactor ?? [1, 1, 1, 1];
    const base = textureRef(pbr.baseColorTexture);
    const ef = m.emissiveFactor ?? [0, 0, 0];
    return {
      name: m.name ?? `material ${i}`,
      baseColorFactor: [f[0] ?? 1, f[1] ?? 1, f[2] ?? 1, f[3] ?? 1],
      baseColorImage: base ? base.image : null,
      baseColorTexture: base,
      doubleSided: m.doubleSided === true,
      // Spec defaults are 1/1 (fully metallic, fully rough) — honoured, not
      // softened: an exporter that MEANT non-metal writes metallicFactor 0.
      metallicFactor: typeof pbr.metallicFactor === 'number' ? pbr.metallicFactor : 1,
      roughnessFactor: typeof pbr.roughnessFactor === 'number' ? pbr.roughnessFactor : 1,
      normalTexture: textureRef(m.normalTexture),
      normalScale: typeof m.normalTexture?.scale === 'number' ? m.normalTexture.scale : 1,
      metallicRoughnessTexture: textureRef(pbr.metallicRoughnessTexture),
      occlusionTexture: textureRef(m.occlusionTexture),
      occlusionStrength: typeof m.occlusionTexture?.strength === 'number' ? m.occlusionTexture.strength : 1,
      emissiveTexture: textureRef(m.emissiveTexture),
      emissiveFactor: [ef[0] ?? 0, ef[1] ?? 0, ef[2] ?? 0],
      emissiveStrength:
        typeof m.extensions?.KHR_materials_emissive_strength?.emissiveStrength === 'number'
          ? m.extensions.KHR_materials_emissive_strength.emissiveStrength
          : 1,
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
        const jointsAttr = p.attributes.JOINTS_0;
        const weightsAttr = p.attributes.WEIGHTS_0;
        return {
          positions,
          normals,
          uvs,
          indices,
          material: p.material ?? null,
          // Skinning attributes travel together — one without the other is a
          // malformed export better rendered rigid than half-skinned.
          joints: jointsAttr !== undefined && weightsAttr !== undefined ? readAccessorF32(jointsAttr) : null,
          weights: jointsAttr !== undefined && weightsAttr !== undefined ? readAccessorF32(weightsAttr) : null,
          targets: (p.targets ?? []).map((t) => ({
            positions: t.POSITION !== undefined ? readAccessorF32(t.POSITION) : null,
            normals: t.NORMAL !== undefined ? readAccessorF32(t.NORMAL) : null,
          })),
        };
      }),
    weights: mesh.weights ?? [],
    targetNames: readTargetNames(mesh),
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
      skin: n.skin ?? null,
      weights: n.weights ?? null,
      t, r, s,
    };
  });

  // Skins: joints + inverse bind matrices (16 floats each, glTF space).
  const skins: GltfSkin[] = (g.skins ?? []).map((sk) => ({
    joints: sk.joints ?? [],
    inverseBindMatrices: sk.inverseBindMatrices !== undefined
      ? readAccessorF32(sk.inverseBindMatrices)
      : null,
  }));

  // Animations → flat channels with decoded time/value streams.
  const animations: GltfAnimation[] = (g.animations ?? []).map((an, ai) => {
    const channels: GltfChannel[] = [];
    for (const ch of an.channels ?? []) {
      const s = (an.samplers ?? [])[ch.sampler];
      if (!s || ch.target.node === undefined) continue;
      const path = ch.target.path;
      if (path !== 'translation' && path !== 'rotation' && path !== 'scale' && path !== 'weights') continue;
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

  return { meshes, materials, images, nodes, roots, animations, skins };
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
