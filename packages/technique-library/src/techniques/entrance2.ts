/**
 * Entrance techniques, second set.
 *
 * The rule for adding to this library is the one that keeps it worth having:
 * **a new technique must differ structurally, not parametrically.** A rise with
 * a bigger travel and a longer span is not a technique, it is `rise_settle` with
 * different params — and the caster can already vary those. What earns a file is
 * a different *mechanism*: a different set of properties animated, a different
 * relationship between them, a different order of arrival.
 *
 * So each one here is named for its mechanism and each animates something the
 * others do not: a clipping mask that travels (`wipe_columns`), rotation on the
 * X axis (`split_flap`), depth (`depth_arrive`), a settle that overshoots on
 * scale while the position is already still (`stamp_impact`), and a per-character
 * selector driving opacity alone (`type_writer_block`).
 */

import { mk, mulberry32, pick, type ToolCall } from '@motion/design-system';
import type { TechniqueDef } from '../schema';
import {
  CURVES, blurIfFast, fadeIn, followThrough, heroMove, hold, offsetFor,
  rolesTargets, staggerAt, subFrame, track, travel,
} from '../emit';

// ── entrance.type_writer_block ────────────────────────────────────────

export const typeWriterBlock: TechniqueDef = {
  id: 'entrance.type_writer_block',
  category: 'entrance',
  displayName: 'Typewriter with Block Cursor',
  intent: 'Text types on character by character behind a block cursor that blinks and then leaves.',
  tags: ['entrance', 'typographic', 'terminal', 'technical', '2d', 'per-character'],
  energy: [0.2, 0.55],
  dimensionality: '2d',
  params: {
    charsPerSec: { kind: 'number', default: 22, min: 6, max: 60 },
    cursorHold: { kind: 'boolean', default: true },
  },
  roles: ['headline', 'subhead', 'support'],
  requires: ['text_animator', 'create_layer', 'set_keyframes'],
  minDurationMs: 900,
  maxDurationMs: 6000,
  approxLayerCount: 1,
  approxToolCalls: 8,
  antipatterns: {
    neverUnderMs: 800,
    maxPerComposition: 1,
    neverWith: ['kinetic_type.scramble_decode', 'entrance.blur_resolve'],
  },
  variants: 3,
  markers: ['explicit_bezier', 'cross_property_offset', 'nonuniform_stagger', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    // The typing rate is a rate, not a duration — that is what makes it read as
    // typing. A fixed duration stretched over a long line types slowly and over
    // a short one types impossibly fast, which is the tell.
    const cps = (p.charsPerSec as number) * pick(rng, [0.85, 1, 1.2]);
    const perCharMs = 1000 / cps;
    const spanMs = Math.min(ctx.durationMs * 0.55, ids.length * perCharMs * 14);

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
      // A generous line budget; the sweep clamps itself to the slot below.
      const lineMs = Math.min(perCharMs * 26, ctx.durationMs - (at - ctx.startMs) - 120);
      if (lineMs <= 0) return;

      calls.push(
        mk('text_animator', {
          nodeId: id,
          basedOn: 'characters',
          // `square` is the whole point: a typewriter has no falloff. Each glyph
          // is either typed or not. `rampUp` here would fade characters in and
          // the result reads as a wipe, not as typing.
          shape: 'square',
          start: 0,
          end: 100,
          opacity: 0,
          sweep: {
            fromSec: subFrame(at, ctx.frameMs, 0.35) / 1000,
            toSec: (at + lineMs) / 1000,
            fromOffset: -100,
            toOffset: 100,
          },
        }),
      );
      // The line itself does not move. Typing IS the entrance, and adding a
      // slide to it produces the "everything animates" look this library exists
      // to avoid. Opacity only, and it precedes the first character.
      calls.push(
        track(id, 'opacity', [
          { t: offsetFor(ctx, 'opacity', at) - ctx.frameMs * 2, value: 0, bezier: CURVES.snap },
          { t: offsetFor(ctx, 'opacity', at), value: 100, bezier: CURVES.snap },
        ]),
      );
    });

    // The cursor. It exists on its own layer so it can outlive the typing and
    // blink at its own rate — a cursor synchronised to the text reads as part of
    // the text rather than as a caret.
    const cursorId = `${ctx.idPrefix}_caret`;
    const h = Math.round(ctx.height * 0.038);
    calls.push(
      mk('create_layer', {
        id: cursorId, kind: 'shape', shape: 'rect', name: 'Caret',
        width: Math.max(8, Math.round(h * 0.5)), height: h, fill: ctx.pack.palette.accent,
      }),
    );

    const endMs = ctx.startMs + Math.min(spanMs + 400, ctx.durationMs);
    // Blink on a HOLD, never a fade. A caret that fades is a glow; a caret that
    // switches is a caret. The period is deliberately not a round number of
    // frames so successive blinks do not land on the same phase.
    const blinkMs = 470;
    const blinkKeys: { t: number; value: number; easing: string }[] = [];
    for (let t = ctx.startMs, on = true; t < endMs; t += blinkMs, on = !on) {
      blinkKeys.push({ t, value: on ? 100 : 0, easing: 'hold' });
    }
    if (blinkKeys.length >= 2) calls.push(track(cursorId, 'opacity', blinkKeys));

    if (p.cursorHold as boolean) {
      calls.push(hold(cursorId, 'scale', 1, ctx.startMs, endMs));
    }

    return calls;
  },
};

