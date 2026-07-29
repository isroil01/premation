/**
 * Kinetic type, second set.
 *
 * The first four kinetic techniques all animate a text layer's own characters
 * via `text_animator`. These four deliberately do not: they treat whole lines as
 * objects and animate the RELATIONSHIP between them — one line displacing
 * another, a word swapping in place, a band that never stops, a stack that
 * collapses. That is a different craft problem, and a library that only knew the
 * per-character kind would make every kinetic sequence read the same.
 */

import { mk, mulberry32, pick, type ToolCall } from '@motion/design-system';
import type { TechniqueDef } from '../schema';
import {
  CURVES, blurIfFast, fadeIn, followThrough, heroMove, hold,
  offsetFor, rolesTargets, staggerAt, subFrame, track, travel,
} from '../emit';

// ── kinetic_type.line_push_stack ──────────────────────────────────────

export const linePushStack: TechniqueDef = {
  id: 'kinetic_type.line_push_stack',
  category: 'kinetic_type',
  displayName: 'Line Push Stack',
  intent: 'Each new line arrives from below and shoves the previous ones up out of its way.',
  tags: ['kinetic', 'typographic', 'rhythmic', 'editorial', '2d', 'displacement'],
  energy: [0.45, 0.9],
  dimensionality: '2d',
  params: {
    lineHeightFraction: { kind: 'number', default: 0.11, min: 0.04, max: 0.3 },
    beatsPerLine: { kind: 'number', default: 1, min: 0.5, max: 3 },
  },
  // Three roles, not four. Adding `list` brought the target count to eight and
  // `staggerAt` had to compress them into the slot, piling the last three
  // within 20ms of each other. A stack technique that stacks eight things is not
  // a better stack technique — see the note on `rolesTargets`.
  roles: ['headline', 'subhead', 'support'],
  requires: ['set_keyframes', 'set_motion_blur'],
  minDurationMs: 1200,
  maxDurationMs: 8000,
  approxLayerCount: 0,
  approxToolCalls: 18,
  antipatterns: {
    neverUnderMs: 1000,
    maxPerComposition: 1,
    neverWith: ['entrance.rise_settle', 'kinetic_type.stack_collapse'],
  },
  variants: 4,
  // `blurIfFast` is still called, but a one-line-height push never clears the
  // velocity threshold in any pack — so `motion_blur` is not claimed. A marker
  // that only fires on some inputs is not a marker this technique exhibits.
  markers: ['overshoot', 'anticipation', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (ids.length < 2) return calls;

    const lineH = ctx.height * (p.lineHeightFraction as number) * pick(rng, [0.85, 1, 1.15]);
    const beat = ctx.pack.pack.pacing.baseBeatMs * (p.beatsPerLine as number);
    const spanMs = Math.min(ctx.durationMs * 0.7, beat * ids.length);
    const perMs = Math.max(220, Math.min(520, beat * 0.9));

    // Every push a line receives is written into ONE track for that line, not
    // one track per push.
    //
    // The first version emitted a separate `y` track each time a later line
    // shoved this one. They overlapped in time, and tracks on the same
    // node+prop merge — so the merged key list interleaved keys from two pushes
    // that disagreed about where the line was, producing value jumps inside a
    // single frame. The linter called it POPPING, which is exactly what it
    // looked like. A displacement sequence is one timeline per object.
    const yKeys = new Map<string, { t: number; value: number; bezier?: readonly number[]; easing?: string }[]>();
    const pushY = (id: string, k: { t: number; value: number; bezier?: readonly number[] }): void => {
      const list = yKeys.get(id) ?? [];
      list.push(k);
      yKeys.set(id, list);
    };
    const arriveAt: number[] = [];
    // Each line dims exactly once, when it first passes out of the reading zone.
    const dimmed = new Set<string>();

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
      arriveAt.push(at);

      // Arrival: from one line below its resting place — anticipation, past the
      // mark, then settle, written by hand here because the rest of this line's
      // life is more pushes on the same channel.
      // The overshoot key is placed relative to the END of the anticipation, not
      // to the start of the move. Measuring it from the start put the two within
      // 49ms of each other whenever `perMs` hit its 220ms floor — a 64%-of-range
      // jump inside one and a half frames, which the linter reported as POPPING
      // and which looked like a flicker.
      const antMs = ctx.frameMs * 3;
      const mainMs = Math.max(150, perMs - antMs);
      pushY(id, { t: at, value: lineH, bezier: CURVES.anticipate });
      pushY(id, { t: at + antMs, value: lineH * 1.09, bezier: CURVES.snap });
      pushY(id, { t: at + antMs + mainMs * 0.68, value: -lineH * 0.28, bezier: CURVES.settle });
      pushY(id, { t: at + antMs + mainMs, value: 0, bezier: CURVES.settle });

      calls.push(fadeIn(ctx, id, at, perMs * 0.7));
      calls.push(...blurIfFast(ctx, id, lineH, perMs));

      // The displacement. Every line ALREADY PRESENT moves up by one line when
      // this one arrives, and they move together on the same frame — which is
      // the mechanism. Staggering the shove would make them independent
      // elements that happen to move; moving together makes them a stack.
      for (let j = 0; j < i; j++) {
        const above = ids[j]!;
        const restingOffset = -(i - j) * lineH;
        const prevOffset = -(i - 1 - j) * lineH;
        // Start the shove only after the previous one on this line has landed,
        // so consecutive pushes never share an interval.
        const shoveAt = Math.max(at, (arriveAt[i - 1] ?? at) + perMs * 0.5);
        pushY(above, { t: shoveAt, value: prevOffset, bezier: CURVES.snap });
        // The shove overshoots slightly and comes back — a stack being pushed
        // has give. Without it the block reads as a scroll position being set
        // rather than as paper being displaced.
        pushY(above, { t: shoveAt + perMs * 0.66, value: restingOffset - lineH * 0.06, bezier: CURVES.settle });
        pushY(above, { t: shoveAt + perMs, value: restingOffset, bezier: CURVES.settle });

        // The topmost lines fade as they leave the reading zone. Only the ones
        // more than three lines up — fading everything makes the stack a
        // gradient, and the effect is a stack, not a gradient.
        // ONCE. Emitting this on every subsequent shove produced four
        // overlapping 100 → 22 tracks on one layer; they merge, and the merged
        // key list snapped back to 100 between them inside a single frame. The
        // linter called it POPPING and it was right — it was a strobe.
        if (i - j >= 3 && !dimmed.has(above)) {
          dimmed.add(above);
          calls.push(
            track(above, 'opacity', [
              { t: offsetFor(ctx, 'opacity', shoveAt), value: 100, bezier: CURVES.exit },
              { t: shoveAt + perMs, value: 22, bezier: CURVES.exit },
            ]),
          );
        }
      }
    });

    // Emit each line's whole vertical life as one sorted track, dropping any key
    // that lands inside a frame of the one before it — those are the collisions
    // that read as a pop, and the earlier key is the one that has a curve
    // leading into it.
    for (const [id, keys] of yKeys) {
      const sorted = [...keys].sort((a, b) => a.t - b.t);
      const clean: typeof sorted = [];
      for (const k of sorted) {
        const prev = clean[clean.length - 1];
        if (prev && k.t - prev.t < ctx.frameMs) {
          if (Math.abs(k.value - prev.value) > 0.5) clean[clean.length - 1] = { ...k, t: prev.t };
          continue;
        }
        clean.push(k);
      }
      if (clean.length >= 2) {
        calls.push(track(id, 'y', clean as { t: number; value: number; bezier?: [number, number, number, number] }[]));
      }
    }

    // Follow-through on the last arrival: the whole stack settles once more
    // after the final push, which is what makes the sequence end rather than
    // simply stop.
    const last = ids[ids.length - 1]!;
    const endMs = ctx.startMs + spanMs + perMs;
    if (endMs < ctx.startMs + ctx.durationMs) {
      calls.push(
        followThrough(ctx, last, 'scale', {
          restValue: 1,
          amount: 0.014,
          settleMs: endMs,
          durationMs: Math.min(perMs * 0.6, ctx.startMs + ctx.durationMs - endMs),
        }),
      );
    }

    return calls;
  },
};

