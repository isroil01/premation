/**
 * The viewport's 3D chrome built from the overlay geometry PUSH (B4 round 5,
 * ENGINE_API.md §15.14): the view camera of a view mode (`OverlayView`) and the
 * cameras / lights / 3D layers of the composition (`OverlayScene3D` records,
 * kind `scene3d`), combined with the mirror's layer headers (kinds, switches,
 * stacking order) and editor state (the selection, the custom views).
 *
 * Pure — every input is an argument. The engine resolves each camera, light
 * and layer exactly as the renderer does (core/engine/overlayScene3d.ts, the
 * C++ overlay_geometry.cpp); what is left here is the editor's choice of what
 * to draw (selected-only devices, the camera looked through, the layer cages)
 * and the pure geometry builders of @motion/workspace.
 */

import type { OverlayScene3D, OverlayView } from '@motion/engine-api';
import { Matrix4Math, Project3D, type Camera3D, type Matrix4, type Vec3 } from '@motion/scene';
import { SceneGizmos, type SceneGizmo } from '@motion/workspace';
import { customViewCamera, isCustomViewId, type CustomViewParams } from '@core/workspace/customViews';
import { isSceneCameraView, orthoViewOf } from '@core/scene/cameraViewMode';
import type { DofConfig } from '@core/scene/camera3d';
import type { NavTarget } from '@core/workspace/cameraNav';
import { canBe3DLayer, uiKindOf } from './layerKinds';
import { flattenCompLayers, type MirrorCompLayersRead } from './compLayers';

/** One layer's pushed geometry, as the overlay mirror merges it (src/stores/overlayGeometry.ts `OverlayLayer`). */
export interface PushedLayer {
  matrix: readonly number[];
  box: readonly number[];
  scene?: OverlayScene3D;
}

/** A pushed lens (position, focalLength, principal, yaw, pitch, roll) as a Camera3D; zero angles = no orientation. */
export function cameraOfLens(lens: readonly number[]): Camera3D | null {
  if (lens.length < 9) return null;
  const [x, y, z, focalLength, px, py, yaw, pitch, roll] = lens as [number, number, number, number, number, number, number, number, number];
  const cam: Camera3D = { position: { x, y, z }, focalLength, principal: { x: px, y: py } };
  if (yaw !== 0 || pitch !== 0 || roll !== 0) cam.orientation = roll !== 0 ? { yaw, pitch, roll } : { yaw, pitch };
  return cam;
}

/**
 * A pushed camera depth of field (strength, focus, aperture, focalLength,
 * fStop — NaN for the legacy ramp) as camera3d's DofConfig, the fields the
 * focus plane reads; null when the camera's DOF is off (an empty push).
 */
export function dofOfPush(dof: readonly number[]): DofConfig | null {
  if (dof.length < 5) return null;
  const [strength, focus, aperture, focalLength, fStop] = dof as [number, number, number, number, number];
  return Number.isNaN(fStop) ? { strength, focus, aperture, focalLength } : { strength, focus, aperture, focalLength, fStop };
}

/**
 * The camera a view projects through: a custom view's STORED camera (the
 * scene camera ignored), else the pushed view camera, else the default camera
 * framed to the comp (before the first frame of the subscription). The axis
 * views report it too; they project orthographically (`projectorOf`).
 *
 * `drawn`: for a custom view, the orbit the frame ON SCREEN was drawn with
 * (core/workspace/displayedView.ts `drawnCustomView`) — it wins over the stored
 * params, which move ahead of the picture while a custom view is navigated.
 */
export function viewCameraOf(
  mode: string,
  view: OverlayView | undefined,
  customViews: Readonly<Record<string, CustomViewParams>>,
  compWidth: number,
  compHeight: number,
  drawn?: CustomViewParams | null,
): Camera3D {
  if (isCustomViewId(mode)) return customViewCamera(drawn ?? customViews[mode]!, compWidth, compHeight);
  return (view && cameraOfLens(view.lens)) ?? Project3D.defaultCamera(compWidth, compHeight);
}

