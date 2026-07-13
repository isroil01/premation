/**
 * World-transform composition (Prompt E3 — parenting).
 *
 * A layer's on-screen placement is its LOCAL transform composed with its
 * parent's WORLD transform, all the way up the chain — After Effects-style
 * parenting. The app stores transforms as component props (x/y/rotation/scale),
 * so composition happens here rather than in @motion/scene's TransformSystem
 * (which owns a separate node model). We reuse @motion/scene's tested 2×3
 * matrix maths for the composition itself.
 *
 * The decomposition folds any shear from a rotated + non-uniformly-scaled
 * parent back into translate/rotate/scale (the renderer draws in TRS), which is
 * exact for the common cases and a documented approximation otherwise.
 */

import { Matrix, type Matrix2D } from '@motion/scene';

export interface LocalTransform {
  x: number;
  y: number;
  /** Degrees. */
  rotation: number;
  scaleX: number;
  scaleY: number;
}

const DEG = Math.PI / 180;

/** A node's local transform → a 2×3 matrix (rotation about the node origin). */
export function localMatrix(l: LocalTransform): Matrix2D {
  return Matrix.compose({
    position: { x: l.x, y: l.y },
    rotation: l.rotation * DEG,
    scale: { x: l.scaleX, y: l.scaleY },
    skew: { x: 0, y: 0 },
    anchor: { x: 0, y: 0 },
  });
}

/** Decompose a world matrix back into a TRS local-shaped transform. */
export function matrixToLocal(m: Matrix2D): LocalTransform {
  const d = Matrix.decompose(m);
  return {
    x: d.position.x,
    y: d.position.y,
    rotation: d.rotation / DEG,
    scaleX: d.scale.x,
    scaleY: d.scale.y,
  };
}

export type LocalOf = (nodeId: string) => LocalTransform | null;
export type ParentOf = (nodeId: string) => string | null;

/**
 * World matrix of a node: `parentWorld · local`, memoized per call via `cache`.
 * A node with no local transform (e.g. a group with no Transform component)
 * contributes identity, so it passes its parent's world straight through.
 */
export function worldMatrixOf(
  nodeId: string,
  localOf: LocalOf,
  parentOf: ParentOf,
  cache: Map<string, Matrix2D> = new Map(),
): Matrix2D {
  const hit = cache.get(nodeId);
  if (hit) return hit;
  const local = localOf(nodeId);
  const lm = local ? localMatrix(local) : Matrix.identity();
  const parent = parentOf(nodeId);
  const world = parent ? Matrix.multiply(worldMatrixOf(parent, localOf, parentOf, cache), lm) : lm;
  cache.set(nodeId, world);
  return world;
}

/** World transform (TRS) of a node, composed along its parent chain. */
export function worldTransformOf(
  nodeId: string,
  localOf: LocalOf,
  parentOf: ParentOf,
  cache?: Map<string, Matrix2D>,
): LocalTransform {
  return matrixToLocal(worldMatrixOf(nodeId, localOf, parentOf, cache));
}

/**
 * Given a child's world matrix and a new parent's world matrix, the local
 * transform the child must adopt to STAY VISUALLY PUT under the new parent:
 * `local = inverse(parentWorld) · childWorld`.
 */
export function localUnderParent(childWorld: Matrix2D, parentWorld: Matrix2D): LocalTransform {
  return matrixToLocal(Matrix.multiply(Matrix.invert(parentWorld), childWorld));
}