// ── entrance.split_flap ───────────────────────────────────────────────

export const splitFlap: TechniqueDef = {
  id: 'entrance.split_flap',
  category: 'entrance',
  displayName: 'Split Flap',
  intent: 'Elements flip into place around their horizontal axis, like a departures board settling.',
  tags: ['entrance', 'mechanical', 'transit', 'rhythmic', '2.5d', 'rotation'],
  energy: [0.4, 0.85],
  dimensionality: '2.5d',
  params: {
    flipDegrees: { kind: 'number', default: 88, min: 30, max: 180 },
    spanMs: { kind: 'number', default: 560, min: 150, max: 2200 },
  },
  roles: ['headline', 'subhead', 'stat', 'list', 'overline'],
  requires: ['update_layer', 'set_keyframes'],
  minDurationMs: 700,
  maxDurationMs: 3600,
  approxLayerCount: 0,
  approxToolCalls: 14,
  antipatterns: {
    neverUnderMs: 600,
    maxPerComposition: 2,
    neverWith: ['entrance.rise_settle', 'entrance.scale_pop_soft'],
  },
  variants: 4,
  markers: ['overshoot', 'anticipation', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const deg = (p.flipDegrees as number) * pick(rng, [0.8, 1, 1.15]);
    const spanMs = Math.min(p.spanMs as number, ctx.durationMs * 0.55);
    const perMs = Math.max(240, Math.min(560, ctx.durationMs - spanMs));
    // Flipping the same way every time reads as a filter effect. A real board
    // has every flap on the same axis but the seed picks which way the set goes.
    const dir = pick(rng, [1, -1]);

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
      calls.push(mk('update_layer', { nodeId: id, threeD: true }));

      // The flip: past vertical, back, settle. The overshoot is what sells the
      // mechanical stop — a flap that eases to flat has no mass.
      calls.push(
        heroMove(ctx, id, 'rotationX', {
          from: deg * dir,
          to: 0,
          startMs: at,
          durationMs: perMs,
          anticipation: 0.06,
          overshoot: 0.34,
        }),
      );
      // Opacity leads and finishes at 55% (see `fadeIn`) — the flap is opaque
      // while it is still rotating, which is what a physical flap does.
      calls.push(fadeIn(ctx, id, at, perMs));
      // A trace of vertical drop, offset two frames behind the rotation. The
      // flap is hinged, not floating; without this it reads as a card spinning
      // in free space. It goes through `heroMove` rather than two keyframes for
      // the reason the linter gives: a subordinate channel that runs straight
      // from A to B is still a hero prop, and it still reads as a tween.
      calls.push(
        heroMove(ctx, id, 'y', {
          from: -ctx.height * 0.004,
          to: 0,
          startMs: offsetFor(ctx, 'y', at),
          durationMs: perMs * 0.75,
          anticipation: 0,
          overshoot: 0.3,
        }),
      );
      // Follow-through: the hinge keeps swinging after the flap has landed.
      //
      // It is on `scale`, not on `rotationX`, and that is not cosmetic. A
      // follow-through emitted onto a channel the main move already used merges
      // into that channel's span, so nothing about the output says "this began
      // after the primary settled" — which is the entire distinction between
      // follow-through and overshoot. A separate channel starting at `at +
      // perMs` says it unambiguously.
      calls.push(
        followThrough(ctx, id, 'scale', {
          restValue: 1,
          amount: 0.012,
          settleMs: at + perMs,
          durationMs: perMs * 0.4,
        }),
      );
    });

    return calls;
  },
};

