/**
 * Bounce — the generator behind the Bounce section in the Graph panel.
 *
 * A bounce cannot be an easing preset. A cubic bezier is one curve with at most
 * a single overshoot; a bounce is N overshoots of shrinking amplitude, which no
 * bezier can express. (`BOUNCE_EASE` in animationPresets.ts, commented "Elastic
 * bounce", is really an ease-out-back.) Generating keyframes is the only honest
 * way to do this without reaching for an expression.
 *
 * Three things live here, and they were the three gaps in the first version:
 *
 *  1. **Parameters, not one hardcoded shape.** `BounceOptions` is what every
 *     version of AE's bounce expression exposes, plus `oscillate` — the one
 *     switch that separates a spring (overshoots BOTH ways around the resting
 *     value) from gravity (only ever rebounds back the way it came). Named
 *     starting points over those parameters are `BOUNCE_STYLES`.
 *  2. **From zero.** `bounceInTracks` builds the fall as well as the bounce, so
 *     a static layer can be dropped in from off-screen. Appending to an
 *     existing animation (`bounceTracks`) is the other half, not the only half.
 *  3. **Squash & stretch.** Opt-in, and a different property: it counter-scales
 *     against each impact rather than moving the layer.
 *
 * Everything above the engine actions at the bottom is pure, because what makes
 * a bounce read as gravity rather than as a wobble is arithmetic — amplitude and
 * duration decaying TOGETHER — and that is invisible in a screenshot.
 */

import {
  defaultAnimation,
  EASY_EASE_IN_BEZIER,
  EASY_EASE_OUT_BEZIER,
  type AnimationEngine,
  type Keyframe,
} from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { getEventBus } from '@core/events/EventBus';
import { nodeBaseValue, type PresetTrack } from '@core/animation/animationPresets';

// ── Options ──────────────────────────────────────────────────────────

export interface BounceOptions {
  /** How many rebounds to add after the original landing. */
  bounces: number;
  /** Fraction of the previous overshoot each rebound keeps, 0..1. Scales the
   *  DURATION by the same factor — see `bounceRebounds`. */
  decay: number;
  /** Overshoot of the FIRST rebound as a fraction of the last segment's
   *  travel. ~0.3 lands firmly, ~0.6 reads rubbery. */
  elasticity: number;
  /**
   * Oscillate around the landing value instead of always rebounding against the
   * direction of travel.
   *
   * Off is gravity: a falling layer only ever bounces UP, because the floor is
   * only underneath it. On is a spring: it overshoots, comes back past the
   * resting value, and converges from alternating sides. Same decay maths, and
   * the difference between the two is one sign flip — but they are the two
   * shapes people mean by "bounce" and neither substitutes for the other.
   */
  oscillate?: boolean;
}

/** The default — `drop`, the shape the Animate menu's one-click item applies. */
export const DEFAULT_BOUNCE: BounceOptions = { bounces: 3, decay: 0.5, elasticity: 0.35 };

export type BounceStyleId = 'drop' | 'elastic' | 'rubber' | 'spring';

export interface BounceStyle {
  id: BounceStyleId;
  label: string;
  description: string;
  options: BounceOptions;
}

/**
 * Named starting points. These are not modes — picking one writes its numbers
 * into the same three (four) knobs, which the user then moves. That is why the
 * panel shows a style as SELECTED only while the parameters still match it.
 */
export const BOUNCE_STYLES: readonly BounceStyle[] = [
  {
    id: 'drop',
    label: 'Drop',
    description: 'Falls, lands firmly, settles in three.',
    options: DEFAULT_BOUNCE,
  },
  {
    id: 'elastic',
    label: 'Elastic',
    description: 'One big rebound past the landing, then done.',
    options: { bounces: 1, decay: 0.5, elasticity: 0.7 },
  },
  {
    id: 'rubber',
    label: 'Rubber',
    description: 'Many small, fast rebounds — a ball on a hard floor.',
    options: { bounces: 6, decay: 0.62, elasticity: 0.22 },
  },
  {
    id: 'spring',
    label: 'Spring',
    description: 'Damped oscillation — overshoots both ways before settling.',
    options: { bounces: 4, decay: 0.6, elasticity: 0.45, oscillate: true },
  },
];