// ── kinetic_type.word_swap ────────────────────────────────────────────

export const wordSwap: TechniqueDef = {
  id: 'kinetic_type.word_swap',
  category: 'kinetic_type',
  displayName: 'Word Swap',
  intent: 'One line stays put while the words in it are exchanged, each replacement cutting in on the beat.',
  tags: ['kinetic', 'typographic', 'punchy', 'advertising', '2d', 'substitution'],
  energy: [0.5, 0.95],
  dimensionality: '2d',
  params: {
    beatsPerSwap: { kind: 'number', default: 1, min: 0.5, max: 4 },
    slideFraction: { kind: 'number', default: 0.045, min: 0, max: 0.2 },
  },
  roles: ['headline', 'overline', 'subhead'],
  requires: ['set_keyframes'],
  minDurationMs: 1400,
  maxDurationMs: 7000,
  approxLayerCount: 0,
  approxToolCalls: 14,
  antipatterns: {
    neverUnderMs: 1200,
    maxPerComposition: 1,
    neverWith: ['kinetic_type.hard_cut_stack', 'kinetic_type.word_cascade'],
  },
  variants: 4,
  markers: ['overshoot', 'anticipation', 'cross_property_offset', 'explicit_bezier', 'subframe_care', 'nonuniform_stagger'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (ids.length < 2) return calls;

    const beat = ctx.pack.pack.pacing.baseBeatMs * (p.beatsPerSwap as number);
    const slide = travel(ctx, (p.slideFraction as number) * pick(rng, [0.7, 1, 1.4]));
    // Each swap is fast — the swap is a CUT, not a crossfade. A 400ms swap is
    // two words dissolving; a 130ms swap is one word replacing another.
    //
    // But it has a floor of two and a half frames, and the floor is not
    // negotiable: on the fast packs `beat * 0.35` fell under one and a half
    // frames, so the outgoing word's fade covered its whole range inside a
    // single frame. That is not a fast cut, it is a dropped frame, and the
    // linter reported it as POPPING. A cut this short belongs on a `hold`, which
    // is what the incoming word's opacity already uses.
    const swapMs = Math.max(ctx.frameMs * 2.5, Math.min(150, beat * 0.35));
    const dir = pick(rng, [1, -1]);

    // Arrival times up front, because each word's exit is defined by the NEXT
    // word's arrival and a word cannot be leaving while it is still arriving.
    //
    // The first version computed them inside the loop and started the exit at
    // `at_next - swapMs` regardless. On the fast packs that landed inside the
    // outgoing word's own arrival, so its `y` channel carried an arrival track
    // and an exit track over the same interval; merged, they swung 70px in 30ms.
    // POPPING, and it looked like a dropped frame.
    const span = Math.min(beat * ids.length, ctx.durationMs * 0.8);
    const arrivals = ids.map((_, i) => ctx.startMs + staggerAt(ctx, i, ids.length, span));

    ids.forEach((id, i) => {
      const at = arrivals[i]!;
      const nextAt = arrivals[i + 1];
      // The exit begins when the next word is one swap away — or, if that would
      // land inside this word's own arrival, as late as it can without
      // colliding.
      const exitAt = nextAt === undefined ? undefined : nextAt - swapMs;
      // At least four frames, so the three-key shape above never compresses into
      // one frame, and never longer than the gap to this word's own exit.
      const arriveMs = Math.max(
        ctx.frameMs * 4,
        Math.min(swapMs * 2.2, exitAt === undefined ? swapMs * 2.2 : exitAt - offsetFor(ctx, 'y', at) - ctx.frameMs * 2),
      );

      // One `y` timeline per word: in, rest, out. The rest is a real hold, which
      // is what gives the sequence its beat — a word that drifts between swaps
      // reads as unsettled rather than as placed.
      // EVERY key on this channel is measured from the offset start, not just
      // the first two. Mixing `offsetFor(at)` for the head of the move and bare
      // `at` for its tail made the four keys non-monotonic whenever the position
      // lead exceeded the move's own length — the sorted result then zig-zagged
      // 44px inside a frame, twelve times per composition.
      const y0 = offsetFor(ctx, 'y', at);
      const yKeys: { t: number; value: number; bezier?: [number, number, number, number]; easing?: string }[] = [
        { t: y0, value: slide * dir, bezier: CURVES.anticipate },
        { t: y0 + ctx.frameMs * 1.5, value: slide * dir * 1.12, bezier: CURVES.snap },
        { t: y0 + ctx.frameMs * 1.5 + (arriveMs - ctx.frameMs * 1.5) * 0.66, value: -slide * dir * 0.3, bezier: CURVES.settle },
        { t: y0 + arriveMs, value: 0, bezier: CURVES.settle },
      ];
      if (exitAt !== undefined && exitAt > y0 + arriveMs + ctx.frameMs) {
        yKeys.push({ t: exitAt, value: 0, easing: 'hold' });
        yKeys.push({ t: exitAt + swapMs, value: -slide * dir, bezier: CURVES.exit });
      }
      calls.push(track(id, 'y', yKeys));

      // Opacity cuts. `hold` on both ends: this is a substitution, and a word
      // that fades in has been dissolved to, not cut to.
      const opKeys: { t: number; value: number; easing: string }[] = [
        { t: offsetFor(ctx, 'opacity', at), value: 0, easing: 'hold' },
        { t: offsetFor(ctx, 'opacity', at) + ctx.frameMs, value: 100, easing: 'hold' },
      ];
      if (exitAt !== undefined) {
        opKeys.push({ t: exitAt + swapMs * 0.6, value: 100, easing: 'hold' });
        opKeys.push({ t: exitAt + swapMs * 0.6 + ctx.frameMs, value: 0, easing: 'hold' });
      }
      calls.push(track(id, 'opacity', opKeys));

      // Hold the word still between arriving and leaving. Motion that never
      // stops has no rhythm, and this technique is entirely rhythm.
      const restEnd = exitAt ?? Math.min(at + beat, ctx.startMs + ctx.durationMs);
      if (restEnd > y0 + arriveMs + ctx.frameMs) {
        calls.push(hold(id, 'scale', 1, y0 + arriveMs, restEnd));
      }
    });

    return calls;
  },
};

