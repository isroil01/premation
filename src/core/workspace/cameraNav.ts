/**
 * Viewport camera navigation — the ONE home for orbit / track / dolly writes.
 *
 * Both input paths drive these: Alt+drag / Alt+wheel (modifier nav in
 * useWorkspace) and the C-key camera tool (left-drag orbit/pan/dolly cycling).
 * Writes go to BASE Transform props via updateNodeComponentProp — the same
 * path CameraSection's fields use — so no keyframes are created and the
 * inspector live-updates.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { is3DEnabled } from '@core/scene/threeD';
import { defaultFocalLength } from '@core/scene/camera3d';
import { updateNodeComponentProp } from '@core/inspector/InspectorAPI';
import { bumpScene } from '@stores/sceneStore';
import { useGuidesStore, type Camera3dMode } from '@stores/guidesStore';
import type { SceneNode } from '@core/types';
import type { Camera3D, OrthoView } from '@motion/scene';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import {
  customViewCamera,
  DollyEaser,
  dollyViewParams,
  isCustomViewId,
  orbitViewParams,
  ORTHO_VIEW_ANGLES,
  resolveCustomView,
  trackViewParams,
  type CustomViewId,
} from './customViews';

/** The three camera navigation modes (AE: Orbit / Track XY / Track Z). */
export type CameraNavMode = 'orbit' | 'pan' | 'dolly';

/** The camera-tool cycle order for the C key: orbit → pan → dolly → orbit. */
export const CAMERA_TOOL_CYCLE: readonly CameraNavMode[] = ['orbit', 'pan', 'dolly'];

export interface CameraNavTarget {
  nodeId: string;
  transId: string;
}

/**
 * The camera the viewport navigates, or null when navigation is meaningless:
 * requires a Camera layer AND at least one 3D content layer (a camera over a
 * flat scene moves nothing).
 */
export function findCameraNav(): CameraNavTarget | null {
  let camNode: SceneNode | undefined;
  let any3D = false;
  for (const n of flattenScene(defaultSceneGraph)) {
    const k = readNodeKind(n);
    if (k === 'camera') {
      if (!camNode) camNode = n;
      continue;
    }
    if (k !== 'light' && is3DEnabled(n)) any3D = true;
  }
  if (!camNode || !any3D) return null;
  const t = camNode.components.find((c) => c.type === 'Transform');
  return t ? { nodeId: camNode.id, transId: t.id } : null;
}

/** True when the ACTIVE scene has any Camera layer at all (3D or not). */
export function sceneHasCamera(): boolean {
  return flattenScene(defaultSceneGraph).some((n) => readNodeKind(n) === 'camera');
}

/**
 * Gentle nudge after a layer is made 3D: without a camera, 3D depth doesn't
 * move — surface the one-step fix. No-op when a camera already exists.
 */
export function notifyCameraTipIfMissing(
  notify: (message: string, level: 'info' | 'warning') => void,
): void {
  if (!sceneHasCamera()) {
    notify('Tip: add a Camera (+ camera button in the viewport bar) to move in 3D', 'info');
  }
}

