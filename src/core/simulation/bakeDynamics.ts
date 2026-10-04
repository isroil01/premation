/**
 * Bake dynamics to keyframes — the TypeScript REFERENCE samplers.
 *
 * The bakes themselves are the engine's `physicsBake` / `particleBake` jobs
 * (native/engine/src/jobs/kind_dynamics_bake.cpp, B4 round 8): the renderer's
 * own solvers sampled over the range and written as ONE history entry. What
 * stays here is the sampling those jobs port, operation for operation, over the
 * TypeScript solvers — `physicsPosesAt` for rigid bodies, `simulateParticles` /
 * `statefulParticleCache` for particles — so the cross-engine tests
 * (dynamicsBakeNative.test.ts) can hold the engine to it on seeded cases.
 *
 * The rules the engine keeps:
 *
 *   * The bake plays back identically to the viewport it replaced — it calls the
 *     solver the renderer calls, never a second stepper.
 *   * Baked keys interpolate LINEARLY (they are samples of an already-curved
 *     motion) and the LAST key holds (no extrapolated motion past the range).
 *   * `simplifyTolerance` thins by Douglas-Peucker on VALUE deviation (The
 *     Smoother's test) before the easing is stamped.
 */

import type { Keyframe } from '@motion/animation';
import { smoothTrackKeyframes } from '@core/animation/keyframeAssistants';

// ── Shared range / track plumbing ─────────────────────────────────────

export interface BakeRangeOptions {
  /** Range start, COMPOSITION seconds. */
  from: number;
  /** Range end, composition seconds (inclusive). */
  to: number;
  fps: number;
  /**
   * Sample every Nth frame. 1 = every frame (the faithful default). Larger
   * values thin the track by TIME, before any value-based simplification —
   * the two are different knobs and a caller may want either or both.
   */
  everyNFrames?: number;
  /**
   * Douglas-Peucker tolerance in value units (px for position, degrees for
   * rotation). 0 / omitted keeps every sample. Runs The Smoother's own
   * `smoothTrackKeyframes`, so a baked track thins by the same rule a hand-
   * authored one does.
   */
  simplifyTolerance?: number;
}

/** One baked scalar track. `t` is COMPOSITION seconds — the caller maps it
 *  onto the keyframe axis, because only the caller knows the node. */
export interface BakedTrack {
  nodeId: string;
  prop: string;
  keyframes: Keyframe[];
}

/**
 * The frames a bake samples.
 *
 * The END frame is always included even when it is not on the stride: the
 * last key is the one that holds, and a bake that stopped 3 frames short of
 * the range the user asked for would silently shorten the motion.
 */
export function bakeFrames(opts: BakeRangeOptions): number[] {
  const fps = opts.fps > 0 ? opts.fps : 30;
  const step = Math.max(1, Math.floor(opts.everyNFrames ?? 1));
  const f0 = Math.max(0, Math.round(opts.from * fps));
  const f1 = Math.max(f0, Math.round(opts.to * fps));
  const out: number[] = [];
  for (let f = f0; f <= f1; f += step) out.push(f);
  if (out[out.length - 1] !== f1) out.push(f1);
  return out;
}

/**
 * Samples → keyframes: simplify (optionally), then stamp interpolation.
 *
 * Easing is stamped AFTER simplification on purpose. `smoothTrackKeyframes`
 * hands back smoothed tangents — right for The Smoother, wrong here, where the
 * curve is already the motion and any added shape is invention.
 */
export function finishBakedTrack(
  samples: ReadonlyArray<{ t: number; value: number }>,
  tolerance = 0,
): Keyframe[] {
  if (samples.length === 0) return [];
  const raw: Keyframe[] = samples.map((s) => ({ t: s.t, value: s.value }));
  const thinned = tolerance > 0 ? smoothTrackKeyframes(raw, tolerance) : raw;
  return thinned.map((k, i) => ({
    t: k.t,
    value: k.value,
    easing: i === thinned.length - 1 ? ('hold' as const) : ('linear' as const),
  }));
}

// ── Particles ─────────────────────────────────────────────────────────

export interface ParticleBakeOptions extends BakeRangeOptions {
  /**
   * Hard cap on layers created. A particle field is routinely thousands of
   * particles and a layer each is a document nobody can open, let alone edit —
   * so the cap is a REFUSAL, not a truncation hint: the caller is told how many
   * there were and decides.
   */
  maxParticles?: number;
}

export const DEFAULT_PARTICLE_BAKE_CAP = 200;

/** One particle's whole life, as tracks in composition seconds. */
export interface BakedParticle {
  index: number;
  /** Base size in px the layer is built at; scale keys are relative to it. */
  baseSize: number;
  x: Array<{ t: number; value: number }>;
  y: Array<{ t: number; value: number }>;
  /** Layer scale multiplier (1 = `baseSize`). */
  scale: Array<{ t: number; value: number }>;
  /** Layer opacity, 0..100. */
  opacity: Array<{ t: number; value: number }>;
}

export interface ParticleSampleResult {
  particles: BakedParticle[];
  /** Distinct particles seen in the range, before the cap. */
  seen: number;
  /** True when `seen` exceeded the cap and the list was trimmed. */
  capped: boolean;
}
