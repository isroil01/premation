/**
 * Entrance techniques — how content arrives.
 *
 * Six of them, and they differ structurally rather than cosmetically. The
 * thirteen `compose` recipes this replaces had one entrance shape with six
 * parameter sets, which is why every piece they produced entered the same way.
 */

import { mk, mulberry32, pick, shuffled, type ToolCall } from '@motion/design-system';
import type { TechniqueDef } from '../schema';
import {
  CURVES, blurIfFast, fadeIn, followThrough, heroMove, offsetFor,
  rolesTargets, staggerAt, track, travel,
} from '../emit';

// ── entrance.rise_settle ──────────────────────────────────────────────

export const riseSettle: TechniqueDef = {
  id: 'entrance.rise_settle',
  category: 'entrance',
  displayName: 'Rise & Settle',
  intent: 'Elements lift into place and settle, staggered so the eye gets a reading order.',
  tags: ['entrance', 'calm', 'universal', '2d', 'staggered'],
  energy: [0.2, 0.6],
  dimensionality: '2d',
  params: {
    travelFraction: { kind: 'number', default: 0.035, min: 0.005, max: 0.15 },
    spanMs: { kind: 'number', default: 520, min: 120, max: 2000 },
  },
  roles: ['headline', 'subhead', 'support', 'overline', 'stat', 'list', 'cta', 'quote'],
  requires: ['set_keyframes', 'set_motion_blur'],
  minDurationMs: 600,
  maxDurationMs: 3200,
  approxLayerCount: 0,
  approxToolCalls: 12,
  antipatterns: { neverUnderMs: 450, maxPerComposition: 3 },
  variants: 4,
  markers: ['overshoot', 'anticipation', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    // Three independent variant axes, so every seed lands somewhere different.
    // A single weighted direction pick gave three of four seeds identical
    // output — a variant that changes nothing is not a variant.
    const dist = travel(ctx, (p.travelFraction as number) * pick(rng, [0.7, 1, 1.35]));
    const spanMs = Math.min((p.spanMs as number) * pick(rng, [0.75, 1, 1.3]), ctx.durationMs * 0.6);
    // Direction changes the read completely: rising reads as arriving, falling
    // reads as being placed.
    const dir = pick(rng, [1, 1, 1, -1]);
    const perElementMs = Math.max(260, ctx.durationMs - spanMs);

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);

      // Position: anticipation + overshoot, offset to LAG by two frames.
      calls.push(
        heroMove(ctx, id, 'y', {
          from: dist * dir,
          to: 0,
          startMs: offsetFor(ctx, 'y', at),
          durationMs: perElementMs,
          anticipation: 0.1,
          overshoot: 0.3,
        }),
      );
      // Opacity LEADS by one frame and finishes early — see fadeIn.
      calls.push(fadeIn(ctx, id, at, perElementMs));
      // Scale is the reference channel, no offset, a smaller excursion so it does
      // not compete with the position move.
      calls.push(
        heroMove(ctx, id, 'scale', {
          from: 0.96,
          to: 1,
          startMs: at,
          durationMs: perElementMs,
          anticipation: 0,
          overshoot: 0.22,
        }),
      );
      calls.push(...blurIfFast(ctx, id, dist, perElementMs));
    });

    return calls;
  },
};

// ── entrance.mask_rise ────────────────────────────────────────────────

