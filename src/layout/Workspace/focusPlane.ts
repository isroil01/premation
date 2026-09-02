/**
 * The focus-plane gizmo's geometry and drag arithmetic — pure, so the parts
 * that can be wrong on paper are testable and the overlay is only plumbing.
 *
 * ## What the plane is
 *
 * Depth of field is three numbers in the camera inspector (focus distance,
 * f-stop / aperture, blur level) describing something entirely spatial: a slab
 * of the scene that renders sharp. Reading it off a number field means guessing
 * where 1200px is in a comp, nudging, re-rendering and looking — the loop AE
 * users know as "racking focus blind". Drawing the plane where the camera's own
 * frustum already goes turns that into a thing you can see and grab.
 *
 * The rectangle IS the frustum's cross-section at the focus distance: half-width
 * `(compWidth/2)·d/focalLength`, the same pinhole relation `Project3D` projects
 * with and `SceneGizmos.buildCameraGizmo` draws the frustum's far rect with. It
 * has to be — a focus plane that did not line up with the cone it sits inside
 * would be describing a different camera.
 *
 * ## The near/far bands
 *
 * The plane alone says where focus is, not how forgiving it is. The two fainter
 * rectangles are `focusRangeAt`'s solution of the blur model for a threshold
 * CoC, so what you see is the band the RENDERER treats as sharp rather than a
 * rule of thumb. Past the hyperfocal distance the far limit is genuinely
 * infinite and simply is not drawn.
 */

import type { Vec3 } from '@motion/scene';
import type { FocusRange } from '@core/scene/camera3d';

/** Which of the three rectangles this is. */
export type FocusRingKind = 'focus' | 'near' | 'far';

export interface FocusRing {
  kind: FocusRingKind;
  /** Distance from the eye along the view axis, in comp px. */
  distance: number;
  /** Corners in comp space, in draw order (tl, tr, br, bl). */
  corners: readonly [Vec3, Vec3, Vec3, Vec3];
}

export interface FocusPlaneGizmo {
  nodeId: string;
  /** Focus distance in comp px — what a drag writes back. */
  distance: number;
  /** Centre of the focus rectangle: where the drag handle sits. */
  centre: Vec3;
  /** Unit view axis. The drag slides along this and nothing else. */
  forward: Vec3;
  rings: FocusRing[];
}

/** The camera's orthonormal frame, as `SceneGizmos.cameraBasis` returns it. */
export interface CameraFrame {
  forward: Vec3;
  right: Vec3;
  down: Vec3;
}

const along = (from: Vec3, dir: Vec3, s: number): Vec3 => ({
  x: from.x + dir.x * s,
  y: from.y + dir.y * s,
  z: from.z + dir.z * s,
});

/**
 * The comp frame as the camera sees it at `distance` — four corners in comp
 * space, in tl → tr → br → bl order.
 *
 * `down` is named for comp space being y-DOWN (see `cameraBasis`), so the "top"
 * corners are the ones at negative `down`.
 */
export function frustumCrossSection(
  eye: Vec3,
  frame: CameraFrame,
  focalLength: number,
  distance: number,
  compWidth: number,
  compHeight: number,
): readonly [Vec3, Vec3, Vec3, Vec3] {
  const d = Math.max(0, distance);
  const k = d / Math.max(1, focalLength);
  const hw = (compWidth / 2) * k;
  const hh = (compHeight / 2) * k;
  const centre = along(eye, frame.forward, d);
  const corner = (sr: number, sd: number): Vec3 =>
    along(along(centre, frame.right, sr * hw), frame.down, sd * hh);
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
}

/** Focus distance can never reach the eye — the inspector's own floor. */
export const MIN_FOCUS_DISTANCE = 1;

