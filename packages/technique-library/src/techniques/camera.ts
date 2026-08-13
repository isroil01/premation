/**
 * The second camera set — eight techniques, taking the vocabulary from 6 to 14.
 *
 * ## Why more cameras, and why now
 *
 * Six was not a vocabulary, it was a fallback. Measured across 8 packs × 3
 * energies × 3 beats, **16 of 72 beat-slots lost an eligible camera to the
 * 25-candidate cap and 4 reached zero** — so on the beats where the model could
 * cast a camera at all it was frequently choosing from one option, which is not
 * a choice. `reserveByCategory` fixed the eviction; this file gives the reserved
 * slots something worth showing.
 *
 * ## Every technique here stages its own depth
 *
 * A camera does not move a 2D layer: `buildSnapshot` projects through the scene
 * camera only for layers with the 3D switch on, and a perspective camera moving
 * across coplanar layers is a uniform scale. So each emitter calls
 * `enterCameraSpace` (asserted by `cameraSpace.test.ts`) and writes a real z
 * ladder through `stageDepth` below. `CAMERA_WITHOUT_PARALLAX` is the arithmetic
 * that keeps that honest — it fired **105 times** across the corpus against the
 * previous staging behaviour.
 *
 * ## Roles are declared wide on purpose
 *
 * The first camera set declared `['camera','background','media','headline','mark']`
 * and nothing else, so a beat's overline, subhead, support and CTA were left at
 * z=0 by the technique AND skipped by the composition's staging pass, which had
 * stood down on the camera's behalf. Declaring the roles a beat actually carries
 * is what makes the depth ladder cover the frame rather than two layers of it.
 *
 * Pure. Emits `ToolCall[]`, executes nothing, never calls `Math.random`.
 */

import { mk, mulberry32, pick, type ToolCall } from '@motion/design-system';
import type { AnimatableRole, EmitContext, TechniqueDef } from '../schema';
import { CURVES, emitCamera, enterCameraSpace, offsetFor, track, travel } from '../emit';

/**
 * The roles a camera technique stages.
 *
 * Everything a layout can put in a frame, because everything in the frame has to
 * sit on a plane for the move to read. The two that are NOT here — `stat` and
 * `list` — are handled by their containers.
 */
const STAGED_ROLES: readonly AnimatableRole[] = [
  'camera', 'background', 'media', 'mark', 'rule',
  'overline', 'headline', 'subhead', 'support', 'quote', 'cta',
];

/**
 * Back-to-front ORDER of the roles, furthest first.
 *
 * Imagery is furthest away and the headline is nearest the viewer. That is the
 * physical reading and it is also the one that keeps type sharp: a layer pushed
 * away is scaled up to compensate, and doing that to text is how a headline goes
 * soft under a push.
 *
 * An ORDER, not a table of fixed fractions — and the difference is not
 * cosmetic. My first version assigned absolute depths (`background 1.0`,
 * `cta 0.08`, `headline 0`), and `CAMERA_WITHOUT_PARALLAX` immediately fired
 * **57 times** on the corpus: a beat whose layout produces only a headline and a
 * CTA got 0 and 26px, which is arithmetically staged and visually flat. Fixed
 * fractions encode an assumption about WHICH roles a beat carries, and a layout
 * library of 44 templates violates that assumption constantly.
 *
 * Ranking the roles that are actually present and distributing them across the
 * full spread makes the guarantee unconditional: N distinct planes for N roles,
 * whichever N the layout produced.
 *
 * (The first camera set's `background|media → 1, mark → 0.35, else → 0` was the
 * same mistake in a harsher form — every role a real beat carries collapsed onto
 * the headline's plane.)
 */
const ROLE_ORDER: readonly string[] = [
  'background', 'media', 'rule', 'mark', 'support', 'subhead', 'overline', 'quote', 'cta', 'headline',
];

/**
 * Put every target on its own plane and hold it there.
 *
 * `easing: 'hold'` on both ends: this is a static arrangement, not an animation,
 * and a hold keyframe is what says so. It also earns `subframe_care` honestly —
 * the marker detector counts a hold, and a hold is exactly what this is.
 */