// ── kinetic_type.marquee_band ─────────────────────────────────────────

export const marqueeBand: TechniqueDef = {
  id: 'kinetic_type.marquee_band',
  category: 'kinetic_type',
  displayName: 'Marquee Band',
  intent: 'A band of type scrolls across the frame at constant speed and never stops.',
  tags: ['kinetic', 'typographic', 'ambient', 'streetwear', 'ticker', '2d', 'loop'],
  energy: [0.3, 0.7],
  dimensionality: '2d',
  params: {
    speedFraction: { kind: 'number', default: 0.35, min: 0.05, max: 1.2 },
    bandCount: { kind: 'number', default: 2, min: 1, max: 4 },
  },
  roles: ['overline', 'support', 'rule'],
  requires: ['set_keyframes', 'create_mask'],
  minDurationMs: 2000,
  maxDurationMs: 20000,
  approxLayerCount: 0,
  approxToolCalls: 8,
  antipatterns: { neverUnderMs: 1800, maxPerComposition: 1 },
  variants: 3,
  // A marquee is a CONSTANT-VELOCITY loop. It genuinely has no overshoot and no
  // anticipation, and claiming either would be a lie the marker test would
  // catch. What it does have is cross-property offset, per-band phase and
  // sub-frame placement — a ticker quantised to frames judders visibly.
  markers: ['explicit_bezier', 'cross_property_offset', 'nonuniform_stagger', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const speed = (p.speedFraction as number) * pick(rng, [0.75, 1, 1.3]);
    const distance = ctx.width * (1 + speed);

    ids.forEach((id, i) => {
      // Alternate bands travel opposite ways. Same-direction bands read as one
      // sheet sliding; opposing bands read as a machine.
      const dir = i % 2 === 0 ? -1 : 1;
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, Math.min(400, ctx.durationMs * 0.2));
      calls.push(mk('create_mask', { nodeId: id, shape: 'rectangle', mode: 'add', feather: 0 }));

      // `glide`, not linear — but only just. A marquee wants near-constant
      // velocity; a visible ease-out at the end of the travel would read as the
      // band arriving somewhere, which it never does.
      calls.push(
        track(id, 'x', [
          { t: subFrame(at, ctx.frameMs, 0.5), value: (ctx.width * 0.5 + 40) * -dir, bezier: CURVES.glide },
          { t: ctx.startMs + ctx.durationMs, value: distance * dir, bezier: CURVES.glide },
        ]),
      );
      // Opacity is a hold, not a fade: the band exists or it does not. Offset
      // from the travel so the two channels do not start on the same frame.
      calls.push(
        track(id, 'opacity', [
          { t: offsetFor(ctx, 'opacity', at), value: 0, easing: 'hold' },
          { t: offsetFor(ctx, 'opacity', at) + ctx.frameMs, value: 100, easing: 'hold' },
        ]),
      );
    });

    return calls;
  },
};