export const maskRise: TechniqueDef = {
  id: 'entrance.mask_rise',
  category: 'entrance',
  displayName: 'Mask Rise',
  intent: 'Type is revealed from behind an invisible edge, sliding up inside its own mask.',
  tags: ['entrance', 'typographic', 'editorial', 'restrained', '2d', 'mask'],
  energy: [0.25, 0.7],
  dimensionality: '2d',
  params: {
    spanMs: { kind: 'number', default: 420, min: 100, max: 1600 },
    overshootLines: { kind: 'boolean', default: true },
  },
  roles: ['headline', 'quote', 'subhead'],
  requires: ['create_mask', 'set_keyframes'],
  minDurationMs: 500,
  maxDurationMs: 2600,
  approxLayerCount: 0,
  approxToolCalls: 10,
  antipatterns: { neverUnderMs: 400, maxPerComposition: 2, neverWith: ['entrance.scale_pop_soft'] },
  variants: 3,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = (ctx.targets.headline ?? ctx.targets.quote ?? ctx.targets.subhead ?? []) as string[];
    if (!ids.length) return calls;

    const beat = ctx.pack.pack.pacing.baseBeatMs;
    const spanMs = Math.min((p.spanMs as number) * (0.7 + beat / 1200), ctx.durationMs * 0.5);
    const perMs = Math.max(320, ctx.durationMs - spanMs);
    const lift = travel(ctx, 0.05 * (0.8 + ctx.pack.pack.motionSignature.overshootBias * 0.7));
    // Whether the mask is a hard edge or slightly feathered is the variant. A
    // hard edge reads as a printed reveal; a soft one as a light wipe.
    const feather = pick(rng, [0, 0, 2, 6]);

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
      // The mask clips to the line's own box, so the glyphs slide up out of
      // nothing rather than fading in from nowhere.
      calls.push(mk('create_mask', { nodeId: id, shape: 'rectangle', mode: 'add', feather }));
      calls.push(
        heroMove(ctx, id, 'y', {
          from: lift,
          to: 0,
          // Half a frame off the grid — on a fast reveal the quantised version
          // steps visibly at the mask edge.
          startMs: at + ctx.frameMs * 0.5,
          durationMs: perMs,
          anticipation: 0,
          overshoot: (p.overshootLines as boolean) ? 0.24 : 0,
        }),
      );
      // Opacity moves too, but only a little and only early: a masked reveal that
      // also fades reads as two effects; one that stays fully opaque can pop.
      calls.push(
        track(id, 'opacity', [
          { t: offsetFor(ctx, 'opacity', at), value: 55, bezier: CURVES.snap },
          { t: at + perMs * 0.35, value: 100, bezier: CURVES.settle },
        ]),
      );
    });
    return calls;
  },
};

// ── entrance.blur_resolve ─────────────────────────────────────────────

export const blurResolve: TechniqueDef = {
  id: 'entrance.blur_resolve',
  category: 'entrance',
  displayName: 'Blur Resolve',
  intent: 'Content resolves out of a defocus, as though the lens found it.',
  tags: ['entrance', 'cinematic', 'soft', '2d', 'lens'],
  energy: [0.15, 0.5],
  dimensionality: '2d',
  params: {
    blurPx: { kind: 'number', default: 14, min: 2, max: 40 },
    spanMs: { kind: 'number', default: 600, min: 150, max: 2400 },
  },
  roles: ['headline', 'media', 'mark', 'subhead', 'quote'],
  requires: ['add_effect', 'set_keyframes'],
  minDurationMs: 700,
  maxDurationMs: 3400,
  approxLayerCount: 0,
  approxToolCalls: 9,
  antipatterns: { neverUnderMs: 600, maxPerComposition: 2 },
  variants: 3,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const spanMs = Math.min(p.spanMs as number, ctx.durationMs * 0.55);
    const perMs = Math.max(400, ctx.durationMs - spanMs);
    // A soft pack resolves from a deeper defocus than a hard one.
    const blur = (p.blurPx as number) * (1.3 - ctx.pack.pack.motionSignature.blurBias * 0.5);
    // Whether the scale also pulls in is the variant: with it the shot reads as a
    // focus pull on a moving subject; without, as a static rack focus.
    const withPull = rng() > 0.4;

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
      const fx = `${ctx.idPrefix}_blur_${i}`;
      // `id: fx` is load-bearing rather than tidiness. `add_effect` used to
      // generate its own `fx_<n>`, and a flat emitter cannot read a return
      // value — so the track below named an effect that never existed. The
      // keyframes validated, stored, and were never sampled. This entrance's
      // whole subject is a blur resolving, and it never resolved because it
      // never blurred.
      calls.push(mk('add_effect', { nodeId: id, type: 'blur', amount: blur, id: fx }));
      // The blur ramp is NOT symmetric with the fade: it resolves faster, so the
      // element is sharp before it is fully opaque. The other order looks like a
      // rendering delay.
      calls.push(
        track(id, `effect.${fx}.blur`, [
          { t: at, value: blur, bezier: CURVES.snap },
          { t: at + perMs * 0.42, value: blur * 0.18, bezier: CURVES.settle },
          { t: at + perMs * 0.7, value: 0, bezier: CURVES.settle },
        ]),
      );
      calls.push(fadeIn(ctx, id, at, perMs));
      if (withPull) {
        calls.push(
          heroMove(ctx, id, 'scale', {
            from: 1.045, to: 1, startMs: at, durationMs: perMs, anticipation: 0, overshoot: 0.15,
          }),
        );
      }
    });
    return calls;
  },
};