function stageDepth(ctx: EmitContext, spread: number): ToolCall[] {
  const targets = ctx.targets as Record<string, string[] | undefined>;
  const calls: ToolCall[] = [];

  const plane = (id: string, z: number): void => {
    calls.push(mk('update_layer', { nodeId: id, threeD: true }));
    calls.push(
      track(id, 'z', [
        { t: ctx.startMs, value: Math.round(z), easing: 'hold' },
        { t: ctx.startMs + ctx.durationMs, value: Math.round(z), easing: 'hold' },
      ]),
    );
  };

  // The composition backdrop sits BEYOND the beat's ladder rather than taking
  // its far rung. It belongs to the composition, not to this beat: it is one
  // layer shared by every beat, and giving it a rung meant the beat's own
  // content occupied only `spread − step` and the measured spread came in under
  // the ladder it was supposed to have. Pushing it past the end also matches
  // what it is — the wall behind the set.
  for (const id of targets.background ?? []) plane(id, spread * 1.15);

  // The beat's own roles, in back-to-front order, spanning the full spread.
  const present = ROLE_ORDER.filter((role) => role !== 'background' && targets[role]?.length);
  if (!present.length) return calls;

  // A single role gets the far plane rather than a division by zero — one layer
  // has nothing to parallax against anyway, and the rule exempts that case.
  const step = present.length > 1 ? spread / (present.length - 1) : 0;
  present.forEach((role, i) => {
    for (const id of targets[role] ?? []) plane(id, spread - i * step);
  });
  return calls;
}

/**
 * The follow-through every operated camera has and no keyframed one does.
 *
 * A rig that stops every axis on the same frame is the single clearest tell of a
 * camera that was animated rather than operated. This keeps one axis easing for
 * a beat after the primary move lands — and it is what earns the
 * `follow_through` marker, which the test suite measures rather than trusts.
 */
function settleAfter(ctx: EmitContext, camId: string, amount: number): ToolCall {
  const end = ctx.startMs + ctx.durationMs;
  return track(camId, 'orbitYaw', [
    { t: end, value: 0, bezier: CURVES.settle },
    { t: end + ctx.durationMs * 0.09, value: amount, bezier: CURVES.settle },
    { t: end + ctx.durationMs * 0.18, value: 0, bezier: CURVES.settle },
  ]);
}

/** Shared antipattern block — one camera per composition, always. */
const CAMERA_GUARD = { maxPerComposition: 1 } as const;

// ── camera.pull_back_reveal ───────────────────────────────────────────

export const pullBackReveal: TechniqueDef = {
  id: 'camera.pull_back_reveal',
  category: 'camera',
  exclusiveResource: 'camera',
  displayName: 'Pull Back to Reveal',
  intent: 'Opens tight on the subject and retreats to disclose the whole frame. The reveal is the point.',
  tags: ['camera', 'reveal', 'cinematic', 'opening', '2.5d', 'parallax'],
  energy: [0.15, 0.6],
  dimensionality: '2.5d',
  params: {
    amount: { kind: 'number', default: 0.5, min: 0.15, max: 1 },
    depthSpread: { kind: 'number', default: 320, min: 120, max: 900 },
  },
  roles: STAGED_ROLES,
  requires: ['create_layer', 'update_layer', 'set_keyframes'],
  minDurationMs: 1800,
  maxDurationMs: 14000,
  approxLayerCount: 1,
  approxToolCalls: 14,
  antipatterns: { ...CAMERA_GUARD, neverWith: ['camera.crash_zoom', 'kinetic_type.slam_in'], neverUnderMs: 1600 },
  variants: 3,
  markers: ['explicit_bezier', 'cross_property_offset', 'follow_through', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const spread = p.depthSpread as number;
    const calls: ToolCall[] = [];
    const camId = `${ctx.idPrefix}_cam`;

    // Wide, because the retreat should feel like space opening up rather than a
    // subject shrinking — a long lens pulling back reads as a zoom out.
    calls.push(...emitCamera(ctx, camId, 'Pull Back Camera', 'normal').calls);
    calls.push(...enterCameraSpace(ctx, STAGED_ROLES));
    calls.push(...stageDepth(ctx, spread));

    const sig = ctx.pack.pack.motionSignature;
    const dist = spread * (p.amount as number) * (0.8 + sig.overshootBias * 0.6);
    calls.push(
      track(camId, 'z', [
        // Starts INSIDE the scene and retreats. A pull-back that begins at rest
        // is a dolly out; beginning past the subject is what makes it a reveal.
        { t: ctx.startMs, value: -dist, bezier: CURVES.drift },
        { t: ctx.startMs + ctx.durationMs * 0.9, value: dist * 0.06, bezier: CURVES.settle },
        { t: ctx.startMs + ctx.durationMs, value: 0, bezier: CURVES.settle },
      ]),
    );
    // Offset from the dolly so the two axes do not start together.
    const rise = travel(ctx, pick(rng, [0.01, 0.018, 0.026]));
    calls.push(
      track(camId, 'y', [
        { t: offsetFor(ctx, 'y', ctx.startMs), value: rise, bezier: CURVES.glide },
        { t: ctx.startMs + ctx.durationMs, value: 0, bezier: CURVES.glide },
      ]),
    );
    calls.push(settleAfter(ctx, camId, rise * 0.01));
    return calls;
  },
};

