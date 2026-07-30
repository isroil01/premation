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
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Project3D, type Vec3 } from '@motion/scene';
import { Gizmo3D } from '@motion/workspace';
import { useGuidesStore } from '@stores/guidesStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { useSceneRevision } from '@stores/sceneStore';
import { isCustomViewId } from '@core/workspace/customViews';
import { useSceneRefGeometry } from './useSceneRefGeometry';
import { viewDragToWorldDelta } from '@core/workspace/ports';
import { currentViewCamera } from '@core/workspace/viewProjection';
import {
  collectDeviceHandles,
  dragDeviceHandleTo,
  hitTestDeviceHandle,
  type DeviceHandle,
} from '@core/workspace/deviceHandles';

interface DeviceDrag {
  handle: DeviceHandle;
  /** Where the handle was in world space when the press landed. */
  startWorld: Vec3;
  /** Comp-space pointer position at press. */
  startComp: { x: number; y: number };
}

export function useDeviceHandles(stageRef: React.RefObject<HTMLElement | null>) {
  const camera3dMode = useGuidesStore((s) => s.camera3dMode);
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);
  const time = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.time ?? 0 : 0));
  // The camera this view looks THROUGH gets no handle — the same suppression
  // the wireframe already has, resolved from the same shared hook so the two
  // can never disagree about which camera that is.
  const { activeCameraId } = useSceneRefGeometry(camera3dMode);
  const viewingThrough = camera3dMode === 'active' ? activeCameraId : null;

  const [hovered, setHovered] = useState<DeviceHandle | null>(null);
  const dragRef = useRef<DeviceDrag | null>(null);

  // The list the overlay DRAWS. Recomputed on any scene mutation (the revision
  // subscription above) and on time, so a keyframed camera's dot tracks it.
  // Deliberately the same collector the hit test calls: a dot the pointer can
  // see but not grab is worse than no dot at all.
  const sceneRev = useSceneRevision((s) => s.rev);
  const handles = useMemo(
    () => collectDeviceHandles(time, compWidth, compHeight, viewingThrough),
    [time, compWidth, compHeight, sceneRev, camera3dMode, viewingThrough],
  );

  // Live values for the listeners, which are installed once per stage.
  const stateRef = useRef({ camera3dMode, compWidth, compHeight, time, viewingThrough });
  stateRef.current = { camera3dMode, compWidth, compHeight, time, viewingThrough };

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const compLocal = (e: PointerEvent): { x: number; y: number } => {
      const rect = stage.getBoundingClientRect();
      return Gizmo3D.viewportToComp(
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        getWorkspaceController().getView(),
      );
    };
    const tolerance = (): number => 12 / (getWorkspaceController().getView().scale || 1);

    /** Project a world point exactly as the overlay draws it. */
    const projector = (): ((p: Vec3) => { x: number; y: number }) => {
      const { camera3dMode: mode, compWidth: w, compHeight: h, time: t } = stateRef.current;
      const ortho = mode !== 'active' && !isCustomViewId(mode) ? (mode as Project3D.OrthoView) : null;
      if (ortho) return (p) => Project3D.projectOrtho(p, ortho, w, h);
      // `currentViewCamera` is the shared resolver — the renderer, the gizmos
      // and this all read the same camera, which is what keeps a handle on its
      // own wireframe.
      const cam = currentViewCamera(w, h, t, mode);
      return cam ? (p: Vec3) => Project3D.projectPoint(p, cam) : (p: Vec3) => ({ x: p.x, y: p.y });
    };

    const handlesNow = (): DeviceHandle[] => {
      const { compWidth: w, compHeight: h, time: t, viewingThrough: vt } = stateRef.current;
      return collectDeviceHandles(t, w, h, vt);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.altKey) return;
      // The C-key camera tool owns plain left-drags while active.
      if (useGuidesStore.getState().cameraTool !== 'none') return;

      const compPt = compLocal(e);
      const hit = hitTestDeviceHandle(compPt, handlesNow(), projector(), tolerance());
      if (!hit) return;

      e.stopPropagation();
      e.preventDefault();
      try { stage.setPointerCapture(e.pointerId); } catch { /* best-effort */ }

      // Selecting the device makes the drag legible in the timeline and the
      // inspector, and matches clicking any other object.
      useSelectionStore.getState().set([hit.nodeId]);
      dragRef.current = { handle: hit, startWorld: hit.world, startComp: compPt };
    };

    const onPointerMove = (e: PointerEvent) => {
      const compPt = compLocal(e);
      const drag = dragRef.current;
      if (!drag) {
        setHovered(hitTestDeviceHandle(compPt, handlesNow(), projector(), tolerance()));
        return;
      }
      const { camera3dMode: mode, compWidth: w, compHeight: h, time: t } = stateRef.current;
      const delta = { x: compPt.x - drag.startComp.x, y: compPt.y - drag.startComp.y };
      // The SAME projected-delta → world conversion the layer drag uses, so a
      // handle tracks the cursor identically in every view. Depth comes from
      // where the handle started, so a distant camera does not lag the pointer.
      const worldDelta = viewDragToWorldDelta(delta, mode, drag.startWorld, w, h, t);
      dragDeviceHandleTo(
        drag.handle,
        {
          x: drag.startWorld.x + worldDelta.x,
          y: drag.startWorld.y + worldDelta.y,
          z: drag.startWorld.z + worldDelta.z,
        },
        t,
      );
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!dragRef.current) return;
      try { stage.releasePointerCapture(e.pointerId); } catch { /* best-effort */ }
      dragRef.current = null;
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