// ── kinetic_type.stack_collapse ───────────────────────────────────────

export const stackCollapse: TechniqueDef = {
  id: 'kinetic_type.stack_collapse',
  category: 'kinetic_type',
  displayName: 'Stack Collapse',
  intent: 'Lines pile up spread apart, then snap together into a single tight block.',
  tags: ['kinetic', 'typographic', 'bold', 'resolve', '2d', 'convergence'],
  energy: [0.55, 1],
  dimensionality: '2d',
  params: {
    spreadFraction: { kind: 'number', default: 0.16, min: 0.05, max: 0.45 },
    holdBeforeMs: { kind: 'number', default: 320, min: 0, max: 1500 },
  },
  // Same reasoning as `line_push_stack`: ten targets is not a stack, it is a
  // crowd, and the stagger cannot give ten arrivals a readable order inside the
  // slot this technique declares.
  roles: ['headline', 'subhead', 'stat'],
  requires: ['set_keyframes', 'set_motion_blur'],
  minDurationMs: 1300,
  maxDurationMs: 5000,
  approxLayerCount: 0,
  approxToolCalls: 16,
  antipatterns: {
    neverUnderMs: 1100,
    maxPerComposition: 1,
    requiresBreathingRoomMs: 250,
    neverWith: ['kinetic_type.line_push_stack', 'entrance.scale_pop_soft'],
  },
  variants: 4,
  markers: ['overshoot', 'anticipation', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger', 'follow_through', 'motion_blur', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (ids.length < 2) return calls;

    const spread = ctx.height * (p.spreadFraction as number) * pick(rng, [0.8, 1, 1.25]);
    const holdMs = p.holdBeforeMs as number;
    // The span has to scale with how many lines there are. A flat 420ms budget
    // put six entries inside the linter's simultaneity window — six things
    // arriving at once, which is precisely the block-arrival this technique is
    // supposed to resolve INTO, not start from.
    const arriveSpan = Math.min(ctx.durationMs * 0.45, 200 + ids.length * 110);
    // The collapse must begin after the LAST line has arrived, not after a
    // nominal span. Deriving it from `arriveSpan` meant late arrivals were still
    // running their entrance when the collapse started, so two `y` phases wrote
    // interleaved keys on one channel — POPPING, and visibly a stutter.
    const arrivals = ids.map((_, i) => ctx.startMs + staggerAt(ctx, i, ids.length, arriveSpan));
    const lastArrival = Math.max(...arrivals);
    const collapseAt = Math.min(
      lastArrival + Math.max(200, arriveSpan * 0.3) + holdMs,
      ctx.startMs + ctx.durationMs * 0.72,
    );
    // The collapse is the beat. It is fast and everything lands together —
    // a staggered collapse is not a collapse, it is a settle.
    const collapseMs = Math.min(260, Math.max(140, ctx.durationMs * 0.14));
    const mid = (ids.length - 1) / 2;

    ids.forEach((id, i) => {
      const offset = (i - mid) * (spread / Math.max(1, ids.length - 1)) * ids.length;
      const at = arrivals[i]!;

      // Phase 1 — arrive spread out.
      calls.push(
        heroMove(ctx, id, 'y', {
          from: offset * 1.6,
          to: offset,
          startMs: offsetFor(ctx, 'y', at),
          // Clamp so no entrance can still be running when the collapse starts.
          durationMs: Math.max(160, Math.min(arriveSpan * 0.8, collapseAt - at - ctx.frameMs * 2)),
          anticipation: 0.1,
          overshoot: 0.26,
        }),
      );
      calls.push(fadeIn(ctx, id, at, arriveSpan * 0.7));

      // Phase 2 — the collapse. Sub-frame, because everything moving on one
      // frame boundary is exactly the quantisation this needs to avoid: the
      // whole read is that the lines arrive together but not mechanically.
      calls.push(
        track(id, 'y', [
          { t: subFrame(collapseAt, ctx.frameMs, i % 2 === 0 ? 0.3 : 0.6), value: offset, bezier: CURVES.anticipate },
          // Past the tight position, then back. Lines that stop exactly on the
          // block have no mass; this is the whole reason the collapse lands.
          { t: collapseAt + collapseMs * 0.7, value: -offset * 0.1, bezier: CURVES.settle },
          { t: collapseAt + collapseMs, value: 0, bezier: CURVES.settle },
        ]),
      );
      calls.push(...blurIfFast(ctx, id, Math.abs(offset), collapseMs));

      // Follow-through on the outer lines only. The ones near the centre barely
      // travelled, and giving them the same wobble makes the block breathe as
      // one soft object rather than snap as a hard one.
      if (Math.abs(i - mid) > 0.5) {
        calls.push(
          followThrough(ctx, id, 'scale', {
            restValue: 1,
            amount: 0.01 * Math.sign(i - mid),
            settleMs: collapseAt + collapseMs,
            durationMs: collapseMs * 0.8,
          }),
        );
      }
    });

    return calls;
  },
};

export const KINETIC_TECHNIQUES_2: readonly TechniqueDef[] = [
  linePushStack,
  wordSwap,
  marqueeBand,
  stackCollapse,
];
