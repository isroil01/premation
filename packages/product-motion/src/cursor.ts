/**
 * Cursor and gesture choreography.
 *
 * Almost always faked badly, and the failures are specific enough to enumerate:
 *
 *  • **Straight lines.** A real pointer travels on a slight arc. A dead-straight
 *    path is the single clearest sign the cursor is a keyframed rectangle.
 *  • **Constant velocity.** Real pointing accelerates away and decelerates into
 *    the target — Fitts's law made visible.
 *  • **No anticipation.** A long move starts with a small pull-back.
 *  • **Click on arrival.** Human beings arrive, *pause*, then click. Firing the
 *    click on the same frame as the arrival is the tell that gives away every
 *    synthetic demo. ~120ms of dwell is what reads as deliberate.
 *
 * Pure — emits `ToolCall[]`.
 */

import { mk, type ToolCall } from '@motion/design-system';
import { UI_LIMITS } from './choreography';

export interface Point {
  x: number;
  y: number;
}

export interface CursorPathOptions {
  nodeId: string;
  from: Point;
  to: Point;
  atMs: number;
  /** Arc height as a fraction of the travel distance. 0.12–0.2 reads natural. */
  arc?: number;
  /** Pull back slightly before a long move. */
  anticipate?: boolean;
  durationMs?: number;
  /** Emit a click at the end, after a dwell. */
  clickAtEnd?: boolean;
}

export interface CursorPathResult {
  calls: ToolCall[];
  /** When the cursor reaches the target. */
  arrivesAtMs: number;
  /** When the click fires — always after a dwell. */
  clicksAtMs: number;
}

/**
 * Duration for a pointer move, from Fitts's law.
 *
 * `a + b·log2(distance/width + 1)`. Not a linear function of distance: doubling
 * the distance does not double the time, and animating it as though it does is
 * why synthetic cursors feel wrong on both short and long moves.
 */
export function pointerDuration(distancePx: number, targetWidthPx = 80): number {
  const index = Math.log2(distancePx / Math.max(8, targetWidthPx) + 1);
  return Math.round(140 + 105 * index);
}

/**
 * A pointer move: arc, anticipation, deceleration into the target, then a dwell
 * before any click.
 *
 * The arc is emitted as an offset midpoint on the perpendicular — three
 * keyframes, not two, because a two-keyframe move between two points is a
 * straight line by construction whatever easing it carries.
 */
export function cursorPath(o: CursorPathOptions): CursorPathResult {
  const dx = o.to.x - o.from.x;
  const dy = o.to.y - o.from.y;
  const distance = Math.hypot(dx, dy);
  const dur = o.durationMs ?? pointerDuration(distance);
  const arc = o.arc ?? 0.15;

  // Perpendicular offset at the midpoint — this is the arc. Which way it bows is
  // derived from the direction rather than chosen, so a sequence of moves bows
  // consistently instead of wandering.
  const perpX = distance > 0 ? -dy / distance : 0;
  const perpY = distance > 0 ? dx / distance : 0;
  const bow = distance * arc * 0.5;
  const midX = (o.from.x + o.to.x) / 2 + perpX * bow;
  const midY = (o.from.y + o.to.y) / 2 + perpY * bow;

  const calls: ToolCall[] = [];
  const start = o.atMs;
  // Anticipation on long moves only. On a short hop it reads as a twitch.
  const anticipate = (o.anticipate ?? distance > 200) ? Math.min(60, dur * 0.12) : 0;
  const pullBack = anticipate > 0 ? 0.04 : 0;

  const key = (t: number, x: number, y: number, ease: [number, number, number, number]) => ({ t, x, y, ease });
  const keys = [
    ...(anticipate > 0
      ? [
          key(start, o.from.x, o.from.y, [0.4, 0, 0.7, 1] as [number, number, number, number]),
          key(start + anticipate, o.from.x - dx * pullBack, o.from.y - dy * pullBack, [0, 0.7, 0.2, 1] as [number, number, number, number]),
        ]
      : [key(start, o.from.x, o.from.y, [0, 0.7, 0.2, 1] as [number, number, number, number])]),
    // Midpoint carries the arc AND the velocity peak.
    key(start + anticipate + dur * 0.5, midX, midY, [0.3, 0, 0.15, 1] as [number, number, number, number]),
    // Decelerating into the target — never constant velocity.
    key(start + anticipate + dur, o.to.x, o.to.y, [0.16, 1, 0.3, 1] as [number, number, number, number]),
  ];

  for (const axis of ['x', 'y'] as const) {
    calls.push(
      mk('set_keyframes', {
        keyframes: keys.map((k) => ({
          nodeId: o.nodeId,
          prop: axis,
          t: Number(((k.t) / 1000).toFixed(4)),
          value: axis === 'x' ? k.x : k.y,
          easing: 'bezier',
          bezier: k.ease,
        })),
      }),
    );
  }

  const arrivesAtMs = start + anticipate + dur;
  // The dwell. A click on the arrival frame is the tell.
  const clicksAtMs = arrivesAtMs + UI_LIMITS.minCursorDwellMs;

  if (o.clickAtEnd) {
    // The cursor itself compresses on the click, together with the target's press
    // state — those two ARE simultaneous, which is correct: they are one event.
    calls.push(
      mk('set_spring', {
        nodeId: o.nodeId, prop: 'scale', from: 1, to: 0.9,
        startSec: clicksAtMs / 1000, preset: 'stiff', maxDurationSec: 0.09,
      }),
      mk('set_spring', {
        nodeId: o.nodeId, prop: 'scale', from: 0.9, to: 1,
        startSec: (clicksAtMs + 90) / 1000, preset: 'snappy',
      }),
    );
  }

  return { calls, arrivesAtMs, clicksAtMs };
}

