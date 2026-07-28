/**
 * Turning a viewport drag back into a world translation.
 *
 * `projectOrtho` / `projectPoint` map world → screen; these bases map a screen
 * delta back. Getting them wrong is not subtle in effect but is invisible in
 * code: the layer moves along an axis the view projects away, so it looks frozen
 * on screen while its stored position drifts.
 *
 * Tested as INVERSES of the projections rather than against copied-out numbers —
 * a table of expected components would just restate the implementation.
 */

import * as Project3D from '../utils/project3d';

const COMP_W = 1920;
const COMP_H = 1080;

/** Move `p` by the world delta a drag of (dx, dy) means in `view`, then check
 *  the projection actually moved by (dx, dy). */
function orthoRoundTrip(
  view: Project3D.OrthoView,
  p: { x: number; y: number; z: number },
  dx: number,
  dy: number,
): { movedX: number; movedY: number } {
  const { right, down } = Project3D.orthoDragBasis(view);
  const moved = {
    x: p.x + right.x * dx + down.x * dy,
    y: p.y + right.y * dx + down.y * dy,
    z: p.z + right.z * dx + down.z * dy,
  };
  const a = Project3D.projectOrtho(p, view, COMP_W, COMP_H);
  const b = Project3D.projectOrtho(moved, view, COMP_W, COMP_H);
  return { movedX: b.x - a.x, movedY: b.y - a.y };
}

describe('orthoDragBasis — the inverse of projectOrtho', () => {
  const VIEWS: Project3D.OrthoView[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];

  it.each(VIEWS)('a drag in %s moves the projection by exactly that much', (view) => {
    const r = orthoRoundTrip(view, { x: 800, y: 500, z: 120 }, 37, -19);
    expect(r.movedX).toBeCloseTo(37, 6);
    expect(r.movedY).toBeCloseTo(-19, 6);
  });

  it('front is the identity — this is the case that always worked', () => {
    const { right, down } = Project3D.orthoDragBasis('front');
    expect(right).toEqual({ x: 1, y: 0, z: 0 });
    expect(down).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('dragging DOWN in Top view is a DEPTH move, not a Y move', () => {
    // The reported bug: this wrote y and left z alone, so the layer slid along
    // the one axis Top view cannot show.
    const { down } = Project3D.orthoDragBasis('top');
    expect(down.y).toBe(0);
    expect(down.z).not.toBe(0);
  });

  it('dragging sideways in Left/Right view is a DEPTH move', () => {
    for (const v of ['left', 'right'] as const) {
      const { right } = Project3D.orthoDragBasis(v);
      expect(right.x).toBe(0);
      expect(right.z).not.toBe(0);
    }
  });

  it('opposite views drag in opposite world directions', () => {
    expect(Project3D.orthoDragBasis('left').right.z).toBe(-Project3D.orthoDragBasis('right').right.z);
    expect(Project3D.orthoDragBasis('top').down.z).toBe(-Project3D.orthoDragBasis('bottom').down.z);
  });
});

describe('cameraDragBasis — the inverse of projectPoint', () => {
  /** Apply a drag the way `moveNodes` does and report how far the projection
   *  actually moved: direction from the basis, magnitude from 1/scale. */
  function perspectiveRoundTrip(
    cam: Project3D.Camera3D,
    p: { x: number; y: number; z: number },
    dx: number,
    dy: number,
  ): { movedX: number; movedY: number } {
    const { right, down } = Project3D.cameraDragBasis(cam);
    const k = 1 / Project3D.projectPoint(p, cam).scale;
    const moved = {
      x: p.x + right.x * dx * k + down.x * dy * k,
      y: p.y + right.y * dx * k + down.y * dy * k,
      z: p.z + right.z * dx * k + down.z * dy * k,
    };
    const a = Project3D.projectPoint(p, cam);
    const b = Project3D.projectPoint(moved, cam);
    return { movedX: b.x - a.x, movedY: b.y - a.y };
  }

  it('an un-orbited camera is the identity basis — the old behaviour, preserved', () => {
    const cam = Project3D.defaultCamera(COMP_W, COMP_H);
    const { right, down } = Project3D.cameraDragBasis(cam);
    expect(right.x).toBeCloseTo(1, 9);
    expect(right.y).toBeCloseTo(0, 9);
    expect(right.z).toBeCloseTo(0, 9);
    expect(down.x).toBeCloseTo(0, 9);
    expect(down.y).toBeCloseTo(1, 9);
    expect(down.z).toBeCloseTo(0, 9);
  });

  it('a layer on the comp plane passes the delta through unchanged', () => {
    const cam = Project3D.defaultCamera(COMP_W, COMP_H);
    // scale is 1 there, which is why writing the raw delta into x/y was right.
    expect(Project3D.projectPoint({ x: 960, y: 540, z: 0 }, cam).scale).toBeCloseTo(1, 9);
  });

  it('the layer lands under the pointer at any depth', () => {
    const cam = Project3D.defaultCamera(COMP_W, COMP_H);
    for (const z of [-400, 0, 900, 5000]) {
      const r = perspectiveRoundTrip(cam, { x: 960, y: 540, z }, 40, 25);
      expect(r.movedX).toBeCloseTo(40, 4);
      expect(r.movedY).toBeCloseTo(25, 4);
    }
  });

  it('still lands under the pointer once the camera is orbited', () => {
    const base = Project3D.defaultCamera(COMP_W, COMP_H);
    const cam: Project3D.Camera3D = { ...base, orientation: { yaw: 34, pitch: -21, roll: 12 } };
    const r = perspectiveRoundTrip(cam, { x: 700, y: 620, z: 250 }, -33, 18);
    expect(r.movedX).toBeCloseTo(-33, 4);
    expect(r.movedY).toBeCloseTo(18, 4);
  });

  it('an orbited camera no longer maps screen-right to world +X', () => {
    const base = Project3D.defaultCamera(COMP_W, COMP_H);
    const cam: Project3D.Camera3D = { ...base, orientation: { yaw: 90, pitch: 0, roll: 0 } };
    const { right } = Project3D.cameraDragBasis(cam);
    // Yawed 90°, screen-right has swung onto the depth axis — writing this drag
    // into `x` (as the code used to) would move the layer sideways instead.
    expect(Math.abs(right.z)).toBeCloseTo(1, 6);
    expect(Math.abs(right.x)).toBeCloseTo(0, 6);
  });

  it('the basis is orthonormal', () => {
    const base = Project3D.defaultCamera(COMP_W, COMP_H);
    const cam: Project3D.Camera3D = { ...base, orientation: { yaw: -47, pitch: 33, roll: -8 } };
    const { right, down } = Project3D.cameraDragBasis(cam);
    const len = (v: { x: number; y: number; z: number }): number => Math.hypot(v.x, v.y, v.z);
    expect(len(right)).toBeCloseTo(1, 9);
    expect(len(down)).toBeCloseTo(1, 9);
    expect(right.x * down.x + right.y * down.y + right.z * down.z).toBeCloseTo(0, 9);
  });
});
