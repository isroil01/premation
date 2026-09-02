/**
 * Gradient gizmo geometry — exact numbers, so the overlay's test can stay about
 * wiring.
 *
 * Two things are pinned here that a gizmo gets wrong invisibly:
 *
 *  • the axis AGREES WITH THE RASTERIZER. `makeCanvasGradient` is the only
 *    other place that turns a fill's relative geometry into coordinates, and
 *    the endpoints asserted below are the ones it passes to
 *    `createLinearGradient` / `createRadialGradient`. A gizmo that drifts from
 *    it draws a handle where the gradient is not, and nothing fails.
 *  • drags ROUND-TRIP. Grabbing a handle and releasing it without moving must
 *    leave the paint alone; anything else means a gesture that nudges the value
 *    just by starting.
 */

import {
  addStopAt,
  AXIS_PICK_PX,
  duplicateStop,
  gradientAxisLocal,
  gradientGrips,
  GRIP_OFFSET_PX,
  hitTestGradient,
  moveStopTo,
  offsetAtPoint,
  orderedStops,
  paintFromGripDrag,
  pointAtOffset,
  removeStopById,
  type GradientScreenView,
} from './gradientHandles';
import type { ColorStop, LinearFill, RadialFill } from '@core/paint/fill';

const W = 200;
const H = 100;

const linear = (angle: number): LinearFill => ({
  type: 'linear',
  angle,
  stops: [
    { id: 'a', offset: 0, color: '#000000' },
    { id: 'b', offset: 1, color: '#ffffff' },
  ],
});

const radial = (cx: number, cy: number, radius: number): RadialFill => ({
  type: 'radial',
  cx,
  cy,
  radius,
  stops: [
    { id: 'a', offset: 0, color: '#000000' },
    { id: 'b', offset: 1, color: '#ffffff' },
  ],
});

describe('the axis is the one the rasterizer draws along', () => {
  it('spans the box along the angle, about the centred origin', () => {
    // 0° = →, so `half` is half the WIDTH and the axis is horizontal.
    const flat = gradientAxisLocal(linear(0), W, H);
    expect(flat.start.x).toBeCloseTo(-100);
    expect(flat.start.y).toBeCloseTo(0);
    expect(flat.end.x).toBeCloseTo(100);
    expect(flat.end.y).toBeCloseTo(0);

    // 90° = ↓, so it is half the HEIGHT instead — the extent is derived from
    // the box, which is exactly why an end grip can only steer the angle.
    const down = gradientAxisLocal(linear(90), W, H);
    expect(down.start.x).toBeCloseTo(0);
    expect(down.start.y).toBeCloseTo(-50);
    expect(down.end.y).toBeCloseTo(50);
  });

  it('runs centre → rim for a radial, which is t=0 → t=1', () => {
    const axis = gradientAxisLocal(radial(0.5, 0.5, 0.5), W, H);
    const r = (0.5 * Math.hypot(W, H)) / 2;
    expect(axis.start).toEqual({ x: 0, y: 0 });
    expect(axis.end.x).toBeCloseTo(r);
    expect(axis.end.y).toBeCloseTo(0);
  });

  it('honours the same 0.01 radius floor makeCanvasGradient applies', () => {
    // A zero radius would collapse the axis to a point and make every stop
    // unhittable; the model already floors it, so the gizmo must too.
    const axis = gradientAxisLocal(radial(0.5, 0.5, 0), W, H);
    expect(axis.end.x).toBeCloseTo((0.01 * Math.hypot(W, H)) / 2);
  });

  it('places an off-centre radial where cx/cy say', () => {
    const axis = gradientAxisLocal(radial(0.75, 0.25, 0.5), W, H);
    expect(axis.start).toEqual({ x: 50, y: -25 });
  });
});

describe('offsets along the axis', () => {
  it('pointAtOffset and offsetAtPoint invert each other', () => {
    const axis = gradientAxisLocal(linear(35), W, H);
    for (const t of [0, 0.25, 0.5, 0.9, 1]) {
      expect(offsetAtPoint(axis, pointAtOffset(axis, t))).toBeCloseTo(t);
    }
  });

  it('projects a point off the line onto it', () => {
    const axis = { start: { x: 0, y: 0 }, end: { x: 100, y: 0 } };
    expect(offsetAtPoint(axis, { x: 50, y: 40 })).toBeCloseTo(0.5);
  });

  it('reads past the ends rather than clamping', () => {
    // Unclamped on purpose: the caller clamps a DRAG and rejects an axis CLICK,
    // and it cannot tell those apart from a value that has already been capped.
    const axis = { start: { x: 0, y: 0 }, end: { x: 100, y: 0 } };
    expect(offsetAtPoint(axis, { x: 150, y: 0 })).toBeCloseTo(1.5);
    expect(offsetAtPoint(axis, { x: -20, y: 0 })).toBeCloseTo(-0.2);
  });

  it('answers 0 for a degenerate axis instead of NaN', () => {
    expect(offsetAtPoint({ start: { x: 5, y: 5 }, end: { x: 5, y: 5 } }, { x: 9, y: 9 })).toBe(0);
  });
});

