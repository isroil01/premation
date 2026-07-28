/**
 * Resolve everything needed to draw a viewport's 3D reference geometry for one
 * view mode: the projection camera, the ortho axis (if any), and the scene's
 * camera / light / layer wireframes at the current playhead.
 *
 * Split out of useGizmo3d so the INSPECTION PANES can draw the same geometry.
 * The 2-up and 4-up layouts render the scene through their own views but had no
 * overlay of any kind, so a 4-up of Top / Front / Right / Active Camera — which
 * is how people actually block out a 3D scene — showed bare layers with no
 * frustums, light cones, ground plane or bounding boxes. One hook, one
 * resolution path: the panes and the main viewport cannot disagree about where
 * a camera is.
 */

import { useMemo } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useGuidesStore } from '@stores/guidesStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { is3DEnabled } from '@core/scene/threeD';
import { readSceneCamera } from '@core/scene/camera3d';
import { customViewCamera, isCustomViewId } from '@core/workspace/customViews';
import { collectSceneGizmos } from '@core/workspace/sceneGizmoData';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { defaultAnimation } from '@motion/animation';
import type { Camera3dMode } from '@stores/guidesStore';
import type { Camera3D, OrthoView } from '@motion/scene';
import type { SceneGizmo } from '@motion/workspace';
import type { SceneNode } from '@core/types';

export interface SceneRefGeometry {
  /** The projection camera for this view (a view camera, or the scene's). */
  camera: Camera3D;
  /** The axis view, or null for Active Camera / a custom view. */
  orthoView: OrthoView | null;
  /** The scene camera node id, when this view looks THROUGH it. */
  activeCameraId: string | null;
  /** True when this view is looking at a 3D scene and should draw the aids. */
  scene3d: boolean;
  /** Ground plane visibility, with Draft 3D forcing it on. */
  groundGridVisible: boolean;
  /** Camera frustums, light cones and layer boxes, in comp space. */
  sceneGizmos: readonly SceneGizmo[];
  compWidth: number;
  compHeight: number;
}

export function useSceneRefGeometry(mode: Camera3dMode): SceneRefGeometry {
  const selectedIds = useSelectionStore((s) => s.ids);
  const customViews = useGuidesStore((s) => s.customViews);
  const groundGridSetting = useGuidesStore((s) => s.groundGridVisible);
  const draft3d = useGuidesStore((s) => s.draft3d);
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);
  const time = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.time ?? 0 : 0));
  const sceneRev = useSceneRevision((s) => s.rev);

  // Draft 3D turns shadows / DOF / motion blur OFF and the spatial aids ON —
  // that pairing is the point of the mode, so the ground plane is forced rather
  // than left to a separate toggle the user has to find.
  const groundGridVisible = groundGridSetting || draft3d;

  // Resolve the projection camera at the CURRENT playhead — the same chain the
  // renderer (buildSnapshot) and the selection chrome (ports.ts) use.
  let camera: Camera3D;
  let activeCameraId: string | null = null;
  if (isCustomViewId(mode)) {
    camera = customViewCamera(customViews[mode], compWidth, compHeight);
  } else {
    let cameraNode: SceneNode | undefined;
    for (const n of flattenScene(defaultSceneGraph)) {
      if (readNodeKind(n) === 'camera') {
        cameraNode = n;
        break;
      }
    }
    activeCameraId = cameraNode?.id ?? null;
    if (cameraNode) {
      const camNode = cameraNode;
      const camValues = defaultAnimation.evaluateNode(camNode.id, getRemappedTime(camNode.id, time));
      camera = readSceneCamera(defaultSceneGraph, compWidth, compHeight, (id, p) =>
        id === camNode.id ? camValues.get(p) : undefined,
      );
    } else {
      camera = readSceneCamera(defaultSceneGraph, compWidth, compHeight);
    }
  }

  const orthoView: OrthoView | null =
    mode === 'active' || isCustomViewId(mode) ? null : (mode as OrthoView);

  /**
   * True when this view is looking at a 3D SCENE, regardless of selection. The
   * ground plane's whole job is to orient you in an otherwise empty view, so
   * gating it on selection hid it in exactly the case it exists for. A non-
   * Active view counts on its own: switching a flat comp to Left view otherwise
   * shows a blank field with no way to tell which way is up.
   */
  const scene3d = (() => {
    if (mode !== 'active' || draft3d) return true;
    for (const n of flattenScene(defaultSceneGraph)) {
      const k = readNodeKind(n);
      if (k === 'camera') return true;
      if (k !== 'light' && is3DEnabled(n)) return true;
    }
    return false;
  })();

  const sceneGizmos = useMemo(
    () =>
      scene3d
        ? collectSceneGizmos({
            time,
            compWidth,
            compHeight,
            selectedIds: new Set(selectedIds),
            // The camera this view looks THROUGH is excluded: its own frustum
            // wraps the viewer and draws a full-screen X across the comp.
            viewingThroughCameraId: mode === 'active' ? activeCameraId : null,
            includeLayerBoxes: true,
          })
        : [],
    // `sceneRev` is not read inside the callback — it is the dependency that
    // matters most. The collector walks the MUTABLE scene graph, so nothing
    // else here changes when a layer moves; the revision counter is the only
    // signal that the graph is different and the gizmos must be rebuilt.
    [scene3d, time, compWidth, compHeight, selectedIds, mode, activeCameraId, sceneRev],
  );

  return { camera, orthoView, activeCameraId, scene3d, groundGridVisible, sceneGizmos, compWidth, compHeight };
}

/**
 * The comp → canvas transform an inspection pane renders at.
 *
 * The panes pass no RenderView, so the renderer falls back to its centred
 * "contain" fit (see `viewToCamera`): zoom = min(w/compW, h/compH) · 0.92 with
 * the comp centred. Recomputing it here — rather than reading a controller the
 * panes do not have — is what lets an overlay land on the pane's pixels.
 * Duplicating the 0.92 would be a silent drift risk, so it is named here and
 * cross-checked by a test against `viewToCamera`.
 */
export const PANE_CONTAIN_FACTOR = 0.92;

export function paneViewTransform(
  cssWidth: number,
  cssHeight: number,
  compWidth: number,
  compHeight: number,
): { scale: number; offsetX: number; offsetY: number } {
  const scale = Math.min(cssWidth / compWidth, cssHeight / compHeight) * PANE_CONTAIN_FACTOR;
  return {
    scale,
    offsetX: cssWidth / 2 - (compWidth / 2) * scale,
    offsetY: cssHeight / 2 - (compHeight / 2) * scale,
  };
}
