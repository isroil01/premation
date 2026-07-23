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
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
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

/** Read x/y/z/focalLength/orbit off a camera node's components (animated values win). */
function cameraFromNode(
  node: SceneNode,
  width: number,
  height: number,
  sample?: CameraSample,
): Camera3D {
  const def = Project3D.defaultCamera(width, height);
  let x: number | undefined, y: number | undefined, z: number | undefined, focal: number | undefined;
  let yaw: number | undefined, pitch: number | undefined;
  let poiX: number | undefined, poiY: number | undefined, poiZ: number | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
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
  const basePosition = { x: x ?? def.position.x, y: y ?? def.position.y, z: z ?? -focalLength };

  // Two-node camera: any POI prop present means the camera has an explicit
  // Point of Interest and always LOOKS AT it (AE's two-node camera). The orbit
  // tool swings the eye about the POI; the camera then re-aims at it. A one-node
  // camera (no POI props) keeps the exact legacy orbit-about-comp-centre path.
  const hasPOI = poiX !== undefined || poiY !== undefined || poiZ !== undefined;
  if (hasPOI) {
    const poi = { x: poiX ?? def.principal.x, y: poiY ?? def.principal.y, z: poiZ ?? 0 };
    const orbited = Project3D.orbitCamera(basePosition, poi, yaw ?? 0, pitch ?? 0);
    const orientation = Project3D.lookAtOrientation(orbited.position, poi);
    return {
      focalLength,
      position: orbited.position,
      principal: def.principal,
      ...(orientation && (orientation.yaw !== 0 || orientation.pitch !== 0) ? { orientation } : {}),
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

  return {
    focalLength,
    position: orbited.position,
    // The optical axis stays on the comp centre no matter where the camera
    // moves — that's what makes panning the camera shift the frame.
    principal: def.principal,
    ...(orbited?.orientation && (orbited.orientation.yaw !== 0 || orbited.orientation.pitch !== 0)
      ? { orientation: orbited.orientation }
      : {}),
  };
}

/**
 * The active camera for a composition: the first Camera layer if present,
 * otherwise the default camera framed to the comp. Pass `sample` (a per-node
 * animated-value lookup at the current time) to make the camera animatable —
 * keyframed x/y/z/focalLength then drive the view.
 */
export function readSceneCamera(
  graph: SceneGraph,
  width: number,
  height: number,
  sample?: CameraSample,
): Camera3D {
  for (const node of flattenScene(graph)) {
    if (readNodeKind(node) === 'camera') return cameraFromNode(node, width, height, sample);
  }
  return Project3D.defaultCamera(width, height);
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

export function readSceneDof(
  graph: SceneGraph,
  width: number,
  height: number,
  sample?: CameraSample,
): DofConfig | null {
  for (const node of flattenScene(graph)) {
    if (readNodeKind(node) !== 'camera') continue;
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
