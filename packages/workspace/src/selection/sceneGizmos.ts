/**
 * Scene reference geometry — the wireframes that make a 3D scene legible from
 * outside it: camera bodies and frustum cones, light cones and falloff spheres,
 * and per-layer bounding boxes.
 *
 * None of this is rendered output. It is viewport overlay only, which is why it
 * lives here as pure world-space geometry rather than in the renderer: the
 * overlay projects these segments through whatever view is active (see
 * Gizmo3dOverlay), so one description serves the active camera, the six
 * orthographic views and the custom views alike.
 *
 * Why it matters: in Classic 3D a layer is a plane of zero thickness, so seen
 * exactly edge-on it projects to zero area and draws nothing — correctly. A
 * side view of a scene therefore shows almost nothing unless something else
 * describes where the layers, cameras and lights actually are. That "something
 * else" is this file.
 *
 * Everything returns segments in COMPOSITION space (y-down, z into the screen),
 * so the caller can project without knowing anything about how it was built.
 */

import { Matrix4Math, type Matrix4, type Vec3 } from '@motion/scene';

const DEG = Math.PI / 180;

/**
 * What a segment depicts. The overlay maps these to colour/dash/width, so the
 * styling lives in one place rather than being baked in here.
 */
export type GizmoSegmentKind =
  | 'body' // camera/light chassis
  | 'frustum' // camera view cone + its far rectangle
  | 'cone' // spot light cone
  | 'feather' // spot light feather edge (softer, dashed)
  | 'radius' // point light falloff sphere
  | 'direction' // parallel light rays
  | 'poi' // point-of-interest crosshair and its connecting line
  | 'bounds'; // 3D layer bounding box

export interface GizmoSegment {
  start: Vec3;
  end: Vec3;
  kind: GizmoSegmentKind;
}

export interface SceneGizmo {
  nodeId: string;
  type: 'camera' | 'light' | 'layer';
  /** Where to hang an icon/label — the device's own position. */
  origin: Vec3;
  segments: GizmoSegment[];
  selected: boolean;
}

const seg = (start: Vec3, end: Vec3, kind: GizmoSegmentKind): GizmoSegment => ({ start, end, kind });

const add = (a: Vec3, b: Vec3, s = 1): Vec3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};

/**
 * The camera's world basis for a given look orientation.
 *
 * This MUST be the forward rotation `Project3D.unprojectScreenRay` uses —
 * Ry(yaw) · Rx(pitch) — not its inverse. `projectPoint` applies the inverse
 * (it takes world into camera space); a gizmo built from the inverse points the
 * frustum backwards, which looks plausible until you orbit and it swings the
 * wrong way. `down` is named for comp space being y-DOWN: it is the direction
 * of increasing screen y, not "up" in the everyday sense.
 */
export function cameraBasis(yawDeg: number, pitchDeg: number, rollDeg = 0): { forward: Vec3; right: Vec3; down: Vec3 } {
  const cx = Math.cos(pitchDeg * DEG);
  const sx = Math.sin(pitchDeg * DEG);
  const cy = Math.cos(yawDeg * DEG);
  const sy = Math.sin(yawDeg * DEG);
  const forward = { x: sy * cx, y: -sx, z: cy * cx };
  const right = { x: cy, y: 0, z: -sy };
  const down = { x: sy * sx, y: cx, z: cy * sx };
  if (rollDeg === 0) return { forward, right, down };
  // Roll spins the frame about the view axis, so it rotates right/down and
  // leaves forward alone — which is exactly why a rolled camera's frustum is
  // still aimed the same way, just twisted.
  const cz = Math.cos(rollDeg * DEG);
  const sz = Math.sin(rollDeg * DEG);
  const mix = (a: Vec3, b: Vec3, ca: number, cb: number): Vec3 => ({
    x: a.x * ca + b.x * cb,
    y: a.y * ca + b.y * cb,
    z: a.z * ca + b.z * cb,
  });
  return { forward, right: mix(right, down, cz, sz), down: mix(right, down, -sz, cz) };
}

