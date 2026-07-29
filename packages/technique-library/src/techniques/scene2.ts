/**
 * Camera, background, transition, emphasis and exit techniques, second set.
 *
 * Three rules learned the hard way while writing the first two expansion files,
 * all of them enforced by the timing linter rather than by memory:
 *
 *  1. **One timeline per node+property.** Tracks with the same node and prop
 *     merge, so two emitters writing overlapping intervals on one channel
 *     produce an interleaved key list that disagrees with itself. Build the
 *     whole channel, then emit it once.
 *  2. **Every key measured from the same origin.** Mixing `offsetFor(at)` for
 *     the head of a move and bare `at` for its tail makes the keys
 *     non-monotonic as soon as the property lead exceeds the move length.
 *  3. **Declare only the roles the technique can actually orchestrate.** A
 *     technique that lists six roles is handed nineteen layers by a full
 *     layout, and no stagger fits nineteen arrivals into a two-second slot.
 */

import { mk, mulberry32, pick, type ToolCall } from '@motion/design-system';
import type { TechniqueDef } from '../schema';
import {
  CURVES, emitCamera, enterCameraSpace, blurIfFast, fadeOut, followThrough, heroMove, hold,
  offsetFor, rolesTargets, staggerAt, subFrame, track, travel,
} from '../emit';

// ── camera.whip_pan ───────────────────────────────────────────────────

export const whipPan: TechniqueDef = {
  id: 'camera.whip_pan',
  category: 'camera',
  // There is exactly one camera per composition — see `exclusiveResource`.
  exclusiveResource: 'camera',
  displayName: 'Whip Pan',
  intent: 'The camera snaps sideways fast enough to smear, and lands on the next subject.',
  tags: ['camera', 'fast', 'energetic', 'documentary', '2.5d', 'transition'],
  energy: [0.7, 1],
  dimensionality: '2.5d',
  params: {
    throwFraction: { kind: 'number', default: 0.55, min: 0.15, max: 1.5 },
    settleMs: { kind: 'number', default: 260, min: 90, max: 800 },
  },
  roles: ['camera', 'background', 'media', 'headline'],
  requires: ['create_layer', 'set_keyframes', 'set_motion_blur'],
  minDurationMs: 700,
  maxDurationMs: 2600,
  approxLayerCount: 1,
  approxToolCalls: 8,
  antipatterns: {
    neverUnderMs: 600,
    maxPerComposition: 2,
    requiresBreathingRoomMs: 400,
    neverWith: ['camera.push_in_slow', 'camera.drift_parallax', 'camera.handheld_float'],
  },
  variants: 3,
  markers: ['overshoot', 'anticipation', 'cross_property_offset', 'explicit_bezier', 'motion_blur', 'subframe_care', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const camId = `${ctx.idPrefix}_whipcam`;
    const dir = pick(rng, [1, -1]);
    // The pack decides how hard the whip is. Without this the emitter produced
    // byte-identical calls in `luxury_film` and `broadcast_sports` — which makes
    // the whole LookPack layer cosmetic, and it is not supposed to be.
    const sig = ctx.pack.pack.motionSignature;
    const throwPx = travel(ctx, p.throwFraction as number) * pick(rng, [0.8, 1, 1.25]) * (0.7 + sig.overshootBias * 0.7);
    // A restrained pack settles LONGER, an energetic one lands and stops.
    const settleMs = Math.min((p.settleMs as number) * (1.35 - sig.overshootBias * 0.5), ctx.durationMs * 0.45);
    const overshootPast = 1 + 0.1 * sig.overshootBias;
    // The whip itself is 4–6 frames. Longer and it is a pan; the smear IS the
    // technique, and a smear needs the move to outrun the shutter. A pack that
    // cuts hard whips at the short end of that range.
    const whipFrames = 6 - Math.round(ctx.pack.pack.pacing.cutBias * 2);
    const whipMs = Math.max(ctx.frameMs * 4, Math.min(ctx.frameMs * whipFrames, ctx.durationMs * 0.2));
    const t0 = ctx.startMs;

    // Wide, because apparent angular speed is what sells a whip — a long lens
    // moving the same distance barely changes what is on screen.
    calls.push(...emitCamera(ctx, camId, 'Whip Camera', 'wide').calls);
    // A whip pans the CAMERA; a 2D layer does not answer to it at all.
    calls.push(...enterCameraSpace(ctx, whipPan.roles));
    // Composition shutter wide open for the duration — this is the one technique
    // where the blur is not a garnish.
    calls.push(mk('set_motion_blur', { nodeId: camId, enabled: true }));

    calls.push(
      track(camId, 'x', [
        // Anticipation the other way, four frames of it. A whip with no wind-up
        // is a cut with a smear on it.
        { t: t0, value: 0, bezier: CURVES.anticipate },
        { t: t0 + ctx.frameMs * 3, value: -throwPx * 0.12 * dir, bezier: CURVES.snap },
        // Past the mark and back. An operator overshoots; a keyframe does not.
        { t: subFrame(t0 + ctx.frameMs * 3 + whipMs, ctx.frameMs, 0.4), value: throwPx * overshootPast * dir, bezier: CURVES.settle },
        { t: t0 + ctx.frameMs * 3 + whipMs + settleMs, value: throwPx * dir, bezier: CURVES.settle },
      ]),
    );
    // A trace of vertical, offset from the horizontal so the two axes do not
    // start together. A perfectly horizontal whip reads as a slide transition.
    calls.push(
      track(camId, 'y', [
        { t: offsetFor(ctx, 'y', t0), value: 0, bezier: CURVES.glide },
        { t: t0 + ctx.frameMs * 3 + whipMs * 0.6, value: -throwPx * 0.05, bezier: CURVES.settle },
        { t: t0 + ctx.frameMs * 3 + whipMs + settleMs, value: 0, bezier: CURVES.settle },
      ]),
    );
    // The rig keeps drifting after the pan has landed.
    calls.push(
      followThrough(ctx, camId, 'orbitYaw', {
        restValue: 0,
        amount: 0.9 * dir,
        settleMs: t0 + ctx.frameMs * 3 + whipMs + settleMs,
        durationMs: Math.min(settleMs * 0.8, ctx.durationMs * 0.2),
      }),
    );

    return calls;
  },
};

