/**
 * Techniques, third set.
 *
 * Same bar, and by now the failure modes are known well enough to state as
 * rules — every one of these was a real defect the linters caught in an earlier
 * batch:
 *
 *  1. One timeline per node+property. Overlapping tracks on one channel merge
 *     into a key list that disagrees with itself.
 *  2. Every key on a channel measured from one origin, or the keys go
 *     non-monotonic as soon as the property lead exceeds the move length.
 *  3. Declare only the roles the technique can orchestrate. Four roles means a
 *     full layout hands you ten layers and no stagger fits them.
 *  4. Read the seed AND the pack, or the variant count and the LookPack are both
 *     decoration.
 *  5. Claim only the markers the output actually exhibits.
 */

import { mk, mulberry32, pick, type ToolCall } from '@motion/design-system';
import type { TechniqueDef } from '../schema';
import {
  CURVES, blurIfFast, emitCamera, fadeIn, fadeOut, followThrough, heroMove, hold,
  offsetFor, rolesTargets, staggerAt, subFrame, track, travel,
} from '../emit';

// ── entrance.unfold ───────────────────────────────────────────────────

export const unfold: TechniqueDef = {
  id: 'entrance.unfold',
  category: 'entrance',
  displayName: 'Unfold',
  intent: 'Elements swing open around a vertical hinge at their leading edge, like a page turning flat.',
  tags: ['entrance', 'dimensional', 'editorial', 'mechanical', '2.5d', 'rotation'],
  energy: [0.3, 0.75],
  dimensionality: '2.5d',
  params: {
    openDegrees: { kind: 'number', default: 74, min: 20, max: 120 },
    spanMs: { kind: 'number', default: 500, min: 140, max: 2000 },
  },
  roles: ['headline', 'media', 'quote'],
  requires: ['update_layer', 'set_keyframes'],
  minDurationMs: 700,
  maxDurationMs: 3400,
  approxLayerCount: 0,
  approxToolCalls: 10,
  antipatterns: {
    neverUnderMs: 600,
    maxPerComposition: 2,
    neverWith: ['entrance.split_flap', 'entrance.depth_arrive'],
  },
  variants: 4,
  markers: ['overshoot', 'anticipation', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const sig = ctx.pack.pack.motionSignature;
    const deg = (p.openDegrees as number) * (0.75 + sig.overshootBias * 0.6) * pick(rng, [0.85, 1, 1.15]);
    const spanMs = Math.min(p.spanMs as number, ctx.durationMs * 0.5);
    const perMs = Math.max(260, Math.min(620, ctx.durationMs - spanMs));
    const dir = pick(rng, [1, -1]);

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
      calls.push(mk('update_layer', { nodeId: id, threeD: true }));
      // Y rotation, not X: a page opens sideways. The distinction from
      // `split_flap` is the axis, and the axis is the whole read.
      calls.push(
        heroMove(ctx, id, 'rotationY', {
          from: deg * dir,
          to: 0,
          startMs: offsetFor(ctx, 'rotation', at),
          durationMs: perMs,
          anticipation: 0.08,
          overshoot: 0.3,
        }),
      );
      calls.push(fadeIn(ctx, id, at, perMs * 0.72));
      // The hinge is at the leading edge, so the far edge travels further and
      // arrives later — a trace of x carries that without needing a real pivot.
      calls.push(
        heroMove(ctx, id, 'x', {
          from: travel(ctx, 0.018) * dir,
          to: 0,
          startMs: offsetFor(ctx, 'x', at),
          durationMs: perMs,
          anticipation: 0,
          overshoot: 0.24,
        }),
      );
      calls.push(
        followThrough(ctx, id, 'scale', {
          restValue: 1,
          amount: 0.011,
          settleMs: at + perMs,
          durationMs: perMs * 0.42,
        }),
      );
    });

    return calls;
  },
};

// ── entrance.shutter_bands ────────────────────────────────────────────