describe('a grip drag round-trips through the paint', () => {
  it('releasing a linear end where it already was leaves the angle alone', () => {
    for (const angle of [0, 35, 90, 180, 270]) {
      const paint = linear(angle);
      const axis = gradientAxisLocal(paint, W, H);
      const back = paintFromGripDrag(paint, 'end', axis.end, W, H);
      expect(back.type).toBe('linear');
      expect((back as LinearFill).angle).toBeCloseTo(angle);
    }
  });

  it('the start grip steers the same angle from the far side', () => {
    const paint = linear(20);
    const axis = gradientAxisLocal(paint, W, H);
    expect((paintFromGripDrag(paint, 'start', axis.start, W, H) as LinearFill).angle).toBeCloseTo(20);
    // Dragging the START to where the END is flips the ramp — 180° away.
    expect((paintFromGripDrag(paint, 'start', axis.end, W, H) as LinearFill).angle).toBeCloseTo(200);
  });

  it('never produces a negative angle', () => {
    // Stored angles feed a `fillAngle` scalar track; a −170 that means 190 is a
    // value the keyframe row would show and interpolate as a different number.
    const back = paintFromGripDrag(linear(0), 'end', { x: 10, y: -10 }, W, H) as LinearFill;
    expect(back.angle).toBeCloseTo(315);
  });

  it('leaves the paint untouched when a linear drag lands on the origin', () => {
    const paint = linear(45);
    expect(paintFromGripDrag(paint, 'end', { x: 0, y: 0 }, W, H)).toBe(paint);
  });

  it('writes a radial centre back as the relative cx/cy the model stores', () => {
    const back = paintFromGripDrag(radial(0.5, 0.5, 0.5), 'start', { x: 20, y: -10 }, W, H) as RadialFill;
    expect(back.cx).toBeCloseTo(0.6);
    expect(back.cy).toBeCloseTo(0.4);
  });

  it('measures a radial radius as a fraction of the half-diagonal', () => {
    const paint = radial(0.5, 0.5, 0.5);
    const axis = gradientAxisLocal(paint, W, H);
    expect((paintFromGripDrag(paint, 'end', axis.end, W, H) as RadialFill).radius).toBeCloseTo(0.5);
    // Direction does not matter — a radius is a distance.
    const half = Math.hypot(W, H) / 2;
    expect((paintFromGripDrag(paint, 'end', { x: 0, y: half }, W, H) as RadialFill).radius).toBeCloseTo(1);
  });

  it('floors a radius drag at the centre rather than writing zero', () => {
    const back = paintFromGripDrag(radial(0.5, 0.5, 0.5), 'end', { x: 0, y: 0 }, W, H) as RadialFill;
    expect(back.radius).toBe(0.01);
  });
});

// ── Screen-space grips and hit testing ───────────────────────────────

const view = (over: Partial<GradientScreenView> = {}): GradientScreenView => ({
  type: 'linear',
  start: { x: 0, y: 0 },
  end: { x: 100, y: 0 },
  stops: [
    { id: 'a', offset: 0, at: { x: 0, y: 0 } },
    { id: 'b', offset: 1, at: { x: 100, y: 0 } },
  ],
  ...over,
});

describe('the geometry grips stand clear of the stops', () => {
  it('a linear gizmo puts them beyond both ends, along the axis', () => {
    const grips = gradientGrips(view());
    expect(grips.start).toEqual({ x: -GRIP_OFFSET_PX, y: 0 });
    expect(grips.end).toEqual({ x: 100 + GRIP_OFFSET_PX, y: 0 });
  });

  it('a radial gizmo steps its centre grip perpendicular', () => {
    // There is no "before the centre" along the axis, so the centre grip goes
    // sideways — otherwise it would sit exactly on the stop at offset 0.
    const grips = gradientGrips(view({ type: 'radial' }));
    expect(grips.start).toEqual({ x: 0, y: GRIP_OFFSET_PX });
    expect(grips.end).toEqual({ x: 100 + GRIP_OFFSET_PX, y: 0 });
  });

  it('keeps the two grips apart when the axis projects to a point', () => {
    const grips = gradientGrips(view({ end: { x: 0, y: 0 }, stops: [] }));
    expect(grips.start).not.toEqual(grips.end);
    expect(Number.isFinite(grips.start.x)).toBe(true);
  });
});