/**
 * A press ripple at a point — the expanding radial acknowledgement.
 *
 * Decelerating and fading as it grows, because a ripple that expands at constant
 * speed reads as a loading indicator rather than as a response to a touch.
 */
export function clickIndicator(nodeId: string, atMs: number, sizePx = 64): ToolCall[] {
  const t = atMs / 1000;
  return [
    mk('set_keyframes', {
      keyframes: [
        { nodeId, prop: 'scale', t, value: 0.1, easing: 'bezier', bezier: [0, 0.7, 0.2, 1] },
        { nodeId, prop: 'scale', t: t + 0.4, value: 1, easing: 'bezier', bezier: [0.16, 1, 0.3, 1] },
        { nodeId, prop: 'opacity', t, value: 55, easing: 'bezier', bezier: [0.3, 0, 0.6, 1] },
        // Fades faster than it grows — the ring is gone before it reaches full
        // size, which is what makes it a pulse rather than a circle.
        { nodeId, prop: 'opacity', t: t + 0.28, value: 0, easing: 'bezier', bezier: [0.4, 0, 0.9, 0] },
      ],
    }),
    mk('update_layer', { nodeId, width: sizePx, height: sizePx, cornerRadius: sizePx / 2 }),
  ];
}

/**
 * Momentum scroll with a rubber-band overshoot at the bounds.
 *
 * The overshoot-and-return at the end of a fling is what distinguishes a scroll
 * from a translate. Without it the content simply stops, which no touch surface
 * has done since 2007.
 */
export function momentumScroll(
  nodeId: string,
  o: { from: number; to: number; atMs: number; atBound?: boolean },
): ToolCall[] {
  const t = o.atMs / 1000;
  if (!o.atBound) {
    return [mk('set_spring', { nodeId, prop: 'y', from: o.from, to: o.to, startSec: t, preset: 'molasses' })];
  }
  const overshoot = (o.to - o.from) * 0.06;
  return [
    // Past the bound, then back. `bouncy` is correct here and almost nowhere else
    // in product motion — a rubber band IS a spring, and the user is expecting it.
    mk('set_spring', { nodeId, prop: 'y', from: o.from, to: o.to + overshoot, startSec: t, preset: 'molasses' }),
    mk('set_spring', { nodeId, prop: 'y', from: o.to + overshoot, to: o.to, startSec: t + 0.28, preset: 'bouncy' }),
  ];
}