// ── camera.crane_down ─────────────────────────────────────────────────

export const craneDown: TechniqueDef = {
  id: 'camera.crane_down',
  category: 'camera',
  exclusiveResource: 'camera',
  displayName: 'Crane Down',
  intent: 'Descends from above and levels off. Production value from the first frame; announces scale.',
  tags: ['camera', 'crane', 'cinematic', 'hero', 'establishing', '2.5d'],
  energy: [0.2, 0.65],
  dimensionality: '2.5d',
  params: {
    height: { kind: 'number', default: 0.22, min: 0.06, max: 0.5 },
    depthSpread: { kind: 'number', default: 300, min: 120, max: 900 },
  },
  roles: STAGED_ROLES,
  requires: ['create_layer', 'update_layer', 'set_keyframes'],
  minDurationMs: 2000,
  maxDurationMs: 14000,
  approxLayerCount: 1,
  approxToolCalls: 14,
  antipatterns: { ...CAMERA_GUARD, neverWith: ['camera.whip_pan'], neverUnderMs: 1800 },
  variants: 3,
  markers: ['explicit_bezier', 'overshoot', 'cross_property_offset', 'follow_through', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const spread = p.depthSpread as number;
    const calls: ToolCall[] = [];
    const camId = `${ctx.idPrefix}_cranecam`;

    calls.push(...emitCamera(ctx, camId, 'Crane Camera', 'portrait').calls);
    calls.push(...enterCameraSpace(ctx, STAGED_ROLES));
    calls.push(...stageDepth(ctx, spread));

    const drop = travel(ctx, p.height as number);
    const sig = ctx.pack.pack.motionSignature;
    calls.push(
      track(camId, 'y', [
        { t: ctx.startMs, value: -drop, bezier: CURVES.drift },
        // Past level, then back up to it. A crane arm has mass and the operator
        // rides it down; landing exactly on the mark is the keyframed tell.
        { t: ctx.startMs + ctx.durationMs * 0.86, value: drop * 0.07 * (1 + sig.overshootBias), bezier: CURVES.settle },
        { t: ctx.startMs + ctx.durationMs, value: 0, bezier: CURVES.settle },
      ]),
    );
    // The pitch levels out as the arm comes down — looking down at the top of
    // the move and straight ahead at the bottom. Offset so it is not locked to
    // the descent.
    calls.push(
      track(camId, 'orbitPitch', [
        { t: offsetFor(ctx, 'rotation', ctx.startMs), value: -3.5 - rng() * 2, bezier: CURVES.glide },
        { t: ctx.startMs + ctx.durationMs, value: 0, bezier: CURVES.glide },
      ]),
    );
    calls.push(settleAfter(ctx, camId, 0.25));
    return calls;
  },
};

// ── camera.rack_focus ─────────────────────────────────────────────────