describe('hit testing', () => {
  it('finds each grip at its offset position', () => {
    expect(hitTestGradient(view(), { x: 100 + GRIP_OFFSET_PX, y: 0 })).toEqual({ kind: 'grip', grip: 'end' });
    expect(hitTestGradient(view(), { x: -GRIP_OFFSET_PX, y: 0 })).toEqual({ kind: 'grip', grip: 'start' });
  });

  it('leaves the stops at 0 and 1 grabbable — the point of the offset', () => {
    expect(hitTestGradient(view(), { x: 0, y: 0 })).toEqual({ kind: 'stop', id: 'a', index: 0 });
    expect(hitTestGradient(view(), { x: 100, y: 0 })).toEqual({ kind: 'stop', id: 'b', index: 1 });
  });

  it('picks the NEAREST stop, not the first in range', () => {
    const v = view({
      stops: [
        { id: 'a', offset: 0.5, at: { x: 50, y: 0 } },
        { id: 'b', offset: 0.55, at: { x: 55, y: 0 } },
      ],
    });
    expect(hitTestGradient(v, { x: 54, y: 0 })).toEqual({ kind: 'stop', id: 'b', index: 1 });
  });

  it('reports a click on the line with the offset it landed at', () => {
    expect(hitTestGradient(view(), { x: 30, y: 0 })).toEqual({ kind: 'axis', offset: 0.3 });
    // Within the band, off the line.
    expect(hitTestGradient(view(), { x: 30, y: AXIS_PICK_PX - 1 })).toEqual({
      kind: 'axis',
      offset: 0.3,
    });
  });

  it('misses everything off the gizmo', () => {
    expect(hitTestGradient(view(), { x: 30, y: 40 })).toBeNull();
    // Past the end grip: projects to t = 2, so it is not a click on the line.
    // Without the segment test it would add a stop clamped onto an end it was
    // nowhere near.
    expect(hitTestGradient(view(), { x: 200, y: 0 })).toBeNull();
  });
});

// ── Stop-list edits ──────────────────────────────────────────────────

const stops = (): ColorStop[] => [
  { id: 'a', offset: 0, color: '#000000' },
  { id: 'b', offset: 0.5, color: '#ff0000' },
  { id: 'c', offset: 1, color: '#ffffff' },
];

describe('moving a stop', () => {
  it('clamps to 0..1', () => {
    expect(moveStopTo(stops(), 'b', 1.4)[1]?.offset).toBe(1);
    expect(moveStopTo(stops(), 'b', -0.3)[1]?.offset).toBe(0);
  });

  it('touches nothing else', () => {
    const next = moveStopTo(stops(), 'b', 0.8);
    expect(next.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(next[0]).toEqual(stops()[0]);
    expect(next[1]?.color).toBe('#ff0000');
  });

  it('keeps STORAGE order when a stop crosses a neighbour', () => {
    // The load-bearing property: the animated stop list has no ids of its own,
    // so the inspector synthesises them from the index. Re-sorting here would
    // rename the dragged stop mid-gesture and the drag would jump to whichever
    // stop inherited its id.
    const next = moveStopTo(stops(), 'b', 0.05);
    expect(next.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    // Ordered for RENDERING, which is where order has always been decided.
    expect(orderedStops(next).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(orderedStops(moveStopTo(stops(), 'b', 0)).map((s) => s.offset)).toEqual([0, 0, 1]);
    expect(orderedStops(moveStopTo(stops(), 'a', 0.9)).map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('adding a stop', () => {
  it('takes the colour the ramp already has there, so nothing moves visually', () => {
    const base: ColorStop[] = [
      { id: 'a', offset: 0, color: '#000000' },
      { id: 'b', offset: 1, color: '#ffffff' },
    ];
    const added = addStopAt(base, 0.5);
    expect(added.stops).toHaveLength(3);
    // Hex, not the sampler's `rgba(...)` — a stop that stored the latter would
    // come back out of the ColorPicker as its fallback blue.
    expect(added.stops[2]?.color).toBe('#808080ff');
    expect(added.stops[2]?.offset).toBe(0.5);
    expect(added.stops[2]?.id).toBe(added.id);
  });

  it('clamps the position and leaves the source list alone', () => {
    const base = stops();
    const added = addStopAt(base, 2);
    expect(added.stops[3]?.offset).toBe(1);
    expect(base).toHaveLength(3);
  });
});

describe('duplicating a stop', () => {
  it('copies the colour to a new id at the new position', () => {
    const dup = duplicateStop(stops(), 'b', 0.75);
    expect(dup).not.toBeNull();
    expect(dup?.stops).toHaveLength(4);
    expect(dup?.stops[3]?.color).toBe('#ff0000');
    expect(dup?.stops[3]?.offset).toBe(0.75);
    expect(dup?.stops[3]?.id).not.toBe('b');
  });

  it('is a no-op for a stop that is not there', () => {
    expect(duplicateStop(stops(), 'nope', 0.5)).toBeNull();
  });
});

describe('removing a stop', () => {
  it('holds the two-stop floor', () => {
    const two: ColorStop[] = [
      { id: 'a', offset: 0, color: '#000000' },
      { id: 'b', offset: 1, color: '#ffffff' },
    ];
    // null rather than a shortened list, so the caller can skip the write
    // entirely instead of pushing an undo step for an edit that never happened.
    expect(removeStopById(two, 'a')).toBeNull();
  });

  it('removes above the floor', () => {
    expect(removeStopById(stops(), 'b')?.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('is a no-op for an unknown id', () => {
    expect(removeStopById(stops(), 'nope')).toBeNull();
  });
});
