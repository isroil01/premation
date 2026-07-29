/**
 * Kinetic typography — techniques where the TYPE is the motion.
 *
 * These are the ones that carry the most identity, and the ones a generic recipe
 * layer cannot express at all: `add_kinetic_title` had exactly one behaviour
 * ("words pop in on a beat"), so every kinetic headline in every piece the old
 * system made was the same headline.
 */

import { mk, mulberry32, pick, pickInt, type ToolCall } from '@motion/design-system';
import type { TechniqueDef } from '../schema';
import {
  CURVES, blurIfFast, followThrough, heroMove, hold, offsetFor, rolesTargets, staggerAt, track, travel,
} from '../emit';

// ── kinetic_type.hard_cut_stack ───────────────────────────────────────

export const hardCutStack: TechniqueDef = {
  id: 'kinetic_type.hard_cut_stack',
  category: 'kinetic_type',
  displayName: 'Hard Cut Stack',
  intent: 'Aggressive editorial headline. Lines punch in on hard cuts with weight contrast.',
  tags: ['editorial', 'aggressive', 'typographic', '2d', 'high-contrast', 'swiss'],
  energy: [0.65, 1],
  dimensionality: '2d',
  params: {
    beatsPerLine: { kind: 'number', default: 1, min: 0.25, max: 3 },
    intensity: { kind: 'number', default: 0.7, min: 0, max: 1 },
    accentColor: { kind: 'string', required: false },
  },
  roles: ['headline', 'quote'],
  requires: ['set_keyframes', 'text_animator', 'set_motion_blur', 'update_layer'],
  minDurationMs: 1200,
  maxDurationMs: 4000,
  approxLayerCount: 0,
  approxToolCalls: 16,
  antipatterns: {
    neverWith: ['camera.crash_zoom', 'camera.push_in_slow', 'entrance.blur_resolve'],
    neverUnderMs: 800,
    maxPerComposition: 1,
  },
  variants: 4,
  // No `motion_blur`: the lines travel 2–4% of the frame, well under the
  // velocity threshold. blurIfFast is still CALLED — it just correctly
  // declines, which is the point of a threshold rather than blanket-enabling.
  markers: ['overshoot', 'anticipation', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const lines = (ctx.targets.headline ?? ctx.targets.quote ?? []) as string[];
    if (!lines.length) return calls;

    const intensity = p.intensity as number;
    const beats = p.beatsPerLine as number;
    const beat = ctx.pack.pack.pacing.baseBeatMs * beats;
    // Four variant axes, each of which changes the read: which way lines enter,
    // which one carries the accent, how far they travel, and whether tracking
    // opens or closes.
    const dir = rng() > 0.5 ? 1 : -1;
    const accentIdx = pickInt(rng, 0, lines.length - 1);
    const dist = travel(ctx, pick(rng, [0.02, 0.028, 0.04]));
    const trackingBias = rng() > 0.5 ? 1 : -1;
    const accent = (p.accentColor as string) || ctx.pack.palette.accent;

    lines.forEach((id, i) => {
      // Non-uniform: 0.72 exponent, so the first two lines land close together
      // and the last one hangs. A fixed beat is a metronome; this is a phrase.
      const t0 = ctx.startMs + Math.pow(i / Math.max(1, lines.length), 0.72) * beat * lines.length * 0.62;
      const punch = 300 + intensity * 120;

      // Scale: anticipation → overshoot → settle, three keyframes, own bezier.
      calls.push(
        heroMove(ctx, id, 'scale', {
          from: 0.94, to: 1, startMs: t0, durationMs: punch, anticipation: 0.14, overshoot: 0.5,
        }),
      );
      // Position LAGS scale by two frames and overshoots PAST rest.
      calls.push(
        heroMove(ctx, id, 'y', {
          from: dist * dir, to: 0,
          startMs: offsetFor(ctx, 'y', t0),
          durationMs: punch * 1.2,
          anticipation: 0, overshoot: 0.42,
        }),
      );
      // Opacity LEADS by one frame and is short — a hard cut, not a fade.
      calls.push(
        track(id, 'opacity', [
          { t: offsetFor(ctx, 'opacity', t0), value: 0, bezier: CURVES.snap },
          { t: t0 + punch * 0.28, value: 100, bezier: CURVES.snap },
        ]),
      );
      // Per-character sweep with an animated selector, tracking closing (or
      // opening) as the characters land.
      calls.push(
        mk('text_animator', {
          nodeId: id,
          basedOn: 'characters',
          shape: 'rampUp',
          start: 0,
          end: 100,
          y: 8 * dir,
          tracking: 6 * trackingBias,
          opacity: 0,
          sweep: {
            fromSec: t0 / 1000,
            toSec: (t0 + punch * 1.05) / 1000,
            fromOffset: -100,
            toOffset: 100,
            easing: 'bezier',
            bezier: CURVES.settle,
          },
        }),
      );
      calls.push(...blurIfFast(ctx, id, dist, punch));
      if (i === accentIdx) {
        calls.push(mk('update_layer', { nodeId: id, fill: accent, fontWeight: 800 }));
      }
    });
    return calls;
  },
};

