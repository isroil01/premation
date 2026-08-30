/**
 * Smart Animate — design two boards, get the transition between them.
 *
 * `layerMatch.ts` answers which layer is which. This turns that
 * correspondence into keyframes: matched layers move from where they are to
 * where they end up, layers that only exist in the first board leave, and
 * layers that only exist in the second arrive.
 *
 * ── Only what actually differs ─────────────────────────────────────
 * A layer whose position is identical in both boards gets NO position track.
 * That is not an optimisation, it is the difference between a readable graph
 * editor and a wall of flat lines: writing every property for every layer
 * would bury the three things that actually move under ninety that do not, and
 * the whole promise of this feature is that you can go and tune the result
 * afterwards.
 *
 * ── Fades are not the same as movement ─────────────────────────────
 * Departures and arrivals cross-fade over a FRACTION of the transition rather
 * than all of it. Something leaving should be gone before the layout finishes
 * settling, and something arriving should not be visible while it is still
 * flying into place — otherwise the two boards read as a dissolve with some
 * sliding in it, which is exactly the look Smart Animate exists to replace.
 *
 * Everything in this file is pure: values in, keyframe plans out. The scene
 * graph, the comps and the undo transaction belong to
 * `smartAnimateCommands.ts`.
 */

import { PHYSICS, type Bezier } from './motionCurves';

/**
 * Properties worth tweening, and what counts as "the same" for each.
 *
 * The epsilon matters: floating-point positions that differ in the twelfth
 * decimal are the same position, and a track written for that difference is
 * pure noise in the graph editor. Angles and percentages get coarser
 * thresholds than pixels because a hundredth of a degree is not a rotation.
 */
const TWEENABLE: ReadonlyArray<{ prop: string; epsilon: number }> = [
  { prop: 'x', epsilon: 0.01 },
  { prop: 'y', epsilon: 0.01 },
  { prop: 'anchorX', epsilon: 0.01 },
  { prop: 'anchorY', epsilon: 0.01 },
  { prop: 'width', epsilon: 0.01 },
  { prop: 'height', epsilon: 0.01 },
  { prop: 'scale', epsilon: 0.001 },
  { prop: 'scaleX', epsilon: 0.001 },
  { prop: 'scaleY', epsilon: 0.001 },
  { prop: 'rotation', epsilon: 0.05 },
  { prop: 'opacity', epsilon: 0.5 },
];

/**
 * How much of the transition a departure or an arrival fades over.
 *
 * Must be at or below 0.5, and that is a correctness bound rather than taste:
 * departures fade over the FIRST `FADE_FRACTION` and arrivals over the LAST,
 * so anything above a half makes the two overlap — old and new on screen
 * together, which is a cross-dissolve, which is precisely the look Smart
 * Animate exists to replace. At 0.4 the outgoing layer is gone before the
 * incoming one starts, and the gap between them is covered by the matched
 * layers still moving.
 */
const FADE_FRACTION = 0.4;

export interface TweenKey {
  t: number;
  value: number;
  bezier?: Bezier;
}

export interface TweenTrack {
  prop: string;
  keys: TweenKey[];
}

export interface TweenPlan {
  /** The layer in the FROM board that receives these tracks. */
  nodeId: string;
  tracks: TweenTrack[];
  /** Why this layer is animating — reported so a surprising match is legible. */
  role: 'matched' | 'departing' | 'arriving';
}

export interface TweenOptions {
  /** Composition seconds the transition starts at. */
  startTime: number;
  durationSec: number;
  /** Easing for the movement. Defaults to a soft, decelerating arrival. */
  curve?: Bezier;
}

/**
 * Tracks for one matched layer: every property whose value actually changes.
 *
 * Values absent on either side are skipped rather than treated as zero. A
 * layer with no explicit `scaleY` has not "scaled to 0" — it simply does not
 * carry that property, and animating it to a default would collapse the layer.
 */
export function planMatchedTracks(
  fromValues: Readonly<Record<string, number | undefined>>,
  toValues: Readonly<Record<string, number | undefined>>,
  opts: TweenOptions,
): TweenTrack[] {
  const curve = opts.curve ?? PHYSICS.softOut;
  const end = opts.startTime + opts.durationSec;
  const tracks: TweenTrack[] = [];

  for (const { prop, epsilon } of TWEENABLE) {
    const from = fromValues[prop];
    const to = toValues[prop];
    if (from === undefined || to === undefined) continue;
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (Math.abs(to - from) <= epsilon) continue;
    tracks.push({
      prop,
      keys: [
        { t: opts.startTime, value: from, bezier: curve },
        { t: end, value: to },
      ],
    });
  }
  return tracks;
}

/**
 * A layer that exists only in the first board: hold, then fade out.
 *
 * The hold is the point. Fading from the first frame makes a departure look
 * like the board was already dissolving; letting it sit at full opacity while
 * everything else starts moving reads as the layout rearranging around it, and
 * then it goes.
 */
export function planDepartureTracks(
  fromOpacity: number | undefined,
  opts: TweenOptions,
): TweenTrack[] {
  const start = fromOpacity ?? 100;
  if (start <= 0) return [];
  const fadeEnd = opts.startTime + opts.durationSec * FADE_FRACTION;
  return [{
    prop: 'opacity',
    keys: [
      { t: opts.startTime, value: start, bezier: PHYSICS.smooth },
      { t: fadeEnd, value: 0 },
    ],
  }];
}

/**
 * A layer that exists only in the second board: invisible, then fade in LATE.
 *
 * Late on purpose — an arrival that appears immediately competes with the
 * movement for attention, and the eye cannot follow both. Waiting until the
 * layout has mostly settled is what makes the new element read as arriving
 * rather than as having been there all along.
 */
export function planArrivalTracks(
  toOpacity: number | undefined,
  opts: TweenOptions,
): TweenTrack[] {
  const target = toOpacity ?? 100;
  if (target <= 0) return [];
  const fadeStart = opts.startTime + opts.durationSec * (1 - FADE_FRACTION);
  return [{
    prop: 'opacity',
    keys: [
      { t: fadeStart, value: 0, bezier: PHYSICS.smooth },
      { t: opts.startTime + opts.durationSec, value: target },
    ],
  }];
}

/** Every property this module will ever write, for callers that must read
 *  them all off a layer before planning. */
export const TWEENABLE_PROPS: readonly string[] = TWEENABLE.map((t) => t.prop);
