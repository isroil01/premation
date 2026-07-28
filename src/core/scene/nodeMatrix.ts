/**
 * A 3D layer's model matrix — ONE formula, shared.
 *
 * The order (translate → Rz·Ry·Rx with orientation folded in → scale → un-anchor)
 * is not arbitrary: it is what `buildSnapshot.affineAt` composes, and anything
 * that hit-tests or highlights projected geometry has to match it exactly or the
 * chrome drifts off the pixels. It has already been written out by hand twice
 * (ports.ts, buildSnapshot.ts); this is the third caller's chance to not be a
 * third copy.
 */

import { Matrix4Math, type Matrix2D, type Matrix4 } from '@motion/scene';
import { readGeometry } from '@core/workspace/geometry';
import { readNodeAnchor } from '@core/scene/anchor';
import { readNode3D } from '@core/scene/threeD';
import { defaultAnimation } from '@motion/animation';
import { getRemappedTime } from '@core/timeline/TimelineController';
import type { SceneNode } from '@core/types';

export interface Node3DTransform {
  x: number;
  y: number;
  z: number;
  /** Degrees, animatable rotation only — orientation is passed separately. */
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  orientationX: number;
  orientationY: number;
  orientationZ: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  anchorX: number;
  anchorY: number;
  anchorZ: number;
}

const DEG = Math.PI / 180;

/** Compose the 4×4 from already-resolved scalars. */
export function composeNodeWorld3d(v: Node3DTransform): Matrix4 {
  return Matrix4Math.compose({
    position: { x: v.x, y: v.y, z: v.z },
    rotation: {
      x: (v.rotationX + v.orientationX) * DEG,
      y: (v.rotationY + v.orientationY) * DEG,
      z: (v.rotationZ + v.orientationZ) * DEG,
    },
    scale: { x: v.scaleX, y: v.scaleY, z: v.scaleZ },
    anchor: { x: v.anchorX, y: v.anchorY, z: v.anchorZ },
  });
}

/**
 * Resolve a node's 3D transform at `time` (raw comp time) — base props with the
 * animated track layered on top.
 *
 * The `av.get(p) ?? base` pattern matters: `evaluateNode` returns ANIMATED
 * properties only, so falling back to a literal instead of the base prop pins
 * un-keyframed layers to zero. That exact bug has been fixed three times in this
 * codebase; keeping the fallback here means callers cannot reintroduce it.
 */
export function resolveNode3DTransform(node: SceneNode, time: number): Node3DTransform | null {
  const g = readGeometry(node);
  if (!g) return null;
  const av = defaultAnimation.evaluateNode(node.id, getRemappedTime(node.id, time));
  const base = readNode3D(node);
  const anchor = readNodeAnchor(node);
  return {
    x: av.get('x') ?? g.x,
    y: av.get('y') ?? g.y,
    z: av.get('z') ?? base.z,
    rotationX: av.get('rotationX') ?? base.rotationX,
    rotationY: av.get('rotationY') ?? base.rotationY,
    rotationZ: av.get('rotation') ?? g.rotationDeg,
    orientationX: av.get('orientationX') ?? base.orientationX,
    orientationY: av.get('orientationY') ?? base.orientationY,
    orientationZ: av.get('orientationZ') ?? base.orientationZ,
    scaleX: av.get('scaleX') ?? av.get('scale') ?? g.scaleX,
    scaleY: av.get('scaleY') ?? av.get('scale') ?? g.scaleY,
    scaleZ: av.get('scaleZ') ?? 1,
    anchorX: av.get('anchorX') ?? anchor.x,
    anchorY: av.get('anchorY') ?? anchor.y,
    anchorZ: av.get('anchorZ') ?? base.anchorZ,
  };
}

/** The node's model matrix at `time`, or null for a node with no geometry. */
export function nodeWorld3d(node: SceneNode, time: number): Matrix4 | null {
  const t = resolveNode3DTransform(node, time);
  return t ? composeNodeWorld3d(t) : null;
}

// ── 3D parenting ────────────────────────────────────────────────────────────

/**
 * The resolvers a 3D parent chain needs. Passed in rather than read from the
 * global graph so the renderer can supply its own per-frame caches and the
 * viewport chrome can supply the playhead-sampled equivalents — the two must
 * agree exactly or the chrome drifts off the pixels.
 */
export interface Parent3DResolvers {
  parentOf: (id: string) => string | null;
  /** The node's OWN local 3D transform (not parent-composed). */
  local3DOf: (id: string) => Node3DTransform | null;
  /** True when this node participates in 3D space (its 3D switch is on). */
  is3DOf: (id: string) => boolean;
  /**
   * The node's 2D WORLD affine, for flattening a 2D ancestor. After Effects
   * flattens a 2D parent's transform into 2D before applying it to a 3D child,
   * which is what this expresses.
   */
  world2DOf: (id: string) => Matrix2D;
}

/**
 * The accumulated 3D world matrix of a node's PARENT chain, or null when no
 * ancestor is 3D.
 *
 * Null is the signal to keep the ordinary 2D path: without a 3D ancestor the
 * existing `worldTransformOf` composition already produces the right answer and
 * must be left byte-identical.
 *
 * With one, the chain has to be composed as 4×4s. `worldTransformOf` is a 2×3
 * affine — x/y/rotation/scaleX/scaleY only — so a child inherited none of its
 * parent's `z`, `rotationX` or `rotationY`. A 3D null dollying away in Z left
 * its children sitting exactly where they were, which is the opposite of what
 * parenting is for.
 *
 * A 2D ancestor contributes its flattened 2D world affine, lifted to 4×4 (z
 * untouched) — AE's rule, and identical to the old behaviour for that case.
 */
export function parentWorld3d(
  nodeId: string,
  r: Parent3DResolvers,
  cache: Map<string, Matrix4 | null> = new Map(),
): Matrix4 | null {
  const parentId = r.parentOf(nodeId);
  if (!parentId) return null;
  const hit = cache.get(parentId);
  if (hit !== undefined) return hit;

  // Guard against a cycle in the parent chain: a malformed graph must not hang
  // the renderer. The chain is walked with an explicit seen-set rather than
  // trusting the data.
  const seen = new Set<string>([nodeId]);
  let anyAncestor3D = false;
  const chain: string[] = [];
  for (let id: string | null = parentId; id && !seen.has(id); id = r.parentOf(id)) {
    seen.add(id);
    chain.push(id);
    if (r.is3DOf(id)) anyAncestor3D = true;
  }
  if (!anyAncestor3D) {
    cache.set(parentId, null);
    return null;
  }

  // Walk root → leaf, composing world = parent · child at each step.
  let acc: Matrix4 | null = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const id = chain[i]!;
    if (!r.is3DOf(id)) {
      // 2D ancestor: `world2DOf` is its WORLD affine, so it already subsumes
      // every ancestor above it — REPLACE the accumulator rather than
      // multiplying, or those ancestors get applied twice. Any 3D ancestors
      // below this one still compose on top, which is what makes a 3D layer
      // parented through a 2D null behave.
      acc = Matrix4Math.fromMatrix2D(r.world2DOf(id));
      continue;
    }
    const local = r.local3DOf(id);
    // A 3D ancestor with no resolvable geometry contributes nothing rather
    // than collapsing the chain to the identity.
    if (!local) continue;
    const own = composeNodeWorld3d(local);
    acc = acc ? Matrix4Math.multiply(acc, own) : own;
  }
  cache.set(parentId, acc);
  return acc;
}