// ── camera.handheld_float ─────────────────────────────────────────────

export const handheldFloat: TechniqueDef = {
  id: 'camera.handheld_float',
  category: 'camera',
  // There is exactly one camera per composition — see `exclusiveResource`.
  exclusiveResource: 'camera',
  displayName: 'Handheld Float',
  intent: 'A slow, irregular drift as if the shot were held rather than mounted.',
  tags: ['camera', 'ambient', 'documentary', 'organic', '2.5d'],
  energy: [0.1, 0.5],
  dimensionality: '2.5d',
  params: {
    amplitudeFraction: { kind: 'number', default: 0.012, min: 0.002, max: 0.06 },
    cycles: { kind: 'number', default: 3, min: 1, max: 8 },
  },
  roles: ['camera', 'background', 'media'],
  requires: ['create_layer', 'set_keyframes'],
  minDurationMs: 2200,
  maxDurationMs: 20000,
  approxLayerCount: 1,
  approxToolCalls: 5,
  antipatterns: {
    neverUnderMs: 2000,
    maxPerComposition: 1,
    neverWith: ['camera.whip_pan', 'camera.crash_zoom', 'camera.push_in_slow'],
  },
  variants: 4,
  // No overshoot and no anticipation: a handheld drift never arrives anywhere,
  // so it has neither. No `nonuniform_stagger` either — it animates ONE camera,
  // and there is nothing to stagger. What it has is three channels that never
  // share a phase.
  markers: ['explicit_bezier', 'cross_property_offset', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const camId = `${ctx.idPrefix}_handheld`;
    // The pack has to reach even the quietest technique. A restrained pack holds
    // the camera steadier and moves it more slowly; an energetic one lets it
    // wander. Ignoring the signature made this emit identical calls in every
    // pack, which is what the pack-variation test is for.
    const sig = ctx.pack.pack.motionSignature;
    const amp = travel(ctx, p.amplitudeFraction as number) * (0.6 + sig.overshootBias * 0.9);
    const cycles = Math.max(1, Math.round((p.cycles as number) * (0.7 + ctx.pack.pack.pacing.cutBias * 0.8)));

    // The documentary default. Anything longer amplifies the drift into a
    // wobble; anything wider makes the operator look drunk.
    calls.push(...emitCamera(ctx, camId, 'Handheld Camera', 'normal').calls);
    // Handheld drift is only visible on layers the camera actually projects.
    calls.push(...enterCameraSpace(ctx, handheldFloat.roles));

    // Three channels, each with its OWN period and phase. Equal periods produce
    // a Lissajous figure — a perfectly repeating loop, which is the one thing a
    // handheld shot never is. The periods here are deliberately incommensurable.
    const channels: { prop: string; period: number; amp: number; phase: number; lead: number }[] = [
      { prop: 'x', period: cycles, amp, phase: rng(), lead: 0 },
      { prop: 'y', period: cycles * 1.37, amp: amp * 0.72, phase: rng(), lead: 2 },
      { prop: 'rotation', period: cycles * 0.83, amp: 0.5 + rng() * 0.5, phase: rng(), lead: 5 },
    ];

    for (const ch of channels) {
      const steps = Math.max(4, Math.round(ch.period * 2));
      const keys: { t: number; value: number; bezier: [number, number, number, number] }[] = [];
      for (let i = 0; i <= steps; i++) {
        // Sub-frame placement on every key, jittered per index. A drift whose
        // extremes land on frame boundaries steps visibly at low amplitudes,
        // which is exactly the amplitude range this technique lives in.
        // Each channel also STARTS on a different frame. Incommensurable periods
        // stop the axes repeating together, but with a shared t0 they still all
        // begin on the same frame — and a rig whose every axis wakes up at once
        // is the tell this technique exists to remove.
        const raw = ctx.startMs + ch.lead * ctx.frameMs + (ctx.durationMs * i) / steps;
        const t = i === 0 ? raw : subFrame(raw, ctx.frameMs, 0.2 + rng() * 0.6);
        // The amplitude decays slightly across the shot — an operator settles.
        const decay = 1 - (i / steps) * 0.25;
        keys.push({
          t,
          value: Math.sin((i / steps) * ch.period * Math.PI * 2 + ch.phase * Math.PI * 2) * ch.amp * decay,
          bezier: CURVES.glide,
        });
      }
      calls.push(track(camId, ch.prop, keys));
    }

    return calls;
  },
};

