/**
 * Particle motion techniques — atmosphere the layout library did not cover.
 */

import { mk, mulberry32, pick, type ToolCall } from '@motion/design-system';
import type { AnimatableRole, TechniqueDef } from '../schema';
import {
  CURVES, blurIfFast, emitCamera, enterCameraSpace, fadeIn, fadeOut, heroMove,
  offsetFor, subFrame, track,
} from '../emit';

const PARTICLE_REQUIRES = ['create_layer', 'set_keyframes', 'update_layer', 'set_motion_blur'] as const;

/** Same staged roles as the operated-camera set — beats never expose a `camera` slot. */
const CAMERA_STAGED_ROLES: readonly AnimatableRole[] = [
  'camera', 'background', 'media', 'mark', 'rule',
  'overline', 'headline', 'subhead', 'support', 'quote', 'cta',
];

export const particleDrift: TechniqueDef = {
  id: 'background.particle_drift',
  category: 'background',
  displayName: 'Particle Drift',
  intent: 'Soft ambient particles drifting through depth — dust, bokeh, atmosphere.',
  tags: ['background', 'ambient', 'particles', 'depth', 'calm'],
  energy: [0.15, 0.55],
  dimensionality: '3d',
  params: {
    depthSpread: { kind: 'number', default: 0.55, min: 0.2, max: 1 },
  },
  roles: ['background'],
  requires: [...PARTICLE_REQUIRES],
  minDurationMs: 2000,
  maxDurationMs: 120_000,
  approxLayerCount: 1,
  approxToolCalls: 10,
  antipatterns: { maxPerComposition: 2 },
  variants: 4,
  markers: ['explicit_bezier', 'motion_blur', 'cross_property_offset', 'subframe_care', 'overshoot'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const sig = ctx.pack.pack.motionSignature;
    const id = `${ctx.idPrefix}particle_drift_${seed}`;
    const endMs = ctx.startMs + ctx.durationMs;
    const zFrom = pick(rng, [160, 220, 280]) * (p.depthSpread as number);
    const zTo = zFrom - pick(rng, [60, 90, 120]) * (0.8 + sig.overshootBias * 0.4);
    const fadeMs = Math.min(600, ctx.durationMs * (0.18 + ctx.pack.pack.pacing.cutBias * 0.08));
    const t0 = subFrame(ctx.startMs, ctx.frameMs, pick(rng, [0.2, 0.35, 0.5]));
    const zStart = offsetFor(ctx, 'z', t0);
    const opStart = offsetFor(ctx, 'opacity', t0);

    const calls: ToolCall[] = [
      mk('create_layer', {
        id,
        kind: 'particle',
        name: 'Ambient Drift',
        x: ctx.width / 2 + pick(rng, [-40, 0, 40]),
        y: ctx.height / 2 + pick(rng, [-30, 0, 30]),
      }),
      mk('update_layer', { nodeId: id, threeD: true }),
      fadeIn(ctx, id, opStart, fadeMs),
      fadeOut(ctx, id, endMs - fadeMs, fadeMs),
      heroMove(ctx, id, 'z', {
        from: zFrom,
        to: zTo,
        startMs: zStart,
        durationMs: ctx.durationMs * (0.75 + sig.overshootBias * 0.15),
        overshoot: 0.06 + sig.overshootBias * 0.08,
      }),
      mk('set_motion_blur', { nodeId: id, enabled: true }),
    ];
    calls.push(...blurIfFast(ctx, id, Math.abs(zFrom - zTo), ctx.durationMs * 0.8));
    return calls;
  },
};

export const particleBurst: TechniqueDef = {
  id: 'emphasis.particle_burst',
  category: 'emphasis',
  displayName: 'Particle Burst',
  intent: 'A radial burst of particles for impact — confetti, sparks, celebration.',
  tags: ['emphasis', 'impact', 'particles', 'energy', '3d'],
  energy: [0.55, 1],
  dimensionality: '3d',
  params: {
    intensity: { kind: 'number', default: 0.8, min: 0.2, max: 1 },
  },
  roles: ['mark', 'headline', 'media'],
  requires: [...PARTICLE_REQUIRES],
  minDurationMs: 800,
  maxDurationMs: 4000,
  approxLayerCount: 1,
  approxToolCalls: 12,
  antipatterns: { maxPerComposition: 2, neverUnderMs: 600 },
  variants: 4,
  markers: ['overshoot', 'anticipation', 'explicit_bezier', 'motion_blur', 'cross_property_offset', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const sig = ctx.pack.pack.motionSignature;
    const id = `${ctx.idPrefix}particle_burst_${seed}`;
    const tScale = subFrame(ctx.startMs + ctx.frameMs * 2, ctx.frameMs, 0.35);
    const tOpacity = offsetFor(ctx, 'opacity', ctx.startMs + ctx.frameMs * 7);
    const dur = Math.min(ctx.durationMs * 0.55 * (p.intensity as number), ctx.durationMs - ctx.frameMs * 4);
    const travel = pick(rng, [80, 120, 160]) * (0.85 + sig.overshootBias * 0.5);
    const peak = 120 + pick(rng, [10, 30, 50]) * sig.overshootBias;

    const calls: ToolCall[] = [
      mk('create_layer', {
        id,
        kind: 'particle',
        name: 'Burst',
        x: ctx.width * pick(rng, [0.45, 0.5, 0.55]),
        y: ctx.height * pick(rng, [0.42, 0.5, 0.58]),
      }),
      mk('update_layer', { nodeId: id, threeD: true }),
      heroMove(ctx, id, 'scale', {
        from: 15,
        to: peak,
        startMs: tScale,
        durationMs: dur * 0.55,
        anticipation: 0.08 + sig.overshootBias * 0.06,
        overshoot: 0.18 + sig.overshootBias * 0.12,
      }),
      track(id, 'opacity', [
        { t: tOpacity, value: 0, bezier: CURVES.settle },
        { t: tOpacity + dur * 0.12, value: 100, bezier: CURVES.settle },
        { t: tOpacity + dur, value: 0, bezier: CURVES.exit },
      ]),
      mk('set_motion_blur', { nodeId: id, enabled: true }),
    ];
    calls.push(...blurIfFast(ctx, id, travel, dur));
    return calls;
  },
};