export const rackFocus: TechniqueDef = {
  id: 'camera.rack_focus',
  category: 'camera',
  exclusiveResource: 'camera',
  displayName: 'Rack Focus',
  intent: 'Throws focus from the near plane to the far one. Redirects the eye without moving the frame.',
  tags: ['camera', 'focus', 'cinematic', 'calm', 'restrained', 'depth'],
  energy: [0.05, 0.45],
  dimensionality: '2.5d',
  params: {
    strength: { kind: 'number', default: 18, min: 4, max: 48 },
    depthSpread: { kind: 'number', default: 380, min: 200, max: 900 },
  },
  roles: STAGED_ROLES,
  requires: ['create_layer', 'update_layer', 'set_keyframes'],
  minDurationMs: 1600,
  maxDurationMs: 12000,
  approxLayerCount: 1,
  approxToolCalls: 14,
  antipatterns: { ...CAMERA_GUARD, neverWith: ['camera.crash_zoom', 'camera.whip_pan'], neverUnderMs: 1400 },
  variants: 3,
  markers: ['explicit_bezier', 'cross_property_offset', 'follow_through', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const spread = p.depthSpread as number;
    const calls: ToolCall[] = [];
    const camId = `${ctx.idPrefix}_rackcam`;

    // The one technique here whose whole subject is depth of field, so it is the
    // one that needs a real aperture. `dofStrength` is the blur cap and
    // `dofAperture` the slope; `readSceneDof` returns null when strength is 0,
    // which is why this has to be set rather than relying on a default.
    const cam = emitCamera(ctx, camId, 'Rack Focus Camera', 'portrait');
    calls.push(...cam.calls);
    calls.push(
      mk('update_layer', {
        nodeId: camId,
        dofStrength: p.strength as number,
        dofAperture: (p.strength as number) * 1.6,
        focusDistance: cam.focalLength,
      }),
    );
    calls.push(...enterCameraSpace(ctx, STAGED_ROLES));
    calls.push(...stageDepth(ctx, spread));

    // Focus travels from the near plane to the far one. The middle key sits past
    // the destination — a focus puller overshoots and corrects, and a perfectly
    // monotonic rack is the tell of a machine doing it.
    //
    // The overshoot is scaled by the PACK, like every other move in this library.
    // Without that this technique emitted byte-identical calls in `luxury_film`
    // and `broadcast_sports`, and the determinism test caught it: a technique
    // that ignores the motion signature makes the pack cosmetic, and the packs
    // are not supposed to be cosmetic.
    const sig = ctx.pack.pack.motionSignature;
    const near = cam.focalLength;
    const far = cam.focalLength + spread;
    calls.push(
      track(camId, 'focusDistance', [
        { t: ctx.startMs, value: near, bezier: CURVES.drift },
        {
          t: ctx.startMs + ctx.durationMs * (0.78 + sig.overshootBias * 0.08),
          value: far + spread * (0.04 + sig.overshootBias * 0.09),
          bezier: CURVES.settle,
        },
        { t: ctx.startMs + ctx.durationMs, value: far, bezier: CURVES.settle },
      ]),
    );
    // A breath of dolly under the rack, offset from it. Focus alone reads as a
    // post effect; a trace of camera motion makes it a lens.
    const breath = travel(ctx, (0.006 + rng() * 0.004) * (0.7 + sig.overshootBias * 0.8));
    calls.push(
      track(camId, 'z', [
        { t: offsetFor(ctx, 'z', ctx.startMs), value: 0, bezier: CURVES.glide },
        { t: ctx.startMs + ctx.durationMs, value: -breath, bezier: CURVES.glide },
      ]),
    );
    calls.push(settleAfter(ctx, camId, 0.12));
    return calls;
  },
};

// ── camera.dolly_zoom ─────────────────────────────────────────────────

