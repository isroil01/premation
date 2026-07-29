/**
 * Camera, background, transition, emphasis and exit techniques.
 *
 * The camera ones are where the Phase 5.1 (2.5D) work pays off: `add_camera_move`
 * previously had nothing to move *through*, because every layer sat on one plane.
 * These push layers apart in z first, so a push-in produces real parallax rather
 * than a uniform scale — which is the difference between "3D" and a zoom.
 */

import { mk, mulberry32, pick, type ToolCall } from '@motion/design-system';
import type { TechniqueDef } from '../schema';
import { CURVES, emitCamera, enterCameraSpace, blurIfFast, fadeOut, hold, offsetFor, rolesTargets, staggerAt, track, travel } from '../emit';

// ── camera.push_in_slow ───────────────────────────────────────────────

export const pushInSlow: TechniqueDef = {
  id: 'camera.push_in_slow',
  category: 'camera',
  // There is exactly one camera per composition — see `exclusiveResource`.
  exclusiveResource: 'camera',
  displayName: 'Slow Push In',
  intent: 'A continuous, almost imperceptible push toward the subject. Makes a static shot breathe.',
  tags: ['camera', 'calm', 'cinematic', '2.5d', 'parallax'],
  energy: [0.05, 0.4],
  dimensionality: '2.5d',
  params: {
    amount: { kind: 'number', default: 0.06, min: 0.01, max: 0.3 },
    depthSpread: { kind: 'number', default: 240, min: 0, max: 900 },
  },
  roles: ['camera', 'background', 'media', 'headline', 'mark'],
  requires: ['create_layer', 'update_layer', 'set_keyframes'],
  minDurationMs: 2000,
  maxDurationMs: 20000,
  approxLayerCount: 1,
  approxToolCalls: 10,
  antipatterns: {
    neverWith: ['kinetic_type.hard_cut_stack', 'camera.crash_zoom', 'kinetic_type.slam_in'],
    neverUnderMs: 1800,
    maxPerComposition: 1,
  },
  variants: 3,
  // No `nonuniform_stagger`: a camera technique animates ONE camera plus a set
  // of depth holds that are all simultaneous by design. There is no group to
  // stagger, and claiming one would make the marker meaningless.
  markers: ['explicit_bezier', 'cross_property_offset', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const camId = `${ctx.idPrefix}_cam`;
    const spread = p.depthSpread as number;

    // A slow push is an observational shot: a long lens collapses depth so the
    // subject grows rather than the room rushing past, which is the difference
    // between contemplative and hurried.
    calls.push(...emitCamera(ctx, camId, 'Push Camera', 'long').calls);

    // Push layers apart in Z BEFORE moving the camera. Without this every layer
    // sits on one plane and the "push" is a uniform scale — visually identical to
    // scaling the whole comp, and the reason `add_camera_move` never looked 3D.
    const layers = Object.entries(ctx.targets)
      .filter(([role]) => role !== 'camera')
      .flatMap(([role, ids]) => (ids ?? []).map((id) => ({ role, id })));

    layers.forEach((l, i) => {
      // Background furthest, content nearest — depth ordered by role, not by
      // index, or the parallax contradicts the visual stacking.
      const depth = l.role === 'background' || l.role === 'media' ? 1 : l.role === 'mark' ? 0.35 : 0;
      calls.push(mk('update_layer', { nodeId: l.id, threeD: true }));
      calls.push(
        track(l.id, 'z', [
          { t: ctx.startMs, value: depth * spread, easing: 'hold' },
          { t: ctx.startMs + ctx.durationMs, value: depth * spread, easing: 'hold' },
        ]),
      );
      void i;
    });

    // The pack's motion signature has to reach even the quietest technique. A
    // push-in that ignored it emitted byte-identical calls in `luxury_film` and
    // `broadcast_sports` — which makes the pack cosmetic, and the packs are not
    // supposed to be cosmetic. Restraint pushes less and settles softer; energy
    // pushes further and lands harder.
    const sig = ctx.pack.pack.motionSignature;
    const amount = (p.amount as number) * (0.75 + sig.overshootBias * 0.9);
    const dolly = -spread * amount * 4;
    const settleOvershoot = 1 + 0.06 * sig.overshootBias;
    // `drift`, not linear. A linear camera move is the single most recognisable
    // robotic-camera tell — a real dolly is always accelerating or decelerating.
    calls.push(
      track(camId, 'z', [
        { t: ctx.startMs, value: 0, bezier: CURVES.drift },
        // Past the mark, then back. A real dolly is a physical object with mass;
        // one that arrives exactly on its number and stops is the clearest tell
        // of a keyframed camera.
        { t: ctx.startMs + ctx.durationMs * 0.88, value: dolly * settleOvershoot, bezier: CURVES.settle },
        { t: ctx.startMs + ctx.durationMs, value: dolly, bezier: CURVES.settle },
      ]),
    );
    // A slight lateral drift too, offset from the dolly so the two do not start
    // together. Pure axial motion reads as a zoom; a trace of sideways motion
    // reads as a camera.
    const lateral = travel(ctx, pick(rng, [0.004, 0.008, 0.012])) * (rng() > 0.5 ? 1 : -1);
    calls.push(
      track(camId, 'x', [
        { t: offsetFor(ctx, 'x', ctx.startMs), value: -lateral, bezier: CURVES.glide },
        { t: ctx.startMs + ctx.durationMs, value: lateral, bezier: CURVES.glide },
      ]),
    );
    // Follow-through: the camera keeps easing sideways for a beat AFTER the
    // dolly has landed. A rig that stops every axis on the same frame is the
    // thing that reads as keyframed rather than operated.
    calls.push(
      track(camId, 'orbitYaw', [
        { t: ctx.startMs + ctx.durationMs, value: 0, bezier: CURVES.settle },
        { t: ctx.startMs + ctx.durationMs * 1.08, value: lateral * 0.02, bezier: CURVES.settle },
        { t: ctx.startMs + ctx.durationMs * 1.16, value: 0, bezier: CURVES.settle },
      ]),
    );
    return calls;
  },
};

