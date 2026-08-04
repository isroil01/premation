/**
 * The four techniques four different packs already named.
 *
 * ## Why these exist and the others do not
 *
 * These were not chosen from a list of nice ideas. Every one of them was already
 * a first-choice entry in a LookPack's `prefer` list — `emphasis.spec_reveal` in
 * `apple_keynote`, `transition.streak_wipe` in `broadcast_sports`,
 * `emphasis.chromatic_pulse` in `cyberpunk_kinetic`, `background.soft_mesh` in
 * `saas_explainer` — and none of them had ever been written.
 *
 * A `prefer` entry is a ranking hint: `indexOf` returns -1 for a name that
 * resolves to nothing, the score contribution is skipped, and the pack silently
 * degrades to having no opinion. Nothing fails, nothing logs, and the pack's
 * stated first choice is simply absent from every piece it ever produces. Four
 * packs had been shipping their second-best answer since they were written.
 *
 * `preferList.test.ts` is the standing check that stops this recurring. This
 * file is the debt it found.
 *
 * Each is authored to the pack that asked for it: the keynote spec callout is
 * restrained and leader-led, the broadcast streak is fast and blurred, the
 * cyberpunk pulse is a signal fault, and the SaaS mesh never draws attention.
 */

import { mk, mulberry32, pick, type ToolCall } from '@motion/design-system';
import type { TechniqueDef } from '../schema';
import { CURVES, blurIfFast, fadeIn, hold, offsetFor, rolesTargets, staggerAt, subFrame, track, travel } from '../emit';

// ── emphasis.spec_reveal ──────────────────────────────────────────────

/**
 * The keynote spec callout: a hairline leader draws OUT, and the number arrives
 * at the end of it.
 *
 * The order is the whole technique. A spec that fades in and then grows a line
 * is a label with decoration; a line that travels and delivers a number is a
 * measurement being taken. The leader has to finish first, and the number has to
 * arrive slightly before the line settles, or the two read as unrelated events
 * that happened to be near each other.
 */