export const dollyZoom: TechniqueDef = {
  id: 'camera.dolly_zoom',
  category: 'camera',
  exclusiveResource: 'camera',
  displayName: 'Dolly Zoom',
  intent: 'Dollies in while zooming out. The subject holds its size and the world warps behind it.',
  tags: ['camera', 'vertigo', 'cinematic', 'unsettling', 'impact', '2.5d'],
  energy: [0.35, 0.85],
  dimensionality: '2.5d',
  params: {
    amount: { kind: 'number', default: 0.4, min: 0.1, max: 1 },
    depthSpread: { kind: 'number', default: 420, min: 200, max: 900 },
  },
  roles: STAGED_ROLES,
  requires: ['create_layer', 'update_layer', 'set_keyframes'],
  minDurationMs: 1600,
  maxDurationMs: 9000,
  approxLayerCount: 1,
  approxToolCalls: 15,
  antipatterns: { ...CAMERA_GUARD, neverWith: ['camera.crash_zoom', 'camera.handheld_float'], neverUnderMs: 1500 },
  variants: 3,
  markers: ['explicit_bezier', 'overshoot', 'cross_property_offset', 'follow_through', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const spread = p.depthSpread as number;
    const calls: ToolCall[] = [];
    const camId = `${ctx.idPrefix}_dzcam`;

    const cam = emitCamera(ctx, camId, 'Dolly Zoom Camera', 'normal');
    calls.push(...cam.calls);
    calls.push(...enterCameraSpace(ctx, STAGED_ROLES));
    // The effect IS the depth: with everything on one plane a counter-animated
    // dolly and zoom cancel exactly and the frame does not change at all. This
    // technique is unusually dependent on a wide spread, hence the raised floor
    // on `depthSpread`.
    calls.push(...stageDepth(ctx, spread));

    // Scaled by the pack, like every other move here. A vertigo shot in
    // `luxury_film` is a slow unease and in `broadcast_sports` it is a lurch;
    // emitting the same numbers for both is what makes a pack cosmetic, and the
    // determinism test refuses it.
    const sig = ctx.pack.pack.motionSignature;
    const push = spread * (p.amount as number) * (0.75 + sig.overshootBias * 0.7);
    calls.push(
      track(camId, 'z', [
        { t: ctx.startMs, value: 0, bezier: CURVES.drift },
        {
          t: ctx.startMs + ctx.durationMs * 0.88,
          value: -push * (1 + 0.04 + sig.overshootBias * 0.06),
          bezier: CURVES.settle,
        },
        { t: ctx.startMs + ctx.durationMs, value: -push, bezier: CURVES.settle },
      ]),
    );
    // Focal length widens by the same proportion the dolly closes, so the
    // subject at z=0 keeps its size. Offset by the standard lead so the two do
    // not start on the same frame — which is what makes it read as operated.
    const widen = cam.focalLength * (p.amount as number) * 0.5;
    calls.push(
      track(camId, 'focalLength', [
        { t: offsetFor(ctx, 'scale', ctx.startMs), value: cam.focalLength, bezier: CURVES.drift },
        { t: ctx.startMs + ctx.durationMs, value: cam.focalLength - widen, bezier: CURVES.settle },
      ]),
    );
    calls.push(settleAfter(ctx, camId, 0.2 + rng() * 0.2));
    return calls;
  },
};

// ── camera.tilt_reveal ────────────────────────────────────────────────

