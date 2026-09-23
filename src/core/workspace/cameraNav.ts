/**
 * Viewport camera navigation — the ONE home for orbit / track / dolly writes.
 *
 * Both input paths drive these: Alt+drag / Alt+wheel (modifier nav in
 * useWorkspace) and the C-key camera tool (left-drag orbit/pan/dolly cycling).
 * Scene-camera writes go through the engine API (B3): one engine gesture per
 * drag (the viewport's pointer gesture) or per wheel burst, keyed at the
 * playhead when the property is animated or Auto-Keyframe is on. The math is
 * incremental (each tick turns the camera by the pointer's step), so the
 * action keeps a SHADOW of the values it has written and reads them back —
 * every message then carries the camera's absolute state.
 *
 * Custom and axis views are NOT the document: their orbit / track / dolly
 * write `guidesStore` view params or the viewport pan/zoom (editor state).
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenComposition, readNodeKind } from '@core/scene/sceneDerive';
import { activeCompRootId } from '@core/scene/activeComp';
import { is3DEnabled } from '@core/scene/threeD';
import { cameraFromNode, defaultFocalLength, viewCameraNode } from '@core/scene/camera3d';
import { isSceneCameraView, orthoViewOf, type CameraViewMode } from '@core/scene/cameraViewMode';
import { nodeWorldWithParents3d } from '@core/scene/liveWorld3d';
import { readGeometry } from '@core/workspace/geometry';
import { sendNodeValues } from '@core/workspace/ports';
import {
  burstTransaction,
  currentToolTransaction,
  openBurstTransaction,
  type ToolTransaction,
} from '@core/workspace/viewportGesture';
import { defaultAnimation } from '@motion/animation';
import { useGuidesStore, type Camera3dMode, type CameraOrbitPivot } from '@stores/guidesStore';
import { useCompositionStore } from '@stores/compositionStore';
import { getTime } from '@stores/playbackClockStore';
import { getRemappedTime, governingClipsFor } from '@core/timeline/TimelineController';
import { Matrix4Math, Project3D, type Camera3D, type OrthoView, type Vec3 } from '@motion/scene';
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

/**
 * The camera-tool cycle order for the C key (see guidesStore.cycleCameraTool):
 * unified → orbit → pan → dolly → unified. 'unified' is AE's Unified Camera —
 * one armed tool where the mouse BUTTON picks the mode (left = orbit,
 * middle = pan, right = dolly); {@link unifiedNavModeFor} is that mapping.
 */
export const CAMERA_TOOL_CYCLE: ReadonlyArray<'unified' | CameraNavMode> =
  ['unified', 'orbit', 'pan', 'dolly'];

/**
 * The Unified Camera tool's button → gesture mapping (AE: left orbits, middle
 * tracks XY, right tracks Z). `button` is PointerEvent.button; anything else
 * (back/forward buttons) is not a camera gesture.
 */
export function unifiedNavModeFor(button: number): CameraNavMode | null {
  return button === 0 ? 'orbit' : button === 1 ? 'pan' : button === 2 ? 'dolly' : null;
}

export interface CameraNavTarget {
  nodeId: string;
  transId: string;
}

/**
 * Is this layer inside its in/out bar at the playhead — the renderer's
 * `isLiveAt` rule (end-exclusive spans, clamped to the last comp frame) asked
 * of the live timeline. Without it the camera tools picked the topmost camera
 * even while it was trimmed out, and orbited a camera nobody was looking
 * through.
 */
function isLiveAtPlayhead(nodeId: string): boolean {
  const clips = governingClipsFor(nodeId);
  if (clips.length === 0) return true;
  const { fps, durationSeconds } = useCompositionStore.getState();
  const raw = Math.round(getTime() * fps);
  const frame = Math.min(raw, Math.max(0, Math.round(durationSeconds * fps) - 1));
  return clips.some((l) => l.isActiveAt(frame));
}

/**
 * The camera the viewport navigates, or null when navigation is meaningless:
 * requires a Camera layer AND at least one 3D content layer (a camera over a
 * flat scene moves nothing).
 */
