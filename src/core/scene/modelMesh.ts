/**
 * Imported 3D models (glTF) — the scene-side registry and conversions.
 *
 * A model layer's GEOMETRY does not live in the scene document: the document
 * stores the source .glb (a data: URL on the imported root's Model component)
 * and small references ({ modelKey, mesh, prim }) on each primitive layer.
 * This module owns the session-side truth those references resolve through:
 * parse once per model, convert each primitive into the SAME interleaved
 * mesh format the extrusion path feeds the renderer (pos3/nrm3/uv2 + indices),
 * and mint object URLs for embedded textures. buildSnapshot then reads the
 * registry synchronously and emits the standard `extrudedMesh` carrier — the
 * whole depth-grouped, lit, cached-GPU-buffer render path comes for free.
 *
 * Coordinate conversion happens HERE, once, at parse: glTF is y-up right-handed
 * (+z toward the viewer); the compositor is y-down with +z away. The change of
 * basis F = rotX(180°) = diag(1,−1,−1) is a proper rotation, so applying it as
 * a conjugation keeps windings and handedness honest:
 *   positions/normals/translations:  (x, y, z) → (x, −y, −z)
 *   rotation quaternions (x,y,z,w):  (x, y, z, w) → (x, −y, −z, w)
 *   scale: unchanged.
 */

import { parseGltf, type ParsedGltf } from '@core/media/gltf';
import { MESH_VERTEX_FLOATS } from '@core/geometry/extrudeMesh';
import type { SceneNode } from '@core/types';

/** Component type carried by imported-model layers. */
export const MODEL_COMPONENT = 'Model';

export interface ModelPrimitiveRef {
  modelKey: string;
  mesh: number;
  prim: number;
}

/** One converted primitive, renderer-ready. */
export interface ModelPrimitiveEntry {
  /** Interleaved x y z nx ny nz u v — the extrusion mesh layout. */
  vertices: Float32Array;
  indices: Uint32Array | Uint16Array;
  /** GPU-buffer cache key (stable per model content + primitive). */
  key: string;
  /** Local-space bounding box, compositor coordinates. */
  bbox: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  /** #rrggbbaa of the material's base colour factor. */
  fill: string;
  /** Object URL of the base colour texture for THIS session, or null. */
  textureUrl: string | null;
  doubleSided: boolean;
}

interface ModelEntry {
  primitives: Map<string, ModelPrimitiveEntry>; // `${mesh}:${prim}`
  textureUrls: string[]; // parallel to parsed images
}

const registry = new Map<string, ModelEntry>();

/** FNV-1a over bytes — the model's content identity (also the GPU key root). */
export function modelKeyForBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
  return `gltf-${(h >>> 0).toString(16).padStart(8, '0')}-${bytes.length}`;
}

/** Convert one glTF primitive into the interleaved renderer layout. */
export function primitiveToEntry(
  parsed: ParsedGltf,
  modelKey: string,
  meshIndex: number,
  primIndex: number,
  textureUrls: string[],
): ModelPrimitiveEntry | null {
  const prim = parsed.meshes[meshIndex]?.primitives[primIndex];
  if (!prim) return null;
  const vcount = prim.positions.length / 3;
  const vertices = new Float32Array(vcount * MESH_VERTEX_FLOATS);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vcount; i++) {
    const px = prim.positions[i * 3]!;
    // `0 - v`, not unary minus: negating 0 mints -0, which survives into
    // bbox/vertex data and fails every strict deep-equality downstream.
    const py = 0 - prim.positions[i * 3 + 1]!; // y-up → y-down
    const pz = 0 - prim.positions[i * 3 + 2]!; // +z toward viewer → +z away
    const o = i * MESH_VERTEX_FLOATS;
    vertices[o] = px;
    vertices[o + 1] = py;
    vertices[o + 2] = pz;
    vertices[o + 3] = prim.normals[i * 3]!;
    vertices[o + 4] = 0 - prim.normals[i * 3 + 1]!;
    vertices[o + 5] = 0 - prim.normals[i * 3 + 2]!;
    vertices[o + 6] = prim.uvs ? prim.uvs[i * 2]! : 0;
    vertices[o + 7] = prim.uvs ? prim.uvs[i * 2 + 1]! : 0;
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
  }
  const material = prim.material !== null ? parsed.materials[prim.material] : undefined;
  const f = material?.baseColorFactor ?? [1, 1, 1, 1];
  const hex = (v: number): string => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  const textureUrl = material?.baseColorImage !== null && material?.baseColorImage !== undefined
    ? textureUrls[material.baseColorImage] ?? null
    : null;
  return {
    vertices,
    // Indices are 16-bit when they fit — half the upload for typical models.
    indices: vcount <= 0xffff ? Uint16Array.from(prim.indices) : prim.indices,
    key: `${modelKey}:m${meshIndex}p${primIndex}`,
    bbox: vcount > 0
      ? { minX, minY, minZ, maxX, maxY, maxZ }
      : { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
    fill: `#${hex(f[0])}${hex(f[1])}${hex(f[2])}${hex(f[3])}`,
    textureUrl,
    doubleSided: material?.doubleSided === true,
  };
}