export const shutterBands: TechniqueDef = {
  id: 'entrance.shutter_bands',
  category: 'entrance',
  displayName: 'Shutter Bands',
  intent: 'Content appears through opening horizontal slats, like a shutter lifting.',
  tags: ['entrance', 'graphic', 'broadcast', 'mechanical', '2d', 'mask'],
  energy: [0.45, 0.9],
  dimensionality: '2d',
  params: {
    bands: { kind: 'number', default: 5, min: 3, max: 9 },
    spanMs: { kind: 'number', default: 380, min: 120, max: 1400 },
  },
  roles: ['headline', 'media'],
  requires: ['create_layer', 'set_keyframes'],
  minDurationMs: 600,
  maxDurationMs: 2600,
  approxLayerCount: 6,
  approxToolCalls: 14,
  antipatterns: {
    neverUnderMs: 500,
    maxPerComposition: 1,
    neverWith: ['entrance.wipe_columns', 'transition.rule_wipe'],
  },
  variants: 3,
  markers: ['overshoot', 'anticipation', 'explicit_bezier', 'nonuniform_stagger', 'cross_property_offset', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const bands = Math.round(p.bands as number);
    const spanMs = Math.min(p.spanMs as number, ctx.durationMs * 0.45);
    const perMs = Math.max(200, Math.min(460, ctx.durationMs - spanMs));
    const bandH = Math.ceil(ctx.height / bands);
    // Alternating slats leave opposite ways. Same-direction slats read as one
    // sheet sliding off; opposing ones read as a mechanism.
    const flip = rng() > 0.5;

    // The slats are real layers that slide away, not a mask animation — masks
    // cannot be shape-animated through the tool surface, and a slat that moves
    // is what makes the mechanism visible.
    for (let b = 0; b < bands; b++) {
      const slatId = `${ctx.idPrefix}_slat_${b}`;
      const y = bandH * b + bandH / 2;
      calls.push(
        mk('create_layer', {
          id: slatId, kind: 'shape', shape: 'rect', name: `Slat ${b + 1}`,
          x: ctx.width / 2, y, width: ctx.width, height: bandH + 2,
          fill: ctx.pack.palette.bg,
        }),
      );
      const dir = (b % 2 === 0) === flip ? 1 : -1;
      const at = ctx.startMs + staggerAt(ctx, b, bands, spanMs);
      calls.push(
        heroMove(ctx, slatId, 'x', {
          from: 0,
          to: ctx.width * 1.05 * dir,
          startMs: subFrame(at, ctx.frameMs, 0.4),
          durationMs: perMs,
          anticipation: 0.1,
          overshoot: 0,
        }),
      );
      calls.push(...blurIfFast(ctx, slatId, ctx.width, perMs));
    }

    // The content underneath does almost nothing — it is being REVEALED, and
    // giving it its own entrance makes the slats look like decoration over an
    // animation that would have worked without them.
    ids.forEach((id, i) => {
      // Staggered like everything else. Settling every revealed layer on one
      // frame is `SIMULTANEOUS_ENTRY` however restrained the move is — and it
      // reads as a block appearing behind the slats rather than as content the
      // slats are uncovering.
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, Math.min(spanMs, ctx.durationMs * 0.3));
      // Opacity LEADS the scale settle by two frames. Both channels started on
      // the same frame before, so the declared `cross_property_offset` was a
      // claim the output did not support — and the marker test said so.
      calls.push(hold(id, 'opacity', 100, Math.max(ctx.startMs, at - ctx.frameMs * 2), ctx.startMs + ctx.durationMs));
      calls.push(
        heroMove(ctx, id, 'scale', {
          from: 1.03,
          to: 1,
          startMs: offsetFor(ctx, 'scale', at),
          durationMs: spanMs + perMs,
          anticipation: 0,
          overshoot: 0.12,
        }),
      );
    });

    return calls;
  },
};

// ── kinetic_type.vertical_ticker ──────────────────────────────────────