export const particleParallaxField: TechniqueDef = {
  id: 'camera.particle_parallax',
  category: 'camera',
  exclusiveResource: 'camera',
  displayName: 'Particle Parallax Field',
  intent: 'Depth-layered particles that sell a slow camera push through space.',
  tags: ['camera', 'parallax', 'particles', 'depth', 'cinematic', '2.5d', 'calm'],
  energy: [0.2, 0.7],
  dimensionality: '2.5d',
  params: {
    layers: { kind: 'number', default: 3, min: 2, max: 3 },
  },
  roles: CAMERA_STAGED_ROLES,
  requires: ['create_layer', 'update_layer', 'set_keyframes', 'set_motion_blur'],
  minDurationMs: 2200,
  maxDurationMs: 14_000,
  approxLayerCount: 3,
  approxToolCalls: 18,
  antipatterns: { maxPerComposition: 1 },
  variants: 3,
  markers: ['explicit_bezier', 'cross_property_offset', 'motion_blur', 'nonuniform_stagger', 'subframe_care'],
  emit(ctx, p, seed) {
    const rng = mulberry32(seed);
    const sig = ctx.pack.pack.motionSignature;
    const layerCount = Math.min(3, Math.max(2, Math.round(p.layers as number)));
    const calls: ToolCall[] = [];
    const camId = `${ctx.idPrefix}_particlecam`;
    const staggerCurve = ctx.pack.pack.pacing.staggerCurve;

    // Long lens: dust layers read as depth when the push is telephoto, not wide.
    calls.push(...emitCamera(ctx, camId, 'Particle Parallax Camera', 'long').calls);
    calls.push(...enterCameraSpace(ctx, CAMERA_STAGED_ROLES));
    calls.push(
      track(camId, 'z', [
        { t: ctx.startMs, value: 40, bezier: CURVES.drift },
        { t: ctx.startMs + ctx.durationMs, value: -80 - sig.overshootBias * 40, bezier: CURVES.settle },
      ]),
    );

    for (let i = 0; i < layerCount; i++) {
      const id = `${ctx.idPrefix}particle_parallax_${seed}_${i}`;
      const z = 120 + i * (140 + sig.overshootBias * 40);
      // Keep the first layer off frame 0 so opacity's −1-frame lead stays ≥ 0.
      const start = Math.max(
        ctx.startMs + ctx.frameMs * 2,
        ctx.startMs + Math.pow(i / Math.max(1, layerCount - 1), staggerCurve) * ctx.durationMs * 0.22,
      );
      const zTravel = 60 * (i + 1) * (0.9 + sig.overshootBias * 0.3);
      calls.push(
        mk('create_layer', {
          id,
          kind: 'particle',
          name: `Parallax ${i + 1}`,
          x: ctx.width / 2 + pick(rng, [-20, 0, 20]),
          y: ctx.height / 2,
        }),
        mk('update_layer', { nodeId: id, threeD: true }),
        heroMove(ctx, id, 'z', {
          from: z,
          to: z - zTravel,
          startMs: offsetFor(ctx, 'z', start),
          durationMs: ctx.durationMs * (0.85 - i * 0.05),
        }),
        // fadeIn applies the opacity lead itself — pass the nominal start only.
        fadeIn(ctx, id, start, Math.min(400, ctx.durationMs * 0.18)),
        mk('set_motion_blur', { nodeId: id, enabled: true }),
      );
      calls.push(...blurIfFast(ctx, id, zTravel, ctx.durationMs * 0.7));
    }
    return calls;
  },
};

export const PARTICLE_TECHNIQUES: readonly TechniqueDef[] = [
  particleDrift,
  particleBurst,
  particleParallaxField,
];
