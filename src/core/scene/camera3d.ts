/**
 * Composition 3D camera — resolved from the scene.
 *
 * If the comp contains a Camera layer, its Transform props drive the view
 * (position x/y, depth z, and focalLength); otherwise a sensible default camera
 * framed to the comp is used. The renderer (buildSnapshot) projects 3D layers
 * through whatever this returns, so adding a Camera and animating it pans /
 * dollies the whole 3D scene — exactly like After Effects.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import type { SceneNode } from '@core/types';
import { flattenComposition, flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { Project3D, type Camera3D } from '@motion/scene';

/** Default focal length (px) for a comp of the given width. */
export function defaultFocalLength(width: number): number {
  return Project3D.defaultCamera(width, 1).focalLength;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/**
 * Samples an animated numeric prop for a node at the current time.
 * Returns undefined when the prop has no keyframes (→ static prop wins).
 */
export type CameraSample = (nodeId: string, prop: string) => number | undefined;

/**
 * Lifts a point from a node's PARENT space into world space.
 *
 * A camera is a layer, and in After Effects a layer follows its parent — the
 * standard camera rig is a camera parented to a null, which is then animated or
 * orbited. This module resolved the camera's raw local props, so that rig moved
 * nothing at all: the timeline showed the parent link, the UI let you create it,
 * and the render ignored it.
 *
 * It is injected rather than read from the graph because the renderer and the
 * viewport chrome must compose parents with their OWN per-frame caches and time
 * remapping — the two agreeing is what keeps the gizmo on the pixels. Omitted
 * (tests, the axis widget) ⇒ identity, i.e. the previous behaviour exactly.
 */
export type CameraWorldOf = (
  nodeId: string,
  point: { x: number; y: number; z: number },
) => { x: number; y: number; z: number };

/** Read x/y/z/focalLength/orbit off a camera node's components (animated values win). */
export function cameraFromNode(
  node: SceneNode,
  width: number,
  height: number,
  sample?: CameraSample,
  worldOf?: CameraWorldOf,
): Camera3D {
  const def = Project3D.defaultCamera(width, height);
  let x: number | undefined, y: number | undefined, z: number | undefined, focal: number | undefined;
  let yaw: number | undefined, pitch: number | undefined;
  let poiX: number | undefined, poiY: number | undefined, poiZ: number | undefined;
  let rollProp: number | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    rollProp = num(p.orientationZ) ?? rollProp;
    x = num(p.x) ?? x;
    y = num(p.y) ?? y;
    z = num(p.z) ?? z;
    focal = num(p.focalLength) ?? focal;
    yaw = num(p.orbitYaw) ?? yaw;
    pitch = num(p.orbitPitch) ?? pitch;
    poiX = num(p.poiX) ?? poiX;
    poiY = num(p.poiY) ?? poiY;
    poiZ = num(p.poiZ) ?? poiZ;
  }
  // Keyframed values beat the static props; unkeyframed props fall through
  // unchanged, so a camera with no animation resolves exactly as before.
  x = sample?.(node.id, 'x') ?? x;
  y = sample?.(node.id, 'y') ?? y;
  z = sample?.(node.id, 'z') ?? z;
  focal = sample?.(node.id, 'focalLength') ?? focal;
  yaw = sample?.(node.id, 'orbitYaw') ?? yaw;
  pitch = sample?.(node.id, 'orbitPitch') ?? pitch;
  poiX = sample?.(node.id, 'poiX') ?? poiX;
  poiY = sample?.(node.id, 'poiY') ?? poiY;
  poiZ = sample?.(node.id, 'poiZ') ?? poiZ;
  const focalLength = focal ?? def.focalLength;
  // A camera with no explicit z sits pulled back by its focal length (so the
  // comp plane renders 1:1), matching the default camera.
  //
  // `worldOf` then composes the parent chain, so a camera parented to a null
  // moves, orbits and dollies with it. The eye AND the point of interest go
  // through the same lift: transforming only the eye would swing the camera
  // around a target that stayed pinned in comp space, which reads as the shot
  // sliding off its subject as the rig moves.
  const lift = worldOf ?? ((_id: string, p: { x: number; y: number; z: number }) => p);
  const basePosition = lift(node.id, {
    x: x ?? def.position.x,
    y: y ?? def.position.y,
    z: z ?? -focalLength,
  });

  // Two-node camera: any POI prop present means the camera has an explicit
  // Point of Interest and always LOOKS AT it (AE's two-node camera). The orbit
  // tool swings the eye about the POI; the camera then re-aims at it. A one-node
  // camera (no POI props) keeps the exact legacy orbit-about-comp-centre path.
  // Camera ROLL (a dutch angle): spins the frame about the view axis without
  // re-aiming. Stored as `orientationZ` to match the layer transform naming, so
  // the inspector row and the keyframe track look like every other rotation.
  const roll = sample?.(node.id, 'orientationZ') ?? rollProp ?? 0;
  const withRoll = (o: { yaw: number; pitch: number }) =>
    roll !== 0 ? { ...o, roll } : o;
  const nonZero = (o: { yaw: number; pitch: number; roll?: number }) =>
    o.yaw !== 0 || o.pitch !== 0 || (o.roll ?? 0) !== 0;

  const hasPOI = poiX !== undefined || poiY !== undefined || poiZ !== undefined;
  if (hasPOI) {
    const poi = lift(node.id, {
      x: poiX ?? def.principal.x,
      y: poiY ?? def.principal.y,
      z: poiZ ?? 0,
    });
    const orbited = Project3D.orbitCamera(basePosition, poi, yaw ?? 0, pitch ?? 0);
    const orientation = withRoll(Project3D.lookAtOrientation(orbited.position, poi));
    return {
      focalLength,
      position: orbited.position,
      principal: def.principal,
      ...(orientation && nonZero(orientation) ? { orientation } : {}),
    };
  }

  // Orbit (keyframeable): swing the eye about the comp-centre POI on the
  // comp plane, keeping it centred. Zero yaw+pitch is the exact legacy path.
  const orbited = Project3D.orbitCamera(
    basePosition,
    { x: def.principal.x, y: def.principal.y, z: 0 },
    yaw ?? 0,
    pitch ?? 0,
  );

  const orientation = withRoll(orbited.orientation);
  return {
    focalLength,
    position: orbited.position,
    // The optical axis stays on the comp centre no matter where the camera
    // moves — that's what makes panning the camera shift the frame.
    principal: def.principal,
    ...(orientation && nonZero(orientation) ? { orientation } : {}),
  };
}