export const verticalTicker: TechniqueDef = {
  id: 'kinetic_type.vertical_ticker',
  category: 'kinetic_type',
  displayName: 'Vertical Ticker',
  intent: 'Lines roll upward through a fixed window, one replacing the next like a departures board.',
  tags: ['kinetic', 'typographic', 'transit', 'rolling', '2d', 'loop'],
  energy: [0.35, 0.8],
  dimensionality: '2d',
  params: {
    windowFraction: { kind: 'number', default: 0.12, min: 0.05, max: 0.3 },
    beatsPerLine: { kind: 'number', default: 1, min: 0.5, max: 3 },
  },
  roles: ['headline', 'subhead', 'overline'],
  requires: ['create_mask', 'set_keyframes'],
  minDurationMs: 1400,
  maxDurationMs: 7000,
  approxLayerCount: 0,
  approxToolCalls: 12,
  antipatterns: {
    neverUnderMs: 1200,
    maxPerComposition: 1,
    neverWith: ['kinetic_type.line_push_stack', 'kinetic_type.marquee_band'],
  },
  variants: 3,
  markers: ['overshoot', 'anticipation', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const windowH = ctx.height * (p.windowFraction as number);
    const beat = ctx.pack.pack.pacing.baseBeatMs * (p.beatsPerLine as number) * pick(rng, [0.9, 1, 1.15]);
    const rollMs = Math.max(ctx.frameMs * 6, Math.min(260, beat * 0.45));
    const span = Math.min(beat * ids.length, ctx.durationMs * 0.85);
    const arrivals = ids.map((_, i) => ctx.startMs + staggerAt(ctx, i, ids.length, span));

    ids.forEach((id, i) => {
      const at = arrivals[i]!;
      const exitAt = arrivals[i + 1] === undefined ? undefined : arrivals[i + 1]! - rollMs;
      // ONE y timeline: roll in from below the window, hold, roll out above it.
      const y0 = offsetFor(ctx, 'y', at);
      const keys: { t: number; value: number; bezier?: [number, number, number, number]; easing?: string }[] = [
        { t: y0, value: windowH, bezier: CURVES.anticipate },
        { t: y0 + ctx.frameMs * 1.5, value: windowH * 1.06, bezier: CURVES.snap },
        { t: y0 + rollMs * 0.7, value: -windowH * 0.06, bezier: CURVES.settle },
        { t: y0 + rollMs, value: 0, bezier: CURVES.settle },
      ];
      if (exitAt !== undefined && exitAt > y0 + rollMs + ctx.frameMs) {
        keys.push({ t: exitAt, value: 0, easing: 'hold' });
        keys.push({ t: exitAt + rollMs, value: -windowH, bezier: CURVES.exit });
      }
      calls.push(track(id, 'y', keys));

      // Opacity cuts at the window edge rather than fading — a ticker line that
      // fades is a dissolve, and the window is what makes it a ticker.
      const op: { t: number; value: number; easing: string }[] = [
        { t: offsetFor(ctx, 'opacity', at), value: 0, easing: 'hold' },
        { t: offsetFor(ctx, 'opacity', at) + ctx.frameMs, value: 100, easing: 'hold' },
      ];
      if (exitAt !== undefined) {
        op.push({ t: exitAt + rollMs * 0.8, value: 100, easing: 'hold' });
        op.push({ t: exitAt + rollMs * 0.8 + ctx.frameMs, value: 0, easing: 'hold' });
      }
      calls.push(track(id, 'opacity', op));
      calls.push(mk('create_mask', { nodeId: id, shape: 'rectangle', mode: 'add', feather: 0 }));
    });

    return calls;
  },
};

// ── camera.orbit_reveal ───────────────────────────────────────────────

