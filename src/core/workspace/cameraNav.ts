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
import { flattenComposition, readNodeKind } from '@core/scene/sceneDerive';
import { activeCompRootId } from '@core/scene/activeComp';
import { is3DEnabled } from '@core/scene/threeD';
import { activeCameraNode, defaultFocalLength } from '@core/scene/camera3d';
import { applyNodePropsKeyframed } from '@core/workspace/ports';
import { bumpScene } from '@stores/sceneStore';
import { useGuidesStore, type Camera3dMode } from '@stores/guidesStore';
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
  const rootId = activeCompRootId();
  // THE shared selection rule — topmost enabled camera, not the first one found.
  //
  // This used to take the FIRST camera in traversal order while the renderer
  // took the LAST. Paint order is back-to-front, so "first" is the BOTTOM-most
  // camera: with two cameras in a comp the C tool drove one camera while the
  // user watched through another, and every drag looked like it did nothing.
  const camNode = activeCameraNode(defaultSceneGraph, rootId);
  if (!camNode || !compHasAny3D()) return null;
  const t = camNode.components.find((c) => c.type === 'Transform');
  return t ? { nodeId: camNode.id, transId: t.id } : null;
}

/** True when the ACTIVE COMPOSITION has any Camera layer at all (3D or not). */
export function sceneHasCamera(): boolean {
  return flattenComposition(defaultSceneGraph, activeCompRootId())
    .some((n) => readNodeKind(n) === 'camera');
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

/**
 * Write one camera prop. Prefer {@link writeCamProps} when a gesture changes
 * several at once — a single call is a single undo entry.
 */
export function writeCamProp(nav: CameraNavTarget, prop: string, value: number): void {
  writeCamProps(nav, { [prop]: value });
}

/**
 * Write camera props through the SAME dual path the layer gizmo uses: the
 * static base prop always, plus a keyframe when the prop is already animated or
 * Auto-Keyframe is on.
 *
 * This used to call `updateNodeComponentProp` directly — base props only — so
 * the camera tools could move a camera but never animate one. With
 * Auto-Keyframe on, dragging a layer's gizmo keyframed and dragging the camera
 * did not, which is not a distinction After Effects makes.
 *
 * All of a gesture's props go in ONE call so orbit (yaw + pitch) and track
 * (x + y + POI) each collapse to a single undo entry instead of two or four.
 */
export function writeCamProps(nav: CameraNavTarget, values: Readonly<Record<string, number>>): void {
  // Merge key stable for the gesture: the playhead cannot move mid-drag, so
  // every write in one drag coalesces.
  applyNodePropsKeyframed(nav.nodeId, values, `camnav:${nav.nodeId}`);
}

/** Orbit: swing the camera around its point of interest. Sensitivity 0.4°/px. */
export function orbitCameraBy(nav: CameraNavTarget, dx: number, dy: number): void {
  const yaw = (readCamProp(nav.nodeId, 'orbitYaw') ?? 0) + dx * 0.4;
  const pitch = Math.max(-89, Math.min(89, (readCamProp(nav.nodeId, 'orbitPitch') ?? 0) + dy * 0.4));
  writeCamProps(nav, { orbitYaw: yaw, orbitPitch: pitch });
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
  const poiX = readCamProp(nav.nodeId, 'poiX');
  const poiY = readCamProp(nav.nodeId, 'poiY');
  writeCamProps(nav, {
    x: cx - dx / s,
    y: cy - dy / s,
    ...(poiX !== undefined ? { poiX: poiX - dx / s } : {}),
    ...(poiY !== undefined ? { poiY: poiY - dy / s } : {}),
  });
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

/**
 * True when the ACTIVE COMPOSITION has at least one 3D CONTENT layer.
 *
 * Cameras and lights carry depth props but are not layers a camera can move, so
 * they never count — a comp holding only a camera and a light has nothing to
 * navigate around.
 */
export function compHasAny3D(): boolean {
  for (const n of flattenComposition(defaultSceneGraph, activeCompRootId())) {
    const k = readNodeKind(n);
    if (k !== 'camera' && k !== 'light' && is3DEnabled(n)) return true;
  }
  return false;
}

/** @deprecated Renamed to {@link compHasAny3D} — it was never scene-wide in
 *  intent, and the old name invited exactly the whole-project search that made
 *  one composition's contents enable navigation in another. */
export const sceneHasAny3D = compHasAny3D;

/**
 * Why camera navigation is unavailable right now, phrased as the next step —
 * or null when it IS available.
 *
 * The inertness itself is correct: a camera only moves layers whose 3D switch
 * is on, in After Effects too. Being inert *silently* is the bug. A user who
 * adds a camera to a flat comp, picks the camera tool and drags has no way to
 * tell the difference between "this tool does nothing here" and "this tool is
 * broken", and reported it as the latter.
 */
export function describeNavUnavailable(): string | null {
  if (findNavTarget()) return null;
  const mode = useGuidesStore.getState().camera3dMode;
  if (!compHasAny3D()) {
    return mode === 'active' && !sceneHasCamera()
      ? 'Camera tools need a Camera layer and a 3D layer — add a camera, then switch a layer to 3D.'
      : 'Camera tools need something 3D to move around — switch a layer to 3D with its 3D toggle.';
  }
  // 3D content exists, so in 'active' the missing piece is the camera itself.
  return 'Camera tools need a Camera layer in this composition — Layer ▸ New ▸ Camera.';
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
 * They used to fall through to `findCameraNav`, so Alt+drag in Top view wrote
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
  if (nav) return { kind: 'scene', ...nav };
  // No camera layer: the default view still navigates. AE's own default view
  // promotes to a custom view on the first orbit rather than demanding a
  // camera, and so does this — the same promotion an orbited axis view makes,
  // seeded from the straight-on 'front' angles so the scene doesn't jump.
  // (The "add a Camera layer" toast now only appears when there is no 3D
  // content to move around at all.)
  return sceneHasAny3D() ? { kind: 'ortho', view: 'front' } : null;
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
