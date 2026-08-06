/**
 * The grips follow the layer's rotation.
 *
 * The reported bug: rotate a layer and "the blueprint border stays as it is".
 * Measuring it showed something more specific than the report — the hairline
 * outline (`selectionBoxes`, oriented since it was written) DID turn, and the
 * eight resize grips did not, because `handles()` derived them from the world
 * AABB. Turned artwork inside an upright rectangle of grips reads as a border
 * that failed to rotate, because the grips are the louder shape.
 *
 * A test on an UNROTATED layer cannot catch any of this: the oriented box and
 * the AABB are the same rectangle at 0 degrees, which is exactly why it survived
 * the existing suite. Everything here is at an angle.
 */

import { orientedHandles } from '../selection/handles';
import { transformCorners } from '../math/OrientedBox';
import * as Mat from '../math/Mat2D';
import * as R from '../math/Rect';

/** The corners of a `w x h` box centred on the origin, rotated by `deg`. */
function rotatedCorners(w: number, h: number, deg: number) {
  const rect = R.rect(-w / 2, -h / 2, w, h);
  return transformCorners(rect, Mat.rotation((deg * Math.PI) / 180));
}

describe('oriented handles', () => {
  it('places grips on the rotated corners, not on the bounding box', () => {
    const corners = rotatedCorners(200, 100, 45);
    const handles = orientedHandles(corners);
    const at = (id: string) => handles.find((h) => h.id === id)!.position;

    // Every grip sits exactly on its corner of the turned box.
    expect(at('nw')).toEqual(corners[0]);
    expect(at('ne')).toEqual(corners[1]);
    expect(at('se')).toEqual(corners[2]);
    expect(at('sw')).toEqual(corners[3]);

    // And NOT on the AABB, which at 45 degrees is a visibly different shape.
    const aabb = R.bounds(corners.map((c) => R.rect(c.x, c.y, 0, 0)))!;
    const aabbNW = { x: aabb.x, y: aabb.y };
    expect(Math.hypot(at('nw').x - aabbNW.x, at('nw').y - aabbNW.y)).toBeGreaterThan(1);
  });

  it('keeps the grips a rectangle — four equal sides in pairs', () => {
    const handles = orientedHandles(rotatedCorners(200, 100, 30));
    const at = (id: string) => handles.find((h) => h.id === id)!.position;
    const len = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(b.x - a.x, b.y - a.y);

    // Opposite sides stay equal at any angle. A grip placed by min/max would
    // fail this the moment the box is not axis-aligned.
    expect(len(at('nw'), at('ne'))).toBeCloseTo(len(at('sw'), at('se')), 6);
    expect(len(at('nw'), at('sw'))).toBeCloseTo(len(at('ne'), at('se')), 6);
    // And the long side is still the long side — 200 wide, not the ~223 the
    // AABB would report at 30 degrees.
    expect(len(at('nw'), at('ne'))).toBeCloseTo(200, 6);
    expect(len(at('nw'), at('sw'))).toBeCloseTo(100, 6);
  });

  it('puts edge grips at the midpoints of the turned sides', () => {
    const c = rotatedCorners(200, 100, 30);
    const handles = orientedHandles(c);
    const at = (id: string) => handles.find((h) => h.id === id)!.position;

    expect(at('n').x).toBeCloseTo((c[0].x + c[1].x) / 2, 9);
    expect(at('n').y).toBeCloseTo((c[0].y + c[1].y) / 2, 9);
    expect(at('w').x).toBeCloseTo((c[3].x + c[0].x) / 2, 9);
    expect(at('w').y).toBeCloseTo((c[3].y + c[0].y) / 2, 9);
  });

  it('is identical to the AABB handles when the layer is NOT rotated', () => {
    // The no-regression half: unrotated layers must be untouched, which is also
    // why the old code looked correct for so long.
    const c = rotatedCorners(200, 100, 0);
    const handles = orientedHandles(c);
    const at = (id: string) => handles.find((h) => h.id === id)!.position;
    expect(at('nw')).toEqual({ x: -100, y: -50 });
    expect(at('se')).toEqual({ x: 100, y: 50 });
    expect(at('n')).toEqual({ x: 0, y: -50 });
  });
});

/**
 * The other half of the fix: a grip on the turned corner has to DRAG along the
 * layer's axis. Mapping the pointer through the inverse start matrix is what
 * makes that true, so this asserts the mapping rather than the whole tool.
 */
describe('resize works in the layer frame', () => {
  it('a pull along the layer axis changes one dimension, not both', () => {
    const deg = 30;
    const m = Mat.rotation((deg * Math.PI) / 180);
    const inv = Mat.invert(m);
    const local = R.rect(-100, -50, 200, 100);

    // Drag the east edge 40 units along the LAYER's own +x, expressed in world.
    const worldPointer = Mat.apply(m, { x: 140, y: 0 });
    const pointerLocal = Mat.apply(inv, worldPointer);

    expect(pointerLocal.x).toBeCloseTo(140, 6);
    expect(pointerLocal.y).toBeCloseTo(0, 6);

    // In the world AABB the same drag moves BOTH extents, which is the bug the
    // local frame removes: a sideways pull used to resize the other axis too.
    const worldAabb = R.bounds(
      transformCorners(local, m).map((c) => R.rect(c.x, c.y, 0, 0)),
    )!;
    expect(worldAabb.width).toBeGreaterThan(local.width);
    expect(worldAabb.height).toBeGreaterThan(local.height);
  });
});