export const orbitReveal: TechniqueDef = {
  id: 'camera.orbit_reveal',
  category: 'camera',
  displayName: 'Orbit Reveal',
  exclusiveResource: 'camera',
  intent: 'The camera arcs around the subject, so depth is read from parallax rather than shading.',
  tags: ['camera', 'dimensional', 'product', 'cinematic', '2.5d', 'parallax'],
  energy: [0.2, 0.6],
  dimensionality: '2.5d',
  params: {
    arcDegrees: { kind: 'number', default: 22, min: 6, max: 70 },
    depthSpread: { kind: 'number', default: 320, min: 80, max: 900 },
  },
  roles: ['camera', 'media', 'mark', 'headline', 'background'],
  requires: ['create_layer', 'update_layer', 'set_keyframes'],
  minDurationMs: 2200,
  maxDurationMs: 14000,
  approxLayerCount: 1,
  approxToolCalls: 12,
  antipatterns: { neverUnderMs: 2000, maxPerComposition: 1 },
  variants: 3,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'follow_through', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const camId = `${ctx.idPrefix}_orbitcam`;
    const sig = ctx.pack.pack.motionSignature;
    const arc = (p.arcDegrees as number) * (0.7 + sig.overshootBias * 0.7) * pick(rng, [0.8, 1, 1.2]);
    const spread = p.depthSpread as number;
    const dir = pick(rng, [1, -1]);

    // Portrait length: an orbit on a wide lens smears the edges of the frame and
    // the subject appears to deform rather than rotate.
    calls.push(...emitCamera(ctx, camId, 'Orbit Camera', 'portrait').calls);

    // Layers separated in z BEFORE the move, or the orbit is a pan.
    const layers = Object.entries(ctx.targets)
      .filter(([role]) => role !== 'camera')
      .flatMap(([role, arr]) => (arr ?? []).map((id) => ({ role, id })));
    layers.forEach((l) => {
      const depth = l.role === 'background' ? 1 : l.role === 'media' ? 0.45 : 0;
      calls.push(mk('update_layer', { nodeId: l.id, threeD: true }));
      calls.push(hold(l.id, 'z', depth * spread, ctx.startMs, ctx.startMs + ctx.durationMs));
    });

    const end = ctx.startMs + ctx.durationMs;
    calls.push(
      track(camId, 'orbitYaw', [
        { t: ctx.startMs, value: -arc / 2 * dir, bezier: CURVES.glide },
        // Past the mark then back: an operated arc decelerates into its end
        // rather than stopping on its number.
        { t: subFrame(ctx.startMs + ctx.durationMs * 0.9, ctx.frameMs, 0.5), value: (arc / 2) * 1.06 * dir, bezier: CURVES.settle },
        { t: end, value: (arc / 2) * dir, bezier: CURVES.settle },
      ]),
    );
    // A slight rise across the arc, offset from the yaw so the two axes never
    // start together — a perfectly level orbit reads as a turntable.
    calls.push(
      track(camId, 'y', [
        { t: offsetFor(ctx, 'y', ctx.startMs), value: travel(ctx, 0.01), bezier: CURVES.glide },
        { t: end, value: -travel(ctx, 0.006), bezier: CURVES.glide },
      ]),
    );
    calls.push(
      followThrough(ctx, camId, 'orbitPitch', {
        restValue: 0,
        amount: 0.6 * dir,
        settleMs: end,
        durationMs: Math.min(400, ctx.durationMs * 0.12),
      }),
    );

    return calls;
  },
};

// ── background.contour_drift ──────────────────────────────────────────

export const contourDrift: TechniqueDef = {
  id: 'background.contour_drift',
  category: 'background',
  displayName: 'Contour Drift',
  intent: 'Fine horizontal lines drift at different rates, like a topographic map breathing.',
  tags: ['background', 'technical', 'data', 'ambient', '2d', 'linework'],
  energy: [0.1, 0.5],
  dimensionality: '2d',
  params: {
    lines: { kind: 'number', default: 9, min: 4, max: 20 },
    driftFraction: { kind: 'number', default: 0.05, min: 0.01, max: 0.2 },
  },
  roles: ['background'],
  requires: ['create_layer', 'set_keyframes'],
  minDurationMs: 2000,
  maxDurationMs: 20000,
  approxLayerCount: 9,
  approxToolCalls: 20,
  antipatterns: { neverUnderMs: 1800, maxPerComposition: 1, neverWith: ['background.grid_scan'] },
  variants: 4,
  markers: ['explicit_bezier', 'cross_property_offset', 'nonuniform_stagger', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const lines = Math.round(p.lines as number);
    const drift = travel(ctx, p.driftFraction as number);
    const end = ctx.startMs + ctx.durationMs;

    for (let i = 0; i < lines; i++) {
      const id = `${ctx.idPrefix}_contour_${i}`;
      const y = Math.round((ctx.height * (i + 0.5)) / lines);
      calls.push(
        mk('create_layer', {
          id, kind: 'shape', shape: 'rect', name: `Contour ${i + 1}`,
          x: ctx.width / 2, y, width: Math.round(ctx.width * 1.2), height: 1,
          fill: ctx.pack.palette.line,
        }),
      );
      // Each line drifts at its OWN rate and phase. Equal rates make the set one
      // sheet translating; unequal rates are what reads as depth.
      const rate = 0.35 + rng() * 1.3;
      const phase = rng();
      // Each line STARTS at a different time, not merely at a different rate.
      // Sub-frame jitter alone put all nine starts inside one frame, which the
      // linter reported as nine elements entering at once — correctly. A set of
      // contours that all begin together is one sheet however differently they
      // then move.
      const at = ctx.startMs + staggerAt(ctx, i, lines, Math.min(ctx.durationMs * 0.35, 900));
      calls.push(
        track(id, 'x', [
          { t: subFrame(at, ctx.frameMs, phase * 0.8), value: -drift * rate, bezier: CURVES.glide },
          { t: end, value: drift * rate, bezier: CURVES.glide },
        ]),
      );
      // Opacity breathes on a different schedule again, offset per line so no
      // two peak together.
      // Every key from the SAME origin as the drift. Anchoring the middle key to
      // `ctx.startMs` while the first came from the staggered `at` put them out
      // of order as soon as a line's stagger exceeded the fade-in — sorted, the
      // track then jumped its whole range inside a frame. Rule 2, broken in the
      // file that states it.
      const peakAt = at + (end - at) * (0.3 + phase * 0.3);
      calls.push(
        track(id, 'opacity', [
          { t: offsetFor(ctx, 'opacity', at), value: 0, bezier: CURVES.settle },
          { t: peakAt, value: 24 + rng() * 26, bezier: CURVES.glide },
          { t: end, value: 8, bezier: CURVES.exit },
        ]),
      );
    }

    return calls;
  },
};