// ── background.spotlight_sweep ────────────────────────────────────────

export const spotlightSweep: TechniqueDef = {
  id: 'background.spotlight_sweep',
  category: 'background',
  displayName: 'Spotlight Sweep',
  intent: 'A soft pool of light travels across the frame, lifting whatever it passes over.',
  tags: ['background', 'cinematic', 'luxury', 'ambient', '2d', 'light'],
  energy: [0.1, 0.5],
  dimensionality: '2d',
  params: {
    sizeFraction: { kind: 'number', default: 0.55, min: 0.2, max: 1.4 },
    passes: { kind: 'number', default: 1, min: 1, max: 3 },
  },
  roles: ['background'],
  requires: ['create_layer', 'create_gradient', 'set_keyframes'],
  minDurationMs: 2000,
  maxDurationMs: 16000,
  approxLayerCount: 1,
  approxToolCalls: 6,
  antipatterns: { neverUnderMs: 1800, maxPerComposition: 1, neverWith: ['background.grid_scan'] },
  variants: 3,
  // One layer, so no stagger to be non-uniform about.
  markers: ['explicit_bezier', 'cross_property_offset', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const poolId = `${ctx.idPrefix}_pool`;
    const size = Math.round(Math.max(ctx.width, ctx.height) * (p.sizeFraction as number) * pick(rng, [0.8, 1, 1.25]));
    const passes = Math.max(1, Math.round(p.passes as number));
    const dir = pick(rng, [1, -1]);

    calls.push(
      mk('create_layer', {
        id: poolId, kind: 'shape', shape: 'ellipse', name: 'Light Pool',
        width: size, height: Math.round(size * 0.8), fill: ctx.pack.palette.accent,
      }),
    );
    calls.push(
      mk('create_gradient', {
        nodeId: poolId,
        type: 'radial',
        stops: [
          { offset: 0, color: ctx.pack.palette.accent },
          { offset: 1, color: ctx.pack.palette.bg },
        ],
      }),
    );

    // The pool crosses the frame `passes` times, and each pass is SLOWER than
    // the last. Equal passes read as a loop; decelerating passes read as light
    // coming to rest.
    const xKeys: { t: number; value: number; bezier: [number, number, number, number] }[] = [];
    const total = passes * 2;
    let acc = 0;
    const weights = Array.from({ length: total }, (_, i) => 1 + i * 0.35);
    const weightSum = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i <= total; i++) {
      const t = ctx.startMs + (acc / weightSum) * ctx.durationMs;
      xKeys.push({
        t: i === 0 ? t : subFrame(t, ctx.frameMs, 0.5),
        value: (i % 2 === 0 ? -1 : 1) * dir * ctx.width * 0.62,
        bezier: CURVES.glide,
      });
      acc += weights[i] ?? 0;
    }
    calls.push(track(poolId, 'x', xKeys));

    // Opacity breathes on its own schedule — offset from the travel, and with
    // fewer inflections, so the two never peak together.
    calls.push(
      track(poolId, 'opacity', [
        { t: offsetFor(ctx, 'opacity', ctx.startMs), value: 0, bezier: CURVES.settle },
        { t: ctx.startMs + ctx.durationMs * 0.22, value: 34, bezier: CURVES.glide },
        { t: ctx.startMs + ctx.durationMs * 0.68, value: 22, bezier: CURVES.glide },
        { t: ctx.startMs + ctx.durationMs, value: 0, bezier: CURVES.exit },
      ]),
    );

    return calls;
  },
};

