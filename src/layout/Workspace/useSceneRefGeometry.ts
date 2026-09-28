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
import { secondsToFlicks, type OverlayKind, type OverlayView } from '@motion/engine-api';
import { useSelectionStore } from '@stores/selectionStore';
import { useGuidesStore } from '@stores/guidesStore';
import { useCurrentTime } from '@stores/playbackClockStore';
import { useActiveCompRootId, useActiveTabCompSettings, useMirrorRevisionFrame } from '@hooks/useMirrorFrame';
import { useOverlayRequest } from '@hooks/useOverlayRequest';
import { documentMirror } from '@stores/documentMirror';
import { MAIN_VIEWPORT, overlayLayer, overlayView, type OverlayLayer } from '@stores/overlayGeometry';
import { compHas3DContent } from '@core/mirror/compLayers';
import { settingsWorld } from '@core/mirror/compFacts';
import { sceneGizmosFrom, sceneLayersOf, viewCameraOf } from '@core/mirror/viewGeometry';
import { isSceneCameraView, orthoViewOf } from '@core/scene/cameraViewMode';
import { isCustomViewId } from '@core/workspace/customViews';
import type { Camera3dMode } from '@stores/guidesStore';
import type { Camera3D, OrthoView } from '@motion/scene';
import type { SceneGizmo } from '@motion/workspace';
import { usePreferenceStore } from '@stores/preferenceStore';

/** What the 3D reference geometry subscribes for each camera / light / 3D layer: the world matrix, the drawn box, the scene3d record. */
export const SCENE_REF_KINDS: readonly OverlayKind[] = ['transform', 'bounds', 'scene3d'];

export interface SceneRefGeometry {
  /** The projection camera for this view (a view camera, or the scene's). */
  camera: Camera3D;
  /** The axis view, or null for Active Camera / a custom view. */
  orthoView: OrthoView | null;
  /**
   * The scene camera this view resolves to — the active one, or the one a
   * `camera:<id>` view names (`viewCameraNode`). A view only looks THROUGH it
   * when `isSceneCameraView(mode)`; the axis views still report it.
   */
  activeCameraId: string | null;
  /** True when this view is looking at a 3D scene and should draw the aids. */
  scene3d: boolean;
  /** Ground plane visibility, with Draft 3D forcing it on. */
  groundGridVisible: boolean;
  /**
   * Where the ground plane sits, as an offset in comp units from the comp's
   * bottom edge (Composition Settings ▸ World ▸ Ground level). 0 is the plane
   * at y = compHeight this has always drawn, to the pixel.
   */
  groundLevel: number;
  /** Camera frustums, light cones and layer boxes, in comp space. */
  sceneGizmos: readonly SceneGizmo[];
  compWidth: number;
  compHeight: number;
  /** B4 round 5: the pushed view camera record of this mode (undefined before the subscription's first frame). */
  view: OverlayView | undefined;
  /** The composition's cameras, lights and 3D layers (back to front) — subscribed with SCENE_REF_KINDS. */
  sceneLayers: readonly string[];
  /** A subscribed layer's pushed record for the frame on screen. */
  recordOf: (id: string) => OverlayLayer | undefined;
  /** Changes when the pushed geometry does (a memo dependency). */
  geometryTick: number;
}

