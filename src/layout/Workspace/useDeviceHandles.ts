/**
 * Dragging a camera or light by its viewport handle.
 *
 * Closes the original report — "I added a camera, tried to grab and move it,
 * nothing moved." A device has no geometry, so it is never hit by layer picking
 * and its wireframe was purely decorative. In After Effects you grab the camera
 * in an orthographic view and move it; this is that gesture.
 *
 * Structured like `useGizmo3d` on purpose: a CAPTURE-phase listener on the
 * stage, hit-testing in comp space. Devices are not part of the layer gizmo, so
 * they need their own listener — `useGizmo3d` returns early unless a layer
 * gizmo is rendered, which is exactly the case where you want to grab a camera
 * (nothing selected).
 *
 * It registers AFTER the layer gizmo's listener, so when a device handle and a
 * transform handle overlap the layer gizmo wins — it is the more specific
 * intent, and it claims the event with `stopPropagation`.
 *
 * B4 round 5: the handles, the view camera and each device's parent matrix
 * come from the overlay geometry push (the same records the wireframes draw),
 * resolved engine-side at the frame on screen.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Vec3 } from '@motion/scene';
import { Gizmo3D } from '@motion/workspace';
import { useGuidesStore } from '@stores/guidesStore';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { displayedRenderView } from '@core/workspace/displayedView';
import { isSceneCameraView } from '@core/scene/cameraViewMode';
import { useSceneRefGeometry } from './useSceneRefGeometry';
import { beginViewportGesture, endViewportGesture } from '@core/workspace/viewportGesture';
import {
  deviceHandlesFrom,
  dragDeltaThrough,
  hitTestDeviceHandle,
  projectorOf,
  type DeviceHandle,
} from '@core/mirror/viewGeometry';
import { dragDeviceHandle } from '@core/workspace/deviceHandleDrag';

interface DeviceDrag {
  handle: DeviceHandle;
  /** Where the handle was in world space when the press landed. */
  startWorld: Vec3;
  /** Comp-space pointer position at press. */
  startComp: { x: number; y: number };
}

export function useDeviceHandles(stageRef: React.RefObject<HTMLElement | null>) {
  const camera3dMode = useGuidesStore((s) => s.camera3dMode);
  // The camera this view looks THROUGH gets no handle — the same suppression
  // the wireframe already has, resolved from the same shared hook so the two
  // can never disagree about which camera that is.
  const { activeCameraId, camera, compWidth, compHeight, sceneLayers, recordOf } = useSceneRefGeometry(camera3dMode, { mainViewport: true });
  const viewingThrough = isSceneCameraView(camera3dMode) ? activeCameraId : null;

  const [hovered, setHovered] = useState<DeviceHandle | null>(null);
  const dragRef = useRef<DeviceDrag | null>(null);

  // The list the overlay DRAWS — the pushed records of the frame on screen, so a
  // keyframed camera's dot tracks it. Deliberately the same list the hit test
  // uses: a dot the pointer can see but not grab is worse than no dot at all.
  const handles = useMemo(
    () => deviceHandlesFrom(documentMirror(), sceneLayers, recordOf, viewingThrough),
    [sceneLayers, recordOf, viewingThrough],
  );

  // Live values for the listeners, which are installed once per stage.
  const stateRef = useRef({ camera3dMode, compWidth, compHeight, camera, handles });
  stateRef.current = { camera3dMode, compWidth, compHeight, camera, handles };

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    // The transform the dots are DRAWN with (Gizmo3dOverlay's, the frame on
    // screen's — useOverlayView), so a dot is grabbed where it is seen.
    const compLocal = (e: PointerEvent): { x: number; y: number } => {
      const rect = stage.getBoundingClientRect();
      return Gizmo3D.viewportToComp(
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        displayedRenderView(),
      );
    };
    const tolerance = (): number => 12 / (displayedRenderView().scale || 1);

    /** Project a world point exactly as the overlay draws it (the view's pushed camera). */
    const projector = (): ((p: Vec3) => { x: number; y: number }) => {
      const { camera3dMode: mode, compWidth: w, compHeight: h, camera: cam } = stateRef.current;
      return projectorOf(mode, cam, w, h);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.altKey) return;
      // The C-key camera tool owns plain left-drags while active.
      if (useGuidesStore.getState().cameraTool !== 'none') return;

      const compPt = compLocal(e);
      const hit = hitTestDeviceHandle(compPt, stateRef.current.handles, projector(), tolerance());
      if (!hit) return;

      e.stopPropagation();
      e.preventDefault();
      try { stage.setPointerCapture(e.pointerId); } catch { /* best-effort */ }

      // Selecting the device makes the drag legible in the timeline and the
      // inspector, and matches clicking any other object.
      useSelectionStore.getState().set([hit.nodeId]);
      // One gesture per drag: one undo entry, one structural bump at the end,
      // and the drag flag that keeps the RAM preview from blitting the
      // pre-drag frame over the light (or camera) being moved.
      beginViewportGesture();
      dragRef.current = { handle: hit, startWorld: hit.world, startComp: compPt };
    };

    const onPointerMove = (e: PointerEvent) => {
      const compPt = compLocal(e);
      const drag = dragRef.current;
      if (!drag) {
        setHovered(hitTestDeviceHandle(compPt, stateRef.current.handles, projector(), tolerance()));
        return;
      }
      const { camera3dMode: mode, camera: cam } = stateRef.current;
      const delta = { x: compPt.x - drag.startComp.x, y: compPt.y - drag.startComp.y };
      // The SAME projected-delta → world conversion the layer drag uses, so a
      // handle tracks the cursor identically in every view. Depth comes from
      // where the handle started, so a distant camera does not lag the pointer.
      const worldDelta = dragDeltaThrough(delta, mode, cam, drag.startWorld);
      dragDeviceHandle(drag.handle, {
        x: drag.startWorld.x + worldDelta.x,
        y: drag.startWorld.y + worldDelta.y,
        z: drag.startWorld.z + worldDelta.z,
      });
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!dragRef.current) return;
      try { stage.releasePointerCapture(e.pointerId); } catch { /* best-effort */ }
      dragRef.current = null;
      endViewportGesture();
    };

    stage.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      stage.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [stageRef]);

  return { deviceHandles: handles, hoveredHandle: hovered };
}
