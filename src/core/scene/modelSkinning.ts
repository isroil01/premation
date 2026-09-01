/**
 * CPU skinning for imported glTF models — pose resolution at snapshot time.
 *
 * A skinned primitive's vertices are placed by its JOINTS, not by its own
 * layer transform (the glTF rule). The joints are ordinary imported null
 * layers, so their world matrices at the current frame come from the exact
 * resolvers the renderer's 3D parenting already uses — a joint keyframed by a
 * baked clip, dragged by the gizmo, or reparented by hand all just work.
 *
 * The math folds the glTF skinning equation into the engine's draw path.
 * The renderer multiplies mesh vertices by the layer's world matrix M, so this
 * module emits vertices PRE-multiplied by M⁻¹:
 *
 *   v_out = M⁻¹ · Σᵢ wᵢ · Wⱼᵢ · B̃ⱼᵢ · ṽ
 *
 * where W is a joint layer's world matrix, B̃ its conjugated inverse bind, and
 * ṽ the registry's basis-flipped vertex. M then cancels on draw, leaving the
 * spec's rule exactly: joints alone place the skin.
 *
 * GPU buffers are cached by geometry key, so a skinned pose gets a POSE-HASHED
 * key — identical poses (a paused playhead, a looped cycle) reuse one buffer,
 * and stale poses age out of the renderer's pool by its normal idle GC. The
 * skinned Float32Array itself is memoized per layer on the same hash, so
 * re-snapshots at an unchanged time cost a hash compare, not a re-skin.
 */

import { Matrix4Math, type Matrix4 } from '@motion/scene';
import { MESH_VERTEX_FLOATS } from '@core/geometry/extrudeMesh';
import {
  modelSkinFor,
  readNodeGltfIndex,
  readNodeModelSource,
  type ModelPrimitiveEntry,
  type ModelPrimitiveRef,
} from './modelMesh';
import type { SceneNode } from '@core/types';

export interface SkinResolvers {
  nodeById: Map<string, SceneNode>;
  parentOf: (id: string) => string | null;
  /** A layer's composed world matrix at the frame's time, or null. */
  jointWorld: (layerId: string) => Matrix4 | null;
}

/**
 * glTF joint index → layer id, for the model instance `meshNodeId` belongs to.
 * Found by walking UP to the imported root (the layer holding the model
 * source) and scanning its subtree for persisted gltfNode markers — stable
 * across save/reload, tolerant of user reparenting inside the subtree.
 * `cache` is per-snapshot (keyed by root id).
 */
export function jointLayerMapFor(
  meshNodeId: string,
  modelKey: string,
  r: SkinResolvers,
  cache: Map<string, Map<number, string> | null>,
): Map<number, string> | null {
  // Ascend to the instance root.
  let rootId: string | null = null;
  const seen = new Set<string>();
  for (let id: string | null = meshNodeId; id && !seen.has(id); ) {
    seen.add(id);
    const n = r.nodeById.get(id);
    if (n && readNodeModelSource(n)?.modelKey === modelKey) { rootId = id; break; }
    id = r.parentOf(id);
  }
  if (!rootId) return null;
  const hit = cache.get(rootId);
  if (hit !== undefined) return hit;

  const map = new Map<number, string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const n = r.nodeById.get(id);
    if (!n) continue;
    const gi = readNodeGltfIndex(n);
    if (gi && gi.modelKey === modelKey && !map.has(gi.gltfNode)) map.set(gi.gltfNode, id);
    for (const c of n.children) stack.push(c);
  }
  cache.set(rootId, map);
  return map;
}

