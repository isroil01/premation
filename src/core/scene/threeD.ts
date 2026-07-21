/**
 * Per-layer 3D (2.5D) support — app side.
 *
 * The app stores transforms as props on a node's `Transform` component
 * (x/y/rotation/scaleX/scaleY). A layer becomes "3D" when it also carries the
 * depth props below; a small inspector toggle adds/removes them. Once present
 * they behave like any other numeric prop — the NodeInspector renders a
 * keyframeable, undoable row for each automatically, so 3D values animate
 * through the exact same command path as x/y/rotation.
 *
 * The renderer (buildSnapshot) reads these via {@link readNode3D} and projects
 * the layer through a pinhole camera: +z dollies the layer away (smaller) and
 * parallaxes it toward the vanishing point; rotationX / rotationY foreshorten
 * it (tilt / flip). See `@motion/scene`'s Project3D + matrix4.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';

/** The depth props that mark a layer as 3D-enabled. */
export const THREE_D_PROPS = ['z', 'rotationX', 'rotationY'] as const;

export interface Node3D {
  /** Depth along the view axis (0 = comp plane). */
  z: number;
  /** Degrees — rotation about the horizontal (x) axis. */
  rotationX: number;
  /** Degrees — rotation about the vertical (y) axis. */
  rotationY: number;
  /** AE Orientation: a resting 3D facing composed BEFORE the animatable
   *  rotation, in degrees. Absent → 0 (no effect). */
  orientationX: number;
  orientationY: number;
  orientationZ: number;
  /** Anchor-point depth (px). matrix4 pivots rotation/scale around it; absent →
   *  0 (the layer plane), which is why it was invisibly dropped before. */
  anchorZ: number;
}

const ZERO_3D: Node3D = {
  z: 0, rotationX: 0, rotationY: 0,
  orientationX: 0, orientationY: 0, orientationZ: 0, anchorZ: 0,
};

/** Extra 3D props beyond the depth markers — orientation + anchor Z. Seeded on
 *  demand (they don't mark a layer 3D; z/rotationX/rotationY already do). */
export const THREE_D_EXTRA_PROPS = ['orientationX', 'orientationY', 'orientationZ', 'anchorZ'] as const;

function transformComponent(node: SceneNode): { id: string; props: Record<string, unknown> } | undefined {
  return node.components.find((c) => c.type === 'Transform') as
    | { id: string; props: Record<string, unknown> }
    | undefined;
}

/** True when the layer carries the 3D depth props (i.e. is a 3D layer). */
export function is3DEnabled(node: SceneNode): boolean {
  const t = transformComponent(node);
  if (!t) return false;
  return THREE_D_PROPS.some((p) => typeof t.props[p] === 'number');
}

/** Read a node's 3D values (0 for any prop that is absent). */
export function readNode3D(node: SceneNode): Node3D {
  const t = transformComponent(node);
  if (!t) return ZERO_3D;
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    z: n(t.props.z),
    rotationX: n(t.props.rotationX),
    rotationY: n(t.props.rotationY),
    orientationX: n(t.props.orientationX),
    orientationY: n(t.props.orientationY),
    orientationZ: n(t.props.orientationZ),
    anchorZ: n(t.props.anchorZ),
  };
}

/**
 * Turn a layer's 3D on/off. Enabling seeds the depth props at 0 (so the
 * inspector shows Z / X-rotation / Y-rotation rows and nothing moves until
 * edited); disabling removes them and drops any animation tracks on them.
 */
export function set3DEnabled(nodeId: string, on: boolean): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const t = transformComponent(node);
  if (!t) return;
  // The plain-view components are rebuilt on read, so props must be persisted
  // through the graph's writeProp, not mutated in place.
  for (const p of THREE_D_PROPS) {
    defaultSceneGraph.writeProp(nodeId, t.id, p, on ? (typeof t.props[p] === 'number' ? t.props[p] : 0) : undefined);
  }
  bumpScene();
}