// ── camera.crash_zoom ─────────────────────────────────────────────────

export const crashZoom: TechniqueDef = {
  id: 'camera.crash_zoom',
  category: 'camera',
  // There is exactly one camera per composition — see `exclusiveResource`.
  exclusiveResource: 'camera',
  displayName: 'Crash Zoom',
  intent: 'A violent snap toward the subject, arriving with a hard stop and a shake.',
  tags: ['camera', 'aggressive', 'broadcast', 'sports', '2.5d', 'impact'],
  energy: [0.8, 1],
  dimensionality: '2.5d',
  params: {
    amount: { kind: 'number', default: 0.5, min: 0.15, max: 1 },
    durationMs: { kind: 'number', default: 260, min: 80, max: 700 },
  },
  // NOT `['camera']`. A layout never produces a `camera` slot — the technique
  // creates its own — so a camera-only role list matches nothing that
  // `availableRolesFor` can ever return, and the candidate filter
  // (`t.roles.some(r => roles.has(r))`) dropped this technique on 100% of beats.
  // It was registered, linted, tested and unreachable: never once cast.
  //
  // The other five camera techniques declare the content they move, and a crash
  // zoom moves everything in the frame.
  roles: ['camera', 'background', 'media', 'headline', 'mark', 'stat'],
  requires: ['create_layer', 'set_keyframes', 'set_motion_blur'],
  minDurationMs: 300,
  maxDurationMs: 1200,
  approxLayerCount: 1,
  approxToolCalls: 6,
  antipatterns: {
    neverWith: ['camera.push_in_slow', 'camera.drift_parallax', 'kinetic_type.hard_cut_stack', 'transition.slow_dissolve'],
    neverUnderMs: 250,
    // Twice in fifteen seconds is amateur. This is the canonical example of a
    // rule the model agrees with and then violates anyway.
    maxPerComposition: 1,
    requiresBreathingRoomMs: 600,
  },
  variants: 2,
  // No `motion_blur`: this is forbidden in every pack whose blurBias is high
  // enough for blurIfFast to fire, so the call correctly declines.
  markers: ['overshoot', 'anticipation', 'explicit_bezier', 'follow_through', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const camId = `${ctx.idPrefix}_cam`;
    // Even a crash zoom answers to the pack. `broadcast_sports` crashes harder
    // and faster than `cyberpunk_kinetic`; ignoring the signature made the two
    // byte-identical, which turns the packs into labels.
    const sig = ctx.pack.pack.motionSignature;
    const dur = (p.durationMs as number) * (1.25 - sig.overshootBias * 0.45);
    const amount = (p.amount as number) * (0.7 + sig.overshootBias * 0.7);
    const zoom = 400 * amount;

    // A crash zoom is the opposite decision: wide, so perspective stretches and
    // the move reads as hurtling INTO the frame rather than magnifying it.
    calls.push(...emitCamera(ctx, camId, 'Crash Camera', 'wide').calls);
    // Without this the crash zoom moves a camera through an empty 3D space:
    // the renderer only projects layers whose 3D switch is on.
    calls.push(...enterCameraSpace(ctx, crashZoom.roles));
    // Pull BACK a frame before crashing in. Two frames of retreat is what makes
    // the crash feel like it was fired rather than scheduled.
    calls.push(
      track(camId, 'z', [
        { t: ctx.startMs, value: 0, bezier: CURVES.anticipate },
        { t: ctx.startMs + ctx.frameMs * 2, value: zoom * 0.12, bezier: CURVES.snap },
        // Sub-frame arrival — a crash landing exactly on a frame boundary steps.
        { t: ctx.startMs + ctx.frameMs * 2 + dur + ctx.frameMs * 0.5, value: -zoom * 1.06, bezier: CURVES.settle },
        { t: ctx.startMs + dur * 1.9, value: -zoom, bezier: CURVES.settle },
      ]),
    );
    // The shake on arrival, decaying. A crash zoom with no shake stops dead.
    const shake = travel(ctx, 0.01) * (rng() > 0.5 ? 1 : -1);
    calls.push(
      track(camId, 'x', [
        // Starts once the dolly has SETTLED (dur * 1.9), not when it arrives.
        // That is what makes it follow-through rather than part of the impact.
        { t: ctx.startMs + dur * 1.9, value: 0, bezier: CURVES.snap },
        { t: ctx.startMs + dur * 1.9 + ctx.frameMs * 2, value: shake, bezier: CURVES.snap },
        { t: ctx.startMs + dur * 1.9 + ctx.frameMs * 5, value: -shake * 0.4, bezier: CURVES.settle },
        { t: ctx.startMs + dur * 2.8, value: 0, bezier: CURVES.settle },
      ]),
    );
    calls.push(...blurIfFast(ctx, camId, zoom, dur));
    return calls;
  },
};

