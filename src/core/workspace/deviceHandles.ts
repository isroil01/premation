/**
 * Draggable handles for cameras and lights — the position handle and the Point
 * of Interest crosshair.
 *
 * The reported symptom this closes: "I added a camera, tried to grab and move
 * it, and nothing moved." Everything around it was already true — the frustum
 * was drawn accurately, the camera tools wrote to the right node, the gizmo sat
 * on the pixels — but the wireframe itself was inert, so the one gesture a user
 * reaches for first did nothing.
 *
 * ## Why a device needs its own handle at all
 *
 * A camera or a light has no geometry, so it is never hit by the ordinary
 * layer-picking path and the layer transform gizmo only appears once you have
 * found it in the timeline and selected it. In After Effects you grab the
 * wireframe in an orthographic view; that is the gesture being restored here.
 *
 * ## THE THING THAT MAKES THIS SUBTLE
 *
 * A drag knows where the pointer is in WORLD space. A node stores PARENT-space
 * values. Now that cameras and lights follow their parents, writing a world
 * position straight to the node means the parent transform gets applied to it a
 * second time on the next frame, so the device leaps away from the cursor by
 * exactly the parent transform the instant the mouse is released. It looks like
 * a snap-back and it is invisible from reading the write path, because the write
 * itself is perfectly ordinary. `Matrix4Math.toLocalPoint` against the parent's
 * world matrix is the whole fix, and it is why that helper exists.
 */

import type { Vec3 } from '@motion/scene';
import { Matrix4Math } from '@motion/scene';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { flattenComposition, readNodeKind } from '@core/scene/sceneDerive';
import { readNodeLight } from '@core/scene/light';
import { cameraFromNode, readCameraPoi } from '@core/scene/camera3d';
import { defaultAnimation } from '@motion/animation';
import { getRemappedTime } from '@core/timeline/TimelineController';
import {
  deviceWorldPosition,
  parentWorldMatrixAt,
  toWorldPointAt,
} from '@core/scene/liveWorld3d';
import { applyNodePropsKeyframed } from '@core/workspace/ports';

/** Which of a device's two draggable points this is. */
export type DeviceHandleKind = 'position' | 'poi';

export interface DeviceHandle {
  nodeId: string;
  device: 'camera' | 'light';
  kind: DeviceHandleKind;
  /** Where the handle sits in COMP (world) space. */
  world: Vec3;
}

/**
 * Every draggable device handle in the ACTIVE COMPOSITION.
 *
 * Comp-scoped deliberately: a camera in another composition is not drawn in
 * this viewport, so it must not be grabbable in it either. The positions come
 * from the same resolvers the gizmos and the renderer use, so a handle can
 * never sit somewhere its own wireframe is not.
 */