/** The style whose numbers these options are, or null once they are edited. */
export function matchBounceStyle(opts: BounceOptions): BounceStyleId | null {
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
  const found = BOUNCE_STYLES.find(
    (s) =>
      s.options.bounces === opts.bounces &&
      near(s.options.decay, opts.decay) &&
      near(s.options.elasticity, opts.elasticity) &&
      !!s.options.oscillate === !!opts.oscillate,
  );
  return found?.id ?? null;
}

// ── The rebound schedule (the tested core) ───────────────────────────

/** One rebound: up to an apex, back down to the landing value. */
export interface Rebound {
  /** Time of the apex. */
  peakT: number;
  /** Value at the apex — past the landing value, by `amp`. */
  peakValue: number;
  /** Time it returns to the landing value. */
  landT: number;
  /** Overshoot magnitude of this rebound (always positive). */
  amp: number;
}

/** Options clamped to the range the maths is defined over. */
function sane(opts: BounceOptions): Required<BounceOptions> {
  return {
    bounces: Math.max(0, Math.floor(opts.bounces)),
    decay: Math.min(0.95, Math.max(0.05, opts.decay)),
    elasticity: Math.max(0, opts.elasticity),
    oscillate: !!opts.oscillate,
  };
}

/**
 * The rebounds that follow a landing — the single source of the geometry.
 *
 * `bounceTracks` turns these into keyframes and `bounceImpacts` reads the
 * landing times off them; deriving both from one function is what keeps the
 * squash aligned with the bounce it is supposed to be reacting to.
 *
 * Amplitude and duration BOTH scale by `decay`, so the bounces get smaller and
 * faster together. Scaling only the amplitude is the classic mistake: it reads
 * as a wobble rather than as gravity.
 */
export function bounceRebounds(
  prev: { t: number; value: number },
  last: { t: number; value: number },
  opts: BounceOptions,
): Rebound[] {
  const { bounces, decay, elasticity, oscillate } = sane(opts);
  if (bounces === 0 || elasticity === 0) return [];

  const travel = last.value - prev.value;
  const segment = last.t - prev.t;
  // A hold at the end has nothing to rebound from, and a zero-length final
  // segment would scale the timing by nothing.
  if (travel === 0 || segment <= 0) return [];

  // The rebound goes back the way it came: land after a fall and you overshoot
  // upward, so the sign is opposite to the travel.
  const dir = -Math.sign(travel);
  const out: Rebound[] = [];
  let amp = Math.abs(travel) * elasticity;
  let dur = segment * decay;
  let t = last.t;

  for (let i = 0; i < bounces; i++) {
    // A spring converges from alternating sides; gravity only ever goes back
    // the way it came, because the floor is only on one side of it.
    const side = oscillate && i % 2 === 1 ? -dir : dir;
    const peakT = t + dur / 2;
    const landT = t + dur;
    out.push({ peakT, landT, amp, peakValue: last.value + side * amp });
    t = landT;
    amp *= decay;
    dur *= decay;
  }
  return out;
}

/**
 * Append a decaying bounce after each track's LAST keyframe.
 *
 * Pure, so the geometry is testable without a scene. A track with fewer than
 * two keyframes comes back untouched — there is no travel to rebound from.
 */
export function bounceTracks(
  tracks: ReadonlyArray<PresetTrack>,
  opts: BounceOptions = DEFAULT_BOUNCE,
): PresetTrack[] {
  return tracks.map((track) => {
    const keys = track.keyframes;
    if (keys.length < 2) return { ...track };
    const last = keys[keys.length - 1]!;
    const prev = keys[keys.length - 2]!;
    const rebounds = bounceRebounds(prev, last, opts);
    if (!rebounds.length) return { ...track };

    const out: Keyframe[] = [...keys];
    for (const r of rebounds) {
      // Decelerating up to the apex, accelerating back down to the landing —
      // the two halves of a throw.
      out.push({ t: r.peakT, value: r.peakValue, easing: 'bezier', bezier: EASY_EASE_OUT_BEZIER });
      out.push({ t: r.landT, value: last.value, easing: 'bezier', bezier: EASY_EASE_IN_BEZIER });
    }
    return { ...track, keyframes: out };
  });
}

// ── Squash & stretch ─────────────────────────────────────────────────

