/**
 * Pinhole camera projection for the 2.5D compositor. Given a 3D point in comp
 * space and a camera, returns the on-screen position, a uniform `scale` factor
 * (how much bigger/smaller the layer draws at that depth), and `depth` for
 * back-to-front painter sorting. Pure, framework-free.
 *
 * Model (After Effects convention): the camera looks down +z at the comp plane
 * (z = 0). The default camera sits `focalLength` *behind* the plane, so a layer
 * at z = 0 projects at scale 1; moving a layer to +z (further) shrinks it, to
 * -z (closer) enlarges it. `focalLength` derives from a field of view.
 */

import type { Vec3 } from '../types';

export interface Camera3D {
  /** Camera position in comp space. z is negative when pulled back from the plane. */
  position: Vec3;
  /** Distance from the camera to the projection plane (px). */
  focalLength: number;
  /**
   * Where the camera's optical axis meets the screen — the comp centre.
   *
   * This must NOT track the camera. `projectPoint` previously used
   * `position.x/y` for both the eye and the principal point, which made the
   * camera term cancel algebraically at z = 0 (scale = 1), so panning the
   * camera in X/Y moved nothing and layers at other depths drifted the wrong
   * way. It looked correct only because the default camera sits at the comp
   * centre, where the two coincide.
   */
  principal: { x: number; y: number };
  /**
   * Optional look orientation, degrees. `yaw` turns the camera about its
   * vertical (Y) axis, `pitch` tilts about its horizontal (X) axis, and `roll`
   * spins it about the view axis (a dutch angle). Absent or zero orientation
   * follows the EXACT legacy projection path, so unrotated cameras render
   * byte-identically.
   *
   * World → camera is Rz(−roll)·Rx(−pitch)·Ry(−yaw)·T(−eye): roll is applied
   * LAST, which is what makes it rotate the frame rather than the aim.
   */
  orientation?: { yaw: number; pitch: number; roll?: number };
}

export interface Projected {
  x: number;
  y: number;
  /** Uniform perspective scale at this depth (1 = on the comp plane). */
  scale: number;
  /** Distance from the camera along z; larger = further (sort descending to paint). */
  depth: number;
  /**
   * True when the point sits at or behind the camera's near plane, i.e. the
   * returned x/y/scale are the NEAR clamp rather than a real projection.
   *
   * The clamp exists so the divide can't blow up, but a clamped point is not a
   * projection — a layer just behind the camera resolves to `focalLength / 1`,
   * which for a 1920-wide comp is a ~1111× scale: one layer smeared opaque over
   * the whole frame instead of disappearing. Callers that draw geometry must
   * drop the layer; callers that only need a finite number (overlays, gizmos)
   * can keep ignoring this field, which is why it is additive rather than a
   * change to the existing return shape.
   */
  clipped?: boolean;
}

/** Focal length (px) for a horizontal field of view over a comp of `width`. */
export function focalLengthForFov(width: number, fovDeg: number): number {
  const fov = Math.max(1, Math.min(179, fovDeg)) * (Math.PI / 180);
  return width / 2 / Math.tan(fov / 2);
}

/**
 * The inverse of {@link focalLengthForFov} — the horizontal field of view (deg)
 * a given focal length produces over a comp of `width`.
 *
 * AE exposes Zoom and Angle of View as two editable views of ONE value, and the
 * two must stay in lockstep: editing either has to update the other, which is
 * only possible with both directions of the conversion available.
 */
export function fovForFocalLength(width: number, focalLength: number): number {
  return (2 * Math.atan(width / 2 / Math.max(1e-6, focalLength)) * 180) / Math.PI;
}

/**
 * The default one-node camera for a comp: centred on the comp, pulled back by
 * `focalLength` so the plane renders 1:1. `fovDeg` defaults to AE's ~40°-ish
 * "50mm" comp-framing feel.
 */
export function defaultCamera(width: number, height: number, fovDeg = 39.6): Camera3D {
  const focalLength = focalLengthForFov(width, fovDeg);
  return {
    position: { x: width / 2, y: height / 2, z: -focalLength },
    focalLength,
    principal: { x: width / 2, y: height / 2 },
  };
}

