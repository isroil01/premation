/**
 * Skeleton — a hierarchy of 2D bones with forward kinematics and bind-pose
 * capture. Pure and framework-free; the animation engine drives a bone's
 * local {x, y, rotation} exactly like any other node transform, so keyframing
 * bones reuses the existing scalar-track machinery.
 */

import { type Mat2D, IDENTITY, fromTRS, multiply, apply, invert } from './mat2d';

export interface Bone {
  id: string;
  /** Human-readable label. Falls back to `id` in the UI when absent. */
  name?: string;
  parentId: string | null;
  /** Bone length along its local +x axis — the tip is at (length, 0). */
  length: number;
  /** Local pose relative to the parent (or comp, if root). */
  x: number;
  y: number;
  rotation: number;
  scaleX?: number;
  scaleY?: number;
}

export interface Skeleton {
  bones: Bone[];
}

/**
 * World transform of every bone (parent-first, memoized). Accepts bones in any
 * order; a cycle resolves to identity for the offending bone rather than
 * looping forever.
 */
export function computeWorldTransforms(skel: Skeleton): Map<string, Mat2D> {
  const byId = new Map(skel.bones.map((b) => [b.id, b]));
  const world = new Map<string, Mat2D>();
  const visiting = new Set<string>();

  const resolve = (id: string): Mat2D => {
    const cached = world.get(id);
    if (cached) return cached;
    const b = byId.get(id);
    if (!b || visiting.has(id)) return IDENTITY;
    visiting.add(id);
    const local = fromTRS(b.x, b.y, b.rotation, b.scaleX ?? 1, b.scaleY ?? 1);
    const m = b.parentId ? multiply(resolve(b.parentId), local) : local;
    visiting.delete(id);
    world.set(id, m);
    return m;
  };

  for (const b of skel.bones) resolve(b.id);
  return world;
}

/** Per-bone inverse of the bind-pose world transforms (for skinning). */
export function computeBindInverses(bindWorld: Map<string, Mat2D>): Map<string, Mat2D> {
  const inv = new Map<string, Mat2D>();
  for (const [id, m] of bindWorld) inv.set(id, invert(m));
  return inv;
}

/** World position of a bone's tip — for drawing bones and seeding IK. */
export function boneTip(world: Mat2D, length: number): { x: number; y: number } {
  return apply(world, length, 0);
}

/** World position of a bone's root (origin). */
export function boneRoot(world: Mat2D): { x: number; y: number } {
  return apply(world, 0, 0);
}