/** A moment the layer strikes the landing value, and how hard. */
export interface Impact {
  t: number;
  /** Relative to the first impact, which is 1. Decays with the rebounds. */
  strength: number;
}

/**
 * When the layer lands, and how hard, for the segment `prev → last` plus its
 * rebounds. The first impact is the original landing (full strength); each
 * rebound's return is weaker by `decay`.
 */
export function bounceImpacts(
  prev: { t: number; value: number },
  last: { t: number; value: number },
  opts: BounceOptions,
): Impact[] {
  const rebounds = bounceRebounds(prev, last, opts);
  const { decay } = sane(opts);
  const impacts: Impact[] = [{ t: last.t, strength: 1 }];
  rebounds.forEach((r, i) => impacts.push({ t: r.landT, strength: decay ** (i + 1) }));
  return impacts;
}

export interface SquashOptions {
  /** Peak squash at the first impact, as a fraction of the layer's scale.
   *  0.22 = 22% flatter along the axis of travel at the hardest landing. */
  amount: number;
  /** Seconds the hardest squash takes to recover. Weaker impacts recover
   *  proportionally faster, for the same reason their rebounds are shorter. */
  duration: number;
}

export const DEFAULT_SQUASH: SquashOptions = { amount: 0.22, duration: 0.16 };

/** Scale keys are written in pairs, so collect them as one event per time. */
interface ScaleEvent {
  t: number;
  sx: number;
  sy: number;
  bezier?: [number, number, number, number];
}

/**
 * Counter-scale against each impact: flatten along the axis of travel, bulge
 * across it, and stretch the other way while airborne.
 *
 * Volume is preserved by construction (one axis up by what the other goes
 * down), which is what stops a squashed layer reading as one that simply got
 * smaller.
 *
 * `startT` gets a keyframe at the layer's own scale, because otherwise the
 * first key would be a stretch and the engine would hold THAT from time zero —
 * the layer would sit deformed before its animation had begun.
 */
export function squashTracks(
  impacts: ReadonlyArray<Impact>,
  axis: 'x' | 'y',
  base: { scaleX: number; scaleY: number },
  startT: number,
  opts: SquashOptions = DEFAULT_SQUASH,
): PresetTrack[] {
  const amount = Math.max(0, Math.min(0.9, opts.amount));
  const duration = Math.max(0.01, opts.duration);
  if (!impacts.length || amount === 0) return [];

  const events: ScaleEvent[] = [];
  /** Times must advance: an overlapping event is one the previous impact has
   *  already spoken for, and two keys at the same time fight each other. */
  const push = (e: ScaleEvent): void => {
    const prev = events[events.length - 1];
    if (prev && e.t <= prev.t + 1e-3) return;
    events.push(e);
  };
  /** Along the axis of travel by `along`, across it by `across`. */
  const scaled = (along: number, across: number): { sx: number; sy: number } =>
    axis === 'y'
      ? { sx: base.scaleX * across, sy: base.scaleY * along }
      : { sx: base.scaleX * along, sy: base.scaleY * across };

  push({ t: startT, ...scaled(1, 1) });

  for (const im of impacts) {
    const a = amount * im.strength;
    const d = duration * im.strength;
    // Airborne: stretched along the direction of travel, at half the impact's
    // amount — the anticipation is always subtler than the hit.
    push({ t: im.t - d, ...scaled(1 + a / 2, 1 - a / 2), bezier: EASY_EASE_IN_BEZIER });
    push({ t: im.t, ...scaled(1 - a, 1 + a), bezier: EASY_EASE_OUT_BEZIER });
    push({ t: im.t + d, ...scaled(1, 1), bezier: EASY_EASE_IN_BEZIER });
  }

  // A lone base keyframe is not a squash — it would pin the layer's scale for
  // no reason and make the property look animated when nothing happens.
  if (events.length < 2) return [];

  const key = (e: ScaleEvent, v: number): Keyframe =>
    e.bezier ? { t: e.t, value: v, easing: 'bezier', bezier: e.bezier } : { t: e.t, value: v };

  return [
    { prop: 'scaleX', keyframes: events.map((e) => key(e, e.sx)) },
    { prop: 'scaleY', keyframes: events.map((e) => key(e, e.sy)) },
  ];
}