// ── entrance.depth_arrive ─────────────────────────────────────────────

export const depthArrive: TechniqueDef = {
  id: 'entrance.depth_arrive',
  category: 'entrance',
  displayName: 'Depth Arrive',
  intent: 'Elements fly in from different distances, the far ones slower, resolving to one plane.',
  tags: ['entrance', 'dimensional', 'spatial', '2.5d', 'parallax'],
  energy: [0.35, 0.8],
  dimensionality: '2.5d',
  params: {
    depthSpread: { kind: 'number', default: 520, min: 120, max: 1600 },
    spanMs: { kind: 'number', default: 640, min: 180, max: 2400 },
  },
  roles: ['headline', 'subhead', 'media', 'mark', 'stat', 'list'],
  requires: ['update_layer', 'set_keyframes', 'set_motion_blur'],
  minDurationMs: 900,
  maxDurationMs: 4200,
  approxLayerCount: 0,
  approxToolCalls: 16,
  antipatterns: {
    neverUnderMs: 800,
    maxPerComposition: 1,
    neverWith: ['entrance.rise_settle', 'entrance.slide_in_edge', 'camera.crash_zoom'],
  },
  variants: 4,
  markers: ['overshoot', 'anticipation', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger', 'motion_blur'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const spread = (p.depthSpread as number) * pick(rng, [0.7, 1, 1.4]);
    const spanMs = Math.min(p.spanMs as number, ctx.durationMs * 0.5);
    // Depth ordering is assigned once, from the seed, and REVERSED on half the
    // seeds. Always-nearest-first is a signature; a set that sometimes resolves
    // front-to-back and sometimes back-to-front is not.
    const nearFirst = rng() > 0.5;

    ids.forEach((id, i) => {
      const rank = nearFirst ? i : ids.length - 1 - i;
      const depth = ids.length <= 1 ? 0.5 : rank / (ids.length - 1);
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
      // Far elements take LONGER. Equal durations across unequal distances is
      // the thing that makes fake 3D read as a scale — the whole illusion is
      // that distant objects subtend less angular velocity.
      const perMs = Math.max(280, Math.min(760, (ctx.durationMs - spanMs) * (0.6 + depth * 0.7)));
      const fromZ = spread * (0.35 + depth);

      calls.push(mk('update_layer', { nodeId: id, threeD: true }));
      calls.push(
        heroMove(ctx, id, 'z', {
          from: fromZ,
          to: 0,
          startMs: offsetFor(ctx, 'z', at),
          durationMs: perMs,
          anticipation: 0.07,
          overshoot: 0.22,
        }),
      );
      calls.push(fadeIn(ctx, id, at, perMs));
      // A small lateral component scaled by depth: things far away that move
      // toward you also drift across the frame unless they are dead centre.
      const lateral = travel(ctx, 0.02) * (depth - 0.5) * 2;
      if (Math.abs(lateral) > 1) {
        calls.push(
          heroMove(ctx, id, 'x', {
            from: lateral,
            to: 0,
            startMs: offsetFor(ctx, 'x', at),
            durationMs: perMs,
            anticipation: 0,
            // Small, but not zero. The linter is right that a hero prop moving
            // straight from A to B reads as a tween however short the move is.
            overshoot: 0.25,
          }),
        );
      }
      calls.push(...blurIfFast(ctx, id, fromZ, perMs));
    });

    return calls;
  },
};

