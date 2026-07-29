/**
 * Techniques, fourth set — the ones that close the M2 target.
 *
 * Written against the five rules the earlier sets established the hard way, each
 * of which cost a linter failure to learn:
 *
 *  1. One timeline per node+property.
 *  2. Every key on a channel from one origin.
 *  3. Only the roles the technique can actually orchestrate.
 *  4. Read the seed AND the pack.
 *  5. Claim only the markers the output exhibits.
 *
 * Most of these are built from `shared`, a parameterised emitter, because at
 * this size hand-writing each one invites the same five mistakes twenty-three
 * more times. What varies between them is the MECHANISM — which channel leads,
 * which direction, what the settle looks like — not the prose around it.
 */

import { mulberry32, pick, type ToolCall } from '@motion/design-system';
import type { AnimatableRole, TechniqueCategory, TechniqueDef } from '../schema';
import {
  CURVES, blurIfFast, fadeIn, fadeOut, followThrough, heroMove,
  offsetFor, rolesTargets, staggerAt, subFrame, track, travel,
} from '../emit';

interface Shape {
  /** The channel that carries the move. */
  axis: 'x' | 'y' | 'scale' | 'rotation' | 'rotationX' | 'rotationY' | 'z';
  /** Start value, as a fraction of the frame (position) or an absolute (others). */
  from: number;
  /** Fraction of travel spent pulling the other way first. */
  anticipation: number;
  /** Fraction of travel spent past the target. */
  overshoot: number;
  /** Secondary channel that keeps moving after the primary settles. */
  followProp?: 'scale' | 'rotation';
  /** Exits accelerate away and never return. */
  exit?: boolean;
}

/**
 * The emitter every technique in this file shares.
 *
 * It exists to make rules 1–5 structural rather than remembered: one timeline
 * per channel, every key from `at`, targets from the declared roles only, and
 * both the seed and the pack read before anything is emitted.
 */
function emitShape(
  ctx: Parameters<TechniqueDef['emit']>[0],
  roles: readonly AnimatableRole[],
  seed: number,
  shape: Shape,
  o: { spanMs: number; perMs: number },
): ToolCall[] {
  const rng = mulberry32(seed);
  const calls: ToolCall[] = [];
  const ids = rolesTargets(ctx, roles);
  if (!ids.length) return calls;

  const sig = ctx.pack.pack.motionSignature;
  const positional = shape.axis === 'x' || shape.axis === 'y' || shape.axis === 'z';
  // EVERY shape reads the seed, not just the positional ones.
  //
  // The variation was applied inside the `positional` branch only, so the
  // thirteen scale- and rotation-driven techniques emitted byte-identical calls
  // for all four of their declared variants. A variant count that changes
  // nothing is a number in a definition, and the determinism test said so.
  const jitter = pick(rng, [0.82, 0.94, 1, 1.12]);
  // Direction flips for anything symmetric about its rest value — a rotation
  // that always arrives clockwise is as much a signature as a slide that always
  // comes from the left. Scale is NOT symmetric: 0.7 and 1.3 are different
  // techniques, so its sign stays as authored.
  const flippable = positional || shape.axis.startsWith('rotation');
  const dir = flippable && rng() > 0.5 ? -1 : 1;
  const magnitude = positional
    ? travel(ctx, Math.abs(shape.from)) * Math.sign(shape.from) * jitter
    : shape.axis === 'scale'
      // Keep the excursion on the authored side of 1 while still varying it.
      ? 1 + (shape.from - 1) * jitter
      : shape.from * jitter;
  const from = flippable ? magnitude * dir : magnitude;
  const spanMs = Math.min(o.spanMs, ctx.durationMs * 0.55);
  const perMs = Math.max(200, Math.min(o.perMs, ctx.durationMs - spanMs));

  ids.forEach((id, i) => {
    const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
    const to = positional || shape.axis === 'rotation' || shape.axis.startsWith('rotationX') || shape.axis.startsWith('rotationY') ? 0 : 1;

    if (shape.exit) {
      // No overshoot on an exit: something leaving does not come back, and the
      // timing linter exempts exits for exactly that reason.
      calls.push(
        track(id, shape.axis, [
          { t: offsetFor(ctx, shape.axis, at), value: to, bezier: CURVES.anticipate },
          { t: offsetFor(ctx, shape.axis, at) + ctx.frameMs * 2, value: -from * shape.anticipation, bezier: CURVES.snap },
          { t: subFrame(at + perMs, ctx.frameMs, 0.5), value: from, bezier: CURVES.exit },
        ]),
      );
      calls.push(fadeOut(ctx, id, at + perMs * 0.55, perMs * 0.45));
    } else {
      calls.push(
        heroMove(ctx, id, shape.axis, {
          from,
          to,
          startMs: offsetFor(ctx, shape.axis, at),
          durationMs: perMs,
          // The pack decides how much wind-up and excursion — without this the
          // emitter would produce byte-identical calls in every LookPack.
          anticipation: shape.anticipation * (0.7 + sig.overshootBias * 0.6),
          overshoot: shape.overshoot,
        }),
      );
      calls.push(fadeIn(ctx, id, at, perMs * 0.7));
    }

    if (shape.followProp) {
      calls.push(
        followThrough(ctx, id, shape.followProp, {
          restValue: shape.followProp === 'scale' ? 1 : 0,
          amount: shape.followProp === 'scale' ? 0.012 : 0.7 * (i % 2 === 0 ? 1 : -1),
          settleMs: at + perMs,
          durationMs: perMs * 0.45,
        }),
      );
    }
    if (positional) calls.push(...blurIfFast(ctx, id, Math.abs(from), perMs));
  });

  return calls;
}

