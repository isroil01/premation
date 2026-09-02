/**
 * Auto-weighting — bind mesh vertices to bones by proximity, so a freshly-rigged
 * character deforms sensibly before any manual weight painting. Each vertex gets
 * inverse-distance weights to the nearest bone SEGMENTS (root→tip), normalized
 * and capped. Pure; a paint tool can override these later.
 */

import type { Vec2 } from './ik';
import type { Mat2D } from './mat2d';
import type { Bone } from './skeleton';
import { boneRoot, boneTip } from './skeleton';
import { normalizeWeights, type VertexWeight } from './skinning';

export interface BoneSegment {
  id: string;
  a: Vec2; // world root
  b: Vec2; // world tip
  /** `Bone.influenceRadius`, carried through. Absent = unlimited reach. */
  radius?: number;
}

/** Shortest distance from point `p` to segment `a`→`b`. */
export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

/** Each bone's world segment (root→tip), for weighting. */
export function boneSegments(bones: readonly Bone[], world: Map<string, Mat2D>): BoneSegment[] {
  const segs: BoneSegment[] = [];
  for (const bone of bones) {
    const m = world.get(bone.id);
    if (!m) continue;
    segs.push({
      id: bone.id,
      a: boneRoot(m),
      b: boneTip(m, bone.length),
      ...(bone.influenceRadius !== undefined ? { radius: bone.influenceRadius } : {}),
    });
  }
  return segs;
}

/**
 * Weights for one vertex: raw weight = 1 / (distance^falloff + eps), then
 * normalized and capped to `maxInfluences`. Higher `falloff` = tighter, more
 * localized influence.
 */
export function autoWeightVertex(
  p: Vec2,
  segments: readonly BoneSegment[],
  falloff = 2,
  maxInfluences = 4,
): VertexWeight[] {
  const raw: VertexWeight[] = segments.map((s) => {
    const d = distanceToSegment(p, s.a, s.b);
    return { boneId: s.id, weight: 1 / (Math.pow(d, falloff) + 1e-6) };
  });
  return normalizeWeights(raw, maxInfluences);
}

/** Auto-weight a whole mesh. Returns one weight list per vertex (index-aligned). */
export function autoWeightMesh(
  vertices: readonly Vec2[],
  segments: readonly BoneSegment[],
  falloff = 2,
  maxInfluences = 4,
): VertexWeight[][] {
  return vertices.map((v) => autoWeightVertex(v, segments, falloff, maxInfluences));
}