export const specReveal: TechniqueDef = {
  id: 'emphasis.spec_reveal',
  category: 'emphasis',
  displayName: 'Spec Reveal',
  intent: 'A hairline leader draws out and delivers a number at its tip. Measured, not announced.',
  tags: ['emphasis', 'keynote', 'product', 'restrained', '2d', 'spec', 'hero'],
  energy: [0.1, 0.55],
  dimensionality: '2d',
  params: {
    leaderFraction: { kind: 'number', default: 0.12, min: 0.04, max: 0.32 },
    durationMs: { kind: 'number', default: 900, min: 350, max: 2400 },
  },
  roles: ['stat', 'support', 'overline', 'mark'],
  requires: ['create_layer', 'update_layer', 'set_trim_path', 'set_keyframes'],
  minDurationMs: 700,
  maxDurationMs: 5000,
  approxLayerCount: 3,
  approxToolCalls: 14,
  antipatterns: {
    neverUnderMs: 650,
    maxPerComposition: 2,
    // A spec callout is a moment of attention. Anything that tears the frame at
    // the same time destroys the one thing it is asking the eye to do.
    neverWith: ['transition.glitch_slam', 'kinetic_type.slam_in', 'camera.crash_zoom'],
    requiresBreathingRoomMs: 300,
  },
  variants: 3,
  markers: ['explicit_bezier', 'cross_property_offset', 'follow_through', 'nonuniform_stagger', 'overshoot', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const sig = ctx.pack.pack.motionSignature;
    // The leader's length, the side it comes from, and how long it takes are the
    // three variant axes. A pack that overshoots harder also draws faster — the
    // signature has to reach the line, not just the number.
    const leaderPx = travel(ctx, (p.leaderFraction as number) * pick(rng, [0.85, 1, 1.2]));
    const fromLeft = rng() > 0.45;
    const drawMs = Math.min(
      (p.durationMs as number) * (1.15 - sig.overshootBias * 0.35),
      ctx.durationMs * 0.55,
    );

    ids.forEach((id, i) => {
      // Non-uniform by construction — `staggerAt` applies the pack's curve in
      // waves. A spec sheet whose rows land on a metronome reads as a table
      // being filled in, not as three separate claims.
      const at = ctx.startMs + staggerAt(ctx, i, ids.length, drawMs * 0.9);
      const leaderId = `${ctx.idPrefix}_lead_${i}`;
      const y = ctx.height * (0.34 + i * 0.11);
      const x = fromLeft ? ctx.width * 0.22 : ctx.width * 0.78;

      calls.push(
        mk('create_layer', {
          id: leaderId, kind: 'shape', shape: 'rect', name: `Leader ${i}`,
          x, y, width: leaderPx, height: Math.max(1, Math.round(ctx.height * 0.0012)),
        }),
      );
      calls.push(mk('update_layer', { nodeId: leaderId, fill: ctx.pack.palette.line }));

      // The line is DRAWN, not scaled. A rule that scales in from zero width
      // reads as a bar appearing; a trim window opening reads as a stroke being
      // laid down, which is the difference this technique trades on.
      calls.push(mk('set_trim_path', { nodeId: leaderId, start: 0, end: 0, offset: 0 }));
      calls.push(
        track(leaderId, 'pathOp.trimEnd', [
          { t: subFrame(at, ctx.frameMs, 0.35), value: 0, bezier: CURVES.settle },
          { t: at + drawMs, value: 100, bezier: CURVES.settle },
        ]),
      );
      // Follow-through: the TAIL creeps in once the head has arrived, so the
      // line thins toward its origin instead of sitting there as a full rule.
      // Beginning both ends together would be a second simultaneous move, not
      // follow-through — see the marker's definition.
      calls.push(
        track(leaderId, 'pathOp.trimStart', [
          { t: at + drawMs, value: 0, bezier: CURVES.glide },
          { t: at + drawMs * 1.3, value: pick(rng, [6, 9, 14]), bezier: CURVES.glide },
        ]),
      );

      // The number arrives just BEFORE the leader lands — it is delivered by the
      // line, so it must be in place as the line reaches it. Arriving after would
      // read as two events; arriving with it would read as one block.
      const landAt = at + drawMs * 0.78;
      const push = leaderPx * 0.22 * (fromLeft ? 1 : -1);
      calls.push(
        track(id, 'x', [
          // Anticipation, then past the mark, then settle. Three keys minimum on
          // a hero move — a straight A→B is what makes generated motion legible
          // as generated.
          { t: offsetFor(ctx, 'x', landAt), value: -push, bezier: CURVES.anticipate },
          { t: landAt + drawMs * 0.16, value: push * 0.14 * (1 + sig.overshootBias), bezier: CURVES.settle },
          { t: landAt + drawMs * 0.34, value: 0, bezier: CURVES.settle },
        ]),
      );
      // Opacity leads the position by the property lead — the number is legible
      // before it stops moving, which is what makes it read as solid.
      calls.push(fadeIn(ctx, id, landAt, drawMs * 0.5));
      // Scale runs on its own schedule again: a whisper, scaled by the pack.
      calls.push(
        track(id, 'scale', [
          { t: landAt + ctx.frameMs, value: 0.985, bezier: CURVES.settle },
          { t: landAt + drawMs * 0.22, value: 1 + 0.012 * (0.5 + sig.overshootBias), bezier: CURVES.settle },
          { t: landAt + drawMs * 0.45, value: 1, bezier: CURVES.settle },
        ]),
      );
    });
    return calls;
  },
};

// ── transition.streak_wipe ────────────────────────────────────────────

/**
 * Speed streaks carry the cut.
 *
 * The thing that makes this read as broadcast rather than as bars sliding past
 * is that the streaks are not the same length, do not start together, and do not
 * travel at the same speed. A rank of identical bars crossing on a fixed
 * interval is a venetian blind.
 */