/**
 * Markers `emitShape` genuinely produces — derived, never asserted.
 *
 * Two of these conditions are the marker test's findings rather than my
 * intentions:
 *
 *  • **`nonuniform_stagger` needs three targets.** A technique whose roles can
 *    only ever resolve to one or two layers has nothing to stagger, and claiming
 *    it made the marker meaningless for the techniques that do stagger.
 *  • **`follow_through` needs a channel the main move does not use.** A
 *    follow-through emitted onto the move's own channel MERGES into it (rule 1),
 *    so nothing in the output says "this began after the primary settled" —
 *    which is the entire distinction between follow-through and overshoot.
 */
function markersFor(shape: Shape, roles: readonly AnimatableRole[]): TechniqueDef['markers'] {
  const m: string[] = ['explicit_bezier', 'cross_property_offset'];
  if (shape.exit) m.push('anticipation', 'subframe_care');
  else m.push('overshoot', 'anticipation');
  // Roles a full layout fills with several layers. Anything else tops out at one
  // or two, and two entry times cannot be non-uniform.
  const MULTI: readonly AnimatableRole[] = ['headline', 'stat', 'list', 'quote'];
  if (roles.filter((r) => MULTI.includes(r)).length >= 1 && roles.length >= 2) {
    m.push('nonuniform_stagger');
  }
  if (shape.followProp && shape.followProp !== shape.axis) m.push('follow_through');
  return m as TechniqueDef['markers'];
}