// ── entrance.scale_pop_soft ───────────────────────────────────────────

export const scalePopSoft: TechniqueDef = {
  id: 'entrance.scale_pop_soft',
  category: 'entrance',
  displayName: 'Scale Pop',
  intent: 'Elements pop up from small with a soft overshoot — friendly, quick, unfussy.',
  tags: ['entrance', 'friendly', 'quick', '2d', 'saas'],
  energy: [0.4, 0.8],
  dimensionality: '2d',
  params: {
    fromScale: { kind: 'number', default: 0.86, min: 0.4, max: 0.99 },
    spanMs: { kind: 'number', default: 340, min: 80, max: 1200 },
  },
  roles: ['mark', 'stat', 'list', 'cta', 'media'],
  requires: ['set_keyframes'],
  minDurationMs: 420,
  maxDurationMs: 2200,
  approxLayerCount: 0,
  approxToolCalls: 9,
  antipatterns: { neverUnderMs: 380, maxPerComposition: 3, neverWith: ['entrance.mask_rise'] },
  variants: 3,
  markers: ['overshoot', 'anticipation', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const spanMs = Math.min(
      (p.spanMs as number) * (0.7 + ctx.pack.pack.pacing.baseBeatMs / 1100),
      ctx.durationMs * 0.55,
    );
    const perMs = Math.max(300, ctx.durationMs - spanMs);
    // Whether the group pops in reading order or from the centre outward.
    const order = rng() > 0.5 ? ids : shuffled(rng, ids);

    order.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, order.length, spanMs);
      calls.push(
        heroMove(ctx, id, 'scale', {
          from: p.fromScale as number,
          to: 1,
          startMs: at,
          durationMs: perMs,
          anticipation: 0.12,
          overshoot: 0.45,
        }),
      );
      calls.push(fadeIn(ctx, id, at, perMs * 0.8));
      // A small rotation follow-through on every SECOND element. Applying it to
      // all of them would be a tic; applying it to none loses the sense that the
      // group has weight.
      if (i % 2 === 1) {
        calls.push(
          followThrough(ctx, id, 'rotation', {
            restValue: 0,
            amount: 1.4 * (i % 4 === 1 ? 1 : -1),
            settleMs: at + perMs * 0.7,
            durationMs: perMs * 0.8,
          }),
        );
      }
    });
    return calls;
  },
};

// ── entrance.slide_in_edge ────────────────────────────────────────────