export interface FocusPlaneInput {
  nodeId: string;
  /** Resolved eye position (parent transforms already applied). */
  eye: Vec3;
  frame: CameraFrame;
  focalLength: number;
  /** Focus distance in comp px. */
  distance: number;
  /**
   * The in-focus band, or null to draw the plane alone.
   *
   * A non-finite `far` (past hyperfocal) drops the far band rather than
   * clamping it: a rectangle at an invented distance would be a claim the lens
   * model never made.
   */
  range: FocusRange | null;
  compWidth: number;
  compHeight: number;
}

export function buildFocusPlaneGizmo(input: FocusPlaneInput): FocusPlaneGizmo {
  const { eye, frame, focalLength, compWidth, compHeight } = input;
  const distance = Math.max(MIN_FOCUS_DISTANCE, input.distance);
  const ring = (kind: FocusRingKind, d: number): FocusRing => ({
    kind,
    distance: d,
    corners: frustumCrossSection(eye, frame, focalLength, d, compWidth, compHeight),
  });

  const rings: FocusRing[] = [ring('focus', distance)];
  const range = input.range;
  if (range) {
    // Strictly INSIDE the plane on each side. A band that has collapsed onto
    // the focus distance draws a second rectangle on top of the first, which
    // reads as a rendering artefact rather than as "the depth of field is
    // vanishingly thin" — the plane's own line already says that.
    if (Number.isFinite(range.near) && range.near > 0 && range.near < distance) {
      rings.push(ring('near', range.near));
    }
    if (Number.isFinite(range.far) && range.far > distance) rings.push(ring('far', range.far));
  }

  return {
    nodeId: input.nodeId,
    distance,
    centre: along(eye, frame.forward, distance),
    forward: frame.forward,
    rings,
  };
}

/**
 * How far the handle moves ON SCREEN per comp-px of focus distance.
 *
 * The view axis is a 3D direction; a pointer only ever moves in 2D, so the
 * gesture has to be resolved against the axis' SCREEN-space image. Measuring it
 * by projecting two points a probe apart — rather than deriving it from the
 * camera basis — means it is correct for every projection the viewport offers
 * without knowing which one is active: perspective, the six ortho views, and a
 * custom view alike.
 *
 * Returns a vector in screen px whose length is the px-per-unit rate. It is
 * near zero exactly when the axis points at the viewer (looking down the barrel
 * of the camera you are inside), which is the case a drag cannot mean anything
 * in — see `focusDistanceFromDrag`.
 */
export function screenAxisPerUnit(
  centre: Vec3,
  forward: Vec3,
  project: (p: Vec3) => { x: number; y: number },
  probe = 1,
): { x: number; y: number } {
  const p = Math.max(1e-6, probe);
  const a = project(centre);
  const b = project(along(centre, forward, p));
  if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
    return { x: 0, y: 0 };
  }
  return { x: (b.x - a.x) / p, y: (b.y - a.y) / p };
}

/**
 * The focus distance a pointer delta asks for.
 *
 * The delta is projected onto the axis' screen direction and divided by the
 * rate, which is the least-squares answer to "how far along this line did the
 * user mean to go" — so a drag perpendicular to the axis changes nothing rather
 * than being interpreted as a small step along it.
 *
 * Everything is measured from where the drag STARTED, never accumulated
 * per-event: an accumulating drag drifts, and it also cannot be undone as one
 * gesture. A degenerate axis (rate ≈ 0) returns the start distance unchanged —
 * refusing the gesture beats amplifying a rounding error into a focus pull of
 * thousands of pixels.
 */
export function focusDistanceFromDrag(
  startDistance: number,
  axisPerUnit: { x: number; y: number },
  delta: { x: number; y: number },
): number {
  const lenSq = axisPerUnit.x * axisPerUnit.x + axisPerUnit.y * axisPerUnit.y;
  if (!(lenSq > 1e-9)) return startDistance;
  const moved = (delta.x * axisPerUnit.x + delta.y * axisPerUnit.y) / lenSq;
  const next = startDistance + moved;
  return Number.isFinite(next) ? Math.max(MIN_FOCUS_DISTANCE, next) : startDistance;
}