/** A closed polyline circle of `radius` about `centre`, spanned by u × v. */
function circle(centre: Vec3, u: Vec3, v: Vec3, radius: number, kind: GizmoSegmentKind, steps = 24): GizmoSegment[] {
  const pt = (i: number): Vec3 => {
    const a = (i / steps) * Math.PI * 2;
    const c = Math.cos(a) * radius;
    const s = Math.sin(a) * radius;
    return { x: centre.x + u.x * c + v.x * s, y: centre.y + u.y * c + v.y * s, z: centre.z + u.z * c + v.z * s };
  };
  const out: GizmoSegment[] = [];
  let prev = pt(0);
  for (let i = 1; i <= steps; i++) {
    const next = pt(i);
    out.push(seg(prev, next, kind));
    prev = next;
  }
  return out;
}

/** A small three-axis cross — the "something is here" marker. */
function crosshair(at: Vec3, size: number, kind: GizmoSegmentKind): GizmoSegment[] {
  return [
    seg({ ...at, x: at.x - size }, { ...at, x: at.x + size }, kind),
    seg({ ...at, y: at.y - size }, { ...at, y: at.y + size }, kind),
    seg({ ...at, z: at.z - size }, { ...at, z: at.z + size }, kind),
  ];
}

/** The 12 edges of an axis-aligned box in the basis (right, down, forward). */
function boxEdges(
  centre: Vec3,
  right: Vec3,
  down: Vec3,
  forward: Vec3,
  half: { r: number; d: number; f: number },
  kind: GizmoSegmentKind,
): GizmoSegment[] {
  const corner = (sr: number, sd: number, sf: number): Vec3 =>
    add(add(add(centre, right, sr * half.r), down, sd * half.d), forward, sf * half.f);
  const c = [
    corner(-1, -1, -1), corner(1, -1, -1), corner(1, 1, -1), corner(-1, 1, -1),
    corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1),
  ];
  const pairs: Array<[number, number]> = [
    [0, 1], [1, 2], [2, 3], [3, 0], // back face
    [4, 5], [5, 6], [6, 7], [7, 4], // front face
    [0, 4], [1, 5], [2, 6], [3, 7], // connecting
  ];
  return pairs.map(([a, b]) => seg(c[a]!, c[b]!, kind));
}

export interface CameraGizmoInput {
  nodeId: string;
  /** Eye position in comp space. */
  position: Vec3;
  /** Look orientation in degrees; absent ⇒ looking down +z. */
  orientation?: { yaw: number; pitch: number; roll?: number };
  /** Distance at which the frame renders 1:1 — sets the angle of view. */
  focalLength: number;
  /** How far down the axis to draw the cone. Defaults to the focal length. */
  focusDistance?: number;
  /** Two-node cameras only: the point the camera aims at. */
  poi?: Vec3 | null;
  compWidth: number;
  compHeight: number;
  selected: boolean;
}

/**
 * Camera wireframe + frustum cone.
 *
 * The cone is the useful part: four rays from the eye through the corners of
 * the image plane, closed by the rectangle they cut at the focus distance. That
 * rectangle is the comp frame as the camera sees it, so from a Top or Left view
 * you can read exactly what the camera can see — which is the entire reason to
 * look at a scene from outside the camera in the first place.
 *
 * Half-width at distance d is (compWidth/2)·d/focalLength, straight out of the
 * same pinhole relation `projectPoint` uses, so the cone always agrees with
 * what actually renders.
 */
export function buildCameraGizmo(input: CameraGizmoInput): SceneGizmo {
  const { position: eye, focalLength, compWidth, compHeight } = input;
  const { forward, right, down } = cameraBasis(input.orientation?.yaw ?? 0, input.orientation?.pitch ?? 0, input.orientation?.roll ?? 0);
  const d = Math.max(1, input.focusDistance ?? focalLength);
  const k = d / Math.max(1, focalLength);
  const hw = (compWidth / 2) * k;
  const hh = (compHeight / 2) * k;

  const centreFar = add(eye, forward, d);
  const far = (sr: number, sd: number): Vec3 => add(add(centreFar, right, sr * hw), down, sd * hh);
  const tl = far(-1, -1);
  const tr = far(1, -1);
  const br = far(1, 1);
  const bl = far(-1, 1);

  const segments: GizmoSegment[] = [
    // The cone.
    seg(eye, tl, 'frustum'),
    seg(eye, tr, 'frustum'),
    seg(eye, br, 'frustum'),
    seg(eye, bl, 'frustum'),
    // The frame it cuts at the focus distance.
    seg(tl, tr, 'frustum'),
    seg(tr, br, 'frustum'),
    seg(br, bl, 'frustum'),
    seg(bl, tl, 'frustum'),
  ];

  // Chassis: a small box straddling the eye, plus a lens stub pointing the way
  // the camera looks so the body reads as directional even when the cone is
  // edge-on and collapses to a line.
  const bodySize = Math.max(12, compWidth / 48);
  segments.push(
    ...boxEdges(add(eye, forward, -bodySize * 0.6), right, down, forward, { r: bodySize, d: bodySize * 0.7, f: bodySize * 0.6 }, 'body'),
    seg(eye, add(eye, forward, bodySize * 0.9), 'body'),
  );

  if (input.poi) {
    segments.push(seg(eye, input.poi, 'poi'), ...crosshair(input.poi, Math.max(10, compWidth / 60), 'poi'));
  }

  return { nodeId: input.nodeId, type: 'camera', origin: eye, segments, selected: input.selected };
}