export const tiltReveal: TechniqueDef = {
  id: 'camera.tilt_reveal',
  category: 'camera',
  exclusiveResource: 'camera',
  displayName: 'Tilt Reveal',
  intent: 'Tilts up the frame to uncover the subject. Reads as looking up at something.',
  tags: ['camera', 'reveal', 'hero', 'entrance', 'establishing', '2.5d'],
  energy: [0.2, 0.7],
  dimensionality: '2.5d',
  params: {
    angle: { kind: 'number', default: 7, min: 2, max: 18 },
    depthSpread: { kind: 'number', default: 300, min: 120, max: 900 },
  },
  roles: STAGED_ROLES,
  requires: ['create_layer', 'update_layer', 'set_keyframes'],
  minDurationMs: 1500,
  maxDurationMs: 10000,
  approxLayerCount: 1,
  approxToolCalls: 14,
  antipatterns: { ...CAMERA_GUARD, neverWith: ['camera.crane_down'], neverUnderMs: 1300 },
  variants: 3,
  markers: ['explicit_bezier', 'overshoot', 'cross_property_offset', 'follow_through', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const spread = p.depthSpread as number;
    const calls: ToolCall[] = [];
    const camId = `${ctx.idPrefix}_tiltcam`;

    calls.push(...emitCamera(ctx, camId, 'Tilt Camera', 'wide').calls);
    calls.push(...enterCameraSpace(ctx, STAGED_ROLES));
    calls.push(...stageDepth(ctx, spread));

    const sig = ctx.pack.pack.motionSignature;
    const angle = p.angle as number;
    calls.push(
      track(camId, 'orbitPitch', [
        { t: ctx.startMs, value: -angle, bezier: CURVES.drift },
        { t: ctx.startMs + ctx.durationMs * 0.85, value: angle * 0.08 * (1 + sig.overshootBias), bezier: CURVES.settle },
        { t: ctx.startMs + ctx.durationMs, value: 0, bezier: CURVES.settle },
      ]),
    );
    // A little rise under the tilt, so the move has translation as well as
    // rotation. A pure rotation about the eye reads as a pan, not as a reveal.
    const rise = travel(ctx, 0.012 + rng() * 0.01);
    calls.push(
      track(camId, 'y', [
        { t: offsetFor(ctx, 'y', ctx.startMs), value: rise, bezier: CURVES.glide },
        { t: ctx.startMs + ctx.durationMs, value: 0, bezier: CURVES.glide },
      ]),
    );
    calls.push(settleAfter(ctx, camId, 0.18));
    return calls;
  },
};

// ── camera.arc_around ─────────────────────────────────────────────────

export const arcAround: TechniqueDef = {
  id: 'camera.arc_around',
  category: 'camera',
  exclusiveResource: 'camera',
  displayName: 'Arc Around Subject',
  intent: 'Swings around the subject on a fixed point of interest. The subject stays framed while the world turns.',
  tags: ['camera', 'orbit', 'product', 'hero', 'cinematic', '3d'],
  energy: [0.25, 0.75],
  dimensionality: '3d',
  params: {
    sweep: { kind: 'number', default: 14, min: 4, max: 40 },
    depthSpread: { kind: 'number', default: 400, min: 200, max: 900 },
  },
  roles: STAGED_ROLES,
  requires: ['create_layer', 'update_layer', 'set_keyframes'],
  minDurationMs: 2200,
  maxDurationMs: 14000,
  approxLayerCount: 1,
  approxToolCalls: 15,
  antipatterns: { ...CAMERA_GUARD, neverWith: ['camera.orbit_reveal', 'camera.whip_pan'], neverUnderMs: 2000 },
  variants: 3,
  markers: ['explicit_bezier', 'overshoot', 'cross_property_offset', 'follow_through', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const spread = p.depthSpread as number;
    const calls: ToolCall[] = [];
    const camId = `${ctx.idPrefix}_arccam`;

    const cam = emitCamera(ctx, camId, 'Arc Camera', 'portrait');
    calls.push(...cam.calls);
    // A TWO-NODE camera: any POI prop present makes `cameraFromNode` aim the
    // camera at the target and keep it framed through the swing. Without it the
    // orbit is about the comp centre, which is the same move but cannot be
    // pointed at anything.
    calls.push(
      mk('update_layer', {
        nodeId: camId,
        poiX: ctx.width / 2,
        poiY: ctx.height / 2,
        poiZ: Math.round(spread * 0.3),
      }),
    );
    calls.push(...enterCameraSpace(ctx, STAGED_ROLES));
    calls.push(...stageDepth(ctx, spread));

    // The pack sets how far the arc swings and how far past its mark it rides.
    // A restrained pack traverses less and stops cleanly; an energetic one swings
    // wider and settles back.
    const sig = ctx.pack.pack.motionSignature;
    const sweep = (p.sweep as number) * (0.8 + sig.overshootBias * 0.5);
    const dir = rng() > 0.5 ? 1 : -1;
    calls.push(
      track(camId, 'orbitYaw', [
        { t: ctx.startMs, value: -sweep * dir, bezier: CURVES.drift },
        {
          t: ctx.startMs + ctx.durationMs * 0.9,
          value: sweep * dir * (1 + 0.02 + sig.overshootBias * 0.05),
          bezier: CURVES.settle,
        },
        { t: ctx.startMs + ctx.durationMs, value: sweep * dir, bezier: CURVES.settle },
      ]),
    );
    // A gentle rise across the arc, offset — an arc that stays exactly level is
    // a turntable, and a turntable is a product render, not a camera move.
    calls.push(
      track(camId, 'orbitPitch', [
        { t: offsetFor(ctx, 'rotation', ctx.startMs), value: 1.5, bezier: CURVES.glide },
        { t: ctx.startMs + ctx.durationMs, value: -1.5, bezier: CURVES.glide },
      ]),
    );
    // The follow-through goes on a DIFFERENT axis from the primary, or it reads
    // as the arc failing to stop rather than as the operator relaxing.
    const end = ctx.startMs + ctx.durationMs;
    calls.push(
      track(camId, 'x', [
        { t: end, value: 0, bezier: CURVES.settle },
        { t: end + ctx.durationMs * 0.1, value: travel(ctx, 0.004) * dir, bezier: CURVES.settle },
        { t: end + ctx.durationMs * 0.2, value: 0, bezier: CURVES.settle },
      ]),
    );
    return calls;
  },
};