// ── kinetic_type.word_cascade ─────────────────────────────────────────

export const wordCascade: TechniqueDef = {
  id: 'kinetic_type.word_cascade',
  category: 'kinetic_type',
  displayName: 'Word Cascade',
  intent: 'Words arrive one at a time on a decelerating beat, each settling before the next.',
  tags: ['typographic', 'rhythmic', 'friendly', '2d', 'word'],
  energy: [0.35, 0.75],
  dimensionality: '2d',
  params: {
    spanMs: { kind: 'number', default: 700, min: 200, max: 2400 },
  },
  roles: ['headline', 'subhead', 'quote'],
  requires: ['text_animator', 'set_keyframes'],
  minDurationMs: 800,
  maxDurationMs: 3600,
  approxLayerCount: 0,
  approxToolCalls: 10,
  antipatterns: { neverUnderMs: 700, maxPerComposition: 2, neverWith: ['kinetic_type.hard_cut_stack'] },
  variants: 3,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = (ctx.targets.headline ?? ctx.targets.quote ?? ctx.targets.subhead ?? []) as string[];
    if (!ids.length) return calls;

    const spanMs = Math.min(
      (p.spanMs as number) * (0.7 + ctx.pack.pack.pacing.baseBeatMs / 1300),
      ctx.durationMs * 0.65,
    );
    const perMs = Math.max(320, ctx.durationMs - spanMs);
    const lift = travel(ctx, 0.022 * (0.8 + ctx.pack.pack.motionSignature.overshootBias * 0.8));
    const shape = pick(rng, ['rampUp', 'triangle', 'smooth'] as const);

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
      calls.push(
        mk('text_animator', {
          nodeId: id,
          // WORDS, not characters — that is the whole difference from
          // hard_cut_stack, and it changes the rhythm from a stutter to a phrase.
          basedOn: 'words',
          shape,
          start: 0,
          end: 100,
          y: lift,
          scale: 88,
          opacity: 0,
          blur: 3,
          sweep: {
            fromSec: at / 1000,
            toSec: (at + perMs) / 1000,
            fromOffset: -100,
            toOffset: 100,
            easing: 'bezier',
            bezier: CURVES.settle,
          },
        }),
      );
      // The LINE itself also settles, slightly after the words finish — the
      // follow-through that makes the group feel connected.
      calls.push(
        followThrough(ctx, id, 'y', {
          restValue: 0,
          amount: lift * 0.22,
          settleMs: at + perMs * 0.8,
          durationMs: perMs * 0.6,
        }),
      );
      calls.push(
        track(id, 'opacity', [
          { t: offsetFor(ctx, 'opacity', at), value: 0, bezier: CURVES.snap },
          { t: at + perMs * 0.2, value: 100, bezier: CURVES.settle },
        ]),
      );
    });
    return calls;
  },
};

// ── kinetic_type.scramble_decode ──────────────────────────────────────

export const scrambleDecode: TechniqueDef = {
  id: 'kinetic_type.scramble_decode',
  category: 'kinetic_type',
  displayName: 'Scramble Decode',
  intent: 'Characters scramble through the alphabet and resolve into the word, terminal-style.',
  tags: ['technical', 'cyberpunk', 'typographic', '2d', 'decode', 'mono'],
  energy: [0.5, 0.9],
  dimensionality: '2d',
  params: {
    scrambleDepth: { kind: 'number', default: 14, min: 2, max: 40 },
    spanMs: { kind: 'number', default: 560, min: 150, max: 2000 },
  },
  roles: ['headline', 'overline', 'stat', 'list'],
  requires: ['text_animator', 'set_keyframes'],
  minDurationMs: 600,
  maxDurationMs: 3000,
  approxLayerCount: 0,
  approxToolCalls: 8,
  antipatterns: {
    neverUnderMs: 550,
    maxPerComposition: 2,
    neverWith: ['entrance.blur_resolve', 'kinetic_type.word_cascade'],
  },
  variants: 3,
  markers: ['cross_property_offset', 'explicit_bezier', 'nonuniform_stagger', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const depth = Math.round(
      (p.scrambleDepth as number) * (0.7 + ctx.pack.pack.motionSignature.overshootBias * 0.7),
    );
    const spanMs = Math.min(
      (p.spanMs as number) * (0.7 + ctx.pack.pack.pacing.baseBeatMs / 1200),
      ctx.durationMs * 0.6,
    );
    const perMs = Math.max(280, ctx.durationMs - spanMs);
    const shape = pick(rng, ['square', 'rampUp'] as const);

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
      // `characterOffset` shifts each covered glyph N places through its
      // alphabet. Rolling it back to 0 across the sweep IS the decode — it
      // cannot be faked with transforms, which is why this technique needs the
      // animator's character-offset channel rather than position and opacity.
      calls.push(
        mk('text_animator', {
          nodeId: id,
          basedOn: 'characters',
          shape,
          start: 0,
          end: 100,
          characterOffset: depth,
          opacity: 30,
          // Sub-frame start: a decode quantised to frames stutters visibly
          // because every glyph changes on the same frame boundary.
          sweep: {
            fromSec: (at + ctx.frameMs * 0.5) / 1000,
            toSec: (at + perMs) / 1000,
            fromOffset: -100,
            toOffset: 100,
            easing: 'bezier',
            bezier: CURVES.drift,
          },
        }),
      );
      calls.push(
        track(id, 'opacity', [
          { t: offsetFor(ctx, 'opacity', at), value: 0, bezier: CURVES.snap },
          { t: at + perMs * 0.12, value: 100, bezier: CURVES.snap },
        ]),
      );
    });
    return calls;
  },
};