/**
 * The six axis-aligned orthographic views (AE's Front/Back/Left/Right/Top/
 * Bottom). Unlike the perspective camera these are PARALLEL projections — no
 * foreshortening (`scale` is always 1) — so a flat comp appears edge-on (a
 * line) in any side/top view, and only 3D-offset layers spread apart. That is
 * the whole point of an orthographic view: it shows true depth relationships
 * without perspective distortion.
 */
export type OrthoView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

type Axis3 = readonly [number, number, number];

/**
 * Each view's screen basis: which world direction is screen-right and which is
 * screen-down. The into-screen depth axis is `right × cross down`, so the set is
 * self-consistent by construction. Comp space is y-DOWN, so "Top" looks from
 * −Y. `front` is the identity for the z=0 plane, matching the default view.
 */
const ORTHO_BASIS: Record<OrthoView, { right: Axis3; down: Axis3 }> = {
  front:  { right: [1, 0, 0],  down: [0, 1, 0] },
  back:   { right: [-1, 0, 0], down: [0, 1, 0] },
  left:   { right: [0, 0, -1], down: [0, 1, 0] },
  right:  { right: [0, 0, 1],  down: [0, 1, 0] },
  top:    { right: [1, 0, 0],  down: [0, 0, -1] },
  bottom: { right: [1, 0, 0],  down: [0, 0, 1] },
};

const dot3 = (a: Axis3, x: number, y: number, z: number): number => a[0] * x + a[1] * y + a[2] * z;

/**
 * The world directions that screen-right and screen-down correspond to in an
 * orthographic view — the INVERSE of what `projectOrtho` does, for turning a
 * drag back into a world translation.
 *
 * A parallel projection has no foreshortening, so this mapping is exact and
 * depth-independent: a drag of `d` screen units along screen-right moves the
 * layer `d` world units along `right`, wherever it sits. Dragging DOWN in Top
 * view therefore moves a layer in −Z (toward the viewer), not in +Y — writing
 * the raw 2D delta into x/y instead slides the layer along the one axis that
 * view projects away, so it appears frozen while its real position drifts.
 *
 * There is deliberately no perspective equivalent: under a perspective camera
 * the same screen delta is a different world delta at every depth, so the
 * conversion needs the layer's distance and is not a property of the view alone.
 */
export function orthoDragBasis(view: OrthoView): { right: Vec3; down: Vec3 } {
  const b = ORTHO_BASIS[view];
  return {
    right: { x: b.right[0], y: b.right[1], z: b.right[2] },
    down: { x: b.down[0], y: b.down[1], z: b.down[2] },
  };
}
const cross3 = (a: Axis3, b: Axis3): Axis3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * Project a comp-space point through one of the orthographic views.
 *
 * The scene is framed about the comp centre, so `front` reproduces the ordinary
 * 2D view exactly (a point at z = 0 maps to itself). `scale` is 1 — orthographic
 * views do not foreshorten; `depth` is the signed distance along the view axis
 * for back-to-front painter sorting.
 */
export function projectOrtho(p: Vec3, view: OrthoView, width: number, height: number): Projected {
  const { right, down } = ORTHO_BASIS[view];
  const cx = width / 2;
  const cy = height / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const dz = p.z; // comp plane sits at z = 0, so the plane is the depth origin
  const into = cross3(right, down);
  return {
    x: cx + dot3(right, dx, dy, dz),
    y: cy + dot3(down, dx, dy, dz),
    scale: 1,
    depth: dot3(into, dx, dy, dz),
  };
}

/** Smallest distance from the camera we will project (avoids divide blow-ups). */
const NEAR = 1;

const DEG = Math.PI / 180;