// ── camera.drift_parallax ─────────────────────────────────────────────

export const driftParallax: TechniqueDef = {
  id: 'camera.drift_parallax',
  category: 'camera',
  // There is exactly one camera per composition — see `exclusiveResource`.
  exclusiveResource: 'camera',
  displayName: 'Drift Parallax',
  intent: 'A slow lateral drift across depth-separated layers. Nothing else moves.',
  tags: ['camera', 'luxury', 'restrained', '2.5d', 'parallax', 'ambient'],
  energy: [0.05, 0.35],
  dimensionality: '2.5d',
  params: {
    depthSpread: { kind: 'number', default: 320, min: 60, max: 1200 },
    driftFraction: { kind: 'number', default: 0.03, min: 0.005, max: 0.12 },
  },
  roles: ['camera', 'background', 'media', 'mark', 'headline'],
  requires: ['create_layer', 'update_layer', 'set_keyframes'],
  minDurationMs: 2500,
  maxDurationMs: 20000,
  approxLayerCount: 1,
  approxToolCalls: 12,
  antipatterns: {
    neverWith: ['camera.crash_zoom', 'camera.push_in_slow', 'kinetic_type.slam_in'],
    neverUnderMs: 2200,
    maxPerComposition: 1,
  },
  variants: 3,
  // No `nonuniform_stagger`: a camera technique animates ONE camera plus a set
  // of depth holds that are all simultaneous by design. There is no group to
  // stagger, and claiming one would make the marker meaningless.
  markers: ['explicit_bezier', 'cross_property_offset', 'follow_through', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const camId = `${ctx.idPrefix}_cam`;
    // Depth separation and drift distance both answer to the pack: a restrained
    // look wants shallow depth and a whisper of movement, an energetic one wants
    // both wider. Without this the technique emitted identical calls in every
    // pack, which is the packs being decorative rather than load-bearing.
    const sig = ctx.pack.pack.motionSignature;
    const spread = (p.depthSpread as number) * (0.8 + sig.overshootBias * 0.8);
    const drift = travel(ctx, (p.driftFraction as number) * (0.7 + sig.overshootBias)) * (rng() > 0.5 ? 1 : -1);

    // Gentle compression keeps a slow parallax drift from looking like a
    // fisheye pan; the planes separate without the edges bending.
    calls.push(...emitCamera(ctx, camId, 'Drift Camera', 'portrait').calls);

    const layers = Object.entries(ctx.targets)
      .filter(([role]) => role !== 'camera')
      .flatMap(([role, ids]) => (ids ?? []).map((id) => ({ role, id })));

    // Depths are NON-UNIFORM across the stack: evenly spaced planes produce
    // evenly spaced parallax, which reads as a mechanical multiplane rather than
    // as space. The exponent bunches the near layers and spreads the far ones,
    // which is how real depth distributes.
    layers.forEach((l, i) => {
      const t = layers.length <= 1 ? 0 : i / (layers.length - 1);
      const depth = Math.pow(t, 1.6) * spread;
      calls.push(mk('update_layer', { nodeId: l.id, threeD: true }));
      calls.push(hold(l.id, 'z', depth, ctx.startMs, ctx.startMs + ctx.durationMs));
    });

    calls.push(
      track(camId, 'x', [
        { t: ctx.startMs, value: -drift, bezier: CURVES.glide },
        { t: ctx.startMs + ctx.durationMs * 0.9, value: drift * 1.03, bezier: CURVES.settle },
        { t: ctx.startMs + ctx.durationMs, value: drift, bezier: CURVES.settle },
      ]),
    );
    // A trace of vertical drift on a LATER, SHORTER span — it keeps moving after
    // the lateral has settled, which is the follow-through that makes the camera
    // read as handheld rather than as two linked sliders. Pure horizontal motion
    // reads as a rig; the tiny lagging vertical reads as a hand.
    calls.push(
      track(camId, 'y', [
        { t: ctx.startMs + ctx.durationMs, value: drift * 0.14, bezier: CURVES.glide },
        { t: ctx.startMs + ctx.durationMs * 1.12, value: -drift * 0.14, bezier: CURVES.glide },
      ]),
    );
    return calls;
  },
};

// ── background.aurora_drift ───────────────────────────────────────────