// ── background.noise_field ────────────────────────────────────────────

export const noiseField: TechniqueDef = {
  id: 'background.noise_field',
  category: 'background',
  displayName: 'Noise Field',
  intent: 'A living grain sits over the whole frame and keeps the image from looking rendered.',
  tags: ['background', 'texture', 'film', 'analogue', '2d', 'grain'],
  energy: [0.05, 0.6],
  dimensionality: '2d',
  params: {
    intensity: { kind: 'number', default: 14, min: 2, max: 60 },
    driftFraction: { kind: 'number', default: 0.02, min: 0, max: 0.12 },
  },
  roles: ['background'],
  requires: ['create_layer', 'add_effect', 'set_keyframes'],
  minDurationMs: 1200,
  maxDurationMs: 30000,
  approxLayerCount: 1,
  approxToolCalls: 6,
  antipatterns: { neverUnderMs: 900, maxPerComposition: 1 },
  variants: 3,
  // One layer — same reason as `spotlight_sweep`.
  markers: ['explicit_bezier', 'cross_property_offset', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const grainId = `${ctx.idPrefix}_grain`;
    const intensity = (p.intensity as number) * pick(rng, [0.7, 1, 1.4]);
    const drift = travel(ctx, p.driftFraction as number);

    calls.push(
      mk('create_layer', {
        id: grainId, kind: 'solid', name: 'Grain',
        width: Math.round(ctx.width * 1.1), height: Math.round(ctx.height * 1.1),
        fill: ctx.pack.palette.muted,
      }),
    );
    calls.push(mk('add_effect', { nodeId: grainId, type: 'fractal-noise', amount: intensity }));

    // Grain that holds still is a texture; grain that moves is film. The steps
    // are irregular in both time and value — a regular cadence reads as a
    // repeating tile, which is the one thing grain must never look like.
    const steps = 7;
    const keys: { t: number; value: number; bezier: [number, number, number, number] }[] = [];
    for (let i = 0; i <= steps; i++) {
      const raw = ctx.startMs + (ctx.durationMs * i) / steps;
      keys.push({
        t: i === 0 ? raw : subFrame(raw, ctx.frameMs, 0.15 + rng() * 0.7),
        value: (rng() - 0.5) * 2 * drift,
        bezier: CURVES.glide,
      });
    }
    calls.push(track(grainId, 'x', keys));
    calls.push(
      track(grainId, 'opacity', [
        { t: offsetFor(ctx, 'opacity', ctx.startMs), value: 0, bezier: CURVES.settle },
        { t: ctx.startMs + Math.min(400, ctx.durationMs * 0.2), value: 100, bezier: CURVES.settle },
      ]),
    );
    calls.push(hold(grainId, 'scale', 1.1, ctx.startMs, ctx.startMs + ctx.durationMs));

    return calls;
  },
};