// ── transition.push_through ───────────────────────────────────────────

export const pushThrough: TechniqueDef = {
  id: 'transition.push_through',
  category: 'transition',
  displayName: 'Push Through',
  intent: 'The whole frame is shoved aside by what comes next, with weight behind it.',
  tags: ['transition', 'physical', 'directional', 'broadcast', '2d'],
  energy: [0.5, 0.95],
  dimensionality: '2d',
  params: {
    direction: { kind: 'enum', values: ['left', 'right', 'up', 'down'], default: 'left' },
    travelFraction: { kind: 'number', default: 1, min: 0.4, max: 1.4 },
  },
  roles: ['headline', 'subhead', 'media', 'mark', 'background'],
  requires: ['set_keyframes', 'set_motion_blur'],
  minDurationMs: 400,
  maxDurationMs: 1600,
  approxLayerCount: 0,
  approxToolCalls: 14,
  antipatterns: {
    neverUnderMs: 350,
    maxPerComposition: 2,
    neverWith: ['transition.iris', 'transition.glitch_slam'],
  },
  variants: 4,
  markers: ['anticipation', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger', 'motion_blur', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const declared = p.direction as string;
    const dirName = pick(rng, [declared, declared, 'left', 'right', 'up', 'down']);
    const horizontal = dirName === 'left' || dirName === 'right';
    const sign = dirName === 'left' || dirName === 'up' ? -1 : 1;
    const axis = horizontal ? 'x' : 'y';
    const extent = (horizontal ? ctx.width : ctx.height) * (p.travelFraction as number);
    // Short. A push that takes a second is a slide; the weight is in the speed.
    const pushMs = Math.max(ctx.frameMs * 6, Math.min(320, ctx.durationMs * 0.7));
    const spanMs = Math.min(ctx.durationMs * 0.25, 120);

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
      calls.push(
        track(id, axis, [
          { t: offsetFor(ctx, axis, at), value: 0, bezier: CURVES.anticipate },
          // Braces against the push before going — the anticipation is what puts
          // mass behind it.
          { t: offsetFor(ctx, axis, at) + ctx.frameMs * 2, value: -extent * 0.03 * sign, bezier: CURVES.snap },
          { t: subFrame(at + pushMs, ctx.frameMs, 0.5), value: extent * sign, bezier: CURVES.exit },
        ]),
      );
      calls.push(fadeOut(ctx, id, at + pushMs * 0.55, pushMs * 0.45));
      calls.push(...blurIfFast(ctx, id, extent, pushMs));
    });

    return calls;
  },
};

// ── emphasis.scale_punch ──────────────────────────────────────────────

