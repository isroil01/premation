/**
 * The focus-plane gizmo's geometry and drag arithmetic.
 *
 * TWO THINGS CARRY THIS FILE.
 *
 * 1. **The plane agrees with the frustum.** The rectangle is only meaningful
 *    because it is the camera's own cross-section: half-width
 *    `(compWidth/2)·d/focalLength`, the identical pinhole relation
 *    `SceneGizmos.buildCameraGizmo` draws the cone's far rect with and
 *    `Project3D` projects with. A focus plane that did not line up with the
 *    frustum around it would be describing a camera that does not exist, and
 *    the error is invisible until someone measures.
 *
 * 2. **A drag means what the pointer meant.** The gesture is resolved against
 *    the view axis' SCREEN direction, so a movement across the axis must change
 *    nothing and a movement along it must move by the amount it looks like.
 *    Degenerate axes (the camera you are inside) must refuse rather than divide
 *    by an epsilon and pull focus by thousands of pixels.
 */

import { SceneGizmos } from '@motion/workspace';
import type { Vec3 } from '@motion/scene';
import {
  buildFocusPlaneGizmo,
  focusDistanceFromDrag,
  frustumCrossSection,
  screenAxisPerUnit,
  MIN_FOCUS_DISTANCE,
  type CameraFrame,
} from './focusPlane';

const COMP_W = 1920;
const COMP_H = 1080;
const FOCAL = 1000;
const EYE: Vec3 = { x: 960, y: 540, z: -1000 };

/** An un-orbited camera: forward is +z, right is +x, down is +y. */
const straight: CameraFrame = SceneGizmos.cameraBasis(0, 0, 0);

describe('the plane is the frustum cross-section', () => {
  it('is the comp frame itself at the focal length', () => {
    // At d = focalLength the camera renders 1:1, so the cross-section is
    // exactly the comp rectangle. Anything else means the plane and the render
    // disagree about what "zoom" is.
    const [tl, tr, br, bl] = frustumCrossSection(EYE, straight, FOCAL, FOCAL, COMP_W, COMP_H);
    expect(tl).toEqual({ x: 0, y: 0, z: 0 });
    expect(tr).toEqual({ x: COMP_W, y: 0, z: 0 });
    expect(br).toEqual({ x: COMP_W, y: COMP_H, z: 0 });
    expect(bl).toEqual({ x: 0, y: COMP_H, z: 0 });
  });

  it('scales linearly with distance', () => {
    const near = frustumCrossSection(EYE, straight, FOCAL, 500, COMP_W, COMP_H);
    const far = frustumCrossSection(EYE, straight, FOCAL, 2000, COMP_W, COMP_H);
    const width = (c: readonly Vec3[]): number => (c[1]?.x ?? 0) - (c[0]?.x ?? 0);
    expect(width(near)).toBeCloseTo(COMP_W * 0.5, 9);
    expect(width(far)).toBeCloseTo(COMP_W * 2, 9);
  });

  it('matches the frustum gizmo the camera already draws', () => {
    // The one assertion that pins the two together. `buildCameraGizmo` closes
    // its cone with the rect at the focus distance; the focus plane must be
    // that same rectangle, or the overlay contradicts itself on screen.
    const d = 1600;
    const giz = SceneGizmos.buildCameraGizmo({
      nodeId: 'cam', position: EYE, focalLength: FOCAL, focusDistance: d,
      compWidth: COMP_W, compHeight: COMP_H, selected: false,
    });
    const corners = frustumCrossSection(EYE, straight, FOCAL, d, COMP_W, COMP_H);
    // The four cone rays end on the four corners of the far rect.
    const rayEnds = giz.segments.filter((s) => s.kind === 'frustum').slice(0, 4).map((s) => s.end);
    for (const corner of corners) {
      expect(rayEnds).toContainEqual(corner);
    }
  });

  it('rides the camera orientation', () => {
    // Yawed 90°, forward is +x — so the plane's centre moves along x, not z.
    const frame = SceneGizmos.cameraBasis(90, 0, 0);
    const giz = buildFocusPlaneGizmo({
      nodeId: 'cam', eye: EYE, frame, focalLength: FOCAL, distance: 1000,
      range: null, compWidth: COMP_W, compHeight: COMP_H,
    });
    expect(giz.centre.x).toBeCloseTo(EYE.x + 1000, 6);
    expect(giz.centre.z).toBeCloseTo(EYE.z, 6);
  });
});

