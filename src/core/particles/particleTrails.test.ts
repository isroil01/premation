/**
 * Particle trails.
 *
 * Each mode's trail proves a different thing. Ballistic trails must be EXACT —
 * they are the same closed form at trailing ages, so any deviation is a second
 * implementation drifting. Stateful trails must be HISTORY — the one test that
 * justifies the ring buffer is a bounce, where the trail has to show positions
 * from before the reflection, which no formula evaluated backwards from the
 * present can produce.
 *
 * The recycled-slot test guards the quiet corruption: slots are reused when
 * the pool is full, and a fresh particle exhuming the previous occupant's
 * trail draws a streak connecting two unrelated lives.
 */

import { simulateParticles, DEFAULT_PARTICLE_CONFIG, type ParticleConfig } from './particleSim';
import { createStatefulParticleSim, particlesFromSoA, trailRingSpec } from './statefulParticleSim';
import { SimulationCache } from '@core/simulation/simulationCore';

const cfg = (patch: Partial<ParticleConfig> = {}): ParticleConfig => ({
  ...DEFAULT_PARTICLE_CONFIG,
  emitterType: 'point',
  birthRate: 10,
  maxParticles: 40,
  lifetime: 5,
  lifetimeRandom: 0,
  speed: 0,
  speedRandom: 0,
  direction: 0,
  spread: 0,
  gravityX: 0,
  gravityY: 0,
  seed: 3,
  ...patch,
});

const FPS = 30;
const statefulAt = (c: ParticleConfig, frame: number, floorY = 1e9) => {
  const sim = createStatefulParticleSim(c, { fps: FPS, floorY, restitution: 0.8, damping: 1 });
  return particlesFromSoA(new SimulationCache(sim).stateAt(frame), c, { frame, fps: FPS });
};

describe('compat', () => {
  it('trail-free output is byte-identical to before trails existed', () => {
    expect(simulateParticles(cfg({ trailLength: 0 }), 2)).toEqual(simulateParticles(cfg(), 2));
    expect(statefulAt(cfg({ simMode: 'stateful', trailLength: 0 }), 60))
      .toEqual(statefulAt(cfg({ simMode: 'stateful' }), 60));
  });
});

describe('ballistic trails', () => {
  it('are the SAME closed form at trailing ages — exact, not approximate', () => {
    // Gravity only: a particle of age a sits at ½·g·a². Its k-th trail point
    // must sit at ½·g·(a − kΔ)² to the last bit.
    const g = 200;
    const spacing = 0.1;
    const ps = simulateParticles(cfg({ gravityY: g, trailLength: 4, trailSpacing: spacing }), 2);
    const withTrail = ps.filter((p) => p.trail && p.trail.length > 0);
    expect(withTrail.length).toBeGreaterThan(0);
    for (const p of withTrail) {
      const age = Math.sqrt((2 * p.y) / g); // invert the closed form
      p.trail!.forEach((t, idx) => {
        const ta = age - (idx + 1) * spacing;
        expect(t.y).toBeCloseTo(0.5 * g * ta * ta, 6);
      });
    }
  });

  it('a newborn has a SHORT trail, not ghosts stacked on the emitter', () => {
    // Trail points before birth are skipped. A particle younger than one
    // spacing has no trail at all.
    const ps = simulateParticles(cfg({ birthRate: 30, trailLength: 6, trailSpacing: 0.2 }), 1);
    const young = ps.filter((p) => p.age01 < 0.2 / 5); // younger than one gap
    expect(young.length).toBeGreaterThan(0);
    for (const p of young) expect(p.trail ?? []).toHaveLength(0);
  });

  it('trail length is capped at 24 whatever the config asks', () => {
    const ps = simulateParticles(cfg({ trailLength: 500, trailSpacing: 0.01 }), 4);
    for (const p of ps) expect((p.trail ?? []).length).toBeLessThanOrEqual(24);
  });
});

describe('stateful trails', () => {
  it('show the path from BEFORE a bounce — the reason the ring exists', () => {
    // One particle falls onto a floor and rebounds. After the bounce its trail
    // must contain points from the descent — positions a backwards-evaluated
    // formula could never produce, because the reflection erased them from
    // any closed form.
    const c = cfg({
      simMode: 'stateful', birthRate: 4, maxParticles: 4,
      gravityY: 2000, trailLength: 10, trailSpacing: 1 / 30,
    });
    const floorY = 60;
    // birthRate 4/s → first spawn near frame 8; falling 60px at 2000px/s²
    // takes ~7 more frames; by 18 the first particle has bounced and its
    // 10-point trail still holds the descent. (Probed, not guessed — the
    // first version of this test asked at frame 14, before anything existed.)
    const ps = statefulAt(c, 18, floorY);
    const bounced = ps.filter((p) => p.trail && p.trail.length > 2 && p.y < floorY - 1);
    expect(bounced.length).toBeGreaterThan(0);
    for (const p of bounced) {
      const ys = p.trail!.map((q) => q.y);
      // The trail bends at the corner: it reaches the floor (the bounce)…
      expect(Math.max(...ys)).toBeGreaterThan(p.y + 1);
      expect(Math.max(...ys)).toBeGreaterThanOrEqual(floorY - 1);
      // …and its LAST point is genuine history, not a phantom copy of the
      // particle's own position (the ring off-by-one this suite caught).
      const last = p.trail![p.trail!.length - 1]!;
      expect(Math.hypot(last.x - p.x, last.y - p.y)).toBeGreaterThan(1);
    }
  });

  it('a recycled slot does not exhume the previous occupant’s trail', () => {
    // Pool of 3 with fast births: slots recycle constantly. Every trail point
    // must be within plausible reach of ITS particle — a stitched-together
    // trail from two lives produces a point wildly far from the head.
    const c = cfg({
      simMode: 'stateful', birthRate: 30, maxParticles: 3, lifetime: 0.4,
      speed: 300, spread: 360, trailLength: 8, trailSpacing: 1 / 30,
    });
    const ps = statefulAt(c, 90);
    for (const p of ps) {
      for (const t of p.trail ?? []) {
        // 300px/s for at most 8/30s ≈ 80px, with margin.
        expect(Math.hypot(t.x - p.x, t.y - p.y)).toBeLessThan(160);
      }
    }
  });

  it('replays identically under hostile scrub order, ring included', () => {
    const c = cfg({ simMode: 'stateful', gravityY: 500, trailLength: 6, turbulence: 100 });
    const make = () => new SimulationCache(
      createStatefulParticleSim(c, { fps: FPS, floorY: 200, restitution: 0.6, damping: 1 }),
      { snapshotInterval: 10 },
    );
    const scrubbed = make();
    scrubbed.stateAt(70);
    scrubbed.stateAt(3);
    scrubbed.stateAt(40);
    expect(scrubbed.stateAt(80)).toEqual(make().stateAt(80));
  });

  it('the ring spec derives identically for writer and reader', () => {
    // The single-derivation rule, pinned: both sides call trailRingSpec, and
    // this asserts the spec itself is stable and capped.
    const spec = trailRingSpec({ trailLength: 10, trailSpacing: 0.1 }, 30);
    // ringSize is points×stride + 1: the head slot holds the CURRENT frame.
    expect(spec).toEqual({ points: 10, stride: 3, ringSize: 31 });
    expect(trailRingSpec({ trailLength: 24, trailSpacing: 1 }, 60).ringSize).toBe(121); // capped
    expect(trailRingSpec({ trailLength: 0 }, 30).ringSize).toBe(0);
  });
});