// ── From zero: the fall as well as the bounce ────────────────────────

export type DropDirection = 'top' | 'bottom' | 'left' | 'right';

export interface DropInOptions {
  /** How far off its resting position the layer starts, in px. */
  distance: number;
  /** Which side it comes from. */
  direction: DropDirection;
  /** Seconds the approach takes, before the first landing. */
  duration: number;
  /** Fade up over the approach. */
  fade: boolean;
}

export const DEFAULT_DROP_IN: DropInOptions = {
  distance: 320,
  direction: 'top',
  duration: 0.45,
  fade: false,
};

/** The travel axis and the signed offset the layer starts at (y grows down). */
export function dropOffset(drop: DropInOptions): { axis: 'x' | 'y'; from: number } {
  const d = Math.abs(drop.distance);
  switch (drop.direction) {
    case 'top': return { axis: 'y', from: -d };
    case 'bottom': return { axis: 'y', from: d };
    case 'left': return { axis: 'x', from: -d };
    case 'right': return { axis: 'x', from: d };
  }
}

/**
 * Everything a drop-in writes, starting at t = 0 — the caller shifts it to the
 * playhead.
 *
 * The position track is RELATIVE: its values are offsets from wherever the
 * layer already sits, so the same settings drop any layer onto its own spot
 * rather than onto a hardcoded one. The scale tracks are absolute, because
 * squash is a factor of the layer's own scale and there is no `scaleX` default
 * to resolve a relative track against.
 */
export function bounceInTracks(
  drop: DropInOptions,
  bounce: BounceOptions = DEFAULT_BOUNCE,
  squash: SquashOptions | null = null,
  baseScale: { scaleX: number; scaleY: number } = { scaleX: 1, scaleY: 1 },
): PresetTrack[] {
  const { axis, from } = dropOffset(drop);
  const fall = Math.max(0.01, drop.duration);
  // Accelerating into the landing: a fall speeds up, it does not ease into the
  // floor. This is the keyframe that STARTS the segment, so the handles here
  // shape the approach.
  const start: Keyframe = { t: 0, value: from, easing: 'bezier', bezier: EASY_EASE_IN_BEZIER };
  const land: Keyframe = { t: fall, value: 0 };

  const position: PresetTrack = { prop: axis, relative: true, keyframes: [start, land] };
  const [bounced] = bounceTracks([position], bounce);
  const tracks: PresetTrack[] = [bounced ?? position];

  if (drop.fade) {
    // Up well before the landing — a layer still fading in as it hits reads as
    // two effects rather than one arrival.
    tracks.push({
      prop: 'opacity',
      keyframes: [
        { t: 0, value: 0, easing: 'bezier', bezier: EASY_EASE_OUT_BEZIER },
        { t: fall * 0.7, value: 100 },
      ],
    });
  }

  if (squash) {
    tracks.push(...squashTracks(bounceImpacts(start, land, bounce), axis, baseScale, 0, squash));
  }
  return tracks;
}

// ── Engine actions (one undoable command each) ───────────────────────

function currentTracks(nodeId: string, engine: AnimationEngine): PresetTrack[] {
  const out: PresetTrack[] = [];
  for (const prop of engine.animatedProps(nodeId)) {
    const kfs = engine.getTrackKeyframes(nodeId, prop);
    if (kfs && kfs.length) out.push({ prop, keyframes: kfs });
  }
  return out;
}

function writeTracks(nodeId: string, tracks: ReadonlyArray<PresetTrack>, engine: AnimationEngine): void {
  for (const t of tracks) {
    for (const k of t.keyframes) {
      engine.setKeyframe(nodeId, t.prop, k.t, k.value, k.easing);
      if (k.bezier) engine.setBezier(nodeId, t.prop, k.t, k.bezier);
    }
  }
}

/**
 * The layer's own scale, for squash to counter-animate around.
 *
 * `scaleX`/`scaleY` first, then uniform `scale`: a layer that has only ever
 * been scaled uniformly carries no per-axis props, and squashing it around 1
 * would snap it back to full size on the first keyframe.
 */