export function readCamProp(nodeId: string, prop: string): number | undefined {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return undefined;
  for (const c of node.components) {
    const v = (c.props as Record<string, unknown>)[prop];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

export function writeCamProp(nav: CameraNavTarget, prop: string, value: number): void {
  updateNodeComponentProp(defaultSceneGraph, nav.nodeId, nav.transId, prop, value);
}

/** Orbit: swing the camera around its point of interest. Sensitivity 0.4°/px. */
export function orbitCameraBy(nav: CameraNavTarget, dx: number, dy: number): void {
  const yaw = (readCamProp(nav.nodeId, 'orbitYaw') ?? 0) + dx * 0.4;
  const pitch = Math.max(-89, Math.min(89, (readCamProp(nav.nodeId, 'orbitPitch') ?? 0) + dy * 0.4));
  writeCamProp(nav, 'orbitYaw', yaw);
  writeCamProp(nav, 'orbitPitch', pitch);
  bumpScene();
}

/**
 * Track XY (AE): the framing follows the cursor, so the camera moves opposite
 * the drag. Screen px → comp px through the viewport zoom. Two-node cameras
 * shift the POI with the eye so the framing tracks instead of re-aiming.
 */
export function trackCameraBy(
  nav: CameraNavTarget,
  dx: number,
  dy: number,
  viewScale: number,
  compWidth: number,
  compHeight: number,
): void {
  const s = viewScale || 1;
  const cx = readCamProp(nav.nodeId, 'x') ?? compWidth / 2;
  const cy = readCamProp(nav.nodeId, 'y') ?? compHeight / 2;
  writeCamProp(nav, 'x', cx - dx / s);
  writeCamProp(nav, 'y', cy - dy / s);
  const poiX = readCamProp(nav.nodeId, 'poiX');
  const poiY = readCamProp(nav.nodeId, 'poiY');
  if (poiX !== undefined) writeCamProp(nav, 'poiX', poiX - dx / s);
  if (poiY !== undefined) writeCamProp(nav, 'poiY', poiY - dy / s);
  bumpScene();
}

/**
 * Dolly along the view axis. Default z is -focalLength (comp plane 1:1), so a
 * negative delta (wheel-up / drag-up) pushes z toward 0 = dolly IN. `delta` is
 * in raw input units (wheel deltaY or drag px); the 2× factor matches the
 * long-standing Alt+wheel feel.
 */
export function dollyCameraBy(nav: CameraNavTarget, delta: number, compWidth: number): void {
  const focal = readCamProp(nav.nodeId, 'focalLength') ?? defaultFocalLength(compWidth || 1920);
  const z = readCamProp(nav.nodeId, 'z') ?? -focal;
  writeCamProp(nav, 'z', z - delta * 2);
  bumpScene();
}

// ── Mode-aware navigation (scene camera OR custom view) ────────────────────
//
// In 'active' (and the ortho views, where nav is meaningless) the target is
// the scene's Camera layer, exactly as before. In a CUSTOM view the target is
// the view's STORED params in guidesStore — orbit/track/dolly re-frame the
// view without touching any scene node, which is the whole point of AE's
// custom views. Custom-view nav needs NO camera layer; its only gate is that
// the comp has something 3D to look at.

/** True when the ACTIVE scene has at least one 3D content layer. */
export function sceneHasAny3D(): boolean {
  for (const n of flattenScene(defaultSceneGraph)) {
    const k = readNodeKind(n);
    if (k !== 'camera' && k !== 'light' && is3DEnabled(n)) return true;
  }
  return false;
}

/** What viewport navigation writes to: a scene camera node, or a stored view. */
export type NavTarget =
  | { kind: 'scene'; nodeId: string; transId: string }
  | { kind: 'view'; viewId: CustomViewId }
  | { kind: 'ortho'; view: OrthoView };

/**
 * The navigation target for the CURRENT view mode, or null when navigation is
 * meaningless (no camera+3D in 'active'; no 3D layer at all in the views).
 *
 * The six axis views resolve to their OWN target, not to the scene camera.
 * They used to fall through to `findCameraNav()`, so Alt+drag in Top view wrote
 * orbitYaw / orbitPitch / x / y / z to the shot camera — invisibly, because an
 * orthographic view ignores the scene camera entirely and so showed no sign of
 * the change. Switching views must never modify the scene.
 */
export function findNavTarget(): NavTarget | null {
  const mode = useGuidesStore.getState().camera3dMode;
  if (isCustomViewId(mode)) {
    return sceneHasAny3D() ? { kind: 'view', viewId: mode } : null;
  }
  if (mode !== 'active') {
    return sceneHasAny3D() ? { kind: 'ortho', view: mode as OrthoView } : null;
  }
  const nav = findCameraNav();
  return nav ? { kind: 'scene', ...nav } : null;
}

function readView(viewId: CustomViewId) {
  return useGuidesStore.getState().customViews[viewId];
}

/**
 * The custom view an orbited axis view is promoted into. Fixed rather than
 * "last used" so the promotion is predictable, and the view label visibly
 * changes to "Custom View 1" — the user can see what happened rather than
 * having a saved view silently rewritten under them.
 */
const ORTHO_ORBIT_PROMOTES_TO: CustomViewId = 'custom1';

/** Orbit through the mode-aware target (0.4°/px on every path). */
export function orbitNavBy(t: NavTarget, dx: number, dy: number): void {
  if (t.kind === 'scene') {
    orbitCameraBy(t, dx, dy);
    return;
  }
  if (t.kind === 'ortho') {
    // Swinging off the axis makes this a custom view by definition. Seed one
    // from the axis angles so the scene does not jump, apply the drag, and
    // switch the viewport to it. Pure view state — no scene node is touched.
    const seeded = orbitViewParams(ORTHO_VIEW_ANGLES[t.view], dx, dy);
    const g = useGuidesStore.getState();
    g.updateCustomView(ORTHO_ORBIT_PROMOTES_TO, { ...seeded, distance: null, poi: null });
    g.setCamera3dMode(ORTHO_ORBIT_PROMOTES_TO);
    return;
  }
  const v = readView(t.viewId);
  useGuidesStore.getState().updateCustomView(t.viewId, orbitViewParams(v, dx, dy));
}

/** Track XY through the mode-aware target (framing follows the cursor). */
export function trackNavBy(
  t: NavTarget,
  dx: number,
  dy: number,
  viewScale: number,
  compWidth: number,
  compHeight: number,
): void {
  if (t.kind === 'scene') {
    trackCameraBy(t, dx, dy, viewScale, compWidth, compHeight);
    return;
  }
  if (t.kind === 'ortho') {
    // An axis view has no eye to move — "track" here IS the viewport pan, and
    // the framing follows the cursor (drag right, scene comes with you).
    getWorkspaceController().ws.pan(dx, dy);
    return;
  }
  const v = resolveCustomView(readView(t.viewId), compWidth, compHeight);
  useGuidesStore.getState().updateCustomView(t.viewId, trackViewParams(v, dx, dy, viewScale));
}

/** Dolly through the mode-aware target (immediate; wheel input should prefer
 *  {@link smoothDollyNavBy}). */
export function dollyNavBy(t: NavTarget, delta: number, compWidth: number, compHeight = 1080): void {
  if (t.kind === 'scene') {
    dollyCameraBy(t, delta, compWidth);
    return;
  }
  if (t.kind === 'ortho') {
    // Parallel projection: moving the eye along the view axis changes nothing,
    // so dolly maps to the viewport zoom — the only "closer" an ortho view has.
    // delta < 0 (wheel-up / drag-up) zooms IN, matching the other two paths.
    getWorkspaceController().ws.zoom(Math.exp(-delta * 0.002));
    return;
  }
  const v = resolveCustomView(readView(t.viewId), compWidth, compHeight);
  useGuidesStore.getState().updateCustomView(t.viewId, dollyViewParams(v, delta));
}

// ── Smooth wheel dolly (shared easer for Alt+wheel and the dolly tool) ─────
//
// Wheel ticks accumulate into a DollyEaser; a rAF loop eases the pending delta
// out through dollyNavBy, so both the scene camera's z and a custom view's
// distance glide instead of stepping. The target is re-resolved per eased
// frame, so a mid-glide view switch just keeps writing to the right place.

let dollyEaser: DollyEaser | null = null;
let dollyCompSize = { width: 1920, height: 1080 };

export function smoothDollyNavBy(delta: number, compWidth: number, compHeight = 1080): void {
  dollyCompSize = { width: compWidth, height: compHeight };
  if (!dollyEaser) {
    dollyEaser = new DollyEaser((d) => {
      const t = findNavTarget();
      if (t) dollyNavBy(t, d, dollyCompSize.width, dollyCompSize.height);
    });
  }
  dollyEaser.add(delta);
}

/** Cancel any in-flight eased dolly (viewport unmount / camera-tool exit). */
export function cancelSmoothDolly(): void {
  dollyEaser?.dispose();
}

// ── View → renderer input ──────────────────────────────────────────────────

/**
 * Resolve a view mode into buildSnapshot's camera inputs: custom views become
 * `{ camera3dMode: 'active', customViewCamera }` (a pre-built camera that
 * REPLACES the scene camera downstream), everything else passes through
 * unchanged. `mode` defaults to the store's current camera3dMode so render
 * closures always see the live view; a pane can pass its own override.
 */
export function resolveViewCameraInput(
  width: number,
  height: number,
  mode: Camera3dMode = useGuidesStore.getState().camera3dMode,
): { camera3dMode: 'active' | OrthoView; customViewCamera?: Camera3D } {
  if (isCustomViewId(mode)) {
    return {
      camera3dMode: 'active',
      customViewCamera: customViewCamera(useGuidesStore.getState().customViews[mode], width, height),
    };
  }
  return { camera3dMode: mode };
}