export const auroraDrift: TechniqueDef = {
  id: 'background.aurora_drift',
  category: 'background',
  displayName: 'Aurora Drift',
  intent: 'The backdrop breathes — a slow hue and scale drift that never draws attention.',
  tags: ['background', 'ambient', 'calm', '2d', 'atmosphere'],
  energy: [0.05, 0.35],
  dimensionality: '2d',
  params: {
    scaleDrift: { kind: 'number', default: 0.05, min: 0.01, max: 0.2 },
  },
  roles: ['background'],
  requires: ['set_keyframes'],
  minDurationMs: 3000,
  maxDurationMs: 30000,
  approxLayerCount: 0,
  approxToolCalls: 4,
  antipatterns: { neverUnderMs: 2800, maxPerComposition: 1 },
  variants: 3,
  // No `follow_through`: what this has is an OVERSHOOT — the move goes past
  // its mark and settles back within one channel. Follow-through is
  // specifically secondary motion that BEGINS after the primary has finished,
  // and calling an overshoot by that name would make the marker meaningless.
  markers: ['explicit_bezier', 'cross_property_offset', 'subframe_care', 'overshoot'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = (ctx.targets.background ?? []) as string[];
    if (!ids.length) return calls;

    // The backdrop breathes at the pack's own amplitude. A restrained look barely
    // moves; an energetic one visibly swells. Ignoring the signature made this
    // byte-identical across all eight packs.
    const sig = ctx.pack.pack.motionSignature;
    const drift = (p.scaleDrift as number) * (0.6 + sig.overshootBias * 1.1);
    const dir = rng() > 0.5 ? 1 : -1;

    ids.forEach((id, i) => {
      const at = ctx.startMs + i * ctx.frameMs;
      // Three keyframes so the drift REVERSES rather than running one way and
      // snapping back at the loop point. A two-keyframe ambient drift is the
      // most common source of a visible hitch in a looping background.
      calls.push(
        track(id, 'scale', [
          { t: at, value: 1, bezier: CURVES.glide },
          { t: at + ctx.durationMs * 0.55, value: 1 + drift * dir, bezier: CURVES.glide },
          { t: at + ctx.durationMs, value: 1, bezier: CURVES.glide },
        ]),
      );
      // Rotation drifts on a DIFFERENT period than scale — same period would
      // make the two read as one transform, which is the flat version of this.
      calls.push(
        track(id, 'rotation', [
          { t: offsetFor(ctx, 'rotation', at), value: 0, bezier: CURVES.glide },
          { t: at + ctx.durationMs * 0.38, value: 0.7 * dir, bezier: CURVES.glide },
          { t: at + ctx.durationMs * 0.82, value: -0.4 * dir, bezier: CURVES.glide },
          // Runs PAST the scale drift's end — the backdrop is still turning
          // after it has finished breathing, so the two never read as one
          // transform.
          { t: at + ctx.durationMs * 1.12, value: 0, bezier: CURVES.glide },
        ]),
      );
    });
    return calls;
  },
};

// ── background.grid_scan ──────────────────────────────────────────────

export const gridScan: TechniqueDef = {
  id: 'background.grid_scan',
  category: 'background',
  displayName: 'Grid Scan',
  intent: 'A scanline sweeps the backdrop on a hard loop. Technical, deliberate, machine-made.',
  tags: ['background', 'cyberpunk', 'technical', '2d', 'scan'],
  energy: [0.4, 0.85],
  dimensionality: '2d',
  params: {
    sweeps: { kind: 'number', default: 2, min: 1, max: 6 },
  },
  roles: ['background'],
  requires: ['create_layer', 'update_layer', 'set_keyframes'],
  minDurationMs: 1500,
  maxDurationMs: 20000,
  approxLayerCount: 1,
  approxToolCalls: 6,
  antipatterns: { neverUnderMs: 1400, maxPerComposition: 1, neverWith: ['background.aurora_drift'] },
  variants: 2,
  // No `nonuniform_stagger`: this animates a rule and a mark, never enough
  // elements for a stagger to exist at all.
  markers: ['explicit_bezier', 'cross_property_offset', 'subframe_care', 'overshoot'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const sweeps = Math.max(1, Math.round(p.sweeps as number));
    const barId = `${ctx.idPrefix}_scan`;
    // Line weight, brightness and which way it travels are the variant axes.
    // The seed was previously discarded entirely (`void rng`), so both declared
    // variants emitted identical calls.
    const h = Math.max(2, Math.round(ctx.height * pick(rng, [0.004, 0.006, 0.011])));
    const glow = pick(rng, [16, 22, 30]) * (0.7 + ctx.pack.pack.motionSignature.blurBias * 0.5);
    const upward = rng() > 0.6;

    calls.push(
      mk('create_layer', {
        id: barId, kind: 'shape', shape: 'rect', name: 'Scanline',
        x: ctx.width / 2, y: 0, width: ctx.width, height: h,
      }),
    );
    calls.push(mk('update_layer', { nodeId: barId, fill: ctx.pack.palette.accent, blendMode: 'add', opacity: glow }));

    const per = ctx.durationMs / sweeps;
    const keys = [];
    for (let s = 0; s < sweeps; s++) {
      // Each sweep starts a fraction of a frame later than the grid — a scanline
      // locked to frame boundaries strobes against the frame rate.
      const t0 = ctx.startMs + s * per + ctx.frameMs * 0.5;
      // `drift`, not linear. A scanline at constant velocity is the one place
      // linear feels defensible — and it still reads as a machine rather than a
      // sweep, which is why the library forbids linear on ANY moving segment.
      keys.push({ t: t0, value: upward ? ctx.height + h : -h, bezier: CURVES.drift });
      // `hold` on the key that STARTS the reset segment, not on the one that
      // ends it. Easing carries forward from the segment's first keyframe, so
      // putting it on the second left the jump back to the top as an eased move
      // across one frame — which the timing linter correctly reported as
      // `POPPING`. A scanline reset is a cut and must be authored as one.
      keys.push({ t: t0 + per * 0.72, value: upward ? -h : ctx.height + h, easing: 'hold' as const });
      keys.push({ t: t0 + per * 0.73, value: upward ? ctx.height + h : -h, easing: 'hold' as const });
    }
    calls.push(track(barId, 'y', keys));
    // Opacity pulses on a different period than the sweep, so the two do not
    // lock and the loop is less obvious.
    calls.push(
      track(barId, 'opacity', [
        { t: offsetFor(ctx, 'opacity', ctx.startMs), value: Math.max(4, glow - 8), bezier: CURVES.glide },
        { t: ctx.startMs + ctx.durationMs * 0.41, value: glow + 8, bezier: CURVES.glide },
        // Runs PAST the sweep's end — the glow lingers after the line has left,
        // which is what stops the loop point reading as a hard cut.
        { t: ctx.startMs + ctx.durationMs * 1.1, value: Math.max(4, glow - 8), bezier: CURVES.glide },
      ]),
    );
    return calls;
  },
};

