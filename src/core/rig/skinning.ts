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

/**
 * Below this total influence a vertex is treated as PARTIALLY bound and the
 * missing share rides on the bind pose instead of being normalized away.
 *
 * Why there is a threshold at all rather than a plain `total < 1` test: a fully
 * bound vertex's weights sum to 1 only up to float rounding, and dividing by
 * `total` (the historical path) is not bit-identical to adding a 1e-16 rest
 * share. The render-test goldens compare bytes, so the fully-bound case keeps
 * its exact old arithmetic and only genuinely partial weights take the new
 * branch.
 */
const FULLY_BOUND = 1 - 1e-6;

/**
 * Deform one vertex.
 *
 * Weights that sum to 1 (every auto-bound vertex) blend the bone matrices and
 * normalize, exactly as before. Weights that sum to LESS than 1 are partial:
 * the remainder rides on the vertex's own bind position, so influence that
 * falls off to zero fades the vertex smoothly back to rest.
 *
 * That distinction is the whole point. Normalizing a dying influence back up to
 * 1 makes a vertex holding 0.001 of one bone follow that bone COMPLETELY, which
 * turns any influence cutoff into a tear along the cutoff boundary — and, with
 * no cutoff at all, hands every far-away vertex a full share of whichever bones
 * it can reach. That is why rotating one arm bone used to swing a whole PNG
 * character: distance set the RATIO between bones and never whether a bone
 * reached the vertex in the first place.
 *
 * Falls back to the bind position when nothing influences the vertex.
 */
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
  if (total >= FULLY_BOUND) return { x: px / total, y: py / total };
  const rest = 1 - total;
  return { x: px + rest * v.x, y: py + rest * v.y };
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

/**
 * Cap and clean weights WITHOUT inflating them: identical to `normalizeWeights`
 * except that a total below 1 is left alone rather than scaled up to 1.
 *
 * Auto-binding needs this. `normalizeWeights` answers "how do these bones split
 * this vertex", which is the right question only once you already know a bone
 * owns it; a falloff that reaches zero needs the other question — "how much of
 * this vertex do the bones own at all" — and the shortfall is what `skinVertex`
 * spends on the bind pose. Scaling up is still applied when the total exceeds 1,
 * so a blend can never overshoot.
 */
export function clampWeights(
  weights: readonly VertexWeight[],
  maxInfluences = 4,
  epsilon = 1e-4,
): VertexWeight[] {
  const kept = weights
    .filter((w) => w.weight > epsilon)
    .sort((a, b) => (b.weight - a.weight) || (a.boneId < b.boneId ? -1 : a.boneId > b.boneId ? 1 : 0))
    .slice(0, maxInfluences);
  const sum = kept.reduce((s, w) => s + w.weight, 0);
  if (sum === 0) return [];
  if (sum <= 1) return kept.map((w) => ({ boneId: w.boneId, weight: w.weight }));
  return kept.map((w) => ({ boneId: w.boneId, weight: w.weight / sum }));
}
