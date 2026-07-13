/**
 * TransformSystem — computes world matrices for the graph. A batch pass walks
 * the tree once (iteratively) and recomputes only where a transform, or an
 * ancestor's transform, changed (dirty propagation). Reads are then O(1).
 */

import type { Matrix2D, Matrix4 } from '../types';
import type { SceneNode } from '../nodes/SceneNode';
import { multiply } from '../utils/matrix';
import { multiply as multiply4, clone as cloneMat4 } from '../utils/matrix4';

function copyInto(src: Readonly<Matrix2D>, dst: Matrix2D): void {
  dst.a = src.a; dst.b = src.b; dst.c = src.c; dst.d = src.d; dst.e = src.e; dst.f = src.f;
}

/**
 * Recompute world matrices for the subtree rooted at `root`. Nodes whose
 * transform (or an ancestor's) is dirty are recomputed; the rest are skipped.
 */
export function updateWorldTransforms(root: SceneNode): void {
  const stack: Array<{ node: SceneNode; parentDirty: boolean }> = [{ node: root, parentDirty: false }];
  while (stack.length) {
    const frame = stack.pop() as { node: SceneNode; parentDirty: boolean };
    const node = frame.node;
    const t = node.transform;
    const dirty = frame.parentDirty || t.worldDirty;
    if (dirty) {
      const local = t.getLocalMatrix();
      const world = t.worldMatrixRef();
      if (node.parent) multiply(node.parent.transform.getWorldMatrix(), local, world);
      else copyInto(local, world);
      t.worldDirty = false;
    }
    for (const child of node.children) stack.push({ node: child, parentDirty: dirty });
  }
}

/**
 * Lazily compute a single node's world matrix by composing along its path from
 * the root. Useful for hit-testing one node without a full pass.
 */
export function computeWorldMatrix(node: SceneNode, out?: Matrix2D): Matrix2D {
  const path = node.path(); // root → node
  const result: Matrix2D = out ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const first = path[0];
  if (!first) return result;
  copyInto(first.transform.getLocalMatrix(), result);
  for (let i = 1; i < path.length; i++) {
    multiply(result, (path[i] as SceneNode).transform.getLocalMatrix(), result);
  }
  return result;
}

/**
 * Compute a single node's world **4x4** matrix by composing its 4x4 locals
 * along the path from the root. Every local is either a true 3D compose or a
 * lifted-2D affine (see {@link import('../components/TransformComponent')}),
 * so a 3D node nested under 2D ancestors composes correctly and uniformly.
 * Lazy and allocation-cheap; used by the renderer for 3D layers only.
 */
export function computeWorldMatrix4(node: SceneNode): Matrix4 {
  const path = node.path(); // root → node
  const first = path[0];
  if (!first) return cloneMat4(node.transform.getLocalMatrix4() as Matrix4);
  const result: Matrix4 = cloneMat4(first.transform.getLocalMatrix4() as Matrix4);
  for (let i = 1; i < path.length; i++) {
    multiply4(result, (path[i] as SceneNode).transform.getLocalMatrix4() as Matrix4, result);
  }
  return result;
}