export interface LightGizmoInput {
  nodeId: string;
  type: 'point' | 'ambient' | 'spot' | 'parallel';
  position: Vec3;
  /** Falloff radius (point/spot reach) in comp px. */
  radius: number;
  /** Spot only: full cone width in degrees. */
  cone: number;
  /**
   * Spot only: soft edge as a PERCENT of the half-cone (AE's Cone Feather).
   * Drawn as a second, fainter cone outside the hard one.
   */
  coneFeatherPct: number;
  /**
   * Spot/parallel aim. When null the light has no 3D target and the gizmo falls
   * back to `angleDeg` in the comp plane — the legacy 2D direction.
   */
  poi?: Vec3 | null;
  /** Legacy 2D direction, degrees (0 = →, 90 = ↓ in comp space). */
  angleDeg: number;
  compWidth: number;
  selected: boolean;
}

/** Any unit vector perpendicular to `v` — the seed for a circle's basis. */
function perpendicular(v: Vec3): Vec3 {
  // Cross with whichever cardinal axis `v` is least aligned to, so the result
  // never degenerates to zero length.
  const a: Vec3 = Math.abs(v.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  return norm({ x: v.y * a.z - v.z * a.y, y: v.z * a.x - v.x * a.z, z: v.x * a.y - v.y * a.x });
}

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/**
 * Light gizmos, per type — the shapes that tell you what a light will actually
 * reach without having to render and look.
 *
 *   ambient — icon only; an ambient light has no position meaning
 *   point — icon + a wireframe sphere at the falloff radius
 *   spot — icon + the cone at its cone angle, with the feather edge shown
 *   parallel — icon + direction rays and the POI line
 */
export function buildLightGizmo(input: LightGizmoInput): SceneGizmo {
  const { position: p, compWidth } = input;
  const iconSize = Math.max(10, compWidth / 70);
  const segments: GizmoSegment[] = [...crosshair(p, iconSize, 'body')];

  // Aim: a real 3D target when present, else the legacy comp-plane angle.
  const dir = input.poi
    ? norm(sub(input.poi, p))
    : norm({ x: Math.cos(input.angleDeg * DEG), y: Math.sin(input.angleDeg * DEG), z: 0 });

  if (input.type === 'ambient') {
    // A ring of short rays — the "lights everything, from nowhere" icon.
    const u = { x: 1, y: 0, z: 0 };
    const v = { x: 0, y: 1, z: 0 };
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const d: Vec3 = { x: u.x * Math.cos(a) + v.x * Math.sin(a), y: u.y * Math.cos(a) + v.y * Math.sin(a), z: 0 };
      segments.push(seg(add(p, d, iconSize * 1.3), add(p, d, iconSize * 2), 'body'));
    }
    return { nodeId: input.nodeId, type: 'light', origin: p, segments, selected: input.selected };
  }

  if (input.type === 'point') {
    // Three great circles = a readable wireframe sphere at the falloff radius.
    const r = Math.max(1, input.radius);
    const X = { x: 1, y: 0, z: 0 };
    const Y = { x: 0, y: 1, z: 0 };
    const Z = { x: 0, y: 0, z: 1 };
    segments.push(...circle(p, X, Y, r, 'radius'), ...circle(p, X, Z, r, 'radius'), ...circle(p, Y, Z, r, 'radius'));
    return { nodeId: input.nodeId, type: 'light', origin: p, segments, selected: input.selected };
  }

  if (input.type === 'spot') {
    const len = Math.max(1, input.radius);
    const u = perpendicular(dir);
    const v = cross(dir, u);
    const centre = add(p, dir, len);

    const coneRing = (halfAngleDeg: number, kind: GizmoSegmentKind): GizmoSegment[] => {
      const r = len * Math.tan(Math.max(0.5, Math.min(89, halfAngleDeg)) * DEG);
      const out = circle(centre, u, v, r, kind);
      // Four edge rays so the cone reads as a cone, not a floating ring.
      for (const [su, sv] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        out.push(seg(p, add(add(centre, u, su * r), v, sv * r), kind));
      }
      return out;
    };

    const half = input.cone / 2;
    segments.push(...coneRing(half, 'cone'));
    // The feather is a percent of the half-cone, so the soft edge grows with
    // the cone rather than being a fixed number of degrees.
    const featherDeg = half * (Math.max(0, input.coneFeatherPct) / 100);
    if (featherDeg > 0.5) segments.push(...coneRing(half + featherDeg, 'feather'));
    if (input.poi) segments.push(seg(p, input.poi, 'poi'), ...crosshair(input.poi, iconSize, 'poi'));
    return { nodeId: input.nodeId, type: 'light', origin: p, segments, selected: input.selected };
  }

  // Parallel: a bundle of same-direction rays — the "sunlight" reading. There
  // is no falloff, so the length is cosmetic; it just has to show the aim.
  const len = Math.max(1, input.radius);
  const u = perpendicular(dir);
  const v = cross(dir, u);
  const spread = iconSize * 2.2;
  for (const [su, sv] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const base = add(add(p, u, su * spread), v, sv * spread);
    const tip = add(base, dir, len);
    segments.push(seg(base, tip, 'direction'));
    // Arrowhead: two short barbs folded back along the ray.
    segments.push(
      seg(tip, add(add(tip, dir, -len * 0.12), u, len * 0.05), 'direction'),
      seg(tip, add(add(tip, dir, -len * 0.12), u, -len * 0.05), 'direction'),
    );
  }
  if (input.poi) segments.push(seg(p, input.poi, 'poi'), ...crosshair(input.poi, iconSize, 'poi'));
  return { nodeId: input.nodeId, type: 'light', origin: p, segments, selected: input.selected };
}

