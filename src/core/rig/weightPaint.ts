/**
 * Weight painting — per-vertex bone-weight OVERRIDES layered on top of the
 * automatic inverse-distance binding.
 *
 * `autoWeight.ts` has always said "a paint tool can override these later"; this
 * is that layer. Auto-weighting is a good first guess and a bad final answer:
 * it cannot know that a sleeve belongs to the forearm rather than the torso it
 * happens to sit near, and there is no amount of bone placement that fixes it.
 *
 * Design:
 *   • Overrides are SPARSE — only painted vertices are stored, so an untouched
 *     rig costs nothing and serialises to nothing.
 *   • They are stored per (bone, vertex) as an absolute target weight in [0,1].
 *     Blending is resolved at bind time: painted bones take their painted value,
 *     the remaining auto weight is redistributed across the unpainted bones, and
 *     the whole vertex is renormalised.
 *   • Vertex indices are only meaningful against a specific rest mesh, so the
 *     map records the vertex count it was painted at and is DISCARDED when the
 *     mesh is rebuilt at a different resolution. Silently re-using stale indices
 *     would smear weights onto unrelated parts of the artwork.
 *
 * Pure and deterministic — no clock, no randomness, fixed iteration order.
 */

import type { VertexWeight } from './skinning';
import { normalizeWeights } from './skinning';

/** Sparse per-bone overrides: boneId → (vertexIndex → weight in [0,1]). */
export interface WeightPaintMap {
  /** Rest-mesh vertex count these indices were painted against. */
  vertexCount: number;
  /** boneId → { vertexIndex: weight }. Plain JSON so it serialises with the rig. */
  bones: Record<string, Record<number, number>>;
}

export type PaintMode = 'add' | 'subtract' | 'smooth';

export function emptyWeightPaint(vertexCount: number): WeightPaintMap {
  return { vertexCount, bones: {} };
}

/** True when the map has no painted vertices at all. */
export function isWeightPaintEmpty(map: WeightPaintMap | undefined): boolean {
  if (!map) return true;
  for (const key of Object.keys(map.bones)) {
    if (Object.keys(map.bones[key]!).length > 0) return false;
  }
  return true;
}

/**
 * Is this map still valid for a mesh of `vertexCount` vertices? Indices are
 * positional, so a rebuilt mesh at a different density invalidates them.
 */
export function weightPaintMatches(
  map: WeightPaintMap | undefined,
  vertexCount: number,
): boolean {
  return !!map && map.vertexCount === vertexCount;
}

/**
 * Apply a circular brush to `map`, returning a NEW map (never mutates).
 *
 * `falloff` is the brush's soft edge as a fraction of the radius (0 = hard,
 * 1 = fully feathered). `strength` scales the per-stroke delta.
 *
 *   add      — push the vertex's weight for `boneId` toward 1
 *   subtract — push it toward 0
 *   smooth   — pull it toward the average of the values already in the brush,
 *              which is what removes the crunchy boundary auto-weighting leaves
 */
export function paintWeights(
  map: WeightPaintMap,
  boneId: string,
  vertices: Float32Array,
  center: { x: number; y: number },
  radius: number,
  opts: {
    mode: PaintMode;
    strength?: number;
    falloff?: number;
    /** Current effective weight of a vertex, used as the base when unpainted. */
    baseWeightAt?: (vertexIndex: number) => number;
  },
): WeightPaintMap {
  const n = vertices.length / 4;
  if (n !== map.vertexCount) return map; // stale indices — refuse rather than smear
  const r = Math.max(1e-6, radius);
  const strength = Math.max(0, Math.min(1, opts.strength ?? 0.5));
  const falloff = Math.max(0, Math.min(1, opts.falloff ?? 0.5));
  const inner = r * (1 - falloff);

  const current = map.bones[boneId] ?? {};
  const base = opts.baseWeightAt ?? (() => 0);

  // Gather the affected vertices and their brush influence first — `smooth`
  // needs the neighbourhood average before it can write anything.
  const hits: Array<{ i: number; infl: number; w: number }> = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(vertices[i * 4]! - center.x, vertices[i * 4 + 1]! - center.y);
    if (d > r) continue;
    // Smoothstep across the feathered band; 1 inside the hard core.
    let infl = 1;
    if (d > inner && r > inner) {
      const u = (d - inner) / (r - inner);
      infl = 1 - u * u * (3 - 2 * u);
    }
    const w = current[i] ?? base(i);
    hits.push({ i, infl, w });
    sum += w;
  }
  if (hits.length === 0) return map;
  const mean = sum / hits.length;

  const next: Record<number, number> = { ...current };
  for (const { i, infl, w } of hits) {
    const amount = infl * strength;
    let target: number;
    if (opts.mode === 'add') target = 1;
    else if (opts.mode === 'subtract') target = 0;
    else target = mean;
    const v = w + (target - w) * amount;
    next[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }

  return { vertexCount: map.vertexCount, bones: { ...map.bones, [boneId]: next } };
}

/**
 * Merge painted overrides into one vertex's auto-computed weights.
 *
 * Painted bones keep their painted value verbatim. Whatever weight remains
 * (1 − Σ painted) is shared out across the unpainted bones in proportion to
 * their auto weights, so painting one bone up naturally pulls the others down
 * instead of leaving the vertex over-weighted. When painting saturates the
 * vertex, the unpainted bones drop to zero.
 */
export function applyWeightPaint(
  auto: readonly VertexWeight[],
  vertexIndex: number,
  map: WeightPaintMap | undefined,
  maxInfluences = 4,
): VertexWeight[] {
  if (!map) return auto.slice();

  const painted = new Map<string, number>();
  for (const boneId of Object.keys(map.bones)) {
    const v = map.bones[boneId]![vertexIndex];
    if (v !== undefined) painted.set(boneId, v);
  }
  if (painted.size === 0) return auto.slice();

  const paintedTotal = [...painted.values()].reduce((a, b) => a + b, 0);
  const merged: VertexWeight[] = [];

  const autoUnpainted = auto.filter((w) => !painted.has(w.boneId));
  const autoRest = autoUnpainted.reduce((a, w) => a + w.weight, 0);
  const remaining = Math.max(0, 1 - paintedTotal);

  for (const [boneId, weight] of painted) merged.push({ boneId, weight });
  if (autoRest > 1e-9 && remaining > 1e-9) {
    for (const w of autoUnpainted) {
      merged.push({ boneId: w.boneId, weight: (w.weight / autoRest) * remaining });
    }
  }
  return normalizeWeights(merged, maxInfluences);
}

/** Drop every painted override for one bone (returns a new map). */
export function clearBonePaint(map: WeightPaintMap, boneId: string): WeightPaintMap {
  if (!map.bones[boneId]) return map;
  const bones = { ...map.bones };
  delete bones[boneId];
  return { vertexCount: map.vertexCount, bones };
}