// ── entrance.wipe_columns ─────────────────────────────────────────────

export const wipeColumns: TechniqueDef = {
  id: 'entrance.wipe_columns',
  category: 'entrance',
  displayName: 'Column Wipe',
  intent: 'A hard edge travels across the frame and content is revealed in its wake, column by column.',
  tags: ['entrance', 'graphic', 'editorial', 'hard-edge', '2d', 'mask'],
  energy: [0.3, 0.75],
  dimensionality: '2d',
  params: {
    direction: { kind: 'enum', values: ['left', 'right', 'up', 'down'], default: 'left' },
    edgeSoftness: { kind: 'number', default: 0, min: 0, max: 40 },
  },
  roles: ['headline', 'subhead', 'media', 'stat', 'list', 'rule'],
  requires: ['create_mask', 'set_keyframes'],
  minDurationMs: 600,
  maxDurationMs: 3000,
  approxLayerCount: 0,
  approxToolCalls: 12,
  antipatterns: {
    neverUnderMs: 500,
    maxPerComposition: 2,
    neverWith: ['entrance.mask_rise', 'transition.rule_wipe'],
  },
  variants: 4,
  markers: ['explicit_bezier', 'cross_property_offset', 'nonuniform_stagger', 'subframe_care', 'overshoot'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    // The seed picks the PERPENDICULAR axis and the edge softness, so four seeds
    // give four visibly different wipes rather than four identical ones. An
    // emitter that reads its params and ignores its seed has one variant however
    // many it declares — the determinism test exists to catch exactly that, and
    // it caught this.
    const declared = p.direction as string;
    const dirName = pick(rng, declared === 'left' || declared === 'right'
      ? [declared, declared, 'up', 'down']
      : [declared, declared, 'left', 'right']);
    const horizontal = dirName === 'left' || dirName === 'right';
    const sign = dirName === 'left' || dirName === 'up' ? -1 : 1;
    const feather = (p.edgeSoftness as number) + pick(rng, [0, 0, 2, 6]);
    const axis = horizontal ? 'x' : 'y';
    const extent = horizontal ? ctx.width : ctx.height;

    // One shared edge crossing the frame, and each element's reveal is its
    // POSITION along that edge — which is what makes it read as one wipe rather
    // than as N elements that happen to wipe. The span is the crossing time.
    const spanMs = Math.min(ctx.durationMs * 0.5, 240 + ids.length * 90);
    const perMs = Math.max(220, Math.min(520, ctx.durationMs - spanMs));

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, spanMs);
      calls.push(mk('create_mask', { nodeId: id, shape: 'rectangle', mode: 'add', feather }));

      // The masked content slides a short way UNDER its own mask. A mask that
      // opens over stationary content reads as a curtain; content that moves
      // with the edge reads as being carried by it.
      const slide = extent * 0.03 * sign;
      calls.push(
        heroMove(ctx, id, axis, {
          from: slide,
          to: 0,
          // Half a frame off the grid — a hard edge quantised to frames steps
          // visibly, and this is a hard edge by construction.
          startMs: subFrame(at, ctx.frameMs, 0.5),
          durationMs: perMs,
          anticipation: 0,
          overshoot: 0.2,
        }),
      );
      calls.push(fadeIn(ctx, id, at, perMs * 0.6));
    });

    return calls;
  },
};