export const scalePunch: TechniqueDef = {
  id: 'emphasis.scale_punch',
  category: 'emphasis',
  displayName: 'Scale Punch',
  intent: 'One element snaps larger for a beat and settles back, marking it without moving it.',
  tags: ['emphasis', 'punchy', 'accent', 'broadcast', '2d'],
  energy: [0.45, 0.9],
  dimensionality: '2d',
  params: { peak: { kind: 'number', default: 1.12, min: 1.03, max: 1.4 } },
  roles: ['stat', 'mark', 'headline'],
  requires: ['set_keyframes'],
  minDurationMs: 300,
  maxDurationMs: 1400,
  approxLayerCount: 0,
  approxToolCalls: 8,
  antipatterns: { neverUnderMs: 260, maxPerComposition: 3, neverWith: ['emphasis.flash_pop'] },
  variants: 3,
  markers: ['overshoot', 'anticipation', 'cross_property_offset', 'explicit_bezier', 'follow_through', 'nonuniform_stagger'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const sig = ctx.pack.pack.motionSignature;
    const peak = 1 + ((p.peak as number) - 1) * (0.6 + sig.overshootBias) * pick(rng, [0.85, 1, 1.15]);
    const punchMs = Math.max(ctx.frameMs * 5, Math.min(220, ctx.durationMs * 0.35));
    const spanMs = Math.min(ctx.durationMs * 0.4, 260);

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
      // Dip BELOW one before the punch. A scale that only goes up reads as a
      // zoom; the compression is what makes it a punch.
      calls.push(
        track(id, 'scale', [
          { t: at, value: 1, bezier: CURVES.anticipate },
          { t: at + ctx.frameMs * 2, value: 0.985, bezier: CURVES.snap },
          { t: at + punchMs * 0.55, value: peak, bezier: CURVES.settle },
          { t: at + punchMs, value: 1, bezier: CURVES.settle },
        ]),
      );
      // Opacity leads by a frame and barely moves — enough to register, not
      // enough to read as a flash.
      calls.push(
        track(id, 'opacity', [
          { t: offsetFor(ctx, 'opacity', at), value: 100, bezier: CURVES.settle },
          { t: offsetFor(ctx, 'opacity', at) + punchMs * 0.4, value: 100, bezier: CURVES.settle },
        ]),
      );
      calls.push(
        followThrough(ctx, id, 'rotation', {
          restValue: 0,
          amount: 0.5 * (i % 2 === 0 ? 1 : -1),
          settleMs: at + punchMs,
          durationMs: punchMs * 0.7,
        }),
      );
    });

    return calls;
  },
};

// ── exit.wipe_off ─────────────────────────────────────────────────────

export const wipeOff: TechniqueDef = {
  id: 'exit.wipe_off',
  category: 'exit',
  displayName: 'Wipe Off',
  intent: 'A hard edge crosses the frame and takes everything with it.',
  tags: ['exit', 'graphic', 'editorial', 'hard-edge', '2d'],
  energy: [0.4, 0.85],
  dimensionality: '2d',
  params: {
    direction: { kind: 'enum', values: ['left', 'right', 'up', 'down'], default: 'right' },
    spanMs: { kind: 'number', default: 260, min: 80, max: 900 },
  },
  roles: ['headline', 'subhead', 'support', 'mark'],
  requires: ['create_mask', 'set_keyframes'],
  minDurationMs: 400,
  maxDurationMs: 1800,
  approxLayerCount: 0,
  approxToolCalls: 10,
  antipatterns: { neverUnderMs: 350, maxPerComposition: 1, neverWith: ['exit.scatter_out', 'exit.fall_away'] },
  variants: 4,
  // An exit, so no overshoot: something leaving does not come back, and the
  // timing linter exempts exits for exactly that reason.
  markers: ['anticipation', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const declared = p.direction as string;
    const dirName = pick(rng, [declared, declared, 'left', 'up', 'down']);
    const horizontal = dirName === 'left' || dirName === 'right';
    const sign = dirName === 'left' || dirName === 'up' ? -1 : 1;
    const axis = horizontal ? 'x' : 'y';
    const extent = horizontal ? ctx.width : ctx.height;
    const spanMs = Math.min(p.spanMs as number, ctx.durationMs * 0.5);
    const perMs = Math.max(ctx.frameMs * 5, Math.min(340, ctx.durationMs - spanMs));

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
      calls.push(mk('create_mask', { nodeId: id, shape: 'rectangle', mode: 'add', feather: 0 }));
      calls.push(
        track(id, axis, [
          { t: offsetFor(ctx, axis, at), value: 0, bezier: CURVES.anticipate },
          { t: offsetFor(ctx, axis, at) + ctx.frameMs * 2, value: -extent * 0.015 * sign, bezier: CURVES.snap },
          { t: subFrame(at + perMs, ctx.frameMs, 0.5), value: extent * 0.35 * sign, bezier: CURVES.exit },
        ]),
      );
      // Opacity cuts late and fast: a hard-edge wipe whose content fades early
      // is a dissolve wearing a wipe's clothes.
      calls.push(fadeOut(ctx, id, at + perMs * 0.7, perMs * 0.3));
    });

    return calls;
  },
};

export const ENTRANCE_TECHNIQUES_3: readonly TechniqueDef[] = [
  unfold,
  shutterBands,
  verticalTicker,
  orbitReveal,
  contourDrift,
  pushThrough,
  scalePunch,
  wipeOff,
];