describe('the near / far bands', () => {
  const build = (range: { near: number; far: number } | null, distance = 1000) =>
    buildFocusPlaneGizmo({
      nodeId: 'cam', eye: EYE, frame: straight, focalLength: FOCAL, distance,
      range, compWidth: COMP_W, compHeight: COMP_H,
    });

  it('draws the plane alone when the model gives no range', () => {
    expect(build(null).rings.map((r) => r.kind)).toEqual(['focus']);
  });

  it('draws all three when the band is real', () => {
    const rings = build({ near: 700, far: 1600 }).rings;
    expect(rings.map((r) => r.kind).sort()).toEqual(['far', 'focus', 'near']);
    expect(rings.find((r) => r.kind === 'near')?.distance).toBe(700);
    expect(rings.find((r) => r.kind === 'far')?.distance).toBe(1600);
  });

  it('drops an infinite far limit rather than inventing a distance', () => {
    // Past the hyperfocal distance everything beyond `near` is sharp. Clamping
    // that to some large number would draw a rectangle claiming a limit the
    // lens model never stated.
    const rings = build({ near: 700, far: Infinity }).rings;
    expect(rings.map((r) => r.kind)).toEqual(['focus', 'near']);
  });

  it('drops a band that has collapsed onto the plane', () => {
    // Two rectangles at the same depth read as a rendering artefact, not as
    // "the depth of field is vanishingly thin".
    expect(build({ near: 1000, far: 1000 }).rings.map((r) => r.kind)).toEqual(['focus']);
  });

  it('never draws a band at or behind the eye', () => {
    expect(build({ near: 0, far: 1600 }).rings.map((r) => r.kind)).toEqual(['focus', 'far']);
    expect(build({ near: -50, far: 1600 }).rings.map((r) => r.kind)).toEqual(['focus', 'far']);
  });

  it('clamps the focus distance to the inspector floor', () => {
    expect(build(null, 0).distance).toBe(MIN_FOCUS_DISTANCE);
    expect(build(null, -900).distance).toBe(MIN_FOCUS_DISTANCE);
  });
});

describe('the drag resolves against the axis on screen', () => {
  /** A trivially checkable projection: comp x/y, ignoring depth. */
  const flat = (p: Vec3): { x: number; y: number } => ({ x: p.x, y: p.y });

  it('measures px-per-unit from the projection, whatever it is', () => {
    // Ortho Top view: forward (+z) projects to screen +y at 1:1, so the rate is
    // one screen px per comp px, straight down.
    const topDown = (p: Vec3): { x: number; y: number } => ({ x: p.x, y: p.z });
    const rate = screenAxisPerUnit({ x: 0, y: 0, z: 0 }, straight.forward, topDown);
    expect(rate.x).toBeCloseTo(0, 9);
    expect(rate.y).toBeCloseTo(1, 9);
  });

  it('reports a zero rate when the axis points at the viewer', () => {
    // Looking down the barrel: forward projects to a point, so there is no
    // screen direction to drag along.
    const rate = screenAxisPerUnit({ x: 0, y: 0, z: 0 }, straight.forward, flat);
    expect(Math.hypot(rate.x, rate.y)).toBeCloseTo(0, 9);
  });

  it('converts a drag along the axis into the distance it looks like', () => {
    const rate = { x: 0, y: 2 }; // two screen px per comp px
    expect(focusDistanceFromDrag(1000, rate, { x: 0, y: 200 })).toBeCloseTo(1100, 9);
    expect(focusDistanceFromDrag(1000, rate, { x: 0, y: -200 })).toBeCloseTo(900, 9);
  });

  it('ignores movement ACROSS the axis', () => {
    // The whole point of projecting the delta: a sideways drag is not a small
    // focus pull, it is no focus pull.
    expect(focusDistanceFromDrag(1000, { x: 0, y: 2 }, { x: 500, y: 0 })).toBe(1000);
  });

  it('refuses a degenerate axis instead of amplifying it', () => {
    // Dividing by |rate|² would turn a one-pixel wobble into a focus pull of
    // millions — the failure mode that makes a handle feel possessed.
    expect(focusDistanceFromDrag(1000, { x: 0, y: 0 }, { x: 40, y: 40 })).toBe(1000);
    expect(focusDistanceFromDrag(1000, { x: 1e-9, y: 0 }, { x: 40, y: 0 })).toBe(1000);
  });

  it('is absolute, not accumulated — the same delta always lands in the same place', () => {
    const rate = { x: 1, y: 1 };
    const once = focusDistanceFromDrag(1000, rate, { x: 30, y: 30 });
    const again = focusDistanceFromDrag(1000, rate, { x: 30, y: 30 });
    expect(again).toBe(once);
  });

  it('cannot pull focus back through the eye', () => {
    expect(focusDistanceFromDrag(100, { x: 0, y: 1 }, { x: 0, y: -1e6 })).toBe(MIN_FOCUS_DISTANCE);
  });
});