/**
 * The active camera for a composition, or the default camera framed to the comp.
 *
 * Pass `sample` (a per-node animated-value lookup at the current time) to make
 * the camera animatable — keyframed x/y/z/focalLength then drive the view.
 *
 * ## Which camera, and why it changed
 *
 * Two rules, and both used to be wrong:
 *
 * 1. **Scoped to `rootId` when given.** This walked the entire project and took
 *    the first camera it found anywhere, so a camera in one composition steered
 *    another composition's render.
 * 2. **The LAST camera wins, not the first.** Creation order is paint order and
 *    paint order is back-to-front, so "first found" meant the BOTTOM-most camera
 *    — the opposite of After Effects, where the topmost camera above a layer is
 *    the active one.
 *
 * Together these made repeat AI runs fail in a way that looked like the camera
 * was broken: nothing deletes layers between runs, so run 2's camera was created
 * after run 1's and lost. Every generative prompt after the first produced a
 * fully keyframed camera the renderer never read.
 *
 * `rootId` is optional so the several call sites that legitimately have no
 * composition context (the axis widget, scene-ref geometry) keep working; they
 * get the whole-scene search, which is what they had.
 */
export function readSceneCamera(
  graph: SceneGraph,
  width: number,
  height: number,
  sample?: CameraSample,
  rootId?: string,
  worldOf?: CameraWorldOf,
  filter?: ActiveCameraFilter,
): Camera3D {
  const node = activeCameraNode(graph, rootId, filter);
  return node
    ? cameraFromNode(node, width, height, sample, worldOf)
    : Project3D.defaultCamera(width, height);
}

/**
 * The one camera node a composition renders through, or null.
 *
 * Shared by `readSceneCamera` and `readSceneDof` on purpose: they used to search
 * independently, so any change to the selection rule could leave depth of field
 * being read off a different camera than the one doing the projecting.
 */
/**
 * Extra conditions a camera must meet to be the active one.
 *
 * `isLiveAt` is the layer's in/out gate — the same clip-bar test the renderer
 * applies to ordinary layers. It is injected rather than read here because the
 * renderer already holds a resolved timeline controller for the frame, and the
 * viewport chrome samples at the playhead; both must reach the same verdict.
 */
export interface ActiveCameraFilter {
  /** False ⇒ this camera's layer is not live at the current time. */
  isLiveAt?: (nodeId: string) => boolean;
}

/**
 * THE camera-selection rule. Every consumer goes through this — renderer,
 * viewport chrome, gizmos and the C tool alike.
 *
 * After Effects: the TOPMOST enabled camera whose layer is live at the current
 * time wins. All three parts matter, and only the first was implemented:
 *
 *   • **Topmost, not first.** Creation order is paint order and paint order is
 *     back-to-front, so "first found" is the BOTTOM-most camera. `findCameraNav`
 *     took the first while the renderer took the last, so with two cameras the C
 *     tool drove one camera while the user looked through another.
 *   • **Enabled.** A hidden camera is not a camera you are looking through.
 *   • **Live now.** A camera trimmed to the second half of the comp must not
 *     steer the first half.
 */