// ── transition.iris ───────────────────────────────────────────────────

export const iris: TechniqueDef = {
  id: 'transition.iris',
  category: 'transition',
  displayName: 'Iris',
  intent: 'A circle closes on the subject and opens again on what comes next.',
  tags: ['transition', 'classic', 'cinematic', 'graphic', '2d', 'mask'],
  energy: [0.35, 0.8],
  dimensionality: '2d',
  params: {
    holdClosedMs: { kind: 'number', default: 120, min: 0, max: 800 },
    offCentre: { kind: 'boolean', default: true },
  },
  roles: ['background', 'media', 'headline'],
  requires: ['create_mask', 'set_keyframes'],
  minDurationMs: 600,
  maxDurationMs: 2400,
  approxLayerCount: 0,
  approxToolCalls: 8,
  antipatterns: {
    neverUnderMs: 500,
    maxPerComposition: 1,
    neverWith: ['transition.glitch_slam', 'transition.rule_wipe'],
  },
  variants: 3,
  markers: ['overshoot', 'anticipation', 'cross_property_offset', 'explicit_bezier', 'subframe_care', 'nonuniform_stagger'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    // The seed picks how the aperture is weighted between closing and opening,
    // and how far past the mark it goes. Without it every seed emitted the same
    // iris, which is one variant however many the definition claims.
    const holdMs = (p.holdClosedMs as number) * pick(rng, [0.6, 1, 1.5]);
    const closeShare = pick(rng, [0.35, 0.45, 0.58]);
    const bloom = pick(rng, [1.03, 1.06, 1.1]);
    const closeMs = Math.max(ctx.frameMs * 5, (ctx.durationMs - holdMs) * closeShare);
    const openAt = ctx.startMs + closeMs + holdMs;
    const openMs = Math.max(ctx.frameMs * 5, ctx.durationMs - closeMs - holdMs);

    ids.forEach((id, i) => {
      // Each layer's iris is offset slightly — a single shared iris across every
      // layer is one shape, and the layers behind it would be invisible anyway.
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, Math.min(ctx.frameMs * 4 * ids.length, closeMs * 0.4));
      calls.push(mk('create_mask', { nodeId: id, shape: 'ellipse', mode: 'add', feather: (p.offCentre as boolean) ? 4 : 0 }));

      // The iris is a scale on the masked content: closing past the subject and
      // easing back is what makes it read as an aperture rather than a wipe.
      calls.push(
        track(id, 'scale', [
          { t: at, value: 1, bezier: CURVES.anticipate },
          { t: at + ctx.frameMs * 2, value: bloom, bezier: CURVES.snap },
          { t: subFrame(at + closeMs, ctx.frameMs, 0.4), value: 0.02, bezier: CURVES.settle },
          { t: openAt, value: 0.02, easing: 'hold' },
          { t: openAt + openMs * 0.72, value: bloom, bezier: CURVES.settle },
          { t: openAt + openMs, value: 1, bezier: CURVES.settle },
        ]),
      );
      calls.push(
        track(id, 'opacity', [
          { t: offsetFor(ctx, 'opacity', at), value: 100, bezier: CURVES.exit },
          { t: at + closeMs, value: 100, easing: 'hold' },
          { t: openAt, value: 100, easing: 'hold' },
        ]),
      );
    });

    return calls;
  },
};

// ── emphasis.highlight_sweep ──────────────────────────────────────────

