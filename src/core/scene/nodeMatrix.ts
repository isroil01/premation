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

import { Matrix4Math, type Matrix4 } from '@motion/scene';
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