export function collectDeviceHandles(
  time: number,
  compWidth: number,
  compHeight: number,
  /**
   * The camera the viewport is looking THROUGH, if any — it gets no handle.
   *
   * `collectSceneGizmos` already suppresses its wireframe (from inside a camera
   * the frustum wraps the viewer and draws a full-screen X), so a handle for it
   * would be a grab point with nothing to grab. It is also degenerate to drag:
   * the eye projects through its own view at zero depth, so the perspective
   * divide that converts a pointer movement into world motion has no meaningful
   * value there. Move the active camera with the camera tools, or look at it
   * from another view and drag it there — which is what After Effects does.
   */
  viewingThroughCameraId: string | null = null,
): DeviceHandle[] {
  const out: DeviceHandle[] = [];
  for (const node of flattenComposition(defaultSceneGraph, activeCompRootId())) {
    const kind = readNodeKind(node);

    if (kind === 'camera') {
      if (node.id === viewingThroughCameraId) continue;
      const values = defaultAnimation.evaluateNode(node.id, getRemappedTime(node.id, time));
      const sample = (id: string, prop: string): number | undefined =>
        id === node.id ? values.get(prop) : undefined;
      // The RESOLVED eye — identical to the frustum apex and to what the
      // renderer projects through, so the handle is on the wireframe.
      const cam = cameraFromNode(node, compWidth, compHeight, sample, (id, p) =>
        toWorldPointAt(id, time, p),
      );
      out.push({ nodeId: node.id, device: 'camera', kind: 'position', world: cam.position });
      // Only a TWO-node camera has a Point of Interest; a one-node camera turns
      // in place and must not sprout a target handle it does not own.
      const localPoi = readCameraPoi(node, compWidth, compHeight, sample);
      if (localPoi) {
        out.push({
          nodeId: node.id, device: 'camera', kind: 'poi',
          world: toWorldPointAt(node.id, time, localPoi),
        });
      }
      continue;
    }

    if (kind === 'light') {
      const lt = readNodeLight(node);
      // An ambient light has no position that means anything — moving it would
      // change nothing on screen, so it gets no handle.
      if (lt.type === 'ambient') continue;
      out.push({ nodeId: node.id, device: 'light', kind: 'position', world: deviceWorldPosition(node, time) });
      if (lt.poi) {
        const values = defaultAnimation.evaluateNode(node.id, getRemappedTime(node.id, time));
        out.push({
          nodeId: node.id, device: 'light', kind: 'poi',
          world: toWorldPointAt(node.id, time, {
            x: values.get('poiX') ?? lt.poi.x,
            y: values.get('poiY') ?? lt.poi.y,
            z: values.get('poiZ') ?? lt.poi.z,
          }),
        });
      }
    }
  }
  return out;
}

/**
 * The handle under `compPt`, or null.
 *
 * POI wins ties: it is the smaller, more precise target, and a camera whose
 * target sits near its own body is exactly the case where you mean the one you
 * can barely hit.
 */
export function hitTestDeviceHandle(
  compPt: { x: number; y: number },
  handles: readonly DeviceHandle[],
  project: (p: Vec3) => { x: number; y: number },
  tolerance: number,
): DeviceHandle | null {
  let best: DeviceHandle | null = null;
  let bestD = Infinity;
  for (const h of handles) {
    const s = project(h.world);
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    const d = Math.hypot(s.x - compPt.x, s.y - compPt.y);
    if (d > tolerance) continue;
    // Strictly-less keeps the FIRST of equal candidates, so bias POI explicitly.
    const better = d < bestD || (d === bestD && h.kind === 'poi');
    if (better) { best = h; bestD = d; }
  }
  return best;
}

/** The prop triple a handle writes. */
const PROPS: Record<DeviceHandleKind, readonly [string, string, string]> = {
  position: ['x', 'y', 'z'],
  poi: ['poiX', 'poiY', 'poiZ'],
};

/**
 * Move a handle to `worldTarget`, writing PARENT-SPACE values.
 *
 * `mergeKey` is stable for a whole gesture so a drag is one undo entry, and the
 * write goes through the same auto-keyframe path the camera tools and the layer
 * gizmo use — a camera dragged with Auto-Keyframe on animates, exactly like
 * everything else.
 *
 * Only the handle's OWN three props are written. Dragging the position must not
 * drag the target and vice versa: they are independent properties, and a camera
 * whose target follows its body can never be aimed.
 */
export function dragDeviceHandleTo(
  handle: DeviceHandle,
  worldTarget: Vec3,
  time: number,
): void {
  const parent = parentWorldMatrixAt(handle.nodeId, time);
  // World → parent space. Unparented ⇒ the two spaces are the same and this is
  // the identity; parented ⇒ this is the step whose absence makes a dragged
  // device snap back by exactly the parent transform on release.
  const local = parent ? Matrix4Math.toLocalPoint(parent, worldTarget) : worldTarget;
  const [px, py, pz] = PROPS[handle.kind];
  applyNodePropsKeyframed(
    handle.nodeId,
    { [px]: local.x, [py]: local.y, [pz]: local.z },
    `devicehandle:${handle.nodeId}:${handle.kind}`,
  );
}
