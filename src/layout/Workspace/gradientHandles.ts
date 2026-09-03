/**
 * Gradient gizmo geometry — the pure half of the on-canvas gradient editor.
 *
 * ## Why a separate file
 *
 * The same split `focusPlane.ts` / `FocusPlaneOverlay.tsx` and
 * `core/effects/effectHandles.ts` / `EffectHandleOverlay.tsx` already make:
 * everything with an exact answer lives here and is unit-tested; the overlay is
 * pointer plumbing and SVG, which cannot be. A gradient gizmo is almost all
 * arithmetic — an axis, a projection onto it, four kinds of hit test — so
 * almost all of it belongs on this side of the line.
 *
 * ## The model this maps to, exactly
 *
 * `core/paint/fill.ts` stores gradient geometry RELATIVE to the layer box, and
 * `makeCanvasGradient` is the only place that turns it into coordinates. Every
 * formula below is that function's, re-derived rather than re-invented, because
 * a gizmo that disagrees with the rasterizer draws the axis somewhere the
 * gradient is not:
 *
 *  • **linear** — direction `(cos θ, sin θ)` with θ in degrees (0 = →, 90 = ↓);
 *    the endpoints span the box: `half = (|dx|·w + |dy|·h) / 2`, so the axis
 *    runs `−dir·half → +dir·half` about the layer's centred origin. The extent
 *    is DERIVED, which is why dragging an end handle changes the angle only.
 *  • **radial** — centre `((cx−0.5)·w, (cy−0.5)·h)`, radius
 *    `max(0.01, r)·hypot(w, h) / 2`. The axis is centre → centre + (radius, 0):
 *    t = 0 at the centre and t = 1 at the rim, which is what
 *    `createRadialGradient(c, 0, c, r)` means.
 *
 * Both live in LAYER-LOCAL px about the centred origin — the space
 * `layerScreenMapping` maps to and from — so one axis type serves both.
 *
 * ## Screen px for the grips, and why they are offset
 *
 * Hit testing is in screen px at a constant radius, the way every other handle
 * in this app is: sizing a grab in layer units makes it unhittable zoomed out
 * and enormous zoomed in.
 *
 * The two GEOMETRY grips are pushed clear of the axis rather than sitting on
 * its ends, and that is a correctness decision, not decoration. A colour stop
 * at offset 0 sits exactly on the axis start and one at offset 1 exactly on the
 * end — the overwhelmingly common case, since every gradient starts life with
 * those two. Grips drawn there would occupy the same pixels as the stops, and
 * whichever the hit test preferred, the other would be ungrabbable. So:
 *
 *  • linear — the grips sit `GRIP_OFFSET_PX` BEYOND each end, along the axis,
 *    reading as the caps of the line they extend;
 *  • radial — the radius grip does the same past the rim, and the CENTRE grip
 *    steps PERPENDICULAR (there is no "before the centre" direction to use).
 *
 * With that, the four target classes are disjoint and the order they are tested
 * in is a tie-break that should never be needed rather than the thing that
 * makes the gizmo usable.
 */

import { clamp01 } from '@utils/lang';
import {
  makeStop,
  sampleGradientHex,
  sortedStops,
  type ColorStop,
  type LinearFill,
  type RadialFill,
} from '@core/paint/fill';

export interface Pt {
  x: number;
  y: number;
}

/** The two paints that have a gradient axis at all. */
export type GradientPaint = LinearFill | RadialFill;

/**
 * The gradient's axis in layer-local px (centred origin).
 *
 * `start` is offset 0 and `end` is offset 1 for BOTH types, so a colour stop's
 * position is one lerp regardless of which kind of gradient it belongs to.
 */
export interface GradientAxis {
  start: Pt;
  end: Pt;
}

/** Screen px a geometry grip stands off the end of the axis. */
export const GRIP_OFFSET_PX = 15;
/** Screen-px grab radius for the two geometry grips. */
export const GRIP_PICK_PX = 10;
/** Screen-px grab radius for a colour stop. */
export const STOP_PICK_PX = 9;
/** Screen-px distance from the axis line that counts as a click ON it. */
export const AXIS_PICK_PX = 6;

// ── Layer-local geometry ─────────────────────────────────────────────

const DEG = Math.PI / 180;

/** The gradient's axis, in layer-local px, over a `w`×`h` layer box. */
export function gradientAxisLocal(paint: GradientPaint, w: number, h: number): GradientAxis {
  if (paint.type === 'linear') {
    const a = paint.angle * DEG;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    // makeCanvasGradient's `half` — the box's extent along the direction.
    const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
    return {
      start: { x: -dx * half, y: -dy * half },
      end: { x: dx * half, y: dy * half },
    };
  }
  const cx = (paint.cx - 0.5) * w;
  const cy = (paint.cy - 0.5) * h;
  const r = (Math.max(0.01, paint.radius) * Math.hypot(w, h)) / 2;
  return { start: { x: cx, y: cy }, end: { x: cx + r, y: cy } };
}