export interface LayerBoxInput {
  nodeId: string;
  /** The layer's 4×4 model matrix (see nodeMatrix.composeNodeWorld3d). */
  world: Matrix4;
  /** Local-space bounds: the rect the layer's content occupies before transform. */
  bounds: { x: number; y: number; width: number; height: number };
  /** > 0 ⇒ an extruded body, so the box gets a back face and side edges. */
  extrusionDepth: number;
  selected: boolean;
}

/**
 * A 3D layer's bounding box.
 *
 * This is what keeps an edge-on layer findable. A flat layer viewed exactly
 * from the side projects to zero area and draws no pixels — correct, and the
 * same thing After Effects does — so without the box there is literally nothing
 * on screen to tell you the layer exists. The box collapses to a hairline in
 * that view too, but a hairline is a thing you can see and click; nothing is
 * not.
 *
 * Flat layers get the 4 edges of their plane; extruded ones get all 12 of the
 * body, so the depth the extrusion adds is visible from outside.
 */
export function buildLayerBoxGizmo(input: LayerBoxInput): SceneGizmo {
  const { x, y, width, height } = input.bounds;
  const d = Math.max(0, input.extrusionDepth);
  const at = (lx: number, ly: number, lz: number): Vec3 => Matrix4Math.transformPoint(input.world, { x: lx, y: ly, z: lz });

  const face = (lz: number): Vec3[] => [
    at(x, y, lz),
    at(x + width, y, lz),
    at(x + width, y + height, lz),
    at(x, y + height, lz),
  ];

  const front = face(0);
  const ring = (c: Vec3[]): GizmoSegment[] =>
    c.map((p, i) => seg(p, c[(i + 1) % c.length]!, 'bounds'));

  const segments = ring(front);
  if (d > 0) {
    const back = face(d);
    segments.push(...ring(back));
    for (let i = 0; i < 4; i++) segments.push(seg(front[i]!, back[i]!, 'bounds'));
  }

  return {
    nodeId: input.nodeId,
    type: 'layer',
    origin: at(x + width / 2, y + height / 2, 0),
    segments,
    selected: input.selected,
  };
}