// ── transition.rule_wipe ──────────────────────────────────────────────

export const ruleWipe: TechniqueDef = {
  id: 'transition.rule_wipe',
  category: 'transition',
  displayName: 'Rule Wipe',
  intent: 'A heavy rule sweeps across the frame and takes the old content with it.',
  tags: ['transition', 'swiss', 'editorial', '2d', 'wipe'],
  energy: [0.5, 0.9],
  dimensionality: '2d',
  params: {
    durationMs: { kind: 'number', default: 420, min: 150, max: 1200 },
    thicknessFraction: { kind: 'number', default: 0.035, min: 0.005, max: 0.2 },
  },
  roles: ['background'],
  requires: ['create_layer', 'update_layer', 'set_keyframes', 'set_motion_blur'],
  minDurationMs: 260,
  maxDurationMs: 1400,
  approxLayerCount: 1,
  approxToolCalls: 7,
  antipatterns: { neverUnderMs: 240, maxPerComposition: 3 },
  variants: 3,
  // No `overshoot`: the bar sweeps OUT of frame and never returns, which is
  // correct for a wipe and is not an overshoot however it is measured.
  markers: ['anticipation', 'cross_property_offset', 'explicit_bezier', 'motion_blur'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const sig = ctx.pack.pack.motionSignature;
    const dur = (p.durationMs as number) * (1.2 - sig.overshootBias * 0.4);
    const thick = Math.round(ctx.height * (p.thicknessFraction as number) * (0.8 + sig.overshootBias * 0.6));
    const barId = `${ctx.idPrefix}_wipe`;
    const dir = rng() > 0.5 ? 1 : -1;
    const angle = pick(rng, [0, 0, -12, 8]);

    calls.push(
      mk('create_layer', {
        id: barId, kind: 'shape', shape: 'rect', name: 'Wipe Rule',
        x: ctx.width / 2, y: ctx.height / 2, width: ctx.width * 1.4, height: thick,
      }),
    );
    calls.push(mk('update_layer', { nodeId: barId, fill: ctx.pack.palette.accent, rotation: angle }));

    const off = ctx.height * 0.6 * dir;
    calls.push(
      track(barId, 'y', [
        // Anticipation: the bar backs off before it sweeps.
        { t: ctx.startMs, value: ctx.height / 2 + off, bezier: CURVES.anticipate },
        { t: ctx.startMs + ctx.frameMs * 2, value: ctx.height / 2 + off * 1.08, bezier: CURVES.snap },
        { t: ctx.startMs + dur, value: ctx.height / 2 - off * 1.04, bezier: CURVES.snap },
      ]),
    );
    // Thickness (scaleY) also changes across the sweep — a constant-width bar
    // reads as a rectangle passing by; one that thins as it accelerates reads as
    // a wipe.
    calls.push(
      track(barId, 'scaleY', [
        // Lags the sweep by two frames: the bar commits to its direction
        // before it commits to its thickness.
        { t: ctx.startMs + ctx.frameMs * 2, value: 1, bezier: CURVES.snap },
        { t: ctx.startMs + dur * 0.5, value: 2.4, bezier: CURVES.settle },
        { t: ctx.startMs + dur, value: 0.6, bezier: CURVES.settle },
      ]),
    );
    calls.push(...blurIfFast(ctx, barId, Math.abs(off) * 2, dur));
    return calls;
  },
};

// ── transition.glitch_slam ────────────────────────────────────────────

