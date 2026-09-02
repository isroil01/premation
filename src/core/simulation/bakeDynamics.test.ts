/**
 * Baking dynamics to keyframes.
 *
 * The claim under test is narrow and is the only one that matters: **the baked
 * track is what the solver actually did**. So the assertions are about the
 * shape of real motion (a falling body's y never decreases before it lands, and
 * stops changing once it has) rather than about specific numbers, which would
 * only re-state the solver's arithmetic back to itself.
 *
 * `samplePhysicsTracks` and `sampleParticleLayers` are exercised directly: they
 * take seeds / a config and return tracks, so the interesting half needs no
 * scene graph, no timeline and no store — and a failure here is a failure of
 * the bake rather than of the fixture around it.
 */

import {
  bakeFrames,
  finishBakedTrack,
  sampleParticleLayers,
  samplePhysicsTracks,
  DEFAULT_PARTICLE_BAKE_CAP,
} from './bakeDynamics';
import { resetPhysicsCaches } from './physicsBodies';
import { DEFAULT_PHYSICS_BODY, type BodySeed, type PhysicsWorld } from './rigidBody';
import { DEFAULT_PARTICLE_CONFIG, type ParticleConfig } from '@core/particles/particleSim';
import { clearStatefulParticleCaches } from '@core/particles/statefulParticleCache';

const FPS = 30;

/** A world with a floor at y = 600 and nothing else in it. */
const WORLD: PhysicsWorld = {
  gravityX: 0,
  gravityY: 1800,
  bounds: { left: -10_000, top: -10_000, right: 10_000, bottom: 600 },
  iterations: 4,
};

/** One 100×100 box starting at the top, dead (restitution 0) so the landing is
 *  a stop rather than a bounce — the bounce is `rigidBody.test.ts`'s subject. */
function fallingBox(patch: Partial<typeof DEFAULT_PHYSICS_BODY> = {}): BodySeed[] {
  return [{
    id: 'box',
    x: 100,
    y: 0,
    width: 100,
    height: 100,
    cfg: { ...DEFAULT_PHYSICS_BODY, enabled: true, kind: 'dynamic', shape: 'box', restitution: 0, damping: 1, ...patch },
  }];
}

const track = (tracks: ReturnType<typeof samplePhysicsTracks>, prop: string) =>
  tracks.find((t) => t.prop === prop);

beforeEach(() => {
  resetPhysicsCaches();
  clearStatefulParticleCaches();
});

describe('bakeFrames', () => {
  it('walks the range on the stride and always includes the last frame', () => {
    expect(bakeFrames({ from: 0, to: 1, fps: 30, everyNFrames: 1 })).toHaveLength(31);
    // 0,4,8…28 is eight frames; 30 is off-stride and joins anyway, because the
    // last key is the one that holds.
    expect(bakeFrames({ from: 0, to: 1, fps: 30, everyNFrames: 4 })).toEqual(
      [0, 4, 8, 12, 16, 20, 24, 28, 30],
    );
  });

  it('never samples a negative frame', () => {
    expect(bakeFrames({ from: -2, to: 0.1, fps: 30 })[0]).toBe(0);
  });
});

describe('finishBakedTrack', () => {
  const ramp = Array.from({ length: 10 }, (_, i) => ({ t: i / 30, value: i * 10 }));

  it('writes LINEAR keys and HOLDS the last one', () => {
    const kfs = finishBakedTrack(ramp);
    expect(kfs).toHaveLength(10);
    expect(kfs.slice(0, -1).every((k) => k.easing === 'linear')).toBe(true);
    expect(kfs[kfs.length - 1]!.easing).toBe('hold');
  });

  it('simplification collapses a straight run and keeps the endpoints', () => {
    const thinned = finishBakedTrack(ramp, 1);
    expect(thinned.length).toBeLessThan(ramp.length);
    expect(thinned[0]!.value).toBe(0);
    expect(thinned[thinned.length - 1]!.value).toBe(90);
    // Still linear-then-hold after thinning — the tangents The Smoother hands
    // back must not survive into a bake.
    expect(thinned[thinned.length - 1]!.easing).toBe('hold');
    expect(thinned.every((k) => k.bezier === undefined)).toBe(true);
  });
});