export function baseScaleOf(
  nodeId: string,
  atTime: number,
  engine: AnimationEngine = defaultAnimation,
): { scaleX: number; scaleY: number } {
  const uniform = nodeBaseValue(nodeId, 'scale', atTime, engine);
  return {
    scaleX: nodeBaseValue(nodeId, 'scaleX', atTime, engine) ?? uniform ?? 1,
    scaleY: nodeBaseValue(nodeId, 'scaleY', atTime, engine) ?? uniform ?? 1,
  };
}

/** The track squash should react to: the layer's travel, preferring vertical. */
function travelTrack(tracks: ReadonlyArray<PresetTrack>): PresetTrack | null {
  return tracks.find((t) => t.prop === 'y') ?? tracks.find((t) => t.prop === 'x') ?? null;
}

/**
 * Add a bounce to the end of the layer's existing animation. False when nothing
 * is animated, or when no track had anything to bounce off — the caller should
 * offer the drop-in instead, which needs no keyframes at all.
 */
export function bounceKeyframes(
  nodeId: string,
  opts: BounceOptions = DEFAULT_BOUNCE,
  squash: SquashOptions | null = null,
  engine: AnimationEngine = defaultAnimation,
): boolean {
  const tracks = currentTracks(nodeId, engine);
  if (!tracks.length) return false;
  const bounced = bounceTracks(tracks, opts);
  // Every track unchanged means every one was a hold or a single key. Reporting
  // success there would push an empty entry onto the undo stack.
  const changed = bounced.some((t, i) => t.keyframes.length !== tracks[i]!.keyframes.length);
  if (!changed) return false;

  const write = [...bounced];
  const travel = travelTrack(tracks);
  if (squash && travel && travel.keyframes.length >= 2) {
    const keys = travel.keyframes;
    const prev = keys[keys.length - 2]!;
    const last = keys[keys.length - 1]!;
    write.push(
      ...squashTracks(
        bounceImpacts(prev, last, opts),
        travel.prop === 'x' ? 'x' : 'y',
        baseScaleOf(nodeId, last.t, engine),
        prev.t,
        squash,
      ),
    );
  }
  runAnimEdit('Bounce keyframes', () => writeTracks(nodeId, write, engine));
  return true;
}

/**
 * Drop the layer in from off-position and bounce it, with no existing
 * keyframes required. This is the half that was missing: the assistant could
 * only add a bounce to motion you had already authored, so "make this drop and
 * bounce" — the thing people actually ask a bounce for — had no answer.
 */
export function bounceInKeyframes(
  nodeId: string,
  atTime: number,
  drop: DropInOptions = DEFAULT_DROP_IN,
  opts: BounceOptions = DEFAULT_BOUNCE,
  squash: SquashOptions | null = null,
  engine: AnimationEngine = defaultAnimation,
): boolean {
  if (drop.distance === 0 || drop.duration <= 0) return false;
  const tracks = bounceInTracks(drop, opts, squash, baseScaleOf(nodeId, atTime, engine));

  // Relative tracks are offsets from where the layer is NOW; resolve them
  // against its current value before shifting the whole thing to the playhead.
  const resolved = tracks.map((t) => {
    const base = t.relative ? nodeBaseValue(nodeId, t.prop, atTime, engine) ?? 0 : 0;
    return {
      ...t,
      relative: false,
      keyframes: t.keyframes.map((k) => ({ ...k, t: k.t + atTime, value: k.value + base })),
    };
  });

  runAnimEdit('Bounce in', () => writeTracks(nodeId, resolved, engine));
  return true;
}

/** What a bounce actually wrote, so the caller can say so. */
export interface BounceResult {
  /** `appended` bounced existing motion; `dropped` generated the fall too. */
  mode: 'appended' | 'dropped';
  /** Keyframes added, across every property touched. */
  added: number;
  /** The properties that gained keyframes, in write order. */
  props: string[];
  /** Comp-time span of the new keyframes. */
  from: number;
  to: number;
}

/** Every keyframe currently on the node, as `prop → times`. */
function keyCensus(nodeId: string, engine: AnimationEngine): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const prop of engine.animatedProps(nodeId)) {
    out.set(prop, new Set((engine.getTrackKeyframes(nodeId, prop) ?? []).map((k) => k.t)));
  }
  return out;
}