/** Linear interpolation along an axis — the point a stop at `t` sits at. */
export function pointAtOffset(axis: GradientAxis, t: number): Pt {
  return {
    x: axis.start.x + (axis.end.x - axis.start.x) * t,
    y: axis.start.y + (axis.end.y - axis.start.y) * t,
  };
}

/**
 * `pointAtOffset`'s inverse: where `p` falls along the axis, as a 0..1 offset.
 *
 * UNCLAMPED on purpose — a drag that runs past the end should read as "past the
 * end" so the caller can clamp deliberately (and, for the axis-click case,
 * reject a click that projects outside the segment). Returns 0 for a degenerate
 * axis rather than NaN.
 */
export function offsetAtPoint(axis: GradientAxis, p: Pt): number {
  const dx = axis.end.x - axis.start.x;
  const dy = axis.end.y - axis.start.y;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 0) return 0;
  return ((p.x - axis.start.x) * dx + (p.y - axis.start.y) * dy) / len2;
}

/** Degrees folded into [0, 360). */
function normalizeDeg(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Which end of the axis a geometry drag moved. */
export type GradientGripKind = 'start' | 'end';

/**
 * The paint a geometry drag produces — the inverse of `gradientAxisLocal`.
 *
 * What each grip means follows from the model rather than from a choice:
 *
 *  • linear — the axis is centred and its length is derived from the box, so
 *    neither end can be placed freely. Both grips therefore steer the ANGLE,
 *    the far one directly and the near one about the centre.
 *  • radial start — the centre, written back as the relative `cx`/`cy` the
 *    model stores (and left unclamped, matching the numeric fields, which take
 *    a centre outside the box as a legitimate off-frame origin).
 *  • radial end — the radius, as a fraction of the box's half-diagonal, floored
 *    at the same 0.01 `makeCanvasGradient` floors it at so the gizmo cannot
 *    write a value the rasterizer would silently correct.
 *
 * A degenerate drag (onto the exact centre for a linear angle, a zero-sized
 * box) returns the paint unchanged instead of NaN.
 */
export function paintFromGripDrag(
  paint: GradientPaint,
  grip: GradientGripKind,
  local: Pt,
  w: number,
  h: number,
): GradientPaint {
  if (paint.type === 'linear') {
    const v = grip === 'end' ? local : { x: -local.x, y: -local.y };
    if (v.x === 0 && v.y === 0) return paint;
    return { ...paint, angle: normalizeDeg(Math.atan2(v.y, v.x) / DEG) };
  }
  if (grip === 'start') {
    if (w <= 0 || h <= 0) return paint;
    return { ...paint, cx: local.x / w + 0.5, cy: local.y / h + 0.5 };
  }
  const half = Math.hypot(w, h) / 2;
  if (half <= 0) return paint;
  const cx = (paint.cx - 0.5) * w;
  const cy = (paint.cy - 0.5) * h;
  return { ...paint, radius: Math.max(0.01, Math.hypot(local.x - cx, local.y - cy) / half) };
}

// ── Screen-space grips and hit testing ───────────────────────────────

/** One colour stop as the overlay has already projected it. */
export interface StopScreenPoint {
  id: string;
  offset: number;
  at: Pt;
}

/**
 * Everything the hit test needs, in screen px.
 *
 * The stop points are passed in already projected rather than lerped from the
 * axis ends here: for a 3D layer the layer→screen map is a perspective one, and
 * lerping in screen space would put the diamonds off the line the renderer
 * draws the ramp along.
 */
export interface GradientScreenView {
  type: GradientPaint['type'];
  start: Pt;
  end: Pt;
  stops: ReadonlyArray<StopScreenPoint>;
}

function unitAlong(view: GradientScreenView): Pt {
  const dx = view.end.x - view.start.x;
  const dy = view.end.y - view.start.y;
  const len = Math.hypot(dx, dy);
  // A gradient can legitimately project to a point (a layer edge-on, a radius
  // of zero). Pointing the grips along +x keeps them separable instead of NaN.
  if (len <= 1e-6) return { x: 1, y: 0 };
  return { x: dx / len, y: dy / len };
}

/** Where the two geometry grips are drawn and hit — see the header note. */
export function gradientGrips(view: GradientScreenView): { start: Pt; end: Pt } {
  const u = unitAlong(view);
  const end = { x: view.end.x + u.x * GRIP_OFFSET_PX, y: view.end.y + u.y * GRIP_OFFSET_PX };
  const start =
    view.type === 'radial'
      ? // Perpendicular: there is no "before the centre" along the axis.
        { x: view.start.x - u.y * GRIP_OFFSET_PX, y: view.start.y + u.x * GRIP_OFFSET_PX }
      : { x: view.start.x - u.x * GRIP_OFFSET_PX, y: view.start.y - u.y * GRIP_OFFSET_PX };
  return { start, end };
}

export type GradientHit =
  | { kind: 'grip'; grip: GradientGripKind }
  | { kind: 'stop'; id: string; index: number }
  | { kind: 'axis'; offset: number };

/**
 * What is under `p`, or null for empty canvas.
 *
 * Grips first, then stops, then the line. The classes are disjoint by
 * construction (see the header), so the order only decides ties that the
 * offset is there to prevent — it is a safety net, not the mechanism.
 *
 * The axis test only fires for a point that projects INSIDE the segment: a
 * click a mile past the end is nearer the line's infinite extension than 6px,
 * and adding a stop there would clamp it onto an end it was nowhere near.
 */
export function hitTestGradient(view: GradientScreenView, p: Pt): GradientHit | null {
  const grips = gradientGrips(view);
  if (Math.hypot(grips.end.x - p.x, grips.end.y - p.y) <= GRIP_PICK_PX) {
    return { kind: 'grip', grip: 'end' };
  }
  if (Math.hypot(grips.start.x - p.x, grips.start.y - p.y) <= GRIP_PICK_PX) {
    return { kind: 'grip', grip: 'start' };
  }

  // Nearest stop wins, not the first within range: two stops close together
  // would otherwise hand every click to whichever the list happened to hold
  // first, which is not the one under the pointer.
  let bestIndex = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < view.stops.length; i++) {
    const s = view.stops[i];
    if (!s) continue;
    const d = Math.hypot(s.at.x - p.x, s.at.y - p.y);
    if (d <= STOP_PICK_PX && d < bestDist) {
      bestDist = d;
      bestIndex = i;
    }
  }
  const bestStop = bestIndex >= 0 ? view.stops[bestIndex] : undefined;
  if (bestStop) return { kind: 'stop', id: bestStop.id, index: bestIndex };

  const t = offsetAtPoint({ start: view.start, end: view.end }, p);
  if (t >= 0 && t <= 1) {
    const on = pointAtOffset({ start: view.start, end: view.end }, t);
    if (Math.hypot(on.x - p.x, on.y - p.y) <= AXIS_PICK_PX) return { kind: 'axis', offset: t };
  }
  return null;
}