describe('samplePhysicsTracks — a falling body', () => {
  it('baked y is monotonic non-decreasing and settles on the floor', () => {
    const tracks = samplePhysicsTracks(fallingBox(), WORLD, ['box'], { from: 0, to: 2, fps: FPS });
    const y = track(tracks, 'y');
    expect(y).toBeDefined();
    const values = y!.keyframes.map((k) => k.value);
    expect(values.length).toBe(61);

    for (let i = 1; i < values.length; i++) {
      // Non-decreasing: gravity is down, restitution is zero, nothing pushes up.
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]! - 1e-9);
    }
    // It actually fell (otherwise "monotonic" is vacuously true of a constant).
    expect(values[values.length - 1]!).toBeGreaterThan(values[0]! + 100);
    // …and landed: the box half-height above the floor, and holding there.
    expect(values[values.length - 1]!).toBeCloseTo(550, 3);
    expect(values[values.length - 1]!).toBeCloseTo(values[values.length - 2]!, 6);
  });

  it('x is a SEPARATE track and holds still under vertical gravity', () => {
    const tracks = samplePhysicsTracks(fallingBox(), WORLD, ['box'], { from: 0, to: 1, fps: FPS });
    const x = track(tracks, 'x');
    expect(x).toBeDefined();
    expect(new Set(x!.keyframes.map((k) => k.value))).toEqual(new Set([100]));
  });

  it('the key count respects everyNFrames', () => {
    const every = (n: number): number =>
      track(samplePhysicsTracks(fallingBox(), WORLD, ['box'], { from: 0, to: 2, fps: FPS, everyNFrames: n }), 'y')!
        .keyframes.length;
    expect(every(1)).toBe(61);
    expect(every(2)).toBe(31);
    // 0,5,…,60 — the end frame is already on the stride here.
    expect(every(5)).toBe(13);
    // Off-stride end: 0,7,…,56 is nine, plus frame 60.
    expect(every(7)).toBe(10);
  });

  it('thinning by value is a second, independent knob', () => {
    const dense = track(samplePhysicsTracks(fallingBox(), WORLD, ['box'], { from: 0, to: 2, fps: FPS }), 'y')!;
    const thin = track(
      samplePhysicsTracks(fallingBox(), WORLD, ['box'], { from: 0, to: 2, fps: FPS, simplifyTolerance: 4 }),
      'y',
    )!;
    expect(thin.keyframes.length).toBeLessThan(dense.keyframes.length);
    expect(thin.keyframes[thin.keyframes.length - 1]!.value)
      .toBeCloseTo(dense.keyframes[dense.keyframes.length - 1]!.value, 6);
  });

  it('rotation is baked only for a body that opted into spin', () => {
    const locked = samplePhysicsTracks(fallingBox(), WORLD, ['box'], { from: 0, to: 1, fps: FPS });
    expect(track(locked, 'rotation')).toBeUndefined();

    resetPhysicsCaches();
    // Tilted so the landing produces real torque rather than a symmetric stop.
    const spinning = samplePhysicsTracks(
      [{ ...fallingBox({ rotate: true })[0]!, rotation: 20 }],
      WORLD,
      ['box'],
      { from: 0, to: 2, fps: FPS },
    );
    const rot = track(spinning, 'rotation');
    expect(rot).toBeDefined();
    expect(rot!.keyframes[0]!.value).toBeCloseTo(20, 6);
    expect(new Set(rot!.keyframes.map((k) => Math.round(k.value))).size).toBeGreaterThan(1);
  });

  it('a static body gets no track — the renderer never overrides its pose', () => {
    const seeds: BodySeed[] = [
      ...fallingBox(),
      { id: 'wall', x: 400, y: 550, width: 800, height: 20, cfg: { ...DEFAULT_PHYSICS_BODY, enabled: true, kind: 'static' } },
    ];
    const tracks = samplePhysicsTracks(seeds, WORLD, ['box', 'wall'], { from: 0, to: 1, fps: FPS });
    expect(tracks.some((t) => t.nodeId === 'wall')).toBe(false);
    expect(tracks.some((t) => t.nodeId === 'box')).toBe(true);
  });

  it('sampling the range out of order gives the same track (the seek contract)', () => {
    const opts = { from: 0, to: 2, fps: FPS };
    const forward = samplePhysicsTracks(fallingBox(), WORLD, ['box'], opts, 'k');
    // Same cache, deliberately warmed by a far seek first.
    samplePhysicsTracks(fallingBox(), WORLD, ['box'], { ...opts, from: 1.5 }, 'k');
    const again = samplePhysicsTracks(fallingBox(), WORLD, ['box'], opts, 'k');
    expect(track(again, 'y')!.keyframes).toEqual(track(forward, 'y')!.keyframes);
  });
});