export const highlightSweep: TechniqueDef = {
  id: 'emphasis.highlight_sweep',
  category: 'emphasis',
  displayName: 'Highlight Sweep',
  intent: 'A block of colour sweeps in behind a phrase and stays, marking it as the point.',
  tags: ['emphasis', 'editorial', 'graphic', 'marker', '2d'],
  energy: [0.3, 0.8],
  dimensionality: '2d',
  params: {
    heightFraction: { kind: 'number', default: 0.055, min: 0.02, max: 0.16 },
    sweepMs: { kind: 'number', default: 280, min: 90, max: 900 },
  },
  roles: ['headline', 'quote', 'overline'],
  requires: ['create_layer', 'set_keyframes'],
  minDurationMs: 600,
  maxDurationMs: 4000,
  approxLayerCount: 1,
  approxToolCalls: 7,
  antipatterns: {
    neverUnderMs: 500,
    maxPerComposition: 2,
    neverWith: ['emphasis.rule_underline', 'emphasis.hairline_draw'],
  },
  variants: 3,
  markers: ['overshoot', 'anticipation', 'cross_property_offset', 'explicit_bezier', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const barId = `${ctx.idPrefix}_hl`;
    const h = Math.round(ctx.height * (p.heightFraction as number) * pick(rng, [0.85, 1, 1.2]));
    const w = Math.round(ctx.width * pick(rng, [0.32, 0.42, 0.55]));
    const sweepMs = Math.max(ctx.frameMs * 5, Math.min(p.sweepMs as number, ctx.durationMs * 0.5));
    const at = ctx.startMs + Math.min(ctx.durationMs * 0.15, 200);

    calls.push(
      mk('create_layer', {
        id: barId, kind: 'shape', shape: 'rect', name: 'Highlight',
        width: w, height: h, fill: ctx.pack.palette.accent,
      }),
    );

    // Scale from one edge: the bar grows across, it does not appear. The
    // overshoot past full width and back is what makes it read as a marker pen
    // rather than as a rectangle being revealed.
    calls.push(
      heroMove(ctx, barId, 'scaleX', {
        from: 0,
        to: 1,
        startMs: subFrame(at, ctx.frameMs, 0.4),
        durationMs: sweepMs,
        anticipation: 0,
        overshoot: 0.16,
      }),
    );
    // Height leads by a frame and settles first — the pen touches down before it
    // travels.
    calls.push(
      heroMove(ctx, barId, 'scaleY', {
        from: 0.55,
        to: 1,
        startMs: offsetFor(ctx, 'scale', at) - ctx.frameMs,
        // Six frames minimum. At three, the 2–4 frame anticipation `heroMove`
        // inserts consumed most of the move, so the settle covered its whole
        // range inside one frame — POPPING, and it flickered.
        durationMs: Math.max(ctx.frameMs * 6, sweepMs * 0.45),
        anticipation: 0.14,
        overshoot: 0.2,
      }),
    );
    calls.push(hold(barId, 'opacity', 100, at, ctx.startMs + ctx.durationMs));

    return calls;
  },
};

// ── exit.fall_away ────────────────────────────────────────────────────

export const fallAway: TechniqueDef = {
  id: 'exit.fall_away',
  category: 'exit',
  displayName: 'Fall Away',
  intent: 'Elements drop out of frame under gravity, the heaviest first.',
  tags: ['exit', 'physical', 'playful', '2d', 'gravity'],
  energy: [0.4, 0.9],
  dimensionality: '2d',
  params: {
    spanMs: { kind: 'number', default: 420, min: 100, max: 1600 },
    tumble: { kind: 'boolean', default: true },
  },
  roles: ['headline', 'subhead', 'support', 'stat'],
  requires: ['set_keyframes', 'set_motion_blur'],
  minDurationMs: 600,
  maxDurationMs: 2600,
  approxLayerCount: 0,
  approxToolCalls: 12,
  antipatterns: { neverUnderMs: 500, maxPerComposition: 1, neverWith: ['exit.lift_out'] },
  variants: 4,
  // No overshoot: something falling out of frame never comes back, and the
  // linter exempts exits for exactly that reason.
  markers: ['anticipation', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger', 'motion_blur'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const spanMs = Math.min(p.spanMs as number, ctx.durationMs * 0.5);
    // Capped, not "whatever is left". Spreading the drop across a 2.2s slot put
    // it at 370px/s — under the motion-blur threshold, and visually a slide. A
    // fall is over in well under a second; the rest of the slot is the empty
    // frame afterwards, which is part of the point.
    const dropMs = Math.min(Math.max(ctx.frameMs * 6, ctx.durationMs - spanMs), 620);
    const tumble = p.tumble as boolean;

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
      const distance = ctx.height * 0.75;

      // Gravity: the first third of the fall covers a ninth of the distance.
      // That ratio is the whole read — a linear drop looks like a slide and an
      // eased drop looks like a fade with extra steps.
      calls.push(
        track(id, 'y', [
          { t: at, value: 0, bezier: CURVES.anticipate },
          // A beat of hang before it goes. Things do not start falling at speed.
          { t: at + ctx.frameMs * 3, value: -ctx.height * 0.012, bezier: CURVES.snap },
          { t: at + ctx.frameMs * 3 + dropMs / 3, value: distance / 9, bezier: CURVES.exit },
          { t: at + ctx.frameMs * 3 + dropMs, value: distance, bezier: CURVES.exit },
        ]),
      );
      calls.push(fadeOut(ctx, id, offsetFor(ctx, 'opacity', at + dropMs * 0.55), dropMs * 0.45));
      if (tumble) {
        // Rotation accelerates too, and each element tumbles a different way —
        // a set that all rotates the same direction reads as one sheet.
        const spin = (28 + rng() * 46) * (rng() > 0.5 ? 1 : -1);
        calls.push(
          track(id, 'rotation', [
            { t: offsetFor(ctx, 'rotation', at), value: 0, bezier: CURVES.exit },
            { t: at + dropMs * 0.5, value: spin * 0.22, bezier: CURVES.exit },
            { t: at + dropMs, value: spin, bezier: CURVES.exit },
          ]),
        );
      }
      calls.push(...blurIfFast(ctx, id, distance, dropMs));
    });

    return calls;
  },
};

