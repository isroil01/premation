/**
 * useGizmo3d — React hook providing interactive 3D Transform Gizmo logic,
 * raycasting interaction, and real-time scene updates.
 */

import { useState, useEffect, useRef } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useGuidesStore } from '@stores/guidesStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSceneRevision } from '@stores/sceneStore';
import { is3DEnabled, canBe3D } from '@core/scene/threeD';
import {
  sampleTransform3DAtPlayhead,
  applyGizmo3DTransforms,
  type Gizmo3DNodeUpdate,
} from '@core/workspace/ports';
import { readSceneCamera } from '@core/scene/camera3d';
import { customViewCamera, isCustomViewId } from '@core/workspace/customViews';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { defaultAnimation } from '@motion/animation';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import type { RenderView } from '@core/rendering/RenderBackend';
import { Project3D, type Camera3D, type OrthoView, type Vec3 } from '@motion/scene';
import { Gizmo3D, type GizmoHandleType, type RenderedGizmo3D } from '@motion/workspace';
import type { SceneNode } from '@core/types';

export interface DragState3D {
  active: boolean;
  handle: GizmoHandleType;
  startPos3D: Vec3;
  currentPos3D: Vec3;
  startRot3D: { rotX: number; rotY: number; rotZ: number };
  currentRot3D: { rotX: number; rotY: number; rotZ: number };
  startScale3D: { scaleX: number; scaleY: number; scaleZ: number };
  currentScale3D: { scaleX: number; scaleY: number; scaleZ: number };
  startMouseScreen: { x: number; y: number };
  /** Pointer-down position mapped into composition space. */
  startMouseComp: { x: number; y: number };
  mouseScreen: { x: number; y: number };
  initialNodeStates?: Array<{
    id: string;
    pos: Vec3;
    rot: { rotX: number; rotY: number; rotZ: number };
    scale: { scaleX: number; scaleY: number };
  }>;
}

