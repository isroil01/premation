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
 *
 * PARENT CYCLES. A document can only hold one if it was damaged or written
 * by something other than the editor, but it must still draw (CLAUDE.md: one
 * bad layer never blanks a frame). Every node ON a cycle is treated as a ROOT
 * — its world is its own local matrix — and `onCycle` is called with its id;
 * nodes parented INTO the cycle compose onto it normally. The rule depends
 * only on the graph, never on which node was asked for first, so the result
 * is the same whatever order a frame resolves its layers in. This used to be
 * a recursion with no guard: a cycle was a stack overflow. The C++ engine
 * (native/libs/motion_transform `world_matrices_2d`) applies the same rule and
 * reports the same nodes; golden_transform.inc pins both.
 *
 * Iterative, so a very deep chain cannot overflow the stack either.
 */
export function worldMatrixOf(
  nodeId: string,
  localOf: LocalOf,
  parentOf: ParentOf,
  cache: Map<string, Matrix2D> = new Map(),
  onCycle?: (nodeId: string) => void,
): Matrix2D {
  const hit = cache.get(nodeId);
  if (hit) return hit;
  // Walk up to a root, an already-resolved ancestor, or back onto this walk.
  const path: string[] = [];
  const onPath = new Map<string, number>();
  let above: Matrix2D | null = null; // world of the last path node's parent, if resolved
  let cycleFrom = -1; // path[cycleFrom..] is a cycle
  for (let id = nodeId; ;) {
    onPath.set(id, path.length);
    path.push(id);
    const parent = parentOf(id);
    if (!parent) break;
    const resolved = cache.get(parent);
    if (resolved) { above = resolved; break; }
    const seenAt = onPath.get(parent);
    if (seenAt !== undefined) { cycleFrom = seenAt; break; }
    id = parent;
  }
  // Fill root-side first: `multiply(parentWorld, local)` exactly as before.
  let world: Matrix2D = Matrix.identity();
  for (let i = path.length - 1; i >= 0; i--) {
    const id = path[i]!;
    const local = localOf(id);
    const lm = local ? localMatrix(local) : Matrix.identity();
    if (cycleFrom >= 0 && i >= cycleFrom) {
      world = lm;
      onCycle?.(id);
    } else if (i === path.length - 1) {
      world = above ? Matrix.multiply(above, lm) : lm;
    } else {
      world = Matrix.multiply(world, lm);
    }
    cache.set(id, world);
  }
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
