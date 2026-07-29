/**
 * Parent-aware world transforms read from the LIVE scene graph at the playhead.
 *
 * ## The invariant this file exists to hold
 *
 * **Every representation of a camera or a light derives from ONE resolved
 * transform.** The renderer projects through it, the viewport gizmo draws
 * through it, and direct manipulation writes back through it. A gizmo and a
 * renderer that *can* disagree is a bug waiting to happen even on the day they
 * happen to agree — this codebase has paid for that three separate times:
 *
 *   • cameras had no parent path at all, so the standard "camera parented to a
 *     null" rig moved the timeline and nothing else;
 *   • the light WASH resolved through `worldTransformOf` while the Lambert
 *     shading and the shadow light read raw local props, so dragging a light's
 *     parent flew the glow across the frame and left every lit surface frozen;
 *   • the overlay resolved cameras and lights with no parent lift whatsoever,
 *     so gizmos drifted off the pixels they were supposed to annotate.
 *
 * `buildSnapshot` composes the same chain from its own per-frame caches (it has
 * to — it already holds resolved values for every node and must not re-read the
 * graph per layer). The rule is that both paths go through
 * `nodeMatrix.parentWorld3d` with equivalent resolvers, so "the renderer's
 * answer" and "the chrome's answer" are the same computation with different
 * caches, not two implementations that must be kept in sync by hand.
 */

import type { SceneNode } from '@core/types';
import type { Matrix4, Vec3 } from '@motion/scene';
import { Matrix4Math } from '@motion/scene';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { worldMatrixOf } from '@core/scene/worldTransform';
import { readGeometry } from '@core/workspace/geometry';
import { is3DEnabled, readNode3D } from '@core/scene/threeD';
import {
  composeNodeWorld3d,
  parentWorld3d,
  resolveNode3DTransform,
  type Parent3DResolvers,
} from '@core/scene/nodeMatrix';

/**
 * `Parent3DResolvers` backed by the live graph, sampled at `time`.
 *
 * The 2×3 fallback (`world2DOf`) is what flattens a 2D ancestor before it
 * reaches a 3D child — After Effects' rule, and the same one the renderer's
 * `parentWorldMatrixOf` applies.
 */
export function liveParent3DResolvers(time: number): Parent3DResolvers {
  const wmCache = new Map<string, ReturnType<typeof worldMatrixOf>>();
  const localOf = (id: string) => {
    const node = defaultSceneGraph.getNode(id);
    if (!node) return null;
    const g = readGeometry(node);
    if (!g) return null;
    return { x: g.x, y: g.y, rotation: g.rotationDeg, scaleX: g.scaleX, scaleY: g.scaleY };
  };
  const parentOf = (id: string) => defaultSceneGraph.getNode(id)?.parent ?? null;
  return {
    parentOf,
    local3DOf: (id) => {
      const n = defaultSceneGraph.getNode(id);
      return n ? resolveNode3DTransform(n, time) : null;
    },
    is3DOf: (id) => {
      const n = defaultSceneGraph.getNode(id);
      return !!n && is3DEnabled(n);
    },
    world2DOf: (id) => worldMatrixOf(id, localOf, parentOf, wmCache),
  };
}

/**
 * The world matrix of `nodeId`'s PARENT chain at `time`, or null when it has no
 * parent (or no 3D ancestor and no 2D parent to flatten).
 *
 * This is the matrix a drag must invert to turn a world-space drop back into
 * the local values the node stores — see `Matrix4Math.toLocalPoint`.
 */
export function parentWorldMatrixAt(nodeId: string, time: number): Matrix4 | null {
  const r = liveParent3DResolvers(time);
  const parentId = r.parentOf(nodeId);
  if (!parentId) return null;
  // A 3D ancestor anywhere in the chain ⇒ compose in 4×4 so depth and X/Y
  // rotation carry; `parentWorld3d` folds any 2D ancestors above it.
  const p3 = parentWorld3d(nodeId, r);
  if (p3) return p3;
  // Pure-2D chain: lift the parent's own world affine. z is left untouched,
  // which is AE's rule for a 2D parent.
  return Matrix4Math.fromMatrix2D(r.world2DOf(parentId));
}

/**
 * Lift a point from `nodeId`'s PARENT space into world space.
 *
 * The chrome-side twin of `buildSnapshot`'s `toWorldPoint`, and the function to
 * hand to `cameraFromNode` as its `worldOf` so a parented camera's gizmo lands
 * on the pixels the renderer draws.
 */
export function toWorldPointAt(nodeId: string, time: number, p: Vec3): Vec3 {
  const m = parentWorldMatrixAt(nodeId, time);
  return m ? Matrix4Math.transformPoint(m, p) : p;
}

/**
 * The world POSITION of a camera or light node at `time`.
 *
 * Cameras and lights are point devices: they have a position and an aim, no
 * geometry. Animated values win over base props, and the base prop — not a
 * literal — is the fallback, because `evaluateNode` returns ANIMATED props only
 * and defaulting to 0 pins every un-keyframed device to the origin. That exact
 * bug has been fixed three times here.
 */
export function deviceWorldPosition(node: SceneNode, time: number): Vec3 {
  const av = defaultAnimation.evaluateNode(node.id, getRemappedTime(node.id, time));
  const g = readGeometry(node);
  const base = readNode3D(node);
  return toWorldPointAt(node.id, time, {
    x: av.get('x') ?? g?.x ?? 0,
    y: av.get('y') ?? g?.y ?? 0,
    z: av.get('z') ?? base.z,
  });
}

/**
 * A camera/light node's Point of Interest in WORLD space, or null when it has
 * none.
 *
 * ## Convention: the POI INHERITS the parent transform
 *
 * Position and Point of Interest are both parent-space properties, exactly as
 * After Effects treats them, so a camera parented to a null travels with its
 * target: the whole rig moves together and the shot holds its subject. The
 * alternative — a world-space POI — makes moving the null swing the camera to
 * keep staring at a fixed point in the composition. That is occasionally what
 * you want and never what you want by default, and the escape hatch for it is
 * an expression on the POI, not a different default.
 *
 * The same rule applies to spot lights, so a light rig behaves like a camera
 * rig rather than needing a second mental model.
 */
export function deviceWorldPoi(
  node: SceneNode,
  time: number,
  fallback: { x: number; y: number; z: number } | null,
): Vec3 | null {
  const av = defaultAnimation.evaluateNode(node.id, getRemappedTime(node.id, time));
  const px = av.get('poiX') ?? fallback?.x;
  const py = av.get('poiY') ?? fallback?.y;
  const pz = av.get('poiZ') ?? fallback?.z;
  if (px === undefined && py === undefined && pz === undefined) return null;
  return toWorldPointAt(node.id, time, { x: px ?? 0, y: py ?? 0, z: pz ?? 0 });
}

/**
 * A layer's full model matrix at `time`, parent chain INCLUDED.
 *
 * `nodeMatrix.nodeWorld3d` composes a node's own local transform only, so the
 * layer-box gizmos built from it sat at the unparented position for every
 * parented 3D layer — the same drift as the camera and light gizmos, in a third
 * place.
 */
export function nodeWorldWithParents3d(node: SceneNode, time: number): Matrix4 | null {
  const t = resolveNode3DTransform(node, time);
  if (!t) return null;
  const local = composeNodeWorld3d(t);
  const parent = parentWorldMatrixAt(node.id, time);
  return parent ? Matrix4Math.multiply(parent, local) : local;
}