/** Project a comp-space point through the camera to screen space + scale + depth. */
/** Project a comp-space point through the camera to screen space + scale + depth. */
export function projectPoint(p: Vec3, cam: Camera3D): Projected {
  if (!cam || !cam.position || !cam.principal) {
    cam = defaultCamera(1920, 1080);
  }
  const yaw = cam.orientation?.yaw ?? 0;
  const pitch = cam.orientation?.pitch ?? 0;
  const roll = cam.orientation?.roll ?? 0;
  if (yaw !== 0 || pitch !== 0 || roll !== 0) {
    // Rotated camera: bring the point into CAMERA SPACE — translate by the
    // eye, then undo the camera's yaw (about Y) and pitch (about X) — and
    // apply the same pinhole divide the straight path uses.
    let vx = p.x - cam.position.x;
    let vy = p.y - cam.position.y;
    let vz = p.z - cam.position.z;
    // Ry(−yaw)
    const cy = Math.cos(-yaw * DEG);
    const sy = Math.sin(-yaw * DEG);
    const x1 = cy * vx + sy * vz;
    const z1 = -sy * vx + cy * vz;
    vx = x1;
    vz = z1;
    // Rx(−pitch)
    const cx = Math.cos(-pitch * DEG);
    const sx = Math.sin(-pitch * DEG);
    const y1 = cx * vy - sx * vz;
    const z2 = sx * vy + cx * vz;
    vy = y1;
    vz = z2;
    // Rz(−roll), applied LAST so it spins the frame about the view axis rather
    // than re-aiming the camera.
    if (roll !== 0) {
      const cz = Math.cos(-roll * DEG);
      const sz = Math.sin(-roll * DEG);
      const rx = cz * vx - sz * vy;
      vy = sz * vx + cz * vy;
      vx = rx;
    }
    const clamped = vz < NEAR ? NEAR : vz;
    const scale = cam.focalLength / clamped;
    return {
      x: cam.principal.x + vx * scale,
      y: cam.principal.y + vy * scale,
      scale,
      depth: clamped,
      ...(vz < NEAR ? { clipped: true } : {}),
    };
  }
  const dist = p.z - cam.position.z; // > 0 when the point is in front of the camera
  const clamped = dist < NEAR ? NEAR : dist;
  const scale = cam.focalLength / clamped;
  return {
    x: cam.principal.x + (p.x - cam.position.x) * scale,
    y: cam.principal.y + (p.y - cam.position.y) * scale,
    scale,
    depth: clamped,
    ...(dist < NEAR ? { clipped: true } : {}),
  };
}

/**
 * The world directions that screen-right and screen-down correspond to under a
 * PERSPECTIVE camera — the counterpart of {@link orthoDragBasis}, for turning a
 * drag in an Active Camera or Custom View back into a world translation.
 *
 * Unlike the orthographic case this is only half the answer: the basis gives the
 * DIRECTION, but a perspective screen delta also means a different world
 * distance at every depth. The magnitude is `delta / projected.scale` — that is
 * the exact inverse of the pinhole divide `projectPoint` applies, so a layer
 * ends up under the pointer at any depth. For an un-orbited camera this reduces
 * to right = (1,0,0), down = (0,1,0), and a layer on the comp plane has
 * scale = 1, which is why writing the raw delta into x/y was right in the
 * default view and only ever wrong once the camera moved.
 *
 * Read off `cameraViewMatrix` rather than re-deriving the rotation: R is
 * orthonormal, so camera→world is Rᵀ, and screen-right/-down are its first two
 * ROWS. Re-expanding those nine entries by hand is precisely where a sign error
 * would hide, and it would drift from `projectPoint` silently.
 */
export function cameraDragBasis(cam: Camera3D): { right: Vec3; down: Vec3 } {
  const m = cameraViewMatrix(cam);
  // Column-major: m[col*4 + row]. Row 0 of R = (m[0], m[4], m[8]).
  return {
    right: { x: m[0]!, y: m[4]!, z: m[8]! },
    down: { x: m[1]!, y: m[5]!, z: m[9]! },
  };
}

// ── GPU matrix forms ─────────────────────────────────────────────────────────
// The depth-tested GPU pipeline needs the SAME camera as `projectPoint` /
// `projectOrtho`, but as 4×4 view + projection matrices (column-major, the
// Matrix4 convention). These are derived to be algebraically identical to the
// scalar projections above: for any point p,
//   transformPoint(projection · view, p)  ===  { projectPoint(p).x/y, zNdc }
// (with the perspective divide by camera-space z happening in hardware).
// Keeping both forms in this one file is what guarantees the CPU affine
// fallback (hit-testing, painter sort, Canvas2D offline path) and the GPU
// mat4 path never disagree about where a layer sits on screen.

import type { Matrix4 } from '../types';