/** World → comp projection of a view: orthographic for the axis views, through `camera` otherwise. */
export function projectorOf(mode: string, camera: Camera3D, compWidth: number, compHeight: number): (p: Vec3) => Project3D.Projected {
  const ortho = orthoViewOf(mode);
  return ortho ? (p) => Project3D.projectOrtho(p, ortho, compWidth, compHeight) : (p) => Project3D.projectPoint(p, camera);
}

/**
 * The layers of `compId` the 3D reference geometry can draw — cameras, lights
 * and 3D-switched layers that can be 3D — in stacking order (back to front).
 * What the chrome subscribes with kind `scene3d`.
 */
export function sceneLayersOf(m: MirrorCompLayersRead, compId: string | undefined): string[] {
  const out: string[] = [];
  for (const id of flattenCompLayers(m, compId)) {
    const layer = m.layer(id);
    const k = uiKindOf(layer);
    if (k === 'camera' || k === 'light' || (layer?.switches.threeD === true && canBe3DLayer(layer))) out.push(id);
  }
  return out;
}

const vec = (a: readonly number[]): Vec3 => ({ x: a[0]!, y: a[1]!, z: a[2]! });

export interface SceneGizmoOptions {
  compWidth: number;
  compHeight: number;
  selectedIds: ReadonlySet<string>;
  /** The camera the view looks THROUGH (its frustum wraps the viewer): skipped. */
  viewingThroughCameraId: string | null;
  /** Draw bounding cages for 3D layers. */
  includeLayerBoxes: boolean;
  /** The view looks through a scene camera: cages for SELECTED layers only. */
  throughSceneCamera?: boolean;
  /** Cameras and lights only when selected (AE's default). */
  devicesSelectedOnly?: boolean;
}

/**
 * sceneGizmoData.ts `collectSceneGizmos` over the push: the frustums, light
 * cones and layer cages of `layers` (sceneLayersOf's list), each from its
 * pushed record — a layer with no record yet is skipped.
 */
export function sceneGizmosFrom(
  m: MirrorCompLayersRead,
  layers: readonly string[],
  recordOf: (id: string) => PushedLayer | undefined,
  opts: SceneGizmoOptions,
): SceneGizmo[] {
  const out: SceneGizmo[] = [];
  for (const id of layers) {
    const layer = m.layer(id);
    const kind = uiKindOf(layer);
    const selected = opts.selectedIds.has(id);
    const rec = recordOf(id);
    const s = rec?.scene;
    if (kind === 'camera') {
      if (id === opts.viewingThroughCameraId) continue;
      if (opts.devicesSelectedOnly && !selected) continue;
      const cam = s?.role === 'camera' ? cameraOfLens(s.lens) : null;
      if (!cam) continue;
      out.push(SceneGizmos.buildCameraGizmo({
        nodeId: id,
        position: cam.position,
        orientation: cam.orientation,
        focalLength: cam.focalLength,
        focusDistance: s!.focusDistance,
        poi: s!.poi.length === 3 ? vec(s!.poi) : null,
        compWidth: opts.compWidth,
        compHeight: opts.compHeight,
        selected,
      }));
      continue;
    }
    if (kind === 'light') {
      if (s?.role !== 'light' || s.position.length !== 3 || s.light.length !== 4) continue;
      const type = s.lightType;
      if ((type === 'ambient' || type === 'environment') && !selected) continue;
      if (opts.devicesSelectedOnly && !selected) continue;
      out.push(SceneGizmos.buildLightGizmo({
        nodeId: id,
        type: type === 'environment' ? 'ambient' : (type as 'point' | 'ambient' | 'spot' | 'parallel'),
        position: vec(s.position),
        radius: s.light[0]!,
        cone: s.light[1]!,
        coneFeatherPct: s.light[2]!,
        angleDeg: s.light[3]!,
        poi: s.poi.length === 3 ? vec(s.poi) : null,
        compWidth: opts.compWidth,
        selected,
      }));
      continue;
    }
    if (!opts.includeLayerBoxes) continue;
    if (opts.throughSceneCamera && !selected) continue;
    if (layer?.switches.visible === false) continue;
    if (s?.role !== 'layer' || !rec || rec.matrix.length !== 16 || rec.box.length !== 4) continue;
    out.push(SceneGizmos.buildLayerBoxGizmo({
      nodeId: id,
      world: rec.matrix as Matrix4,
      bounds: { x: rec.box[0]!, y: rec.box[1]!, width: rec.box[2]!, height: rec.box[3]! },
      extrusionDepth: s.extrusion,
      selected,
    }));
  }
  return out;
}