export interface BounceRequest {
  /** Playhead — where a generated fall starts. */
  atTime: number;
  /**
   * `auto` appends to existing motion when there is any and generates the fall
   * otherwise; `append` and `drop` force one or the other. A menu item wants
   * auto; the panel's two buttons say which one they are.
   */
  mode?: 'auto' | 'append' | 'drop';
  drop?: DropInOptions;
  bounce?: BounceOptions;
  squash?: SquashOptions | null;
  engine?: AnimationEngine;
}

/**
 * Bounce this layer, and report what that wrote.
 *
 * **This is what every UI surface calls.** `bounceKeyframes` refuses on a layer
 * with nothing to bounce off, which is right for a primitive and wrong for a
 * menu item: the user clicks "Bounce", a toast explains why not, and the honest
 * conclusion they draw is that the feature is broken. In `auto` there is always
 * a sensible bounce — no motion to rebound from means generate the fall too —
 * so the entry point is never a no-op.
 *
 * Returns what was written rather than a bare boolean, because "did anything
 * happen?" is the question the user is actually asking, and the bounce's
 * keyframes land in the SAME Position row as theirs: nothing on screen
 * distinguishes them, so the caller has to say it in words.
 */
export function applyBounce(nodeId: string, req: BounceRequest): BounceResult | null {
  const engine = req.engine ?? defaultAnimation;
  const opts = req.bounce ?? DEFAULT_BOUNCE;
  const squash = req.squash ?? null;
  const mode = req.mode ?? 'auto';

  const before = keyCensus(nodeId, engine);
  const appended = mode !== 'drop' && bounceKeyframes(nodeId, opts, squash, engine);
  if (!appended) {
    if (mode === 'append') return null;
    if (!bounceInKeyframes(nodeId, req.atTime, req.drop ?? DEFAULT_DROP_IN, opts, squash, engine)) return null;
  }

  const after = keyCensus(nodeId, engine);
  const props: string[] = [];
  let added = 0;
  let from = Infinity;
  let to = -Infinity;
  for (const [prop, times] of after) {
    const had = before.get(prop) ?? new Set<number>();
    let fresh = 0;
    for (const t of times) {
      if (had.has(t)) continue;
      fresh++;
      if (t < from) from = t;
      if (t > to) to = t;
    }
    if (fresh > 0) {
      props.push(prop);
      added += fresh;
    }
  }
  // A write that added no NEW keyframe times only re-stated what was there.
  if (added === 0) return null;
  return { mode: appended ? 'appended' : 'dropped', added, props, from, to };
}

// ── Saying what happened ─────────────────────────────────────────────
//
// Both of these exist because a bounce is INVISIBLE as an object: it is not an
// effect in the stack or a track of its own, it is more keyframes on Position —
// in the same row, drawn as the same diamonds, as the ones the user placed by
// hand. So the two surfaces that apply a bounce must both say what was written
// and both put it on screen, and they must do it identically.

/**
 * One line naming what a bounce wrote, for the toast.
 *
 * Rows are named as the TIMELINE labels them, not as the engine stores them: a
 * user told "keyframes on y and scaleX" has to translate that into the Position
 * and Scale rows in front of them, which is the opposite of the job.
 */
export function describeBounce(r: BounceResult): string {
  const span = `${r.from.toFixed(2)}–${r.to.toFixed(2)}s`;
  const rowName = (p: string): string => {
    if (p === 'x' || p === 'y' || p === 'z') return 'Position';
    if (p === 'scale' || p === 'scaleX' || p === 'scaleY') return 'Scale';
    return p;
  };
  const where = r.props.map(rowName).filter((p, i, a) => a.indexOf(p) === i);
  return r.mode === 'dropped'
    ? `Dropped in with a bounce — ${r.added} keyframes on ${where.join(' + ')}, ${span}`
    : `Bounce added — ${r.added} keyframes on ${where.join(' + ')}, ${span}`;
}

/**
 * Expand the layer's timeline rows so the new keyframes are visible.
 *
 * Without this the timeline is unchanged at a glance — layers are collapsed by
 * default and nothing expands when animation appears — so a bounce that worked
 * perfectly is indistinguishable from one that silently did nothing.
 */
export function revealBounce(nodeId: string): void {
  getEventBus().emit('RevealAnimatedProps', { nodeIds: [nodeId], mode: 'animated', force: true });
}