export function useSceneRefGeometry(mode: Camera3dMode): SceneRefGeometry {
  const selectedIds = useSelectionStore((s) => s.ids);
  const customViews = useGuidesStore((s) => s.customViews);
  const groundGridSetting = useGuidesStore((s) => s.groundGridVisible);
  const layerBoxesVisible = usePreferenceStore((s) => s.showLayerBounds);
  const deviceWireframesAll = usePreferenceStore((s) => s.deviceWireframesAll);
  const draft3d = useGuidesStore((s) => s.draft3d);
  const compSettings = useActiveTabCompSettings();
  const compWidth = compSettings?.width ?? 1920;
  const compHeight = compSettings?.height ?? 1080;
  // Per-COMP, not a view setting: where the floor is is a fact about the scene
  // being blocked out, so it has to follow the composition across views, panes
  // and sessions rather than resetting with the viewport chrome.
  // (World ▸ Ground level; `settingsWorld` caches the parse per JSON string, so this per-frame read allocates nothing.)
  const groundLevelSetting = settingsWorld(compSettings).groundLevel;
  // Scoped like the renderer's, so the overlay never draws a different camera
  // than the one the frame was rendered through.
  const compRootId = useActiveCompRootId();
  const time = useCurrentTime();
  const sceneRev = useMirrorRevisionFrame();

  // Draft 3D turns shadows / DOF / motion blur OFF and the spatial aids ON —
  // that pairing is the point of the mode, so the ground plane is forced rather
  // than left to a separate toggle the user has to find.
  const groundGridVisible = groundGridSetting || draft3d;
  // Absent (every document written before World settings existed) reads as 0,
  // which is byte-for-byte the plane this drew before.
  const groundLevel = Number.isFinite(groundLevelSetting) ? (groundLevelSetting as number) : 0;

  const orthoView: OrthoView | null = orthoViewOf(mode);

  /**
   * True when this view is looking at a 3D SCENE, regardless of selection. The
   * ground plane's whole job is to orient you in an otherwise empty view, so
   * gating it on selection hid it in exactly the case it exists for. A non-
   * Active view counts on its own: switching a flat comp to Left view otherwise
   * shows a blank field with no way to tell which way is up.
   */
  // Memoised on the scene revision: this hook re-renders every FRAME during
  // playback (it reads the time), and the scan is a walk of the whole comp.
  const scene3d = useMemo(() => {
    if (!isSceneCameraView(mode) || draft3d) return true;
    // Comp-scoped: a camera or 3D layer in a DIFFERENT composition must not
    // switch this one's reference geometry on.
    return compHas3DContent(documentMirror(), compRootId, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sceneRev is the walk's dependency
  }, [mode, draft3d, compRootId, sceneRev]);

  // B4 round 5: the view camera and the scene's cameras / lights / 3D layers come
  // from the overlay geometry push — resolved engine-side at the frame's own time,
  // exactly as the renderer resolves them (core/engine/overlayScene3d.ts, the C++
  // overlay_geometry.cpp). The layer LIST is the mirror's (kinds and switches).
  // Not gated on `scene3d`: the device handles (useDeviceHandles) read the
  // cameras and lights in any view, as they always did.
  const sceneLayers = useMemo(
    () => sceneLayersOf(documentMirror(), compRootId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sceneRev is the walk's dependency
    [compRootId, sceneRev],
  );
  const geometryTick = useOverlayRequest('sceneRef', sceneLayers, SCENE_REF_KINDS, isCustomViewId(mode) ? [] : [mode]);
  const at = secondsToFlicks(time);
  const view = isCustomViewId(mode) ? undefined : overlayView(MAIN_VIEWPORT, mode, at);
  // Custom views build their camera from their STORED params (the scene camera ignored).
  const camera: Camera3D = viewCameraOf(mode, view, customViews, compWidth, compHeight);
  const activeCameraId: string | null = isCustomViewId(mode) ? null : view?.camera || null;
  const recordOf = useMemo(
    () => (id: string): OverlayLayer | undefined => overlayLayer(MAIN_VIEWPORT, id, at),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- geometryTick: a new frame's records
    [at, geometryTick],
  );

  const sceneGizmos = useMemo(
    () =>
      scene3d
        ? sceneGizmosFrom(documentMirror(), sceneLayers, recordOf, {
            compWidth,
            compHeight,
            selectedIds: new Set(selectedIds),
            // The camera this view looks THROUGH is excluded: its own frustum
            // wraps the viewer and draws a full-screen X across the comp.
            viewingThroughCameraId: isSceneCameraView(mode) ? activeCameraId : null,
            // Was unconditional. On a comp with many small layers the boxes
            // pack together into a picket fence of vertical lines that reads as
            // banding on the artwork itself — chrome mistaken for output.
            includeLayerBoxes: layerBoxesVisible,
            throughSceneCamera: isSceneCameraView(mode),
            devicesSelectedOnly: !deviceWireframesAll,
          })
        : [],
    [scene3d, sceneLayers, recordOf, compWidth, compHeight, selectedIds, mode, activeCameraId, layerBoxesVisible, deviceWireframesAll],
  );

  return {
    camera, orthoView, activeCameraId, scene3d, groundGridVisible, groundLevel, sceneGizmos, compWidth, compHeight,
    view, sceneLayers, recordOf, geometryTick,
  };
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