function make(
  id: string,
  displayName: string,
  intent: string,
  o: {
    category: TechniqueCategory;
    tags: string[];
    energy: [number, number];
    roles: readonly AnimatableRole[];
    shape: Shape;
    spanMs?: number;
    perMs?: number;
    minDurationMs?: number;
    maxDurationMs?: number;
    maxPerComposition?: number;
    neverWith?: string[];
    dimensionality?: TechniqueDef['dimensionality'];
  },
): TechniqueDef {
  const minDurationMs = o.minDurationMs ?? 600;
  return {
    id,
    category: o.category,
    displayName,
    intent,
    tags: o.tags,
    energy: o.energy,
    dimensionality: o.dimensionality ?? '2d',
    params: {
      spanMs: { kind: 'number', default: o.spanMs ?? 420, min: 100, max: 2000 },
      perMs: { kind: 'number', default: o.perMs ?? 460, min: 160, max: 1400 },
    },
    roles: o.roles,
    requires: ['set_keyframes', 'set_motion_blur'],
    minDurationMs,
    maxDurationMs: o.maxDurationMs ?? 3200,
    approxLayerCount: 0,
    approxToolCalls: 12,
    antipatterns: {
      neverUnderMs: minDurationMs - 80,
      maxPerComposition: o.maxPerComposition ?? 2,
      ...(o.neverWith ? { neverWith: o.neverWith } : {}),
    },
    variants: 4,
    markers: markersFor(o.shape, o.roles),
    emit(ctx, p, seed) {
      return emitShape(ctx, this.roles, seed, o.shape, {
        spanMs: p.spanMs as number,
        perMs: p.perMs as number,
      });
    },
  };
}