export function findCameraNav(
  mode: Camera3dMode = useGuidesStore.getState().camera3dMode,
): CameraNavTarget | null {
  const rootId = activeCompRootId();
  // THE shared selection rule — topmost enabled camera, not the first one found.
  //
  // This used to take the FIRST camera in traversal order while the renderer
  // took the LAST. Paint order is back-to-front, so "first" is the BOTTOM-most
  // camera: with two cameras in a comp the C tool drove one camera while the
  // user watched through another, and every drag looked like it did nothing.
  //
  // Resolved through the VIEW for the same reason: in a `camera:<id>` view the
  // camera on screen is not the topmost, and orbiting the topmost would bring
  // that exact bug back.
  const camNode = viewCameraNode(defaultSceneGraph, mode, rootId, { isLiveAt: isLiveAtPlayhead });
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

/** Idle after which a wheel dolly's burst of ticks becomes one undo entry. */
export const CAMNAV_BURST_MS = 400;

const camKey = (nodeId: string): string => `camnav:${nodeId}`;

/**
 * The tool action a camera write belongs to: the viewport's pointer gesture
 * (a drag), else a burst (Alt+wheel / the eased dolly, which write outside
 * any pointer gesture).
 */
function camTxn(nodeId: string): ToolTransaction {
  return currentToolTransaction() ?? burstTransaction(camKey(nodeId), CAMNAV_BURST_MS);
}

/** The values the current action has written to this camera (its shadow). */
function camShadow(nodeId: string): Record<string, number> | undefined {
  const txn = currentToolTransaction() ?? openBurstTransaction(camKey(nodeId));
  return txn?.peek<Record<string, number>>(camKey(nodeId));
}

/**
 * A camera prop as the NEXT navigation step must see it: what this action
 * already wrote (the engine applies messages asynchronously, and an animated
 * prop takes a key rather than a new static value), else the value at the
 * playhead (animated winning), else the static prop.
 */
export function readCamProp(nodeId: string, prop: string): number | undefined {
  const shadowed = camShadow(nodeId)?.[prop];
  if (shadowed !== undefined) return shadowed;
  if (defaultAnimation.isAnimated(nodeId, prop)) {
    const v = defaultAnimation.sample(nodeId, prop, getRemappedTime(nodeId, getTime()));
    if (v !== undefined) return v;
  }
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
 * several at once.
 */
export function writeCamProp(nav: CameraNavTarget, prop: string, value: number, label = 'Camera'): void {
  writeCamProps(nav, { [prop]: value }, label);
}

/**
 * Write camera props as part of the current action — ONE engine gesture per
 * drag or wheel burst, the whole shadow (every prop this action changed, at
 * its latest value) in each message, so each message is absolute. A property
 * already animated — or any while Auto-Keyframe is on — keys at the playhead:
 * the camera tools animate a camera exactly as the layer gizmo animates a
 * layer, which is what After Effects does.
 */
export function writeCamProps(nav: CameraNavTarget, values: Readonly<Record<string, number>>, label = 'Camera'): void {
  const txn = camTxn(nav.nodeId);
  const shadow = txn.memo<Record<string, number>>(camKey(nav.nodeId), () => ({}));
  Object.assign(shadow, values);
  sendNodeValues(nav.nodeId, { ...shadow }, label, camKey(nav.nodeId), txn);
}

/** Orbit: swing the camera around its point of interest. Sensitivity 0.4°/px. */
export function orbitCameraBy(nav: CameraNavTarget, dx: number, dy: number): void {
  const yaw = (readCamProp(nav.nodeId, 'orbitYaw') ?? 0) + dx * 0.4;
  const pitch = Math.max(-89, Math.min(89, (readCamProp(nav.nodeId, 'orbitPitch') ?? 0) + dy * 0.4));
  writeCamProps(nav, { orbitYaw: yaw, orbitPitch: pitch }, 'Orbit Camera');
}

// ── Orbit about an arbitrary world pivot (AE's Orbit Around Cursor / Scene) ──

const DEGR = Math.PI / 180;
const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const sub3 = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const add3 = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);

/** Rx(pitch) then Ry(yaw) — the same axis order `Project3D.orbitCamera` uses,
 *  so an incremental pivot orbit and the POI orbit turn the same way. */
function rotYawPitch(v: Vec3, yawDeg: number, pitchDeg: number): Vec3 {
  const cx = Math.cos(pitchDeg * DEGR);
  const sx = Math.sin(pitchDeg * DEGR);
  const y1 = cx * v.y - sx * v.z;
  const z1 = sx * v.y + cx * v.z;
  const cy = Math.cos(yawDeg * DEGR);
  const sy = Math.sin(yawDeg * DEGR);
  return v3(cy * v.x + sy * z1, y1, -sy * v.x + cy * z1);
}

/** Inverse of {@link rotYawPitch}: Ry(−yaw) then Rx(−pitch). */
function rotYawPitchInv(v: Vec3, yawDeg: number, pitchDeg: number): Vec3 {
  const cy = Math.cos(yawDeg * DEGR);
  const sy = Math.sin(yawDeg * DEGR);
  const x1 = cy * v.x - sy * v.z;
  const z1 = sy * v.x + cy * v.z;
  const cx = Math.cos(pitchDeg * DEGR);
  const sx = Math.sin(pitchDeg * DEGR);
  return v3(x1, cx * v.y + sx * z1, -sx * v.y + cx * z1);
}

/**
 * Orbit the WHOLE camera rig rigidly about `pivot` — the cursor point or the
 * scene origin, not the camera's own target.
 *
 * The existing orbit props cannot express this (orbitYaw/orbitPitch always
 * pivot on the POI / comp centre), so the rotation is folded back into the
 * props the camera model already has:
 *
 *  - **Two-node camera** — the eye AND the Point of Interest rotate about the
 *    pivot (a rigid move, so the shot keeps framing its subject while the rig
 *    swings around the pivot). orbitYaw/orbitPitch stay untouched; the BASE
 *    position is solved so the resolved eye lands where the rigid rotation
 *    put it. The pivot itself is never written into the POI — orbiting around
 *    the cursor must not re-target the camera.
 *  - **One-node camera** — the eye rotates about the pivot and the in-place
 *    aim follows by ADDING the deltas to orbitYaw/orbitPitch (additive Euler,
 *    exactly how the POI orbit composes drags); the base position is solved
 *    back through the new angles so the resolved eye is the rotated one.
 *
 * One `writeCamProps` call per drag tick; the drag is one engine gesture =
 * one undo entry, the same contract every other nav write keeps.
 */
export function orbitCameraAboutPivot(
  nav: CameraNavTarget,
  dx: number,
  dy: number,
  pivot: Vec3,
  compWidth: number,
  compHeight: number,
): void {
  const dYaw = dx * 0.4;
  const focal = readCamProp(nav.nodeId, 'focalLength') ?? defaultFocalLength(compWidth || 1920);
  const base = v3(
    readCamProp(nav.nodeId, 'x') ?? compWidth / 2,
    readCamProp(nav.nodeId, 'y') ?? compHeight / 2,
    readCamProp(nav.nodeId, 'z') ?? -focal,
  );
  const yaw = readCamProp(nav.nodeId, 'orbitYaw') ?? 0;
  const pitch = readCamProp(nav.nodeId, 'orbitPitch') ?? 0;
  const poiX = readCamProp(nav.nodeId, 'poiX');
  const poiY = readCamProp(nav.nodeId, 'poiY');
  const poiZ = readCamProp(nav.nodeId, 'poiZ');
  const hasPOI = poiX !== undefined || poiY !== undefined || poiZ !== undefined;

  if (hasPOI) {
    const poi = v3(poiX ?? compWidth / 2, poiY ?? compHeight / 2, poiZ ?? 0);
    const eye = Project3D.orbitCamera(base, poi, yaw, pitch).position;
    const dPitch = dy * 0.4;
    const eye2 = add3(pivot, rotYawPitch(sub3(eye, pivot), dYaw, dPitch));
    const poi2 = add3(pivot, rotYawPitch(sub3(poi, pivot), dYaw, dPitch));
    const base2 = add3(poi2, rotYawPitchInv(sub3(eye2, poi2), yaw, pitch));
    writeCamProps(nav, {
      x: base2.x, y: base2.y, z: base2.z,
      poiX: poi2.x, poiY: poi2.y, poiZ: poi2.z,
    }, 'Orbit Camera');
  } else {
    const centre = v3(compWidth / 2, compHeight / 2, 0);
    const eye = Project3D.orbitCamera(base, centre, yaw, pitch).position;
    const newYaw = yaw + dYaw;
    // The same ±89° pitch clamp as the POI orbit; the rigid rotation applies
    // only the pitch that survived the clamp, so eye and aim stay in step.
    const newPitch = Math.max(-89, Math.min(89, pitch + dy * 0.4));
    const dPitch = newPitch - pitch;
    const eye2 = add3(pivot, rotYawPitch(sub3(eye, pivot), dYaw, dPitch));
    const base2 = add3(centre, rotYawPitchInv(sub3(eye2, centre), newYaw, newPitch));
    writeCamProps(nav, {
      x: base2.x, y: base2.y, z: base2.z,
      orbitYaw: newYaw, orbitPitch: newPitch,
    }, 'Orbit Camera');
  }
}

/**
 * The world-space pivot the CURRENT orbit-pivot mode asks for, resolved at
 * DRAG START (the pivot must not slide mid-gesture), or null when the drag
 * should use the classic POI orbit ('poi' mode, and every non-scene target).
 *
 * `cursor` is the pointer in COMP px (`ws.screenToWorld` of the pointer).
 * Cursor mode projects it into the scene:
 *
 *  1. the plane of the FRONTMOST 3D layer under the cursor (nearest ray hit
 *     whose intersection lands inside the layer's box), else
 *  2. the ground plane (y = compHeight + groundLevel — where the 3D ground
 *     grid actually draws; the comp's floor, not the top edge), else
 *  3. the POI-distance plane facing the camera, so empty space still orbits
 *     at a sensible depth.
 */
export function resolveOrbitPivot(
  cursor: { x: number; y: number } | null,
  compWidth: number,
  compHeight: number,
  mode: CameraOrbitPivot = useGuidesStore.getState().cameraOrbitPivot,
): Vec3 | null {
  if (mode === 'poi') return null;
  if (mode === 'scene') return v3(0, 0, 0);
  if (!cursor) return null;

  const rootId = activeCompRootId();
  const view = useGuidesStore.getState().camera3dMode;
  const camNode = viewCameraNode(defaultSceneGraph, view, rootId, { isLiveAt: isLiveAtPlayhead });
  const cam = camNode
    ? cameraFromNode(camNode, compWidth, compHeight)
    : Project3D.defaultCamera(compWidth, compHeight);
  const ray = Project3D.unprojectScreenRay(cursor.x, cursor.y, cam, null, compWidth, compHeight);
  const rayT = (p: Vec3): number =>
    (p.x - ray.origin.x) * ray.direction.x
    + (p.y - ray.origin.y) * ray.direction.y
    + (p.z - ray.origin.z) * ray.direction.z;

  // 1) Frontmost 3D layer plane under the cursor.
  const time = getTime();
  let best: { t: number; p: Vec3 } | null = null;
  for (const n of flattenComposition(defaultSceneGraph, rootId)) {
    const kind = readNodeKind(n);
    if (kind === 'camera' || kind === 'light') continue;
    if (n.visible === false || !is3DEnabled(n)) continue;
    const g = readGeometry(n);
    if (!g || !(g.width > 0) || !(g.height > 0)) continue;
    const m = nodeWorldWithParents3d(n, time);
    if (!m) continue;
    const origin = Matrix4Math.transformPoint(m, v3(0, 0, 0));
    const zTip = Matrix4Math.transformPoint(m, v3(0, 0, 1));
    const hit = Project3D.intersectRayPlane(ray, origin, sub3(zTip, origin));
    if (!hit) continue;
    const inv = Matrix4Math.invert(m);
    if (!inv) continue;
    const local = Matrix4Math.transformPoint(inv, hit);
    if (local.x < 0 || local.x > g.width || local.y < 0 || local.y > g.height) continue;
    const t = rayT(hit);
    if (t <= 0) continue;
    if (!best || t < best.t) best = { t, p: hit };
  }
  if (best) return best.p;

  // 2) The ground plane, where the 3D ground grid draws.
  const groundLevel = useCompositionStore.getState().groundLevel ?? 0;
  const ground = Project3D.intersectRayPlane(
    ray, v3(0, compHeight + groundLevel, 0), v3(0, 1, 0),
  );
  if (ground && rayT(ground) > 0) return ground;

  // 3) The POI-distance plane facing the camera.
  const dist = poiDistanceOf(camNode?.id ?? null, cam, compWidth, compHeight);
  const fwd = Project3D.unprojectScreenRay(compWidth / 2, compHeight / 2, cam, null, compWidth, compHeight).direction;
  const planePoint = add3(cam.position, v3(fwd.x * dist, fwd.y * dist, fwd.z * dist));
  const facing = Project3D.intersectRayPlane(ray, planePoint, fwd);
  return facing && rayT(facing) > 0 ? facing : planePoint;
}

/** Eye → POI distance for a two-node camera; the focal length otherwise (the
 *  comp-plane distance a fresh camera sits at). */
function poiDistanceOf(
  nodeId: string | null,
  cam: Camera3D,
  compWidth: number,
  compHeight: number,
): number {
  if (nodeId) {
    const px = readCamProp(nodeId, 'poiX');
    const py = readCamProp(nodeId, 'poiY');
    const pz = readCamProp(nodeId, 'poiZ');
    if (px !== undefined || py !== undefined || pz !== undefined) {
      const poi = v3(px ?? compWidth / 2, py ?? compHeight / 2, pz ?? 0);
      const d = Math.hypot(poi.x - cam.position.x, poi.y - cam.position.y, poi.z - cam.position.z);
      if (d > 1e-3) return d;
    }
  }
  return Math.max(1, cam.focalLength);
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
  }, 'Track Camera');
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
  writeCamProp(nav, 'z', z - delta * 2, 'Dolly Camera');
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
    return isSceneCameraView(mode) && !sceneHasCamera()
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
  const ortho = orthoViewOf(mode);
  if (ortho) {
    return sceneHasAny3D() ? { kind: 'ortho', view: ortho } : null;
  }
  // Active Camera or a camera view: the scene camera that view looks through.
  const nav = findCameraNav(mode);
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