/**
 * Parse + register a model under `modelKey`. Idempotent; returns whether the
 * registry now holds it. Object URLs for embedded textures are minted here and
 * live for the session (models are few; revocation happens on re-register).
 */
export function registerModel(modelKey: string, bytes: ArrayBuffer): boolean {
  if (registry.has(modelKey)) return true;
  const parsed = parseGltf(bytes);
  const textureUrls = parsed.images.map((im) => {
    try {
      // Uint8Array → fresh ArrayBuffer: a subarray's buffer would leak the
      // whole GLB into the blob.
      const copy = im.bytes.slice();
      return URL.createObjectURL(new Blob([copy], { type: im.mimeType }));
    } catch {
      return '';
    }
  });
  const primitives = new Map<string, ModelPrimitiveEntry>();
  parsed.meshes.forEach((mesh, mi) => {
    mesh.primitives.forEach((_p, pi) => {
      const entry = primitiveToEntry(parsed, modelKey, mi, pi, textureUrls);
      if (entry) primitives.set(`${mi}:${pi}`, entry);
    });
  });
  registry.set(modelKey, { primitives, textureUrls });
  return true;
}

export function isModelRegistered(modelKey: string): boolean {
  return registry.has(modelKey);
}

/** The converted primitive for a layer's Model reference, or null. */
export function modelPrimitiveFor(ref: ModelPrimitiveRef): ModelPrimitiveEntry | null {
  return registry.get(ref.modelKey)?.primitives.get(`${ref.mesh}:${ref.prim}`) ?? null;
}

/** TEST SEAM: drop everything (object URLs are revoked). */
export function clearModelRegistry(): void {
  for (const entry of registry.values()) {
    for (const url of entry.textureUrls) {
      try { if (url) URL.revokeObjectURL(url); } catch { /* jsdom */ }
    }
  }
  registry.clear();
}

// ── Component readers ─────────────────────────────────────────────────

/** A primitive layer's { modelKey, mesh, prim }, or null. */
export function readNodeModelRef(node: SceneNode): ModelPrimitiveRef | null {
  for (const c of node.components) {
    if (c.type !== MODEL_COMPONENT) continue;
    const p = c.props as Record<string, unknown>;
    if (typeof p.modelKey === 'string' && typeof p.mesh === 'number' && typeof p.prim === 'number') {
      return { modelKey: p.modelKey, mesh: p.mesh, prim: p.prim };
    }
  }
  return null;
}

/** The imported ROOT's stored source ({ modelKey, glbData }), or null. */
export function readNodeModelSource(node: SceneNode): { modelKey: string; glbData: string } | null {
  for (const c of node.components) {
    if (c.type !== MODEL_COMPONENT) continue;
    const p = c.props as Record<string, unknown>;
    if (typeof p.modelKey === 'string' && typeof p.glbData === 'string' && p.glbData.startsWith('data:')) {
      return { modelKey: p.modelKey, glbData: p.glbData };
    }
  }
  return null;
}

// ── glTF TRS → compositor transform props ─────────────────────────────

/**
 * Conjugated quaternion → Tait-Bryan degrees for the renderer's R = Rz·Ry·Rx
 * (matrix4.compose). Pinned by a round-trip test against compose itself, so
 * whatever that convention is, this stays its inverse.
 */
export function gltfRotationToEulerDeg(q: [number, number, number, number]): { x: number; y: number; z: number } {
  // Change of basis (see file header): negate y and z components.
  const x = q[0], y = -q[1], z = -q[2], w = q[3];
  const n = Math.hypot(x, y, z, w) || 1;
  const qx = x / n, qy = y / n, qz = z / n, qw = w / n;
  // Rotation matrix rows (row-major), matching compose's r-naming.
  const r00 = 1 - 2 * (qy * qy + qz * qz);
  const r01 = 2 * (qx * qy - qz * qw);
  const r10 = 2 * (qx * qy + qz * qw);
  const r11 = 1 - 2 * (qx * qx + qz * qz);
  const r20 = 2 * (qx * qz - qy * qw);
  const r21 = 2 * (qy * qz + qx * qw);
  const r22 = 1 - 2 * (qx * qx + qy * qy);
  const DEG = 180 / Math.PI;
  const sy = -r20; // compose: r20 = −sin(y)
  if (Math.abs(sy) > 0.999999) {
    // Gimbal: fold x into z.
    return {
      x: 0,
      y: (sy > 0 ? 90 : -90),
      z: Math.atan2(-r01, r11) * DEG,
    };
  }
  return {
    x: Math.atan2(r21, r22) * DEG,
    y: Math.asin(sy) * DEG,
    z: Math.atan2(r10, r00) * DEG,
  };
}

/** glTF translation → compositor local offsets. */
export function gltfTranslationToLocal(t: [number, number, number]): { x: number; y: number; z: number } {
  return { x: t[0], y: 0 - t[1], z: 0 - t[2] };
}