// ── entrance.stamp_impact ─────────────────────────────────────────────

export const stampImpact: TechniqueDef = {
  id: 'entrance.stamp_impact',
  category: 'entrance',
  displayName: 'Stamp Impact',
  intent: 'Content slams down from oversize onto the frame and everything around it shudders.',
  tags: ['entrance', 'punchy', 'bold', 'impact', '2d'],
  energy: [0.7, 1],
  dimensionality: '2d',
  params: {
    fromScale: { kind: 'number', default: 1.9, min: 1.2, max: 4 },
    shakeAmount: { kind: 'number', default: 7, min: 0, max: 30 },
  },
  roles: ['headline', 'mark', 'overline'],
  requires: ['set_keyframes', 'set_motion_blur'],
  minDurationMs: 500,
  maxDurationMs: 2200,
  approxLayerCount: 0,
  approxToolCalls: 12,
  antipatterns: {
    neverUnderMs: 420,
    maxPerComposition: 1,
    requiresBreathingRoomMs: 300,
    neverWith: ['entrance.rise_settle', 'entrance.blur_resolve', 'camera.push_in_slow'],
  },
  variants: 3,
  // No `anticipation`, deliberately. A stamp has none — the whole read is that
  // it arrives without warning, and the marker test correctly refused the claim.
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'follow_through', 'motion_blur', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const fromScale = (p.fromScale as number) * pick(rng, [0.85, 1, 1.2]);
    const shake = p.shakeAmount as number;
    // Short. A stamp that takes 600ms is a zoom; the impact IS the brevity.
    const impactMs = Math.min(220, ctx.durationMs * 0.3);
    const at = ctx.startMs;

    ids.forEach((id, i) => {
      // Successive stamps land on the beat, not on a stagger curve — this is one
      // of the few places a regular interval is correct, because the regularity
      // is the rhythm. It is still not uniform: the beat is scaled per index.
      const t0 = at + i * ctx.pack.pack.pacing.baseBeatMs * (1 + i * 0.12);
      if (t0 - ctx.startMs > ctx.durationMs * 0.7) return;

      calls.push(
        track(id, 'scale', [
          { t: t0, value: fromScale, bezier: CURVES.snap },
          // Undershoot BELOW 1 on impact, then back. Landing exactly on 1 is
          // what makes a slam read as a scale animation instead of a collision.
          { t: subFrame(t0 + impactMs, ctx.frameMs, 0.4), value: 0.94, bezier: CURVES.snap },
          { t: t0 + impactMs * 1.9, value: 1.02, bezier: CURVES.settle },
          { t: t0 + impactMs * 3.1, value: 1, bezier: CURVES.settle },
        ]),
      );
      calls.push(
        track(id, 'opacity', [
          { t: offsetFor(ctx, 'opacity', t0), value: 0, bezier: CURVES.snap },
          { t: offsetFor(ctx, 'opacity', t0) + impactMs * 0.5, value: 100, bezier: CURVES.snap },
        ]),
      );
      if (shake > 0) {
        // The shudder AFTER the landing — this is follow-through, and it starts
        // where the scale settle ends rather than running alongside it.
        calls.push(
          followThrough(ctx, id, 'y', {
            restValue: 0,
            amount: shake,
            settleMs: t0 + impactMs * 1.6,
            durationMs: impactMs * 2.2,
          }),
        );
      }
      calls.push(...blurIfFast(ctx, id, ctx.height * (fromScale - 1), impactMs));
    });

    return calls;
  },
};

export const ENTRANCE_TECHNIQUES_2: readonly TechniqueDef[] = [
  typeWriterBlock,
  splitFlap,
  depthArrive,
  wipeColumns,
  stampImpact,
];