/**
 * A 3D layer's local transform at the frame (ports.ts `sampleTransform3DAtPlayhead`'s
 * values) from its pushed scene3d record, or null without one.
 */
export function transform3DOf(rec: PushedLayer | undefined): {
  x: number; y: number; z: number; rotationX: number; rotationY: number; rotation: number; scaleX: number; scaleY: number; scaleZ: number;
} | null {
  const l = rec?.scene?.role === 'layer' ? rec.scene.local : undefined;
  if (!l || l.length < 9) return null;
  return { x: l[0]!, y: l[1]!, z: l[2]!, rotationX: l[3]!, rotationY: l[4]!, rotation: l[5]!, scaleX: l[6]!, scaleY: l[7]!, scaleZ: l[8]! };
}

/**
 * What a 3D layer's gizmo needs beyond its local values: the parent chain's
 * world matrix (empty = none) and its Orientation — so the gizmo sits at the
 * layer's WORLD position, points along its real local axes, and a drag writes
 * parent-space values (as camera and light handles already do).
 */
export interface GizmoFrame {
  parent: readonly number[];
  orientation: { x: number; y: number; z: number };
  /** The layer's position in the world (its local position lifted through `parent`). */
  world: Vec3;
}

export function gizmoFrameOf(rec: PushedLayer | undefined): GizmoFrame | null {
  const s = rec?.scene;
  const l = s?.role === 'layer' ? s.local : undefined;
  if (!s || !l || l.length < 9) return null;
  const local = { x: l[0]!, y: l[1]!, z: l[2]! };
  const parent = s.parent.length === 16 ? s.parent : [];
  return {
    parent,
    orientation: l.length >= 12 ? { x: l[9]!, y: l[10]!, z: l[11]! } : { x: 0, y: 0, z: 0 },
    world: parent.length === 16 ? Matrix4Math.transformPoint(parent as Matrix4, local) : local,
  };
}

// ── Device handles (deviceHandles.ts over the push) ─────────────────────────

/** Which of a device's two draggable points this is. */
export type DeviceHandleKind = 'position' | 'poi';

export interface DeviceHandle {
  nodeId: string;
  device: 'camera' | 'light';
  kind: DeviceHandleKind;
  /** Where the handle sits in COMP (world) space. */
  world: Vec3;
  /** The device's parent-chain world matrix at the frame (empty = none): a drag inverts it to write parent-space values. */
  parent: readonly number[];
}

/**
 * deviceHandles.ts `collectDeviceHandles` over the push: every camera's eye
 * (and a two-node camera's POI), every non-ambient light's position (and its
 * POI) — `viewingThroughCameraId` gets none.
 */