export const streakWipe: TechniqueDef = {
  id: 'transition.streak_wipe',
  category: 'transition',
  displayName: 'Streak Wipe',
  intent: 'A rake of speed streaks tears across the frame and takes the cut with it.',
  tags: ['transition', 'broadcast', 'sports', 'fast', '2d', 'wipe', 'streak'],
  energy: [0.6, 1],
  dimensionality: '2d',
  params: {
    streaks: { kind: 'number', default: 7, min: 3, max: 14 },
    angle: { kind: 'number', default: -18, min: -45, max: 45 },
    durationMs: { kind: 'number', default: 380, min: 140, max: 900 },
  },
  roles: ['background'],
  requires: ['create_layer', 'update_layer', 'set_keyframes', 'set_motion_blur'],
  minDurationMs: 240,
  maxDurationMs: 1100,
  approxLayerCount: 7,
  approxToolCalls: 24,
  antipatterns: {
    neverUnderMs: 220,
    maxPerComposition: 3,
    // Both are full-frame events on a similar timescale. Two of them in the same
    // cut is not a louder cut, it is an unreadable one.
    neverWith: ['transition.slow_dissolve', 'transition.iris', 'camera.push_in_slow'],
  },
  variants: 3,
  markers: ['anticipation', 'cross_property_offset', 'explicit_bezier', 'motion_blur', 'nonuniform_stagger', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const sig = ctx.pack.pack.motionSignature;
    const count = Math.max(3, Math.round(p.streaks as number));
    const angle = p.angle as number;
    const dur = (p.durationMs as number) * (1.15 - sig.overshootBias * 0.3);
    const upward = rng() > 0.5;
    // Which way the rake sweeps, and the palette pair it sweeps in.
    const dir = rng() > 0.5 ? 1 : -1;
    const across = ctx.width * 1.9;

    for (let i = 0; i < count; i++) {
      const id = `${ctx.idPrefix}_streak_${i}`;
      // Lengths and weights are drawn from the seed, so no two streaks are the
      // same object repeated. A uniform rake is the venetian blind this is
      // trying not to be.
      const len = ctx.width * (0.35 + rng() * 0.75);
      const thick = Math.max(2, Math.round(ctx.height * (0.004 + rng() * 0.02)));
      const lane = ctx.height * ((i + 0.5) / count) + (rng() - 0.5) * ctx.height * 0.05;

      calls.push(
        mk('create_layer', {
          id, kind: 'shape', shape: 'rect', name: `Streak ${i}`,
          x: ctx.width / 2, y: upward ? ctx.height - lane : lane,
          width: Math.round(len), height: thick,
        }),
      );
      calls.push(
        mk('update_layer', {
          nodeId: id,
          fill: i % 3 === 0 ? ctx.pack.palette.accent : i % 3 === 1 ? ctx.pack.palette.fg : ctx.pack.palette.support,
          rotation: angle,
          blendMode: 'screen',
        }),
      );

      // The rake staggers on the pack's curve, not on a fixed interval.
      const at = ctx.startMs + staggerAt(ctx, i, count, dur * 0.55);
      const start = ctx.width / 2 - across * 0.5 * dir;
      const end = ctx.width / 2 + across * 0.5 * dir;
      // Each streak takes a slightly different time to cross. Identical speeds
      // make the rake read as one rigid object with gaps cut in it.
      const cross = dur * (0.72 + rng() * 0.5);

      calls.push(
        track(id, 'x', [
          // Anticipation: the streak backs further off-frame for two frames
          // before it launches. On a fast move this is barely perceptible as a
          // position and very perceptible as weight.
          { t: subFrame(at, ctx.frameMs, 0.2), value: start, bezier: CURVES.anticipate },
          { t: at + ctx.frameMs * 2, value: start - across * 0.06 * dir, bezier: CURVES.snap },
          { t: at + cross, value: end, bezier: CURVES.snap },
        ]),
      );
      // ScaleX lags the travel by two frames and stretches at speed, then
      // collapses. A constant-length streak is a bar; one that stretches is
      // velocity made visible.
      calls.push(
        track(id, 'scaleX', [
          { t: at + ctx.frameMs * 2, value: 0.7, bezier: CURVES.snap },
          { t: at + cross * 0.45, value: 1.5 + sig.overshootBias * 0.8, bezier: CURVES.settle },
          { t: at + cross, value: 0.55, bezier: CURVES.settle },
        ]),
      );
      // Opacity is a short window: the streak is only visible while it is fast.
      // A streak that fades out slowly at the end of its travel reads as a bar
      // that stopped.
      calls.push(
        track(id, 'opacity', [
          { t: offsetFor(ctx, 'opacity', at), value: 0, bezier: CURVES.snap },
          { t: at + cross * 0.18, value: 100, bezier: CURVES.snap },
          { t: at + cross * 0.86, value: 0, bezier: CURVES.exit },
        ]),
      );
      calls.push(...blurIfFast(ctx, id, across, cross));
    }
    return calls;
  },
};

// ── emphasis.chromatic_pulse ──────────────────────────────────────────