/** FNV-1a over the quantized matrix floats — the pose's buffer-cache identity. */
function poseHash(mats: Float32Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < mats.length; i++) {
    // ~1/1024 px quantization: fine enough to never visibly snap, coarse
    // enough that a looped cycle lands on identical hashes each pass.
    const q = Math.round(mats[i]! * 1024) | 0;
    h = Math.imul(h ^ (q & 0xff), 0x01000193);
    h = Math.imul(h ^ ((q >> 8) & 0xff), 0x01000193);
    h = Math.imul(h ^ ((q >> 16) & 0xff), 0x01000193);
    h = Math.imul(h ^ ((q >> 24) & 0xff), 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Apply per-vertex skinning: 4 weighted joint matrices per vertex. */
export function skinVertices(
  src: Float32Array,
  skinData: NonNullable<ModelPrimitiveEntry['skinData']>,
  mats: Float32Array,
): Float32Array {
  const out = new Float32Array(src.length);
  const vcount = src.length / MESH_VERTEX_FLOATS;
  const jointCount = mats.length / 16;
  for (let v = 0; v < vcount; v++) {
    const o = v * MESH_VERTEX_FLOATS;
    const x = src[o]!, y = src[o + 1]!, z = src[o + 2]!;
    const nx = src[o + 3]!, ny = src[o + 4]!, nz = src[o + 5]!;
    let px = 0, py = 0, pz = 0;
    let qx = 0, qy = 0, qz = 0;
    for (let c = 0; c < 4; c++) {
      const w = skinData.weights[v * 4 + c]!;
      if (w === 0) continue;
      const j = skinData.joints[v * 4 + c]!;
      if (j >= jointCount) continue;
      const m = j * 16;
      const m0 = mats[m]!, m1 = mats[m + 1]!, m2 = mats[m + 2]!;
      const m4 = mats[m + 4]!, m5 = mats[m + 5]!, m6 = mats[m + 6]!;
      const m8 = mats[m + 8]!, m9 = mats[m + 9]!, m10 = mats[m + 10]!;
      px += w * (m0 * x + m4 * y + m8 * z + mats[m + 12]!);
      py += w * (m1 * x + m5 * y + m9 * z + mats[m + 13]!);
      pz += w * (m2 * x + m6 * y + m10 * z + mats[m + 14]!);
      // Normals through the basis only. Joints are rotations + near-uniform
      // scales in practice, so the inverse-transpose is approximated by the
      // basis itself and a renormalize — the standard real-time shortcut.
      qx += w * (m0 * nx + m4 * ny + m8 * nz);
      qy += w * (m1 * nx + m5 * ny + m9 * nz);
      qz += w * (m2 * nx + m6 * ny + m10 * nz);
    }
    const nlen = Math.hypot(qx, qy, qz);
    out[o] = px; out[o + 1] = py; out[o + 2] = pz;
    if (nlen > 1e-6) {
      out[o + 3] = qx / nlen; out[o + 4] = qy / nlen; out[o + 5] = qz / nlen;
    } else {
      out[o + 3] = nx; out[o + 4] = ny; out[o + 5] = nz;
    }
    out[o + 6] = src[o + 6]!;
    out[o + 7] = src[o + 7]!;
  }
  return out;
}

// Memo of the last skinned pose per layer — re-snapshots at an unchanged
// time (selection changes, panel redraws) skip the vertex loop entirely.
const skinnedMemo = new Map<string, { hash: string; vertices: Float32Array }>();
const SKINNED_MEMO_CAP = 64;

/** TEST SEAM. */
export function clearSkinnedMemo(): void {
  skinnedMemo.clear();
}

/**
 * The skinned replacement geometry for a primitive at the current pose, or
 * null when the pose cannot be resolved (no skin def, a joint layer deleted,
 * a degenerate layer matrix) — callers then draw the rigid bind pose, which
 * is visible and honest rather than half-deformed.
 */
export function skinnedMeshFor(
  meshNode: SceneNode,
  ref: ModelPrimitiveRef,
  entry: ModelPrimitiveEntry,
  layerWorld: Matrix4,
  r: SkinResolvers,
  jointMapCache: Map<string, Map<number, string> | null>,
): { key: string; vertices: Float32Array } | null {
  if (!entry.skinData || ref.skin === undefined) return null;
  const skin = modelSkinFor(ref.modelKey, ref.skin);
  if (!skin || skin.joints.length === 0) return null;
  const jointMap = jointLayerMapFor(meshNode.id, ref.modelKey, r, jointMapCache);
  if (!jointMap) return null;
  const minv = Matrix4Math.invert(layerWorld);
  if (!minv) return null;

  const mats = new Float32Array(skin.joints.length * 16);
  const scratch: Matrix4 = Matrix4Math.identity();
  for (let j = 0; j < skin.joints.length; j++) {
    const layerId = jointMap.get(skin.joints[j]!);
    const world = layerId ? r.jointWorld(layerId) : null;
    if (!world) return null;
    const bind = Array.from(skin.invBind.subarray(j * 16, j * 16 + 16)) as unknown as Matrix4;
    Matrix4Math.multiply(world, bind, scratch);
    const full = Matrix4Math.multiply(minv, scratch);
    mats.set(full, j * 16);
  }

  const hash = poseHash(mats);
  const memoKey = `${entry.key}#${meshNode.id}`;
  const memo = skinnedMemo.get(memoKey);
  let vertices: Float32Array;
  if (memo && memo.hash === hash) {
    vertices = memo.vertices;
  } else {
    vertices = skinVertices(entry.vertices, entry.skinData, mats);
    if (skinnedMemo.size >= SKINNED_MEMO_CAP && !skinnedMemo.has(memoKey)) {
      const oldest = skinnedMemo.keys().next().value;
      if (oldest !== undefined) skinnedMemo.delete(oldest);
    }
    skinnedMemo.set(memoKey, { hash, vertices });
  }
  return { key: `${entry.key}:sk-${hash}`, vertices };
}