/** Near plane distance (matches the NEAR clamp of `projectPoint`). */
export const PERSPECTIVE_NEAR = NEAR;
/** Far plane for depth-buffer normalisation. Generous — comp z rarely exceeds
 *  a few tens of thousands of px. Only depth PRECISION depends on it. */
export const PERSPECTIVE_FAR = 100000;
/** Half-range of the orthographic depth window (±px around the comp plane). */
export const ORTHO_DEPTH_RANGE = 50000;

/**
 * World → camera-space view matrix: V = Rx(−pitch) · Ry(−yaw) · T(−eye).
 * Matches `projectPoint`'s rotated path exactly (translate by the eye, undo
 * yaw about Y, then pitch about X). Zero orientation reduces to a translation.
 */
export function cameraViewMatrix(cam: Camera3D): Matrix4 {
  if (!cam || !cam.position) cam = defaultCamera(1920, 1080);
  const yaw = (cam.orientation?.yaw ?? 0) * DEG;
  const pitch = (cam.orientation?.pitch ?? 0) * DEG;
  const cy = Math.cos(-yaw), sy = Math.sin(-yaw);
  const cx = Math.cos(-pitch), sx = Math.sin(-pitch);
  // R = Rx(−pitch) · Ry(−yaw), row-major rows:
  //   projectPoint applies Ry(−yaw) first: x1 = cy·vx + sy·vz ; z1 = −sy·vx + cy·vz
  //   then Rx(−pitch):                     y2 = cx·vy − sx·z1 ; z2 = sx·vy + cx·z1
  let r00 = cy,        r01 = 0,  r02 = sy;
  let r10 = -sx * -sy, r11 = cx, r12 = -sx * cy;
  const r20 = cx * -sy, r21 = sx, r22 = cx * cy;
  // Premultiply by Rz(−roll) — computed rather than hand-expanded, because
  // re-deriving nine entries by hand is exactly where a sign error hides.
  // Rz only mixes rows 0 and 1; row 2 (the view axis) is untouched.
  const roll = (cam.orientation?.roll ?? 0) * DEG;
  if (roll !== 0) {
    const cz = Math.cos(-roll);
    const sz = Math.sin(-roll);
    const n00 = cz * r00 - sz * r10, n01 = cz * r01 - sz * r11, n02 = cz * r02 - sz * r12;
    const n10 = sz * r00 + cz * r10, n11 = sz * r01 + cz * r11, n12 = sz * r02 + cz * r12;
    r00 = n00; r01 = n01; r02 = n02;
    r10 = n10; r11 = n11; r12 = n12;
  }
  const ex = cam.position.x, ey = cam.position.y, ez = cam.position.z;
  // Column-major store; translation column = −R·eye.
  return [
    r00, r10, r20, 0,
    r01, r11, r21, 0,
    r02, r12, r22, 0,
    -(r00 * ex + r01 * ey + r02 * ez),
    -(r10 * ex + r11 * ey + r12 * ez),
    -(r20 * ex + r21 * ey + r22 * ez),
    1,
  ];
}

/**
 * Camera space → homogeneous COMP-SPACE clip: after the divide by w (= camera z),
 * x/y are comp px identical to `projectPoint` (principal + f·v/z) and z is a
 * [0,1] normalised depth (monotonic in camera z) for the depth buffer. The 2D
 * pan/zoom camera is applied AFTER this, as a lifted mat3 (see the renderer).
 */
export function cameraProjectionMatrix(cam: Camera3D): Matrix4 {
  if (!cam || !cam.principal) cam = defaultCamera(1920, 1080);
  const f = cam.focalLength;
  const px = cam.principal.x;
  const py = cam.principal.y;
  const n = PERSPECTIVE_NEAR;
  const fr = PERSPECTIVE_FAR;
  const a = fr / (fr - n);
  const b = (-fr * n) / (fr - n);
  return [
    f, 0, 0, 0,
    0, f, 0, 0,
    px, py, a, 1,
    0, 0, b, 0,
  ];
}

/**
 * The orthographic twin: view rotates comp space into the axis view's basis
 * about the comp centre; projection is identity in x/y (scale 1, no divide,
 * w = 1) with depth normalised into [0,1] across ±ORTHO_DEPTH_RANGE. Matches
 * `projectOrtho` exactly for x/y and ordering for depth.
 */
