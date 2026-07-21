/**
 * Linear blend skinning (LBS) — deform mesh vertices by a weighted blend of
 * bone transforms. This is the core of "artwork bends with the skeleton":
 *
 *     v' = Σ  weightᵢ · (poseWorldᵢ · bindInverseᵢ) · v
 *
 * Vertices are stored in BIND world space (where the mesh was bound to the
 * skeleton). `bindInverse` maps a vertex back into each bone's local frame;
 * `poseWorld` re-places it under the bone's current pose. Pure — the CPU
 * (Canvas2D) and GPU (vertex-shader) skinning paths both build on this.
 */

import { type Mat2D, apply, multiply } from './mat2d';

export interface VertexWeight {
  boneId: string;
  weight: number;
}

export interface SkinVertex {
  /** Bind-pose position, world space. */
  x: number;
  y: number;
  /** Bone influences. Weights need not be pre-normalized. */
  weights: VertexWeight[];
}

/** Deform one vertex. Falls back to the bind position if it has no live bones. */
export function skinVertex(
  v: SkinVertex,
  poseWorld: Map<string, Mat2D>,
  bindInverse: Map<string, Mat2D>,
): { x: number; y: number } {
  let px = 0;
  let py = 0;
  let total = 0;
  for (const { boneId, weight } of v.weights) {
    if (weight === 0) continue;
    const pose = poseWorld.get(boneId);
    const bind = bindInverse.get(boneId);
    if (!pose || !bind) continue;
    const p = apply(multiply(pose, bind), v.x, v.y);
    px += p.x * weight;
    py += p.y * weight;
    total += weight;
  }
  if (total === 0) return { x: v.x, y: v.y };
  return { x: px / total, y: py / total };
}

/** Deform a whole mesh. */
export function skinMesh(
  vertices: readonly SkinVertex[],
  poseWorld: Map<string, Mat2D>,
  bindInverse: Map<string, Mat2D>,
): Array<{ x: number; y: number }> {
  return vertices.map((v) => skinVertex(v, poseWorld, bindInverse));
}

/**
 * Normalize a vertex's weights to sum to 1, dropping influences below `epsilon`
 * and keeping at most `maxInfluences` (the strongest). Weight-binding and the
 * GPU path both want clean, capped, normalized weights.
 */
export function normalizeWeights(
  weights: readonly VertexWeight[],
  maxInfluences = 4,
  epsilon = 1e-4,
): VertexWeight[] {
  const kept = weights
    .filter((w) => w.weight > epsilon)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, maxInfluences);
  const sum = kept.reduce((s, w) => s + w.weight, 0);
  if (sum === 0) return [];
  return kept.map((w) => ({ boneId: w.boneId, weight: w.weight / sum }));
}