/**
 * An RGB separation that pulses and recovers — a signal fault, not a colour
 * treatment.
 *
 * Built from `channel-mixer` cross-feed rather than a hue shift, because those
 * are different things: a hue rotation moves the whole image around the wheel
 * and still reads as *a colour*, while feeding red into blue and blue into red
 * pulls the channels apart and reads as *a failure*. The `echo` gives the
 * separation somewhere to smear to.
 *
 * The pulses are irregular in time on purpose. A regular pulse is a heartbeat,
 * and a heartbeat is alive; interference is not.
 */
export const chromaticPulse: TechniqueDef = {
  id: 'emphasis.chromatic_pulse',
  category: 'emphasis',
  displayName: 'Chromatic Pulse',
  intent: 'The colour channels pull apart and snap back, twice, like a signal fighting to hold.',
  tags: ['emphasis', 'cyberpunk', 'glitch', 'technical', '2d', 'chromatic'],
  energy: [0.55, 1],
  dimensionality: '2d',
  params: {
    intensity: { kind: 'number', default: 0.7, min: 0.15, max: 1 },
    pulses: { kind: 'number', default: 2, min: 1, max: 4 },
  },
  roles: ['headline', 'overline', 'stat', 'mark', 'cta'],
  requires: ['add_effect', 'set_keyframes'],
  minDurationMs: 320,
  maxDurationMs: 2200,
  approxLayerCount: 0,
  approxToolCalls: 12,
  antipatterns: {
    neverUnderMs: 300,
    maxPerComposition: 2,
    // Two chromatic faults at once is noise with no signal left to fault.
    neverWith: ['transition.glitch_slam', 'emphasis.hairline_draw', 'transition.slow_dissolve'],
    requiresBreathingRoomMs: 260,
  },
  variants: 3,
  markers: ['overshoot', 'cross_property_offset', 'explicit_bezier', 'nonuniform_stagger', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const ids = rolesTargets(ctx, this.roles);
    if (!ids.length) return calls;

    const sig = ctx.pack.pack.motionSignature;
    const intensity = (p.intensity as number) * (0.7 + sig.overshootBias * 0.6);
    const pulses = Math.max(1, Math.round(p.pulses as number));
    const f = ctx.frameMs;
    // How far the channels separate, how long the echo trails, and which channel
    // leads are the variant axes.
    const bleed = 46 * intensity * pick(rng, [0.8, 1, 1.3]);
    const redLeads = rng() > 0.5;

    ids.forEach((id, i) => {
      const mixFx = `${ctx.idPrefix}_chroma_${i}`;
      const echoFx = `${ctx.idPrefix}_smear_${i}`;
      // Both effects are NAMED. `add_effect` generates its own id otherwise, and
      // a flat emitter cannot read a return value — so the tracks below would
      // point at effects that never existed and store keyframes nothing reads.
      // See `emphasis.flash_pop`, which shipped exactly that bug.
      calls.push(mk('add_effect', { nodeId: id, type: 'channel-mixer', id: mixFx }));
      calls.push(mk('add_effect', { nodeId: id, type: 'echo', id: echoFx }));

      const at = ctx.startMs + staggerAt(ctx, i, ids.length, f * 4);

      /**
       * The pulse train. Gaps are irregular, and they scale with the SLOT.
       *
       * Both halves matter. Irregular, because two pulses on the same interval
       * are a rhythm and a rhythm is something alive — interference is not.
       * Slot-scaled, because a fixed frame count left the back two-thirds of a
       * long beat with nothing happening in it: the timing linter reported 3.4s
       * of dead air, correctly. The pulses spread to fill what they are given;
       * only the RECOVERY stays at a fixed frame count, because a signal
       * recovers at signal speed no matter how long the shot is.
       */
      const span = ctx.durationMs * 0.62;
      const beats: number[] = [];
      let cursor = at;
      for (let k = 0; k < pulses; k++) {
        beats.push(cursor);
        cursor += Math.max(f * 7, (span / pulses) * (0.65 + rng() * 0.7));
      }

      /**
       * Red ← blue cross-feed. The ATTACK is a hold; the RECOVERY is eased.
       *
       * This is the asymmetry that makes it read as a fault rather than as a
       * move, and it is the same call `transition.glitch_slam` makes: a
       * discontinuity that has been eased is no longer a discontinuity. So the
       * channels separate on a hard cut — one frame, no curve — and then fight
       * their way back over five, crossing past rest on the way. Easing the
       * attack too would produce a smooth colour swing, which is a treatment.
       *
       * The timing linter agrees, and said so: an eased attack tripped `POPPING`
       * on every pack and every seed, with the fix named in the message. A hold
       * is how you declare that the jump is the point.
       */
      const mixKeys: { t: number; value: number; easing?: string; bezier?: [number, number, number, number] }[] = [
        { t: at - f, value: 0, easing: 'hold' },
      ];
      for (const b of beats) {
        mixKeys.push({ t: subFrame(b, f, 0.3), value: bleed, bezier: CURVES.settle });
        // Both recovery segments run longer than a frame and a half, so the
        // slide back is a move and only the attack is a cut.
        mixKeys.push({ t: b + f * 2.5, value: -bleed * 0.42, bezier: CURVES.settle });
        mixKeys.push({ t: b + f * 5, value: 0, easing: 'hold' });
      }
      calls.push(track(id, `effect.${mixFx}.${redLeads ? 'redBlue' : 'blueRed'}`, mixKeys));

      // The opposite feed, one frame behind. Two channels separating on the SAME
      // frame is a tint; separating a frame apart is a split.
      const laggedKeys = mixKeys.map((k) => ({
        t: k.t + f,
        value: -k.value * 0.75,
        ...(k.easing ? { easing: k.easing } : {}),
        ...(k.bezier ? { bezier: k.bezier } : {}),
      }));
      calls.push(track(id, `effect.${mixFx}.${redLeads ? 'blueRed' : 'redBlue'}`, laggedKeys));

      // The echo count rides the pulse so the smear only exists while the
      // channels are apart. A permanent echo is a ghosting artefact; a
      // momentary one is the separation having somewhere to go.
      calls.push(
        track(id, `effect.${echoFx}.numEchoes`, [
          { t: at - f, value: 0, easing: 'hold' },
          { t: subFrame(beats[0]!, f, 0.3), value: Math.round(2 + intensity * 4), easing: 'hold' },
          { t: beats[beats.length - 1]! + f * 3.5, value: 0, easing: 'hold' },
        ]),
      );
      // A sub-pixel horizontal jitter, leading the first pulse. The eye reads
      // the displacement before it reads the colour.
      // Four frames of run-up, and NOT through `offsetFor`. The x lead pushed
      // the anchor forward until the run-up was exactly 1.5 frames — right on
      // the pop threshold — so the displacement was being read as a jump. It is
      // a move; only the colour attack is a cut. The offset from the mixer track
      // is explicit here rather than derived, because that is what it is for.
      calls.push(
        track(id, 'x', [
          { t: at - f * 4, value: 0, bezier: CURVES.anticipate },
          { t: beats[0]! + f * 0.5, value: bleed * 0.06, bezier: CURVES.snap },
          { t: beats[0]! + f * 3, value: -bleed * 0.02, bezier: CURVES.settle },
          { t: beats[beats.length - 1]! + f * 5, value: 0, bezier: CURVES.settle },
        ]),
      );
    });
    return calls;
  },
};