export function orthoCameraMatrices(
  view: OrthoView,
  width: number,
  height: number,
): { view: Matrix4; projection: Matrix4 } {
  const { right, down } = ORTHO_BASIS[view];
  const into = cross3(right, down);
  const cx = width / 2;
  const cy = height / 2;
  // v = B·(p − center): rows are right / down / into.
  const V: Matrix4 = [
    right[0], down[0], into[0], 0,
    right[1], down[1], into[1], 0,
    right[2], down[2], into[2], 0,
    -(right[0] * cx + right[1] * cy),
    -(down[0] * cx + down[1] * cy),
    -(into[0] * cx + into[1] * cy),
    1,
  ];
  const R = ORTHO_DEPTH_RANGE;
  const P: Matrix4 = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1 / (2 * R), 0,
    cx, cy, 0.5, 1,
  ];
  return { view: V, projection: P };
}

/**
 * The look orientation (yaw, pitch in DEGREES) that points a camera at `eye`
 * toward `target` — a two-node camera's Point of Interest. Derived to be the
 * exact inverse of `projectPoint`'s rotated path: the target then projects to
 * the principal point (screen centre). A target directly along −z (the default
 * camera looking at the comp centre) yields zero orientation, i.e. the legacy
 * one-node path. Pure and framework-free.
 */
export function lookAtOrientation(eye: Vec3, target: Vec3): { yaw: number; pitch: number } {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const h = Math.hypot(dx, dz);
  // yaw about Y so the horizontal component aligns to +z; pitch about X so the
  // vertical component zeroes out. Matches projectPoint's Ry(−yaw)·Rx(−pitch).
  // `+ 0` normalises a JS `-0` (from atan2(-0, …)) to `+0` so callers comparing
  // against a zero orientation don't trip on Object.is(-0, 0).
  const yaw = Math.atan2(dx, dz) / DEG + 0;
  const pitch = Math.atan2(-dy, h) / DEG + 0;
  return { yaw, pitch };
}

/**
 * ORBIT the camera about a point of interest: keep the distance from `poi`,
 * swing by yaw/pitch (degrees), and return the eye position + the orientation
 * that keeps `poi` centred. yaw = pitch = 0 returns the base configuration
 * unchanged. Exact when the base offset is along −z (the default camera);
 * panned cameras orbit about their own POI-relative axis.
 */
export function orbitCamera(
  basePosition: Vec3,
  poi: Vec3,
  yaw: number,
  pitch: number,
): { position: Vec3; orientation: { yaw: number; pitch: number } } {
  if (yaw === 0 && pitch === 0) {
    return { position: basePosition, orientation: { yaw: 0, pitch: 0 } };
  }
  const ox = basePosition.x - poi.x;
  const oy = basePosition.y - poi.y;
  const oz = basePosition.z - poi.z;
  // Rx(pitch) then Ry(yaw) applied to the base offset.
  const cx = Math.cos(pitch * DEG);
  const sx = Math.sin(pitch * DEG);
  const y1 = cx * oy - sx * oz;
  const z1 = sx * oy + cx * oz;
  const cy = Math.cos(yaw * DEG);
  const sy = Math.sin(yaw * DEG);
  const x2 = cy * ox + sy * z1;
  const z2 = -sy * ox + cy * z1;
  return {
    position: { x: poi.x + x2, y: poi.y + y1, z: poi.z + z2 },
    orientation: { yaw, pitch },
  };
}

export interface Ray3D {
  origin: Vec3;
  direction: Vec3;
}

/**
 * Unproject a screen coordinate (px) into a 3D ray in composition space.
 */