// ── camera.settle_on_rest ─────────────────────────────────────────────

export const settleOnRest: TechniqueDef = {
  id: 'camera.settle_on_rest',
  category: 'camera',
  exclusiveResource: 'camera',
  displayName: 'Settle On Rest',
  intent: 'Arrives from a small offset and comes to rest. The quietest camera there is; use it to end on.',
  tags: ['camera', 'calm', 'restrained', 'closing', 'endcard', '2.5d'],
  energy: [0.05, 0.4],
  dimensionality: '2.5d',
  params: {
    amount: { kind: 'number', default: 0.03, min: 0.008, max: 0.08 },
    depthSpread: { kind: 'number', default: 260, min: 120, max: 700 },
  },
  roles: STAGED_ROLES,
  requires: ['create_layer', 'update_layer', 'set_keyframes'],
  minDurationMs: 1200,
  maxDurationMs: 12000,
  approxLayerCount: 1,
  approxToolCalls: 13,
  antipatterns: { ...CAMERA_GUARD, neverWith: ['camera.crash_zoom', 'kinetic_type.slam_in'] },
  variants: 3,
  markers: ['explicit_bezier', 'anticipation', 'cross_property_offset', 'follow_through', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const spread = p.depthSpread as number;
    const calls: ToolCall[] = [];
    const camId = `${ctx.idPrefix}_restcam`;

    calls.push(...emitCamera(ctx, camId, 'Rest Camera', 'long').calls);
    calls.push(...enterCameraSpace(ctx, STAGED_ROLES));
    calls.push(...stageDepth(ctx, spread));

    // Even the quietest technique reads the pack. This move is 3% of the frame,
    // so the signature's effect is a few pixels — and a few pixels is exactly
    // the difference between "restrained" and "inert" at this scale.
    const sig = ctx.pack.pack.motionSignature;
    const drift = travel(ctx, (p.amount as number) * (0.7 + sig.overshootBias * 0.9));
    const dir = rng() > 0.5 ? 1 : -1;
    // `anticipate` has y1 < 0 — the camera leans the wrong way for two frames
    // before it goes. On a move this small that is the entire character of it.
    calls.push(
      track(camId, 'x', [
        { t: ctx.startMs, value: drift * dir, bezier: CURVES.anticipate },
        { t: ctx.startMs + ctx.durationMs, value: 0, bezier: CURVES.settle },
      ]),
    );
    calls.push(
      track(camId, 'z', [
        { t: offsetFor(ctx, 'z', ctx.startMs), value: -drift * 0.5, bezier: CURVES.glide },
        { t: ctx.startMs + ctx.durationMs, value: 0, bezier: CURVES.glide },
      ]),
    );
    calls.push(settleAfter(ctx, camId, 0.08));
    return calls;
  },
};