/**
 * Orbit through the mode-aware target (0.4°/px on every path).
 *
 * `pivot` (from {@link resolveOrbitPivot}, captured at DRAG START) swings a
 * SCENE camera about that world point instead of its POI. View targets ignore
 * it on purpose: an orthographic/custom view keeps its existing
 * promote-to-custom-view orbit, exactly as before.
 */
export function orbitNavBy(t: NavTarget, dx: number, dy: number, pivot?: Vec3 | null): void {
  if (t.kind === 'scene') {
    if (pivot) {
      const comp = useCompositionStore.getState();
      orbitCameraAboutPivot(t, dx, dy, pivot, comp.width, comp.height);
      return;
    }
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
 *
 * A `camera:<id>` view passes through as-is: buildSnapshot resolves the node
 * itself, per frame and with the same stale-id fallback as every other reader,
 * rather than trusting a camera pre-built here from an id that may have died.
 */
export function resolveViewCameraInput(
  width: number,
  height: number,
  mode: Camera3dMode = useGuidesStore.getState().camera3dMode,
): { camera3dMode: 'active' | OrthoView | CameraViewMode; customViewCamera?: Camera3D } {
  if (isCustomViewId(mode)) {
    return {
      camera3dMode: 'active',
      customViewCamera: customViewCamera(useGuidesStore.getState().customViews[mode], width, height),
    };
  }
  return { camera3dMode: mode };
}