export const slideInEdge: TechniqueDef = {
  id: 'entrance.slide_in_edge',
  category: 'entrance',
  displayName: 'Slide From Edge',
  intent: 'Content enters from off-frame at speed and brakes hard into position.',
  tags: ['entrance', 'kinetic', 'broadcast', '2d', 'directional'],
  energy: [0.55, 0.95],
  dimensionality: '2d',
  params: {
    from: { kind: 'enum', values: ['left', 'right', 'top', 'bottom'], default: 'left' },
    spanMs: { kind: 'number', default: 260, min: 60, max: 900 },
  },
  roles: ['headline', 'overline', 'rule', 'stat', 'list', 'mark'],
  requires: ['set_keyframes', 'set_motion_blur'],
  minDurationMs: 380,
  maxDurationMs: 1800,
  approxLayerCount: 0,
  approxToolCalls: 10,
  antipatterns: { neverUnderMs: 340, maxPerComposition: 2 },
  variants: 4,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger', 'motion_blur'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const from = p.from as string;
    const horizontal = from === 'left' || from === 'right';
    const prop = horizontal ? 'x' : 'y';
    const sign = from === 'left' || from === 'top' ? -1 : 1;
    // Enters from beyond the frame edge, so the first visible frame is already at
    // speed — an element that starts just inside the edge reads as sliding out of
    // a wall.
    const dist = (horizontal ? ctx.width : ctx.height) * pick(rng, [0.55, 0.7, 0.9]) * sign;
    const spanMs = Math.min(
      (p.spanMs as number) * (0.7 + ctx.pack.pack.pacing.baseBeatMs / 1200),
      ctx.durationMs * 0.5,
    );
    const perMs = Math.max(240, ctx.durationMs - spanMs);

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
      calls.push(
        heroMove(ctx, id, prop, {
          from: dist,
          to: 0,
          startMs: offsetFor(ctx, prop, at),
          durationMs: perMs,
          anticipation: 0,
          overshoot: 0.3,
        }),
      );
      // Opacity is a SHORT ramp at the start only — a long fade over a fast
      // travel means the element is a ghost for most of the distance.
      calls.push(
        track(id, 'opacity', [
          { t: offsetFor(ctx, 'opacity', at), value: 0, bezier: CURVES.snap },
          { t: at + perMs * 0.22, value: 100, bezier: CURVES.settle },
        ]),
      );
      // Genuinely fast — this is the technique that most needs blur.
      calls.push(...blurIfFast(ctx, id, Math.abs(dist), perMs));
    });
    return calls;
  },
};

// ── entrance.stat_count_up ────────────────────────────────────────────

export const statCountUp: TechniqueDef = {
  id: 'emphasis.count_up',
  category: 'emphasis',
  displayName: 'Count Up',
  intent: 'Numbers count to their value on an ease-out, never a linear tick.',
  tags: ['emphasis', 'stat', 'data', 'saas', '2d'],
  energy: [0.3, 0.7],
  dimensionality: '2d',
  params: {
    durationMs: { kind: 'number', default: 900, min: 300, max: 3000 },
  },
  roles: ['stat'],
  requires: ['set_keyframes', 'text_animator'],
  minDurationMs: 500,
  maxDurationMs: 3200,
  approxLayerCount: 0,
  approxToolCalls: 8,
  antipatterns: { neverUnderMs: 450, maxPerComposition: 2 },
  variants: 2,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = (ctx.targets.stat ?? []) as string[];
    if (!ids.length) return calls;

    const beat = ctx.pack.pack.pacing.baseBeatMs;
    const dur = Math.min((p.durationMs as number) * (0.7 + beat / 1300), ctx.durationMs * 0.8);
    const spanMs = Math.min(240, ctx.durationMs * 0.25);
    const digitRoll = rng() > 0.5;

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
      // The engine cannot interpolate the numeric CONTENT of a text layer, so the
      // count is expressed the way a designer would build it by hand: a
      // per-character roll plus a scale settle. Claiming a numeric tween the
      // engine cannot do would be a silent no-op — see the audit's rule about
      // never leaving a track the renderer will not read.
      if (digitRoll) {
        calls.push(
          mk('text_animator', {
            nodeId: id,
            basedOn: 'characters',
            shape: 'rampUp',
            start: 0,
            end: 100,
            y: -ctx.height * 0.02,
            characterOffset: 8,
            sweep: {
              fromSec: (at) / 1000,
              toSec: (at + dur) / 1000,
              fromOffset: -100,
              toOffset: 100,
              easing: 'bezier',
              bezier: CURVES.settle,
            },
          }),
        );
      }
      calls.push(
        heroMove(ctx, id, 'scale', {
          from: 0.94, to: 1, startMs: at, durationMs: dur * 0.55, anticipation: 0.08, overshoot: 0.4,
        }),
      );
      calls.push(fadeIn(ctx, id, at, dur * 0.35));
    });
    return calls;
  },
};

export const ENTRANCE_TECHNIQUES = [
  riseSettle,
  maskRise,
  blurResolve,
  scalePopSoft,
  slideInEdge,
  statCountUp,
] as const;