export function useGizmo3d(overlayRef: React.RefObject<HTMLCanvasElement | null>, stageRef: React.RefObject<HTMLElement | null>) {
  const selectedIds = useSelectionStore((s) => s.ids);

  const gizmoState = useGuidesStore((s) => s.gizmo3dState);
  const axisMode = useGuidesStore((s) => s.gizmo3dAxisMode);
  const groundGridVisible = useGuidesStore((s) => s.groundGridVisible);
  const camera3dMode = useGuidesStore((s) => s.camera3dMode);
  const customViews = useGuidesStore((s) => s.customViews);

  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);

  // Current playhead time of the active tab — the camera must be sampled at it
  // (an animated/orbited camera otherwise leaves the gizmo at frame 0's view).
  const time = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.time ?? 0 : 0));

  // Re-render on ANY scene mutation (canvas drags, inspector edits, undo…) so
  // the gizmo tracks the object it is attached to. Without this, moving the
  // object only sometimes moved the gizmo (whenever something else happened to
  // trigger a render).
  useSceneRevision((s) => s.rev);

  const [hoverHandle, setHoverHandle] = useState<GizmoHandleType | null>(null);
  const [activeHandle, setActiveHandle] = useState<GizmoHandleType | null>(null);
  const [dragState, setDragState] = useState<DragState3D | null>(null);

  // Filter selected nodes to those with 3D enabled (AE multi-layer 3D selection).
  //
  // `canBe3D` — not bare `is3DEnabled` — is the gate, and it is the SAME predicate
  // the renderer, the selection chrome (ports.ts) and the axis widget use.
  // insertCamera writes `z = -focalLength`, so every camera satisfies
  // `is3DEnabled` and used to get a full layer transform gizmo whose drags wrote
  // camera x/y/z; lights had the same problem. Cameras and lights are positioned
  // with the camera-navigation tools and their own inspector, not this gizmo.
  const selected3DNodes = selectedIds
    .map((id) => defaultSceneGraph.getNode(id))
    .filter((node): node is SceneNode => node != null && canBe3D(node) && is3DEnabled(node));

  const is3D = selected3DNodes.length > 0;
  const singleId = selectedIds.length === 1 ? selectedIds[0] : (selected3DNodes[0]?.id ?? null);

  // Compute centroid (group center) for single or multi-layer selection
  let sumX = 0, sumY = 0, sumZ = 0;
  let firstRot = { rotX: 0, rotY: 0, rotZ: 0 };
  let firstScale = { scaleX: 1, scaleY: 1, scaleZ: 1 };

  selected3DNodes.forEach((node, idx) => {
    // SAMPLED at the current remapped playhead (animated tracks win) — the
    // renderer draws the sampled value, so anchoring the gizmo on static base
    // props desynced it off any keyframed layer (Bug: gizmo/object desync).
    const tv = sampleTransform3DAtPlayhead(node);

    sumX += tv.x;
    sumY += tv.y;
    sumZ += tv.z;

    if (idx === 0) {
      firstRot = { rotX: tv.rotationX, rotY: tv.rotationY, rotZ: tv.rotation };
      firstScale = { scaleX: tv.scaleX, scaleY: tv.scaleY, scaleZ: 1 };
    }
  });

  const count = Math.max(1, selected3DNodes.length);
  const position3D: Vec3 = {
    x: sumX / count,
    y: sumY / count,
    z: sumZ / count,
  };

  const nodeRotation = firstRot;
  const nodeScale = firstScale;

  // Resolve the scene camera at the CURRENT playhead time — same resolver
  // chain the renderer (buildSnapshot) and selection chrome (ports.ts) use.
  let camera: Camera3D;
  if (isCustomViewId(camera3dMode)) {
    // Custom views: the gizmo projects through the STORED view camera — the
    // scene's Camera layer is ignored, matching the renderer.
    camera = customViewCamera(customViews[camera3dMode], compWidth, compHeight);
  } else {
    let cameraNode: SceneNode | undefined;
    for (const n of flattenScene(defaultSceneGraph)) {
      if (readNodeKind(n) === 'camera') {
        cameraNode = n;
        break;
      }
    }
    if (cameraNode) {
      const camNode = cameraNode;
      const camTime = getRemappedTime(camNode.id, time);
      const camValues = defaultAnimation.evaluateNode(camNode.id, camTime);
      camera = readSceneCamera(defaultSceneGraph, compWidth, compHeight, (id, p) =>
        id === camNode.id ? camValues.get(p) : undefined,
      );
    } else {
      camera = readSceneCamera(defaultSceneGraph, compWidth, compHeight);
    }
  }
  const orthoView: OrthoView | null =
    camera3dMode === 'active' || isCustomViewId(camera3dMode) ? null : (camera3dMode as OrthoView);

  // Comp → canvas view transform (RenderView: canvasPx = compPx·scale + offset,
  // CSS px). Kept in state and re-synced on wheel / pointer input so the SVG
  // overlay follows viewport pan & zoom.
  const [viewTransform, setViewTransform] = useState<RenderView>(() => getWorkspaceController().getView());
  useEffect(() => {
    const sync = (): void => {
      const v = getWorkspaceController().getView();
      setViewTransform((prev) =>
        prev.scale === v.scale && prev.offsetX === v.offsetX && prev.offsetY === v.offsetY ? prev : v,
      );
    };
    sync();
    window.addEventListener('wheel', sync, { passive: true, capture: true });
    window.addEventListener('pointermove', sync, { capture: true });
    window.addEventListener('pointerup', sync, { capture: true });
    return () => {
      window.removeEventListener('wheel', sync, { capture: true } as EventListenerOptions);
      window.removeEventListener('pointermove', sync, { capture: true } as EventListenerOptions);
      window.removeEventListener('pointerup', sync, { capture: true } as EventListenerOptions);
    };
  }, []);

  const renderedGizmoRef = useRef<RenderedGizmo3D | null>(null);

  if (is3D) {
    // Screen-constant gizmo (AE-style): the overlay group is scaled by the
    // viewport zoom, so build the gizmo in comp px sized 85 / scale — it then
    // always occupies ~85 CSS px on screen regardless of zoom.
    const viewScale = viewTransform.scale || 1;
    renderedGizmoRef.current = Gizmo3D.buildRenderedGizmo3D(
      position3D,
      nodeRotation,
      camera,
      orthoView,
      { gizmoState, axisMode, gizmoLengthPx: 85 / viewScale },
      compWidth,
      compHeight,
    );
  } else {
    // Clear it. Leaving the last gizmo behind meant the capture-phase pointerdown
    // handler could hit-test against a stale gizmo for a selection that is no
    // longer 3D (or no longer selected) and swallow the click.
    renderedGizmoRef.current = null;
  }

  // Pointer event handlers for 3D Gizmo interaction
  useEffect(() => {
    const overlay = overlayRef.current;
    const stage = stageRef.current;
    if (!overlay || !stage || !is3D || selected3DNodes.length === 0) return;

    const getStageLocal = (e: MouseEvent): { x: number; y: number } => {
      const rect = stage.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    // Comp space mouse coordinate (factoring out viewport zoom and pan).
    // RenderView is canvasPx = compPx·scale + offset ⇒ comp = (canvas − offset)/scale.
    const getCompLocal = (stagePt: { x: number; y: number }): { x: number; y: number } => {
      return Gizmo3D.viewportToComp(stagePt, getWorkspaceController().getView());
    };

    // Hit thresholds are in comp px — scale a fixed on-screen tolerance down.
    const hitTolerance = (): number => {
      const s = getWorkspaceController().getView().scale || 1;
      return 12 / s;
    };

    const onPointerMove = (e: PointerEvent) => {
      const stagePt = getStageLocal(e);
      const compPt = getCompLocal(stagePt);

      if (dragState && dragState.active) {
        // Drag in progress — calculate updated 3D transform
        const ray = Project3D.unprojectScreenRay(compPt.x, compPt.y, camera, orthoView, compWidth, compHeight);
        const basis = Gizmo3D.getGizmoBasis(axisMode, dragState.startRot3D, camera);

        let newPos = { ...dragState.startPos3D };
        const newRot = { ...dragState.startRot3D };
        const newScale = { ...dragState.startScale3D };

        const handle = dragState.handle;

        if (handle === 'pos_x' || handle === 'pos_y' || handle === 'pos_z') {
          const axisDir = handle === 'pos_x' ? basis.x : handle === 'pos_y' ? basis.y : basis.z;
          // Ray/axis intersection is SINGULAR when the axis points at the camera:
          // `closestPointRayAxis` divides by `a*c - b*b`, which goes to 0, and
          // returns tAxis = 0 — so dragging the Z arrow in a front view (the
          // default view, where basis.z faces the viewer) did precisely nothing.
          // Fall back to vertical screen travel, AE-style: drag up pushes the
          // layer along +axis, away from the camera.
          const axisEntry = renderedGizmoRef.current?.axes.find((a) => a.type === handle);
          let tAxis: number;
          if (axisEntry?.degenerate) {
            const viewScale = getWorkspaceController().getView().scale || 1;
            tAxis = -(stagePt.y - dragState.startMouseScreen.y) / viewScale;
          } else {
            tAxis = Project3D.closestPointRayAxis(ray, dragState.startPos3D, axisDir).tAxis;
          }
          newPos = {
            x: dragState.startPos3D.x + axisDir.x * tAxis,
            y: dragState.startPos3D.y + axisDir.y * tAxis,
            z: dragState.startPos3D.z + axisDir.z * tAxis,
          };
        } else if (handle === 'plane_xy' || handle === 'plane_xz' || handle === 'plane_yz') {
          const normal = handle === 'plane_xy' ? basis.z : handle === 'plane_xz' ? basis.y : basis.x;
          const hit = Project3D.intersectRayPlane(ray, dragState.startPos3D, normal);
          if (hit) newPos = hit;
        } else if (handle === 'rot_x' || handle === 'rot_y' || handle === 'rot_z') {
          // Delta rotation relative to the grab point:
          //   rot_z — true relative angle around the gizmo centre (comp space);
          //   rot_x / rot_y — vertical / horizontal mouse travel mapped to degrees.
          let deltaDeg = 0;
          if (handle === 'rot_z') {
            const center = renderedGizmoRef.current
              ? { x: renderedGizmoRef.current.centerScreen.x, y: renderedGizmoRef.current.centerScreen.y }
              : { x: dragState.startPos3D.x, y: dragState.startPos3D.y };
            const a0 = Math.atan2(dragState.startMouseComp.y - center.y, dragState.startMouseComp.x - center.x);
            const a1 = Math.atan2(compPt.y - center.y, compPt.x - center.x);
            deltaDeg = ((a1 - a0) * 180) / Math.PI;
            if (deltaDeg > 180) deltaDeg -= 360;
            if (deltaDeg < -180) deltaDeg += 360;
          } else if (handle === 'rot_x') {
            deltaDeg = -(stagePt.y - dragState.startMouseScreen.y) * 0.5;
          } else {
            deltaDeg = (stagePt.x - dragState.startMouseScreen.x) * 0.5;
          }

          // Shift key snaps rotation to 15° increments (AE standard)
          if (e.shiftKey) {
            deltaDeg = Math.round(deltaDeg / 15) * 15;
          }

          if (handle === 'rot_x') newRot.rotX = dragState.startRot3D.rotX + deltaDeg;
          else if (handle === 'rot_y') newRot.rotY = dragState.startRot3D.rotY + deltaDeg;
          else newRot.rotZ = dragState.startRot3D.rotZ + deltaDeg;
        } else if (handle === 'scale_x' || handle === 'scale_y' || handle === 'scale_center') {
          // Each handle follows the axis it points along. Every scale handle used
          // to read `stagePt.x` only, so the VERTICAL Y-scale handle grew when you
          // dragged sideways and ignored vertical motion entirely.
          const dxPx = stagePt.x - dragState.startMouseScreen.x;
          const dyPx = stagePt.y - dragState.startMouseScreen.y;
          const travel =
            handle === 'scale_y' ? -dyPx
            : handle === 'scale_center' ? (dxPx - dyPx) / 2
            : dxPx;
          const factor = Math.max(0.05, 1 + travel * 0.01);
          if (handle === 'scale_x' || handle === 'scale_center') newScale.scaleX = dragState.startScale3D.scaleX * factor;
          if (handle === 'scale_y' || handle === 'scale_center') newScale.scaleY = dragState.startScale3D.scaleY * factor;
        }

        const deltaX = newPos.x - dragState.startPos3D.x;
        const deltaY = newPos.y - dragState.startPos3D.y;
        const deltaZ = newPos.z - dragState.startPos3D.z;

        const deltaRotX = newRot.rotX - dragState.startRot3D.rotX;
        const deltaRotY = newRot.rotY - dragState.startRot3D.rotY;
        const deltaRotZ = newRot.rotZ - dragState.startRot3D.rotZ;

        // Per-axis factors. A single factor derived from scaleX made `scale_y` a
        // no-op: that handle only changes scaleY, so the X ratio stayed 1 and the
        // update below multiplied both axes by 1.
        const scaleFactorX = newScale.scaleX / Math.max(0.001, dragState.startScale3D.scaleX);
        const scaleFactorY = newScale.scaleY / Math.max(0.001, dragState.startScale3D.scaleY);

        // Apply to all selected 3D nodes through ports' dual write path: props
        // with a lit stopwatch (or Auto-Keyframe on) keyframe at the playhead —
        // a base-only write is invisible on keyframed layers because the
        // renderer samples the track first — and static props write the base.
        // One undo entry per drag (stable merge key inside).
        // Only the handle's own props: a position drag must not touch (and
        // possibly keyframe) rotation or scale tracks, and vice versa.
        const isPosHandle = handle.startsWith('pos_') || handle.startsWith('plane_');
        const isRotHandle = handle.startsWith('rot_');
        const isScaleHandle = handle.startsWith('scale_');
        const updates: Gizmo3DNodeUpdate[] = (dragState.initialNodeStates ?? []).map((st) => ({
          id: st.id,
          values: {
            ...(isPosHandle
              ? { x: st.pos.x + deltaX, y: st.pos.y + deltaY, z: st.pos.z + deltaZ }
              : {}),
            ...(isRotHandle && handle === 'rot_x' ? { rotationX: st.rot.rotX + deltaRotX } : {}),
            ...(isRotHandle && handle === 'rot_y' ? { rotationY: st.rot.rotY + deltaRotY } : {}),
            ...(isRotHandle && (handle === 'rot_z' || handle === 'rot_outer')
              ? { rotation: st.rot.rotZ + deltaRotZ }
              : {}),
            ...(isScaleHandle
              ? { scaleX: st.scale.scaleX * scaleFactorX, scaleY: st.scale.scaleY * scaleFactorY }
              : {}),
          },
        }));
        applyGizmo3DTransforms(updates);

        setDragState({
          ...dragState,
          currentPos3D: newPos,
          currentRot3D: newRot,
          currentScale3D: newScale,
          mouseScreen: stagePt,
        });
        return;
      }

      // Hover hit-testing
      if (renderedGizmoRef.current) {
        const hit = Gizmo3D.hitTestGizmo3D(compPt, renderedGizmoRef.current, hitTolerance());
        setHoverHandle(hit);
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || !renderedGizmoRef.current) return;
      // Alt+drag is viewport camera navigation (orbit / track — useWorkspace);
      // never start a gizmo transform drag from an Alt press.
      if (e.altKey) return;
      // The C-key camera tool owns plain left-drags while active — let the
      // press fall through to useWorkspace's camera navigation.
      if (useGuidesStore.getState().cameraTool !== 'none') return;
      const stagePt = getStageLocal(e);
      const compPt = getCompLocal(stagePt);

      const hit = Gizmo3D.hitTestGizmo3D(compPt, renderedGizmoRef.current, hitTolerance());
      if (hit) {
        // CLAIM the press before the canvas selection layer sees it. This
        // listener runs on the STAGE in the CAPTURE phase — useWorkspace's
        // pointerdown listens on the overlay canvas (a descendant), so
        // stopPropagation here is what keeps a gizmo grab from clearing /
        // re-running selection (which unmounted the gizmo mid-click).
        e.stopPropagation();
        e.preventDefault();
        try {
          stage.setPointerCapture(e.pointerId);
        } catch {
          /* best-effort */
        }

        // Anchor the drag on the SAMPLED transform at the playhead (same read
        // the gizmo display and the renderer use), not the static base props.
        // Nodes are re-fetched at event time so the anchor is never a stale
        // render-closure value.
        const initialNodeStates = selected3DNodes
          .map((n) => defaultSceneGraph.getNode(n.id))
          .filter((n): n is SceneNode => n != null)
          .map((node) => {
            const tv = sampleTransform3DAtPlayhead(node);
            return {
              id: node.id,
              pos: { x: tv.x, y: tv.y, z: tv.z },
              rot: { rotX: tv.rotationX, rotY: tv.rotationY, rotZ: tv.rotation },
              scale: { scaleX: tv.scaleX, scaleY: tv.scaleY },
            };
          });
        if (initialNodeStates.length === 0) return;

        // Fresh centroid + first-node rot/scale (mirrors the render-path math).
        const n = initialNodeStates.length;
        const startPos: Vec3 = {
          x: initialNodeStates.reduce((a, s) => a + s.pos.x, 0) / n,
          y: initialNodeStates.reduce((a, s) => a + s.pos.y, 0) / n,
          z: initialNodeStates.reduce((a, s) => a + s.pos.z, 0) / n,
        };
        const first = initialNodeStates[0]!;
        const startRot = { ...first.rot };
        const startScale = { scaleX: first.scale.scaleX, scaleY: first.scale.scaleY, scaleZ: 1 };

        setActiveHandle(hit);
        setDragState({
          active: true,
          handle: hit,
          startPos3D: startPos,
          currentPos3D: { ...startPos },
          startRot3D: startRot,
          currentRot3D: { ...startRot },
          startScale3D: startScale,
          currentScale3D: { ...startScale },
          startMouseScreen: stagePt,
          startMouseComp: compPt,
          mouseScreen: stagePt,
          initialNodeStates,
        });
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (dragState && dragState.active) {
        try {
          stage.releasePointerCapture(e.pointerId);
        } catch {
          /* best-effort */
        }
        setActiveHandle(null);
        setDragState(null);
      }
    };

    // Capture phase on the STAGE (the overlay canvas' ancestor): the gizmo
    // must see the press BEFORE useWorkspace's overlay-level pointerdown.
    // Both used to listen on the same canvas element, where stopPropagation
    // cannot suppress a sibling listener — so clicking the gizmo also ran
    // canvas selection (deselect on empty backdrop → gizmo vanished).
    stage.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      stage.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [is3D, singleId, dragState, axisMode, camera3dMode, customViews, compWidth, compHeight, time]);

  return {
    is3D,
    singleId,
    position3D,
    nodeRotation,
    nodeScale,
    camera,
    orthoView,
    compWidth,
    compHeight,
    viewTransform,
    gizmoState,
    axisMode,
    groundGridVisible,
    activeHandle,
    hoverHandle,
    dragState,
  };
}