export const glitchSlam: TechniqueDef = {
  id: 'transition.glitch_slam',
  category: 'transition',
  displayName: 'Glitch Slam',
  intent: 'A two-frame chromatic tear punctuates the cut. Violent and very short.',
  tags: ['transition', 'cyberpunk', 'glitch', '2d', 'aggressive'],
  energy: [0.75, 1],
  dimensionality: '2d',
  params: {
    intensity: { kind: 'number', default: 0.7, min: 0.1, max: 1 },
  },
  roles: ['background'],
  requires: ['create_layer', 'update_layer', 'add_effect', 'set_keyframes'],
  minDurationMs: 100,
  maxDurationMs: 500,
  approxLayerCount: 1,
  approxToolCalls: 8,
  antipatterns: {
    neverUnderMs: 90,
    maxPerComposition: 3,
    neverWith: ['transition.slow_dissolve', 'camera.push_in_slow', 'camera.drift_parallax'],
    requiresBreathingRoomMs: 400,
  },
  variants: 3,
  // No `explicit_bezier` on purpose: every segment is a one-frame HOLD. A
  // tear is a discontinuity, and easing one removes the thing that makes it
  // read as a signal fault rather than as a move.
  markers: ['cross_property_offset', 'subframe_care', 'nonuniform_stagger', 'follow_through'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const sig = ctx.pack.pack.motionSignature;
    const intensity = (p.intensity as number) * (0.7 + sig.overshootBias * 0.6);
    const f = ctx.frameMs;
    const slabs = 3;

    // Torn slabs, each offset a different amount for a different single frame.
    // The tear is what makes it read as a signal fault; a whole-frame flash is
    // just a flash.
    for (let i = 0; i < slabs; i++) {
      const id = `${ctx.idPrefix}_glitch_${i}`;
      const h = ctx.height / slabs;
      calls.push(
        mk('create_layer', {
          id, kind: 'shape', shape: 'rect', name: `Tear ${i}`,
          x: ctx.width / 2, y: h * (i + 0.5), width: ctx.width, height: h,
        }),
      );
      calls.push(mk('update_layer', {
        nodeId: id,
        fill: i % 2 === 0 ? ctx.pack.palette.accent : ctx.pack.palette.support,
        blendMode: i % 2 === 0 ? 'screen' : 'difference',
      }));

      // Non-uniform: each slab appears on its OWN frame, in a scrambled order.
      // Slabs that all flash together are a strobe, not a tear.
      const at = ctx.startMs + staggerAt(ctx, i, slabs, f * 2.5);
      const shift = ctx.width * 0.04 * intensity * (rng() > 0.5 ? 1 : -1);
      calls.push(
        track(id, 'opacity', [
          { t: at, value: 0, easing: 'hold' },
          { t: at + f * 0.5, value: 70 * intensity, easing: 'hold' },
          { t: at + f * 1.5, value: 0, easing: 'hold' },
        ]),
      );
      calls.push(
        track(id, 'x', [
          { t: offsetFor(ctx, 'x', at), value: ctx.width / 2 + shift, easing: 'hold' },
          { t: at + f * 1.5, value: ctx.width / 2, easing: 'hold' },
        ]),
      );
    }
    return calls;
  },
};

// ── transition.slow_dissolve ──────────────────────────────────────────

export const slowDissolve: TechniqueDef = {
  id: 'transition.slow_dissolve',
  category: 'transition',
  displayName: 'Slow Dissolve',
  intent: 'A long, unhurried cross-fade with a trace of scale so it does not read as a fade.',
  tags: ['transition', 'luxury', 'calm', '2d', 'dissolve'],
  energy: [0.05, 0.35],
  dimensionality: '2d',
  params: {
    durationMs: { kind: 'number', default: 900, min: 300, max: 3000 },
  },
  roles: ['background', 'media', 'headline'],
  requires: ['set_keyframes'],
  minDurationMs: 400,
  maxDurationMs: 3200,
  approxLayerCount: 0,
  approxToolCalls: 6,
  antipatterns: {
    neverUnderMs: 380,
    maxPerComposition: 3,
    neverWith: ['transition.glitch_slam', 'kinetic_type.slam_in', 'camera.crash_zoom'],
  },
  variants: 2,
  // No `follow_through`: what this has is an OVERSHOOT — the move goes past its
  // mark and settles back within one channel. Follow-through is specifically
  // secondary motion that BEGINS after the primary has finished.
  markers: ['explicit_bezier', 'cross_property_offset', 'nonuniform_stagger', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;
    // A restrained pack dissolves slower than an energetic one, and the base
    // beat is the honest source for that.
    const beat = ctx.pack.pack.pacing.baseBeatMs;
    const dur = Math.min((p.durationMs as number) * (0.6 + beat / 900), ctx.durationMs);
    const zoomOut = rng() > 0.5;

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, dur * 0.25);
      calls.push(fadeOut(ctx, id, at, dur));
      // A dissolve with NO transform reads as a fault. A 2% drift is invisible
      // as motion and completely changes how the fade reads.
      // Starts two frames after the fade and runs 15% longer — the drift is
      // still going as the element vanishes, which is what stops a dissolve
      // reading as a power cut.
      calls.push(
        track(id, 'scale', [
          { t: at + ctx.frameMs * 2, value: 1, bezier: CURVES.glide },
          { t: at + dur * 1.15, value: zoomOut ? 0.98 : 1.02, bezier: CURVES.glide },
        ]),
      );
    });
    return calls;
  },
};

// ── emphasis.rule_underline ───────────────────────────────────────────