// ── Particles ─────────────────────────────────────────────────────────

const particleCfg = (patch: Partial<ParticleConfig> = {}): ParticleConfig => ({
  ...DEFAULT_PARTICLE_CONFIG,
  emitterType: 'point',
  birthRate: 10,
  maxParticles: 60,
  lifetime: 1,
  lifetimeRandom: 0,
  speed: 100,
  speedRandom: 0,
  direction: 0,
  spread: 0,
  gravityX: 0,
  gravityY: 0,
  turbulence: 0,
  seed: 5,
  ...patch,
});

describe('sampleParticleLayers', () => {
  it('groups samples by particle identity, not by array position', () => {
    const cfg = particleCfg();
    const out = sampleParticleLayers(() => cfg, { from: 0, to: 2, fps: FPS });
    expect(out.particles.length).toBeGreaterThan(5);
    // Distinct identities, and each one's x marches forward under a constant
    // rightward launch — which is only true if the grouping actually followed
    // one particle rather than whatever sat at index 3 that frame.
    expect(new Set(out.particles.map((p) => p.index)).size).toBe(out.particles.length);
    for (const p of out.particles) {
      for (let i = 1; i < p.x.length; i++) {
        expect(p.x[i]!.value).toBeGreaterThanOrEqual(p.x[i - 1]!.value - 1e-9);
      }
    }
  });

  it('opacity is written in LAYER units and fades over the life ramp', () => {
    const cfg = particleCfg({ opacityStart: 1, opacityEnd: 0 });
    const out = sampleParticleLayers(() => cfg, { from: 0, to: 2, fps: FPS });
    const p = out.particles.find((q) => q.opacity.length > 10)!;
    expect(p.opacity[0]!.value).toBeGreaterThan(90);
    expect(p.opacity[p.opacity.length - 1]!.value).toBeLessThan(p.opacity[0]!.value);
    expect(p.opacity.every((k) => k.value >= 0 && k.value <= 100)).toBe(true);
  });

  it('scale is relative to the size the layer is built at', () => {
    const cfg = particleCfg({ sizeStart: 20, sizeEnd: 10 });
    const out = sampleParticleLayers(() => cfg, { from: 0, to: 2, fps: FPS });
    const p = out.particles.find((q) => q.scale.length > 10)!;
    expect(p.scale[0]!.value).toBeCloseTo(1, 6);
    expect(p.scale[p.scale.length - 1]!.value).toBeLessThan(1);
    expect(p.baseSize).toBeGreaterThan(0);
  });

  it('the cap trims to the earliest-born particles and says it did', () => {
    const cfg = particleCfg();
    const uncapped = sampleParticleLayers(() => cfg, { from: 0, to: 2, fps: FPS, maxParticles: 1000 });
    const capped = sampleParticleLayers(() => cfg, { from: 0, to: 2, fps: FPS, maxParticles: 4 });
    expect(capped.particles).toHaveLength(4);
    expect(capped.capped).toBe(true);
    expect(capped.seen).toBe(uncapped.seen);
    expect(capped.particles.map((p) => p.index))
      .toEqual(uncapped.particles.slice(0, 4).map((p) => p.index));
    expect(uncapped.capped).toBe(false);
  });

  it('the stateful emitter bakes too, and its ids stay distinct', () => {
    const cfg = particleCfg({ simMode: 'stateful', gravityY: 400, bounceFloor: 120 });
    const out = sampleParticleLayers(() => cfg, { from: 0, to: 2, fps: FPS }, 'stateful-test');
    expect(out.particles.length).toBeGreaterThan(3);
    expect(new Set(out.particles.map((p) => p.index)).size).toBe(out.particles.length);
    for (const p of out.particles) expect(p.y.length).toBe(p.x.length);
  });

  it('has a default cap small enough to be an editable document', () => {
    expect(DEFAULT_PARTICLE_BAKE_CAP).toBe(200);
  });
});