export function unprojectScreenRay(
  screenX: number,
  screenY: number,
  cam: Camera3D,
  orthoView?: OrthoView | null,
  width: number = 1920,
  height: number = 1080,
): Ray3D {
  if (!cam || !cam.principal || !cam.position) {
    cam = defaultCamera(width, height);
  }
  if (orthoView) {
    const { right, down } = ORTHO_BASIS[orthoView];
    const into = cross3(right, down);
    const cx = width / 2;
    const cy = height / 2;
    const dx = screenX - cx;
    const dy = screenY - cy;
    const origin: Vec3 = {
      x: cx + right[0] * dx + down[0] * dy - into[0] * ORTHO_DEPTH_RANGE,
      y: cy + right[1] * dx + down[1] * dy - into[1] * ORTHO_DEPTH_RANGE,
      z: right[2] * dx + down[2] * dy - into[2] * ORTHO_DEPTH_RANGE,
    };
    return {
      origin,
      direction: { x: into[0], y: into[1], z: into[2] },
    };
  }

  const dx = (screenX - cam.principal.x) / cam.focalLength;
  const dy = (screenY - cam.principal.y) / cam.focalLength;
  let vx = dx;
  let vy = dy;
  let vz = 1;

  const yaw = (cam.orientation?.yaw ?? 0) * DEG;
  const pitch = (cam.orientation?.pitch ?? 0) * DEG;
  const roll = (cam.orientation?.roll ?? 0) * DEG;
  if (yaw !== 0 || pitch !== 0 || roll !== 0) {
    // Forward rotation R = Ry(yaw) · Rx(pitch) · Rz(roll) — the exact inverse
    // of projectPoint's Rz(−roll)·Rx(−pitch)·Ry(−yaw), so roll comes FIRST here.
    if (roll !== 0) {
      const cz = Math.cos(roll), sz = Math.sin(roll);
      const rx = cz * vx - sz * vy;
      vy = sz * vx + cz * vy;
      vx = rx;
    }
    const cx = Math.cos(pitch), sx = Math.sin(pitch);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const y1 = cx * vy - sx * vz;
    const z1 = sx * vy + cx * vz;
    const x2 = cy * vx + sy * z1;
    const z2 = -sy * vx + cy * z1;
    vx = x2;
    vy = y1;
    vz = z2;
  }

  const len = Math.hypot(vx, vy, vz) || 1;
  return {
    origin: { ...cam.position },
    direction: { x: vx / len, y: vy / len, z: vz / len },
  };
}

/**
 * Intersect a 3D ray with a plane defined by a point and normal vector.
 */
export function intersectRayPlane(ray: Ray3D, planePoint: Vec3, planeNormal: Vec3): Vec3 | null {
  const denom = ray.direction.x * planeNormal.x + ray.direction.y * planeNormal.y + ray.direction.z * planeNormal.z;
  if (Math.abs(denom) < 1e-6) return null;
  const num = (planePoint.x - ray.origin.x) * planeNormal.x +
              (planePoint.y - ray.origin.y) * planeNormal.y +
              (planePoint.z - ray.origin.z) * planeNormal.z;
  const t = num / denom;
  return {
    x: ray.origin.x + t * ray.direction.x,
    y: ray.origin.y + t * ray.direction.y,
    z: ray.origin.z + t * ray.direction.z,
  };
}

/**
 * Find closest points between a 3D ray and a 3D line axis.
 * Returns parameter `tAxis` along axisDir from axisOrigin.
 */
export function closestPointRayAxis(
  ray: Ray3D,
  axisOrigin: Vec3,
  axisDir: Vec3,
): { tAxis: number; tRay: number; pointOnAxis: Vec3 } {
  const w0x = ray.origin.x - axisOrigin.x;
  const w0y = ray.origin.y - axisOrigin.y;
  const w0z = ray.origin.z - axisOrigin.z;

  const a = ray.direction.x * ray.direction.x + ray.direction.y * ray.direction.y + ray.direction.z * ray.direction.z;
  const b = ray.direction.x * axisDir.x + ray.direction.y * axisDir.y + ray.direction.z * axisDir.z;
  const c = axisDir.x * axisDir.x + axisDir.y * axisDir.y + axisDir.z * axisDir.z;
  const d = ray.direction.x * w0x + ray.direction.y * w0y + ray.direction.z * w0z;
  const e = axisDir.x * w0x + axisDir.y * w0y + axisDir.z * w0z;

  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-6) {
    return {
      tAxis: 0,
      tRay: 0,
      pointOnAxis: { ...axisOrigin },
    };
  }

  const tRay = (b * e - c * d) / denom;
  const tAxis = (a * e - b * d) / denom;

  return {
    tAxis,
    tRay,
    pointOnAxis: {
      x: axisOrigin.x + tAxis * axisDir.x,
      y: axisOrigin.y + tAxis * axisDir.y,
      z: axisOrigin.z + tAxis * axisDir.z,
    },
  };
}