export function activeCameraNode(
  graph: SceneGraph,
  rootId?: string,
  filter?: ActiveCameraFilter,
): SceneNode | null {
  const nodes = rootId ? flattenComposition(graph, rootId) : flattenScene(graph);
  // Last, not first. Reverse rather than sort: paint order is the list order and
  // the topmost layer is the final one.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;
    if (readNodeKind(node) !== 'camera') continue;
    if (node.visible === false) continue;
    if (filter?.isLiveAt && !filter.isLiveAt(node.id)) continue;
    return node;
  }
  return null;
}

/** Depth-of-field config (camera props; keyframeable). Null = DOF off. */
export interface DofConfig {
  /** Max defocus blur in px (AE's Blur Level cap). */
  strength: number;
  /** In-focus distance from the camera (px). Defaults to the focal length —
   *  the comp plane — so fresh cameras keep everything sharp. */
  focus: number;
  /**
   * Aperture — how fast defocus turns into blur (AE's Aperture / f-stop, wider =
   * shallower depth of field). It's the SLOPE of the circle-of-confusion ramp;
   * `strength` remains the cap. Defaults to `strength` so a camera that only set
   * Blur Level behaves exactly as before this field existed.
   */
  aperture: number;
}

/**
 * Circle-of-confusion blur (px) for a layer at `depth`, given the DOF config.
 * `|depth − focus| / focus` is the normalised defocus; multiplied by the
 * aperture (slope) and clamped to `strength` (cap). Pure/testable — the render
 * layer applies the returned px as a CSS blur.
 */
export function dofBlurPx(depth: number, dof: DofConfig): number {
  const defocus = Math.abs(depth - dof.focus) / Math.max(1, dof.focus);
  return Math.min(dof.strength, defocus * dof.aperture);
}

/**
 * A camera node's Point of Interest at `sample` time, or null for a one-node
 * camera. Split out because the viewport gizmo has to draw the POI crosshair
 * and the eye→POI line, and `cameraFromNode` folds the POI away into a look
 * orientation — by the time it returns, the target itself is gone.
 */
export function readCameraPoi(
  node: SceneNode,
  width: number,
  height: number,
  sample?: CameraSample,
): { x: number; y: number; z: number } | null {
  let px: number | undefined, py: number | undefined, pz: number | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    px = num(p.poiX) ?? px;
    py = num(p.poiY) ?? py;
    pz = num(p.poiZ) ?? pz;
  }
  px = sample?.(node.id, 'poiX') ?? px;
  py = sample?.(node.id, 'poiY') ?? py;
  pz = sample?.(node.id, 'poiZ') ?? pz;
  if (px === undefined && py === undefined && pz === undefined) return null;
  return { x: px ?? width / 2, y: py ?? height / 2, z: pz ?? 0 };
}

/** A camera node's focus distance (px) at `sample` time — where the frustum
 *  cone is drawn to. Falls back to the focal length (the comp plane). */
export function readCameraFocusDistance(
  node: SceneNode,
  width: number,
  sample?: CameraSample,
): number {
  let focus: number | undefined, focal: number | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    focus = num(p.focusDistance) ?? focus;
    focal = num(p.focalLength) ?? focal;
  }
  focus = sample?.(node.id, 'focusDistance') ?? focus;
  focal = sample?.(node.id, 'focalLength') ?? focal;
  return focus ?? focal ?? defaultFocalLength(width);
}

export function readSceneDof(
  graph: SceneGraph,
  width: number,
  height: number,
  sample?: CameraSample,
  rootId?: string,
  filter?: ActiveCameraFilter,
): DofConfig | null {
  const active = activeCameraNode(graph, rootId, filter);
  for (const node of active ? [active] : []) {
    let strength: number | undefined;
    let focus: number | undefined;
    let focal: number | undefined;
    let aperture: number | undefined;
    for (const c of node.components) {
      const p = c.props as Record<string, unknown>;
      strength = num(p.dofStrength) ?? strength;
      focus = num(p.focusDistance) ?? focus;
      focal = num(p.focalLength) ?? focal;
      aperture = num(p.dofAperture) ?? aperture;
    }
    strength = sample?.(node.id, 'dofStrength') ?? strength;
    focus = sample?.(node.id, 'focusDistance') ?? focus;
    aperture = sample?.(node.id, 'dofAperture') ?? aperture;
    if (!strength || strength <= 0) return null;
    return {
      strength,
      focus: focus ?? focal ?? Project3D.defaultCamera(width, height).focalLength,
      // Default the slope to the cap → identical to the old single-scalar ramp.
      aperture: aperture ?? strength,
    };
  }
  return null;
}