// ── exit.scatter_out ──────────────────────────────────────────────────

export const scatterOut: TechniqueDef = {
  id: 'exit.scatter_out',
  category: 'exit',
  displayName: 'Scatter Out',
  intent: 'Elements fly apart in every direction at once, clearing the frame in a beat.',
  tags: ['exit', 'explosive', 'energetic', 'broadcast', '2d'],
  energy: [0.65, 1],
  dimensionality: '2d',
  params: {
    forceFraction: { kind: 'number', default: 0.6, min: 0.2, max: 1.5 },
    spanMs: { kind: 'number', default: 180, min: 40, max: 700 },
  },
  roles: ['headline', 'subhead', 'stat', 'list', 'mark'],
  requires: ['set_keyframes', 'set_motion_blur'],
  minDurationMs: 400,
  maxDurationMs: 1600,
  approxLayerCount: 0,
  approxToolCalls: 14,
  antipatterns: {
    neverUnderMs: 350,
    maxPerComposition: 1,
    neverWith: ['exit.lift_out', 'exit.fall_away'],
  },
  variants: 4,
  markers: ['anticipation', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger', 'motion_blur', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const force = travel(ctx, p.forceFraction as number);
    const spanMs = Math.min(p.spanMs as number, ctx.durationMs * 0.4);
    // Same reasoning as `fall_away`: a scatter that takes a second is a drift.
    const flyMs = Math.min(Math.max(ctx.frameMs * 5, ctx.durationMs - spanMs), 420);

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
      // Directions spread around the circle from the seed, never on a grid. An
      // even fan is a starburst graphic; an uneven one is a scatter.
      const angle = (i / ids.length) * Math.PI * 2 + rng() * 1.1;
      const speed = force * (0.7 + rng() * 0.7);
      const dx = Math.cos(angle) * speed;
      const dy = Math.sin(angle) * speed;

      for (const [prop, delta] of [['x', dx], ['y', dy]] as const) {
        calls.push(
          track(id, prop, [
            { t: offsetFor(ctx, prop, at), value: 0, bezier: CURVES.anticipate },
            // Compress toward the centre for two frames before flying out. The
            // compression is what gives the scatter its sense of release.
            { t: offsetFor(ctx, prop, at) + ctx.frameMs * 2, value: -delta * 0.07, bezier: CURVES.snap },
            { t: subFrame(at + flyMs, ctx.frameMs, 0.5), value: delta, bezier: CURVES.exit },
          ]),
        );
      }
      calls.push(fadeOut(ctx, id, at + flyMs * 0.4, flyMs * 0.6));
      calls.push(...blurIfFast(ctx, id, speed, flyMs));
    });

    return calls;
  },
};

export const SCENE_TECHNIQUES_2: readonly TechniqueDef[] = [
  whipPan,
  handheldFloat,
  spotlightSweep,
  noiseField,
  iris,
  highlightSweep,
  fallAway,
  scatterOut,
];