// ── kinetic_type.slam_in ──────────────────────────────────────────────

export const slamIn: TechniqueDef = {
  id: 'kinetic_type.slam_in',
  category: 'kinetic_type',
  displayName: 'Slam In',
  intent: 'Type arrives oversized and slams down to size, with a shockwave of secondary motion.',
  tags: ['broadcast', 'aggressive', 'sports', 'typographic', '2d', 'impact'],
  energy: [0.75, 1],
  dimensionality: '2d',
  params: {
    fromScale: { kind: 'number', default: 1.45, min: 1.05, max: 3 },
    impactMs: { kind: 'number', default: 180, min: 60, max: 600 },
  },
  roles: ['headline', 'stat', 'overline'],
  requires: ['set_keyframes', 'set_motion_blur'],
  minDurationMs: 500,
  maxDurationMs: 2000,
  approxLayerCount: 0,
  approxToolCalls: 12,
  antipatterns: {
    neverUnderMs: 450,
    maxPerComposition: 1,
    neverWith: ['entrance.blur_resolve', 'camera.drift_parallax', 'transition.slow_dissolve'],
    requiresBreathingRoomMs: 300,
  },
  variants: 3,
  // No `anticipation`: a slam arrives ALREADY oversized and travels inward.
  // There is no counter-move to make, and adding one would soften the impact.
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'motion_blur', 'follow_through', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const sig = ctx.pack.pack.motionSignature;
    const impact = (p.impactMs as number) * (1.2 - sig.overshootBias * 0.4);
    const fromScale = 1 + ((p.fromScale as number) - 1) * (0.7 + sig.overshootBias * 0.7);
    const shakeDir = rng() > 0.5 ? 1 : -1;

    ids.forEach((id, i) => {
      // A slam is one event, not a sequence — so the stagger is tight. But it
      // still goes through `staggerAt`: `i * frameMs * 2` was a literal fixed
      // interval, which is exactly the metronome the timing linter exists to
      // catch, and it caught it.
      //
      // "Tight" has a floor, though. Squeezing N elements into three frames means
      // three of them enter on the same frame, which is `SIMULTANEOUS_ENTRY` — a
      // different defect, and no less real. The span is scaled by the impact so
      // the group still lands as one hit while remaining individually readable.
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, impact * 1.4);

      // The scale slam: no anticipation on the way in (it is already huge), a
      // hard compression past the target, then a settle. The compression below
      // 1.0 is the impact — without it the type just gets smaller.
      calls.push(
        track(id, 'scale', [
          { t: at, value: fromScale, bezier: CURVES.snap },
          { t: at + impact, value: 0.965, bezier: CURVES.overshoot },
          { t: at + impact * 2.1, value: 1.012, bezier: CURVES.settle },
          { t: at + impact * 3.4, value: 1, bezier: CURVES.settle },
        ]),
      );
      calls.push(
        track(id, 'opacity', [
          { t: offsetFor(ctx, 'opacity', at), value: 0, bezier: CURVES.snap },
          // Sub-frame: on a 180ms impact a whole-frame fade is a visible step.
          { t: at + ctx.frameMs * 1.5, value: 100, bezier: CURVES.snap },
        ]),
      );
      // The shockwave: a lateral shake that decays. This is the follow-through
      // that sells the impact — without it the type stops dead, which reads as a
      // cut rather than a landing.
      calls.push(
        followThrough(ctx, id, 'x', {
          restValue: 0,
          amount: travel(ctx, 0.006) * shakeDir * (i % 2 === 0 ? 1 : -1),
          settleMs: at + impact,
          durationMs: impact * 2.4,
        }),
      );
      calls.push(...blurIfFast(ctx, id, (fromScale - 1) * ctx.width * 0.4, impact));
      // A held beat after the settle — the slam needs silence after it or the
      // next event steps on the impact.
      calls.push(hold(id, 'scale', 1, at + impact * 3.4, Math.min(at + impact * 5, ctx.startMs + ctx.durationMs)));
    });
    return calls;
  },
};

export const KINETIC_TECHNIQUES = [hardCutStack, wordCascade, scrambleDecode, slamIn] as const;