// ── Stop-list edits ──────────────────────────────────────────────────

/**
 * Move one stop to `t`, clamped to 0..1.
 *
 * ARRAY ORDER IS PRESERVED, and that is deliberate. Sorting on every write
 * looks tidier and breaks the drag: the animated stop list is read back from
 * the `fill.stops` data track, where a stop has no id of its own and the
 * inspector synthesises one from its INDEX. Re-sorting mid-drag would hand the
 * dragged stop a new id the moment it crossed a neighbour, and the gesture
 * would silently jump to whichever stop inherited the old one. Renderers sort
 * on read anyway — `sampleGradientColor` and `makeCanvasGradient` both do — so
 * the stored order has never been what "ordered" means here.
 */
export function moveStopTo(
  stops: ReadonlyArray<ColorStop>,
  id: string,
  t: number,
): ColorStop[] {
  return stops.map((s) => (s.id === id ? { ...s, offset: clamp01(t) } : s));
}

/** The stops in the order they RENDER in — what the gizmo draws and samples. */
export function orderedStops(stops: ReadonlyArray<ColorStop>): ColorStop[] {
  return sortedStops(stops);
}

/**
 * Add a stop at `t` carrying the colour the ramp already has there.
 *
 * Interpolated rather than a default grey because the point of clicking the
 * axis is to gain a control point, not to change the picture: the gradient must
 * look identical the instant the stop appears, and only change when it is
 * dragged. Appended, not inserted, for the order reason `moveStopTo` documents.
 */
export function addStopAt(
  stops: ReadonlyArray<ColorStop>,
  t: number,
): { stops: ColorStop[]; id: string } {
  const stop = makeStop(clamp01(t), sampleGradientHex(stops, clamp01(t)));
  return { stops: [...stops, stop], id: stop.id };
}

/**
 * A copy of `id` at `t` — Alt-drag's first half.
 *
 * The duplicate keeps the source's colour (that is what "duplicate" means) and
 * takes the new position, so the caller can hand the fresh id straight to the
 * drag it started.
 */
export function duplicateStop(
  stops: ReadonlyArray<ColorStop>,
  id: string,
  t: number,
): { stops: ColorStop[]; id: string } | null {
  const src = stops.find((s) => s.id === id);
  if (!src) return null;
  const stop = makeStop(clamp01(t), src.color);
  return { stops: [...stops, stop], id: stop.id };
}

/**
 * Remove a stop, or null when it must not be removed.
 *
 * Two is the floor the inspector's own remove button enforces: one stop is not
 * a gradient, and zero renders as nothing at all. Returning null rather than a
 * shortened list lets the caller skip the write entirely instead of recording
 * an undo step for an edit that did not happen.
 */
export function removeStopById(
  stops: ReadonlyArray<ColorStop>,
  id: string,
): ColorStop[] | null {
  if (stops.length <= 2) return null;
  const next = stops.filter((s) => s.id !== id);
  return next.length === stops.length ? null : next;
}