export function deviceHandlesFrom(
  m: MirrorCompLayersRead,
  layers: readonly string[],
  recordOf: (id: string) => PushedLayer | undefined,
  viewingThroughCameraId: string | null,
): DeviceHandle[] {
  const out: DeviceHandle[] = [];
  for (const id of layers) {
    const kind = uiKindOf(m.layer(id));
    const s = recordOf(id)?.scene;
    if (!s) continue;
    if (kind === 'camera' && s.role === 'camera') {
      if (id === viewingThroughCameraId) continue;
      const cam = cameraOfLens(s.lens);
      if (!cam) continue;
      out.push({ nodeId: id, device: 'camera', kind: 'position', world: cam.position, parent: s.parent });
      if (s.poi.length === 3) out.push({ nodeId: id, device: 'camera', kind: 'poi', world: vec(s.poi), parent: s.parent });
      continue;
    }
    if (kind === 'light' && s.role === 'light' && s.position.length === 3) {
      if (s.lightType === 'ambient') continue;
      out.push({ nodeId: id, device: 'light', kind: 'position', world: vec(s.position), parent: s.parent });
      if (s.poi.length === 3) out.push({ nodeId: id, device: 'light', kind: 'poi', world: vec(s.poi), parent: s.parent });
    }
  }
  return out;
}

/**
 * The handle under `compPt`, or null — POI wins ties (the smaller, more precise
 * target). deviceHandles.ts `hitTestDeviceHandle`.
 */
export function hitTestDeviceHandle<H extends { world: Vec3; kind: DeviceHandleKind }>(
  compPt: { x: number; y: number },
  handles: readonly H[],
  project: (p: Vec3) => { x: number; y: number },
  tolerance: number,
): H | null {
  let best: H | null = null;
  let bestD = Infinity;
  for (const h of handles) {
    const s = project(h.world);
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    const d = Math.hypot(s.x - compPt.x, s.y - compPt.y);
    if (d > tolerance) continue;
    const better = d < bestD || (d === bestD && h.kind === 'poi');
    if (better) { best = h; bestD = d; }
  }
  return best;
}

/**
 * A projected (comp px) drag → a world delta in view `mode` (ports.ts
 * `viewDragToWorldDelta` with the view camera handed in): an axis view maps
 * through its fixed basis; a perspective view through the camera's basis,
 * scaled by the projected scale at `at` (the dragged point's depth).
 */
export function dragDeltaThrough(
  delta: { x: number; y: number },
  mode: string,
  camera: Camera3D,
  at: Vec3,
): Vec3 {
  const ortho = orthoViewOf(mode);
  const basis = ortho ? Project3D.orthoDragBasis(ortho) : Project3D.cameraDragBasis(camera);
  let k = 1;
  if (!ortho) {
    const s = Project3D.projectPoint(at, camera).scale;
    k = Math.abs(s) > 1e-9 ? 1 / s : 1;
  }
  const dx = delta.x * k;
  const dy = delta.y * k;
  const { right, down } = basis;
  return { x: right.x * dx + down.x * dy, y: right.y * dx + down.y * dy, z: right.z * dx + down.z * dy };
}

// ── Camera navigation (cameraNav.ts over the push) ──────────────────────────

/**
 * cameraNav.ts `findNavTarget` over the push: a custom view navigates itself,
 * an axis view its own (orthographic) target, Active Camera / a camera view the
 * camera the RENDERER looks through (`OverlayView.liveCamera`: live at the
 * frame), else the default view (promoted to a custom view on the first orbit)
 * — and nothing without 3D content in the composition.
 */
export function navTargetOf(mode: string, view: OverlayView | undefined, compHasAny3D: boolean): NavTarget | null {
  if (!compHasAny3D) return null;
  if (isCustomViewId(mode)) return { kind: 'view', viewId: mode };
  const ortho = orthoViewOf(mode);
  if (ortho) return { kind: 'ortho', view: ortho };
  const cam = view?.liveCamera;
  if (cam) return { kind: 'scene', nodeId: cam, transId: '' };
  return { kind: 'ortho', view: 'front' };
}

/** cameraNav.ts `describeNavUnavailable` for a view with no nav target: the next step, phrased. */
export function navUnavailableMessage(mode: string, compHasAny3D: boolean, compHasCamera: boolean): string {
  if (!compHasAny3D) {
    return isSceneCameraView(mode) && !compHasCamera
      ? 'Camera tools need a Camera layer and a 3D layer — add a camera, then switch a layer to 3D.'
      : 'Camera tools need something 3D to move around — switch a layer to 3D with its 3D toggle.';
  }
  return 'Camera tools need a Camera layer in this composition — Layer ▸ New ▸ Camera.';
}

