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
import { physicsPosesAt } from './physicsBodies';
import type { BodySeed, PhysicsWorld } from './rigidBody';
import { simulateParticles, type Particle, type ParticleConfig } from '@core/particles/particleSim';
import { particlesFromSoA } from '@core/particles/statefulParticleSim';
import { statefulParticleCache } from '@core/particles/statefulParticleCache';

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

// ── Physics: sampling (pure, given seeds) ─────────────────────────────

/**
 * Step the shared solver over the range and read back each target's pose.
 *
 * Pure with respect to the scene: seeds and world come in, tracks come out,
 * with `t` in composition seconds. That is what makes the interesting half
 * testable without a scene graph, a timeline or a store.
 *
 * `rotation` appears only for bodies that opted into spin — `physicsPosesAt`
 * reports an angle only for those, and writing a constant 0 for the rest would
 * turn a rotation-lock into a rotation FREEZE, overwriting whatever the layer's
 * own rotation track was doing.
 */
export function samplePhysicsTracks(
  seeds: ReadonlyArray<BodySeed>,
  world: PhysicsWorld,
  targetIds: ReadonlyArray<string>,
  opts: BakeRangeOptions,
  compKey = 'bake',
): BakedTrack[] {
  const fps = opts.fps > 0 ? opts.fps : 30;
  const frames = bakeFrames({ ...opts, fps });
  const wanted = new Set(targetIds);

  const samples = new Map<string, { x: Array<{ t: number; value: number }>; y: Array<{ t: number; value: number }>; rotation: Array<{ t: number; value: number }> }>();
  for (const id of wanted) samples.set(id, { x: [], y: [], rotation: [] });

  for (const frame of frames) {
    const poses = physicsPosesAt(compKey, seeds, world, fps, frame);
    const t = frame / fps;
    for (const id of wanted) {
      const pose = poses.get(id);
      if (!pose) continue;
      const bucket = samples.get(id)!;
      bucket.x.push({ t, value: pose.x });
      bucket.y.push({ t, value: pose.y });
      if (pose.rotation !== undefined) bucket.rotation.push({ t, value: pose.rotation });
    }
  }

  const out: BakedTrack[] = [];
  for (const id of targetIds) {
    const bucket = samples.get(id);
    if (!bucket) continue;
    // x and y are SEPARATE scalar tracks in this engine — there is no combined
    // position property to write.
    for (const prop of ['x', 'y', 'rotation'] as const) {
      const list = bucket[prop];
      if (list.length === 0) continue;
      out.push({ nodeId: id, prop, keyframes: finishBakedTrack(list, opts.simplifyTolerance ?? 0) });
    }
  }
  return out;
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

/**
 * All particles alive anywhere in the range, grouped by identity.
 *
 * Identity is `Particle.index` — the birth index, which is why that field
 * exists at all (see its docstring). Grouping by array position instead would
 * re-assign every particle to a different layer the moment one of them died.
 *
 * Which particles survive the cap: the EARLIEST-born ones, so a capped bake is
 * the front of the emission rather than an arbitrary slice. Sorting by index
 * also makes the layer order stable across re-bakes.
 */
export function sampleParticleLayers(
  configAt: (frame: number) => ParticleConfig,
  opts: ParticleBakeOptions,
  cacheKey = 'bake',
): ParticleSampleResult {
  const fps = opts.fps > 0 ? opts.fps : 30;
  const frames = bakeFrames({ ...opts, fps });
  const cap = Math.max(1, Math.floor(opts.maxParticles ?? DEFAULT_PARTICLE_BAKE_CAP));

  const byIndex = new Map<number, BakedParticle>();
  for (const frame of frames) {
    const cfg = configAt(frame);
    const t = frame / fps;
    for (const p of particlesAtFrame(cfg, frame, fps, cacheKey)) {
      if (p.index === undefined) continue;
      let rec = byIndex.get(p.index);
      if (!rec) {
        // The size at FIRST sighting is the layer's base size, so the layer is
        // built at the particle's real size and its scale track starts at 1.
        rec = { index: p.index, baseSize: Math.max(1, p.size), x: [], y: [], scale: [], opacity: [] };
        byIndex.set(p.index, rec);
      }
      rec.x.push({ t, value: p.x });
      rec.y.push({ t, value: p.y });
      rec.scale.push({ t, value: p.size / rec.baseSize });
      rec.opacity.push({ t, value: Math.max(0, Math.min(1, p.opacity)) * 100 });
    }
  }

  const all = [...byIndex.values()].sort((a, b) => a.index - b.index);
  return { particles: all.slice(0, cap), seen: all.length, capped: all.length > cap };
}

/** The renderer's own two entry points, chosen by sim mode — never a third. */
function particlesAtFrame(
  cfg: ParticleConfig,
  frame: number,
  fps: number,
  cacheKey: string,
): Particle[] {
  if (cfg.simMode === 'stateful') {
    const cache = statefulParticleCache(cacheKey, cfg, fps);
    const state = cache.stateAt(Math.max(0, frame));
    return particlesFromSoA(state, cfg, { frame, fps });
  }
  return simulateParticles(cfg, frame / fps);
}