export const ruleUnderline: TechniqueDef = {
  id: 'emphasis.rule_underline',
  category: 'emphasis',
  displayName: 'Rule Underline',
  intent: 'A rule draws itself beneath the headline, from one edge, after the type has settled.',
  tags: ['emphasis', 'swiss', 'editorial', '2d', 'draw'],
  energy: [0.3, 0.7],
  dimensionality: '2d',
  params: {
    durationMs: { kind: 'number', default: 420, min: 120, max: 1400 },
  },
  roles: ['rule', 'headline'],
  requires: ['set_keyframes', 'set_trim_path'],
  minDurationMs: 300,
  maxDurationMs: 1800,
  approxLayerCount: 0,
  approxToolCalls: 5,
  antipatterns: { neverUnderMs: 260, maxPerComposition: 3, requiresBreathingRoomMs: 150 },
  variants: 2,
  // No `follow_through`: what this has is an OVERSHOOT — the move goes past
  // its mark and settles back within one channel. Follow-through is
  // specifically secondary motion that BEGINS after the primary has finished,
  // and calling an overshoot by that name would make the marker meaningless.
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = (ctx.targets.rule ?? []) as string[];
    if (!ids.length) return calls;
    const beat = ctx.pack.pack.pacing.baseBeatMs;
    const dur = Math.min((p.durationMs as number) * (0.65 + beat / 1100), ctx.durationMs * 0.6);
    // How far past full width the rule runs before settling. `fromLeft` was
    // computed and then discarded (`void fromLeft`), so the seed did nothing.
    const overshootTo = pick(rng, [1.03, 1.06, 1.11]);

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, 180);
      // scaleX from 0 with the anchor implied by the direction — the rule DRAWS
      // rather than fading in, which is what makes it read as a mark being made.
      calls.push(
        track(id, 'scaleX', [
          { t: at, value: 0, bezier: CURVES.snap },
          { t: at + dur, value: overshootTo, bezier: CURVES.settle },
          // Overshoot past full width, then settle back. A rule that stops
          // exactly at its width reads as a progress bar.
          { t: at + dur * 1.35, value: 1, bezier: CURVES.settle },
        ]),
      );
      calls.push(
        track(id, 'opacity', [
          { t: offsetFor(ctx, 'opacity', at), value: 0, bezier: CURVES.snap },
          { t: at + ctx.frameMs * 2, value: 100, bezier: CURVES.snap },
        ]),
      );
    });
    return calls;
  },
};

// ── emphasis.hairline_draw ────────────────────────────────────────────

export const hairlineDraw: TechniqueDef = {
  id: 'emphasis.hairline_draw',
  category: 'emphasis',
  displayName: 'Hairline Draw',
  intent: 'A single-pixel line traces around or beneath an element, very slowly.',
  tags: ['emphasis', 'luxury', 'restrained', '2d', 'hairline'],
  energy: [0.05, 0.35],
  dimensionality: '2d',
  params: {
    durationMs: { kind: 'number', default: 1400, min: 400, max: 4000 },
  },
  roles: ['rule', 'mark'],
  requires: ['set_trim_path', 'set_keyframes'],
  minDurationMs: 600,
  maxDurationMs: 4200,
  approxLayerCount: 0,
  approxToolCalls: 5,
  antipatterns: { neverUnderMs: 550, maxPerComposition: 2, neverWith: ['kinetic_type.slam_in', 'camera.crash_zoom'] },
  variants: 2,
  markers: ['explicit_bezier', 'cross_property_offset', 'follow_through', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = [...(ctx.targets.rule ?? []), ...(ctx.targets.mark ?? [])] as string[];
    if (!ids.length) return calls;
    // How far the tail creeps in behind the head, and how long it takes. The
    // seed was discarded here too.
    const beat = ctx.pack.pack.pacing.baseBeatMs;
    const dur = Math.min(
      (p.durationMs as number) * pick(rng, [0.8, 1, 1.25]) * (0.7 + beat / 1000),
      ctx.durationMs * 0.8,
    );
    const tailCreep = pick(rng, [3, 4, 7]);

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, 320) + ctx.frameMs * 0.5;
      calls.push(mk('set_trim_path', { nodeId: id, start: 0, end: 0, offset: 0 }));
      calls.push(
        track(id, 'pathOp.trimEnd', [
          { t: at, value: 0, bezier: CURVES.drift },
          { t: at + dur, value: 100, bezier: CURVES.drift },
        ]),
      );
      // The START also creeps, slightly and much later — the tail follows the
      // head. A trim that only extends reads as a wipe; one where both ends move
      // reads as a stroke being drawn.
      calls.push(
        track(id, 'pathOp.trimStart', [
          // Begins once the HEAD has finished drawing — the tail follows it in.
          // That is follow-through; starting both at once would just be a second
          // simultaneous move.
          { t: at + dur, value: 0, bezier: CURVES.glide },
          { t: at + dur * 1.25, value: tailCreep, bezier: CURVES.glide },
        ]),
      );
    });
    return calls;
  },
};

// ── emphasis.flash_pop ────────────────────────────────────────────────