// ── background.soft_mesh ──────────────────────────────────────────────

/**
 * Three soft colour fields drifting behind everything, on periods that never
 * line up.
 *
 * The one rule that matters here is that the blobs must not share a period. Give
 * three drifting shapes the same cycle length and they lock into a single moving
 * mass — which is a gradient sliding around, the exact thing a mesh gradient is
 * chosen over. Different periods mean the composite is never quite the same
 * twice inside the piece's length.
 *
 * Deliberately far below the threshold of attention: this sits behind copy that
 * has to be readable, and a backdrop that can be watched is a backdrop that has
 * taken the beat.
 */
export const softMesh: TechniqueDef = {
  id: 'background.soft_mesh',
  category: 'background',
  displayName: 'Soft Mesh',
  intent: 'Three blurred colour fields drift behind the frame on periods that never align.',
  tags: ['background', 'ambient', 'calm', 'saas', 'friendly', '2d', 'gradient'],
  energy: [0.05, 0.5],
  dimensionality: '2d',
  params: {
    blobs: { kind: 'number', default: 3, min: 2, max: 5 },
    driftFraction: { kind: 'number', default: 0.08, min: 0.02, max: 0.24 },
  },
  roles: ['background'],
  requires: ['create_layer', 'update_layer', 'add_effect', 'set_keyframes'],
  minDurationMs: 2500,
  maxDurationMs: 30000,
  approxLayerCount: 3,
  approxToolCalls: 16,
  antipatterns: {
    neverUnderMs: 2200,
    maxPerComposition: 1,
    // Every one of these owns the backdrop. Two ambient fields in one
    // composition is two things competing to be ignored.
    neverWith: ['background.aurora_drift', 'background.grid_scan', 'background.noise_field'],
  },
  variants: 3,
  markers: ['explicit_bezier', 'cross_property_offset', 'nonuniform_stagger', 'overshoot', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const calls: ToolCall[] = [];
    const count = Math.max(2, Math.round(p.blobs as number));
    const drift = travel(ctx, p.driftFraction as number);
    const palette = ctx.pack.palette;
    const inks = [palette.accent, palette.support, palette.line, palette.muted];
    // How soft, and how large — a mesh that is not soft enough reads as circles.
    const softness = Math.round(Math.min(ctx.width, ctx.height) * pick(rng, [0.16, 0.22, 0.3]));

    for (let i = 0; i < count; i++) {
      const id = `${ctx.idPrefix}_mesh_${i}`;
      const size = Math.round(Math.min(ctx.width, ctx.height) * (0.55 + rng() * 0.5));
      const cx = ctx.width * (0.18 + rng() * 0.64);
      const cy = ctx.height * (0.18 + rng() * 0.64);

      calls.push(
        mk('create_layer', {
          id, kind: 'shape', shape: 'ellipse', name: `Mesh ${i}`,
          x: cx, y: cy, width: size, height: Math.round(size * (0.7 + rng() * 0.6)),
        }),
      );
      calls.push(mk('update_layer', { nodeId: id, fill: inks[i % inks.length]!, blendMode: 'screen', opacity: 42 }));
      calls.push(mk('add_effect', { nodeId: id, type: 'blur', amount: softness, id: `${ctx.idPrefix}_soft_${i}` }));

      // Each blob gets its OWN period, and the ratios are irrational enough that
      // they do not re-align inside any plausible composition length. Sharing a
      // period is what turns three fields into one moving mass.
      const period = ctx.durationMs * (0.61 + i * 0.29 + rng() * 0.17);
      // Entry times are curved rather than evenly spaced — the same reason every
      // other technique here uses `staggerAt` instead of `i * k`.
      const at = ctx.startMs + staggerAt(ctx, i, count, 420);
      const dir = rng() > 0.5 ? 1 : -1;

      // X drifts past its far point and comes back — a field that reaches its
      // extreme and reverses exactly there reads as a bounce off a wall.
      calls.push(
        track(id, 'x', [
          { t: subFrame(at, ctx.frameMs, 0.25), value: cx, bezier: CURVES.glide },
          { t: at + period * 0.5, value: cx + drift * dir * 1.08, bezier: CURVES.glide },
          { t: at + period * 0.72, value: cx + drift * dir * 0.94, bezier: CURVES.glide },
          { t: at + period, value: cx, bezier: CURVES.glide },
        ]),
      );
      // Y runs on a different fraction of the same period, offset from x, so the
      // blob traces a loop rather than a diagonal.
      calls.push(
        track(id, 'y', [
          { t: offsetFor(ctx, 'y', at) + ctx.frameMs * 2, value: cy, bezier: CURVES.glide },
          { t: at + period * 0.34, value: cy - drift * 0.62 * dir, bezier: CURVES.glide },
          { t: at + period * 0.79, value: cy + drift * 0.44 * dir, bezier: CURVES.glide },
          { t: at + period * 1.06, value: cy, bezier: CURVES.glide },
        ]),
      );
      // Scale breathes on yet another period, and past its mark. Three channels
      // on three periods is what stops the composite from repeating.
      calls.push(
        track(id, 'scale', [
          { t: at + ctx.frameMs * 4, value: 1, bezier: CURVES.glide },
          { t: at + period * 0.44, value: 1.14, bezier: CURVES.glide },
          { t: at + period * 0.68, value: 1.06, bezier: CURVES.glide },
          { t: at + period * 0.93, value: 1, bezier: CURVES.glide },
        ]),
      );
      // The blur holds — animating softness as well would be a fourth moving
      // channel on a layer nobody is supposed to be watching.
      calls.push(hold(id, 'rotation', 0, at, at + period));
    }
    return calls;
  },
};

export const SCENE_TECHNIQUES_3: readonly TechniqueDef[] = [
  specReveal,
  streakWipe,
  chromaticPulse,
  softMesh,
];