// ── camera.match_move ─────────────────────────────────────────────────

export const matchMove: TechniqueDef = {
  id: 'camera.match_move',
  category: 'camera',
  exclusiveResource: 'camera',
  // The whole technique is "the move continues through the cut", which is only
  // a match if something else continues too. Over the sequencer's weakest
  // auto-inserted bridge the camera would be the only thing that carried, and a
  // camera still travelling while the entire frame changes reads as an error.
  requiresBridge: true,
  displayName: 'Match Move Across the Cut',
  intent: 'Carries one continuous camera move through a beat boundary, so two beats read as one shot.',
  tags: ['camera', 'continuity', 'transition', 'cinematic', '2.5d', 'parallax'],
  energy: [0.2, 0.7],
  dimensionality: '2.5d',
  params: {
    amount: { kind: 'number', default: 0.18, min: 0.05, max: 0.5 },
    depthSpread: { kind: 'number', default: 340, min: 150, max: 900 },
  },
  roles: STAGED_ROLES,
  requires: ['create_layer', 'update_layer', 'set_keyframes'],
  minDurationMs: 1500,
  maxDurationMs: 12000,
  approxLayerCount: 1,
  approxToolCalls: 14,
  antipatterns: { ...CAMERA_GUARD, neverWith: ['camera.whip_pan', 'camera.crash_zoom'], neverUnderMs: 1400 },
  variants: 3,
  markers: ['explicit_bezier', 'cross_property_offset', 'follow_through', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const spread = p.depthSpread as number;
    const calls: ToolCall[] = [];
    const camId = `${ctx.idPrefix}_matchcam`;

    calls.push(...emitCamera(ctx, camId, 'Match Move Camera', 'normal').calls);
    calls.push(...enterCameraSpace(ctx, STAGED_ROLES));
    calls.push(...stageDepth(ctx, spread));

    // Deliberately does NOT decelerate into the beat's end. The whole point is
    // that the move is still going when the cut happens — the eye tracks
    // through it, which is what makes two beats read as one shot. Every other
    // camera technique here settles; this one is the exception and the exception
    // is the technique.
    // A carry is still a pack decision: how far the shot travels through the cut
    // is the difference between a drift and a sweep.
    const sig = ctx.pack.pack.motionSignature;
    const dist = spread * (p.amount as number) * (0.75 + sig.overshootBias * 0.7);
    const dir = rng() > 0.5 ? 1 : -1;
    calls.push(
      track(camId, 'x', [
        { t: ctx.startMs, value: -dist * dir, bezier: CURVES.glide },
        // Past the boundary. The value at the cut is mid-travel, not a rest.
        { t: ctx.startMs + ctx.durationMs * 1.25, value: dist * dir, bezier: CURVES.glide },
      ]),
    );
    calls.push(
      track(camId, 'z', [
        { t: offsetFor(ctx, 'z', ctx.startMs), value: 0, bezier: CURVES.drift },
        { t: ctx.startMs + ctx.durationMs * 1.25, value: -dist * 0.35, bezier: CURVES.drift },
      ]),
    );
    // The follow-through here runs PAST the beat too, for the same reason — and
    // it has to start after the LONGEST primary channel, not after the beat.
    // Both the x and z tracks above already run to 1.25×, so a settle beginning
    // at 1.0× is concurrent with them rather than following them: the craft-floor
    // test measured this technique at three markers and correctly refused the
    // `follow_through` it declared. The declaration was the lie, not the test.
    const carryEnd = ctx.startMs + ctx.durationMs * 1.25;
    calls.push(
      track(camId, 'orbitYaw', [
        { t: carryEnd, value: 0.3 * dir, bezier: CURVES.glide },
        { t: carryEnd + ctx.durationMs * 0.2, value: 0, bezier: CURVES.glide },
      ]),
    );
    return calls;
  },
};

export const CAMERA_TECHNIQUES_2: readonly TechniqueDef[] = [
  pullBackReveal,
  craneDown,
  rackFocus,
  dollyZoom,
  tiltReveal,
  arcAround,
  settleOnRest,
  matchMove,
];