export const flashPop: TechniqueDef = {
  id: 'emphasis.flash_pop',
  category: 'emphasis',
  displayName: 'Flash Pop',
  intent: 'One element flares for two frames and settles — a hit, not a highlight.',
  tags: ['emphasis', 'broadcast', 'sports', '2d', 'impact'],
  energy: [0.7, 1],
  dimensionality: '2d',
  params: {
    intensity: { kind: 'number', default: 0.8, min: 0.2, max: 1 },
  },
  roles: ['mark', 'stat', 'overline', 'cta'],
  requires: ['add_effect', 'set_keyframes'],
  minDurationMs: 150,
  maxDurationMs: 900,
  approxLayerCount: 0,
  approxToolCalls: 6,
  antipatterns: {
    neverUnderMs: 130,
    maxPerComposition: 3,
    neverWith: ['emphasis.hairline_draw', 'transition.slow_dissolve'],
    requiresBreathingRoomMs: 250,
  },
  variants: 2,
  markers: ['overshoot', 'anticipation', 'cross_property_offset', 'explicit_bezier', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;
    // Flare radius and how long the decay runs are the variant axes; the seed
    // was discarded before.
    const sig = ctx.pack.pack.motionSignature;
    const intensity = (p.intensity as number) * pick(rng, [0.8, 1, 1.25]) * (0.7 + sig.overshootBias * 0.6);
    const decayFrames = pick(rng, [7, 9, 13]);
    const f = ctx.frameMs;

    ids.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, f * 3);
      const fx = `${ctx.idPrefix}_flash_${i}`;
      calls.push(mk('add_effect', { nodeId: id, type: 'glow', amount: 0 }));
      calls.push(
        track(id, `effect.${fx}.radius`, [
          // The flare LEADS the scale dip by a frame — light reaches the eye
          // before the object appears to move.
          // HOLD on, then decay. A flash frame is a hard cut to full brightness —
          // authoring it as an eased ramp across half a frame is a discontinuity
          // wearing a curve, and the timing linter reported it as POPPING.
          { t: at - ctx.frameMs, value: 0, easing: 'hold' },
          { t: at + f * 0.5, value: 44 * intensity, bezier: CURVES.settle },
          { t: at + f * 4, value: 6 * intensity, bezier: CURVES.settle },
          { t: at + f * decayFrames, value: 0, bezier: CURVES.settle },
        ]),
      );
      // The scale dips FIRST — the anticipation — then flares. A flare with no
      // dip reads as a lighting change rather than an impact.
      calls.push(
        track(id, 'scale', [
          { t: offsetFor(ctx, 'scale', at), value: 1, bezier: CURVES.anticipate },
          { t: at + f * 1.5, value: 0.985, bezier: CURVES.snap },
          { t: at + f * 4, value: 1.03 * (1 + intensity * 0.2), bezier: CURVES.settle },
          { t: at + f * decayFrames, value: 1, bezier: CURVES.settle },
        ]),
      );
    });
    return calls;
  },
};

// ── exit.lift_out ─────────────────────────────────────────────────────

export const liftOut: TechniqueDef = {
  id: 'exit.lift_out',
  category: 'exit',
  displayName: 'Lift Out',
  intent: 'Content leaves the way it arrived but faster, accelerating out of frame.',
  tags: ['exit', 'universal', '2d'],
  energy: [0.2, 0.7],
  dimensionality: '2d',
  params: {
    spanMs: { kind: 'number', default: 260, min: 80, max: 1000 },
  },
  roles: ['headline', 'subhead', 'support', 'overline', 'stat', 'list', 'cta', 'mark', 'quote'],
  requires: ['set_keyframes'],
  minDurationMs: 250,
  maxDurationMs: 1600,
  approxLayerCount: 0,
  approxToolCalls: 8,
  antipatterns: { neverUnderMs: 200, maxPerComposition: 4 },
  variants: 3,
  markers: ['explicit_bezier', 'cross_property_offset', 'nonuniform_stagger', 'anticipation'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const beat = ctx.pack.pack.pacing.baseBeatMs;
    const spanMs = Math.min((p.spanMs as number) * (0.6 + beat / 800), ctx.durationMs * 0.5);
    const perMs = Math.max(180, ctx.durationMs - spanMs);
    const dir = pick(rng, [-1, -1, 1]);
    const dist = travel(ctx, 0.05) * dir;

    // Exits reverse the stagger: the LAST element in reading order leaves first.
    // Keeping the same order makes an exit feel like a second entrance.
    const order = [...ids].reverse();
    order.forEach((id, i) => {
      const at = ctx.startMs + staggerAt(ctx, i, order.length, spanMs);
      calls.push(
        track(id, 'y', [
          // A beat of settle in the opposite direction before leaving.
          { t: at, value: 0, bezier: CURVES.anticipate },
          { t: at + ctx.frameMs * 2, value: -dist * 0.09, bezier: CURVES.snap },
          { t: at + perMs, value: dist, bezier: CURVES.exit },
        ]),
      );
      calls.push(fadeOut(ctx, id, offsetFor(ctx, 'opacity', at + perMs * 0.2), perMs * 0.7));
    });
    return calls;
  },
};

export const SCENE_TECHNIQUES = [
  pushInSlow,
  crashZoom,
  driftParallax,
  auroraDrift,
  gridScan,
  ruleWipe,
  glitchSlam,
  slowDissolve,
  ruleUnderline,
  hairlineDraw,
  flashPop,
  liftOut,
] as const;