export const ENTRANCE_TECHNIQUES_4: readonly TechniqueDef[] = [
  // ── Entrances ───────────────────────────────────────────────────────
  make('entrance.drop_settle', 'Drop & Settle', 'Elements fall a short way into place and compress on landing.',
    { category: 'entrance', tags: ['entrance', 'physical', 'weighty', '2d'], energy: [0.35, 0.8],
      roles: ['headline', 'subhead', 'stat'], shape: { axis: 'y', from: -0.05, anticipation: 0.1, overshoot: 0.34, followProp: 'scale' } }),

  make('entrance.glide_left', 'Glide In', 'Content slides in laterally and comes to rest without bouncing.',
    { category: 'entrance', tags: ['entrance', 'calm', 'corporate', '2d'], energy: [0.15, 0.5],
      roles: ['headline', 'subhead', 'support'], shape: { axis: 'x', from: 0.06, anticipation: 0.05, overshoot: 0.16 } }),

  make('entrance.scale_bloom', 'Scale Bloom', 'Elements open outward from nothing, growing past full size before settling.',
    { category: 'entrance', tags: ['entrance', 'organic', 'soft', '2d'], energy: [0.3, 0.75],
      roles: ['mark', 'media', 'stat'], shape: { axis: 'scale', from: 0.7, anticipation: 0.06, overshoot: 0.3, followProp: 'rotation' } }),

  make('entrance.tilt_in', 'Tilt In', 'A slight rotation unwinds as the element arrives, like a card being straightened.',
    { category: 'entrance', tags: ['entrance', 'casual', 'handmade', '2d'], energy: [0.25, 0.7],
      roles: ['media', 'quote', 'mark'], shape: { axis: 'rotation', from: 7, anticipation: 0.12, overshoot: 0.32, followProp: 'scale' } }),

  make('entrance.recede_in', 'Recede In', 'Content arrives from close to the lens and settles back to its plane.',
    { category: 'entrance', tags: ['entrance', 'dimensional', 'cinematic', '2.5d'], energy: [0.3, 0.75],
      roles: ['headline', 'media'], shape: { axis: 'z', from: -0.18, anticipation: 0.08, overshoot: 0.24 }, dimensionality: '2.5d' }),

  make('entrance.hinge_up', 'Hinge Up', 'Elements swing up around their bottom edge into the frame.',
    { category: 'entrance', tags: ['entrance', 'mechanical', 'dimensional', '2.5d'], energy: [0.35, 0.8],
      roles: ['stat', 'list', 'cta'], shape: { axis: 'rotationX', from: -62, anticipation: 0.08, overshoot: 0.3, followProp: 'scale' }, dimensionality: '2.5d' }),

  make('entrance.settle_from_wide', 'Settle From Wide', 'Content starts oversized and contracts to its final scale.',
    { category: 'entrance', tags: ['entrance', 'confident', 'keynote', '2d'], energy: [0.2, 0.6],
      roles: ['headline', 'mark'], shape: { axis: 'scale', from: 1.14, anticipation: 0.04, overshoot: 0.18, followProp: 'rotation' } }),

  make('entrance.swing_in', 'Swing In', 'Elements arrive on an arc, rotating as they travel.',
    { category: 'entrance', tags: ['entrance', 'playful', 'energetic', '2d'], energy: [0.45, 0.9],
      roles: ['mark', 'stat', 'cta'], shape: { axis: 'rotation', from: -22, anticipation: 0.14, overshoot: 0.38, followProp: 'scale' } }),

  // ── Kinetic type ────────────────────────────────────────────────────
  make('kinetic_type.stagger_drop', 'Stagger Drop', 'Lines fall in one after another with weight behind each.',
    { category: 'kinetic_type', tags: ['kinetic', 'typographic', 'rhythmic', '2d'], energy: [0.4, 0.85],
      roles: ['headline', 'subhead'], shape: { axis: 'y', from: -0.07, anticipation: 0.12, overshoot: 0.34, followProp: 'scale' },
      spanMs: 520, neverWith: ['kinetic_type.line_push_stack'] }),

  make('kinetic_type.weight_shift', 'Weight Shift', 'Type settles by scale alone, the way a press stamps rather than slides.',
    { category: 'kinetic_type', tags: ['kinetic', 'typographic', 'editorial', '2d'], energy: [0.3, 0.75],
      roles: ['headline', 'quote'], shape: { axis: 'scale', from: 0.92, anticipation: 0.08, overshoot: 0.26, followProp: 'rotation' } }),

  make('kinetic_type.lean_in', 'Lean In', 'Lines rotate up out of a lean, like a headline righting itself.',
    { category: 'kinetic_type', tags: ['kinetic', 'typographic', 'editorial', '2d'], energy: [0.35, 0.8],
      roles: ['headline', 'overline'], shape: { axis: 'rotation', from: -5, anticipation: 0.1, overshoot: 0.3 } }),

  // ── Emphasis ────────────────────────────────────────────────────────
  make('emphasis.nudge', 'Nudge', 'A single element shifts a few pixels and returns, marking it quietly.',
    { category: 'emphasis', tags: ['emphasis', 'subtle', 'restrained', '2d'], energy: [0.15, 0.5],
      roles: ['stat', 'cta', 'mark'], shape: { axis: 'x', from: 0.012, anticipation: 0.2, overshoot: 0.4, followProp: 'scale' },
      minDurationMs: 300, maxDurationMs: 1200, maxPerComposition: 4 }),

  make('emphasis.rise_accent', 'Rise Accent', 'An element lifts slightly and stays there, holding the eye.',
    { category: 'emphasis', tags: ['emphasis', 'calm', 'product', '2d'], energy: [0.2, 0.6],
      roles: ['stat', 'mark', 'cta'], shape: { axis: 'y', from: 0.018, anticipation: 0.1, overshoot: 0.3 },
      minDurationMs: 320, maxDurationMs: 1400, maxPerComposition: 4 }),

  make('emphasis.tilt_accent', 'Tilt Accent', 'A slight rotation marks one element without moving it off its line.',
    { category: 'emphasis', tags: ['emphasis', 'playful', 'editorial', '2d'], energy: [0.25, 0.7],
      roles: ['mark', 'media'], shape: { axis: 'rotation', from: 4, anticipation: 0.16, overshoot: 0.36, followProp: 'scale' },
      minDurationMs: 320, maxDurationMs: 1400, maxPerComposition: 3 }),

  make('emphasis.depth_lift', 'Depth Lift', 'One element comes forward off the plane while the rest stay put.',
    { category: 'emphasis', tags: ['emphasis', 'dimensional', 'product', '2.5d'], energy: [0.2, 0.65],
      roles: ['media', 'mark'], shape: { axis: 'z', from: 0.05, anticipation: 0.08, overshoot: 0.28 },
      dimensionality: '2.5d', minDurationMs: 400, maxPerComposition: 2 }),

  // ── Transitions ─────────────────────────────────────────────────────
  make('transition.lift_swap', 'Lift Swap', 'Everything rises out together, clearing the frame for what follows.',
    { category: 'transition', tags: ['transition', 'clean', 'vertical', '2d'], energy: [0.35, 0.8],
      roles: ['headline', 'subhead', 'stat'], shape: { axis: 'y', from: -0.4, anticipation: 0.05, overshoot: 0, exit: true },
      minDurationMs: 400, maxDurationMs: 1600, maxPerComposition: 2 }),

  make('transition.scale_away', 'Scale Away', 'The frame contents shrink toward the centre and vanish.',
    { category: 'transition', tags: ['transition', 'centred', 'clean', '2d'], energy: [0.3, 0.75],
      roles: ['headline', 'media', 'stat'], shape: { axis: 'scale', from: 0.72, anticipation: 0.06, overshoot: 0, exit: true },
      minDurationMs: 400, maxDurationMs: 1500, maxPerComposition: 2 }),

  make('transition.slide_off', 'Slide Off', 'Content leaves laterally, staggered so the frame empties in order.',
    { category: 'transition', tags: ['transition', 'directional', 'editorial', '2d'], energy: [0.35, 0.8],
      roles: ['headline', 'subhead', 'support'], shape: { axis: 'x', from: 0.55, anticipation: 0.04, overshoot: 0, exit: true },
      minDurationMs: 400, maxDurationMs: 1500, maxPerComposition: 2 }),

  // ── Exits ───────────────────────────────────────────────────────────
  make('exit.sink_out', 'Sink Out', 'Elements settle downward and fade, the opposite of arriving.',
    { category: 'exit', tags: ['exit', 'calm', 'closing', '2d'], energy: [0.2, 0.6],
      roles: ['headline', 'subhead', 'support'], shape: { axis: 'y', from: 0.06, anticipation: 0.06, overshoot: 0, exit: true },
      minDurationMs: 400, maxDurationMs: 1800, maxPerComposition: 1 }),

  make('exit.recede_back', 'Recede Back', 'Content falls away from the lens rather than off the edge.',
    { category: 'exit', tags: ['exit', 'dimensional', 'cinematic', '2.5d'], energy: [0.25, 0.7],
      roles: ['headline', 'media'], shape: { axis: 'z', from: 0.3, anticipation: 0.05, overshoot: 0, exit: true },
      dimensionality: '2.5d', minDurationMs: 450, maxDurationMs: 1800, maxPerComposition: 1 }),

  make('exit.spin_off', 'Spin Off', 'Elements rotate away as they leave, each a different way.',
    { category: 'exit', tags: ['exit', 'playful', 'energetic', '2d'], energy: [0.5, 0.9],
      roles: ['mark', 'stat', 'cta'], shape: { axis: 'rotation', from: 42, anticipation: 0.1, overshoot: 0, exit: true },
      minDurationMs: 400, maxDurationMs: 1400, maxPerComposition: 1, neverWith: ['exit.scatter_out'] }),

  make('exit.fold_away', 'Fold Away', 'Elements close around a horizontal hinge and are gone.',
    { category: 'exit', tags: ['exit', 'mechanical', 'dimensional', '2.5d'], energy: [0.35, 0.8],
      roles: ['stat', 'list', 'media'], shape: { axis: 'rotationX', from: 78, anticipation: 0.08, overshoot: 0, exit: true },
      dimensionality: '2.5d', minDurationMs: 400, maxDurationMs: 1600, maxPerComposition: 1 }),

  make('exit.compress_out', 'Compress Out', 'Content squeezes horizontally to nothing, like a shutter closing.',
    { category: 'exit', tags: ['exit', 'graphic', 'broadcast', '2d'], energy: [0.4, 0.85],
      roles: ['headline', 'media', 'stat'], shape: { axis: 'x', from: 0.28, anticipation: 0.12, overshoot: 0, exit: true },
      minDurationMs: 380, maxDurationMs: 1400, maxPerComposition: 1 }),
];