/** A 3D layer's plane for the cursor pivot: its world matrix and drawn size. */
export interface PivotPlane {
  world: readonly number[];
  width: number;
  height: number;
}

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/**
 * cameraNav.ts `resolveOrbitPivot` over the push: the world point an orbit
 * swings about, resolved at drag start — null for the classic POI orbit.
 * Cursor mode projects the pointer (comp px) through the navigated camera onto
 * the frontmost 3D layer plane under it, else the ground plane, else the plane
 * facing the camera at its POI distance (`poi`: the camera's world POI, or
 * null for a one-node camera — its focal length is used).
 */
export function orbitPivotFrom(
  cursor: { x: number; y: number } | null,
  pivotMode: 'poi' | 'scene' | 'cursor' | string,
  cam: Camera3D,
  planes: readonly PivotPlane[],
  compWidth: number,
  compHeight: number,
  groundLevel: number,
  poi: Vec3 | null,
): Vec3 | null {
  if (pivotMode === 'poi') return null;
  if (pivotMode === 'scene') return v3(0, 0, 0);
  if (!cursor) return null;
  const ray = Project3D.unprojectScreenRay(cursor.x, cursor.y, cam, null, compWidth, compHeight);
  const rayT = (p: Vec3): number =>
    (p.x - ray.origin.x) * ray.direction.x + (p.y - ray.origin.y) * ray.direction.y + (p.z - ray.origin.z) * ray.direction.z;

  // 1) The frontmost 3D layer plane under the cursor.
  let best: { t: number; p: Vec3 } | null = null;
  for (const pl of planes) {
    if (!(pl.width > 0) || !(pl.height > 0) || pl.world.length !== 16) continue;
    const m = pl.world as Matrix4;
    const origin = Matrix4Math.transformPoint(m, v3(0, 0, 0));
    const zTip = Matrix4Math.transformPoint(m, v3(0, 0, 1));
    const hit = Project3D.intersectRayPlane(ray, origin, v3(zTip.x - origin.x, zTip.y - origin.y, zTip.z - origin.z));
    if (!hit) continue;
    const inv = Matrix4Math.invert(m);
    if (!inv) continue;
    const local = Matrix4Math.transformPoint(inv, hit);
    if (local.x < 0 || local.x > pl.width || local.y < 0 || local.y > pl.height) continue;
    const t = rayT(hit);
    if (t <= 0) continue;
    if (!best || t < best.t) best = { t, p: hit };
  }
  if (best) return best.p;

  // 2) The ground plane, where the 3D ground grid draws.
  const ground = Project3D.intersectRayPlane(ray, v3(0, compHeight + groundLevel, 0), v3(0, 1, 0));
  if (ground && rayT(ground) > 0) return ground;

  // 3) The POI-distance plane facing the camera.
  let dist = Math.max(1, cam.focalLength);
  if (poi) {
    const d = Math.hypot(poi.x - cam.position.x, poi.y - cam.position.y, poi.z - cam.position.z);
    if (d > 1e-3) dist = d;
  }
  const fwd = Project3D.unprojectScreenRay(compWidth / 2, compHeight / 2, cam, null, compWidth, compHeight).direction;
  const planePoint = v3(cam.position.x + fwd.x * dist, cam.position.y + fwd.y * dist, cam.position.z + fwd.z * dist);
  const facing = Project3D.intersectRayPlane(ray, planePoint, fwd);
  return facing && rayT(facing) > 0 ? facing : planePoint;
}

/** A world point → the parent space of a device (the inverse of its pushed parent matrix; none = the same). */
export function toParentSpace(parent: readonly number[], world: Vec3): Vec3 {
  return parent.length === 16 ? Matrix4Math.toLocalPoint(parent as Matrix4, world) : world;
}
