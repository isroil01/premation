/**
 * Wind and turbulence.
 *
 * The compat tests are load-bearing: every field defaults to zero, and at zero
 * BOTH sims must be byte-identical to what they produced before the fields
 * existed — a particle sim is its history, and an update that re-renders every
 * old project's particles differently is a corruption wearing a feature's name.
 *
 * The curl test is the one that justifies the implementation: divergence-free
 * is WHY curl noise swirls instead of clumping, and it is a property no
 * screenshot can check.
 */

import { simulateParticles, DEFAULT_PARTICLE_CONFIG, type ParticleConfig } from './particleSim';
import { createStatefulParticleSim, particlesFromSoA } from './statefulParticleSim';
import { wanderOffset, curlForce } from './particleField';
import { SimulationCache } from '@core/simulation/simulationCore';

const cfg = (patch: Partial<ParticleConfig> = {}): ParticleConfig => ({
  ...DEFAULT_PARTICLE_CONFIG,
  emitterType: 'point',
  birthRate: 20,
  maxParticles: 50,
  lifetime: 3,
  lifetimeRandom: 0,
  speed: 0,
  speedRandom: 0,
  direction: 0,
  spread: 0,
  gravityX: 0,
  gravityY: 0,
  seed: 7,
  ...patch,
});

const statefulAt = (c: ParticleConfig, frame: number) => {
  const sim = createStatefulParticleSim(c, {
    fps: 30, floorY: 1e9, restitution: 0, damping: 1,
  });
  const cache = new SimulationCache(sim);
  return particlesFromSoA(cache.stateAt(frame), c);
};

describe('compat — zero fields are byte-identical to the pre-field sims', () => {
  it('ballistic', () => {
    const before = simulateParticles(cfg(), 2);
    const withZeroFields = simulateParticles(cfg({ windX: 0, windY: 0, turbulence: 0 }), 2);
    expect(withZeroFields).toEqual(before);
  });

  it('stateful', () => {
    const base = cfg({ simMode: 'stateful' });
    expect(statefulAt(cfg({ simMode: 'stateful', windX: 0, turbulence: 0 }), 60))
      .toEqual(statefulAt(base, 60));
  });
});

describe('wind', () => {
  it('ballistic: displacement is the exact closed form ½·w·t²', () => {
    // Wind IS acceleration, so it must integrate exactly like gravity — that
    // is what keeps scrubbing free.
    const still = simulateParticles(cfg(), 2);
    const windy = simulateParticles(cfg({ windX: 100 }), 2);
    expect(windy.length).toBe(still.length);
    // Per-particle ages differ, so assert against GRAVITY at the same
    // magnitude: both must integrate through the identical ½·a·age² form, so
    // their displacements must match to the last bit.
    const gravityRef = simulateParticles(cfg({ gravityX: 100 }), 2);
    for (let i = 0; i < still.length; i++) {
      const dx = windy[i]!.x - still[i]!.x;
      expect(dx).toBeCloseTo(gravityRef[i]!.x - still[i]!.x, 9);
    }
  });

  it('stateful: particles accelerate along the wind', () => {
    const still = statefulAt(cfg({ simMode: 'stateful' }), 60);
    const windy = statefulAt(cfg({ simMode: 'stateful', windX: 200 }), 60);
    const meanX = (ps: typeof still): number => ps.reduce((s, p) => s + p.x, 0) / Math.max(1, ps.length);
    expect(meanX(windy)).toBeGreaterThan(meanX(still) + 10);
  });
});

describe('ballistic wander', () => {
  it('is exactly zero at birth — particles are born ON the emitter', () => {
    for (let i = 0; i < 20; i++) {
      const w = wanderOffset(i, 0, { turbulence: 50, turbulenceSpeed: 1, seed: 3 });
      expect(w.x).toBeCloseTo(0, 9);
      expect(w.y).toBeCloseTo(0, 9);
    }
  });

  it('is deterministic and seed-dependent', () => {
    const a = wanderOffset(5, 1.3, { turbulence: 50, turbulenceSpeed: 1, seed: 3 });
    expect(wanderOffset(5, 1.3, { turbulence: 50, turbulenceSpeed: 1, seed: 3 })).toEqual(a);
    expect(wanderOffset(5, 1.3, { turbulence: 50, turbulenceSpeed: 1, seed: 4 })).not.toEqual(a);
  });

  it('stays within ~amplitude', () => {
    // Two octaves normalised by 1.5 with each term in [-2, 2]… the bound the
    // control promises is the AMPLITUDE, so hold it with margin.
    for (let i = 0; i < 10; i++) {
      for (let t = 0; t < 5; t += 0.05) {
        const w = wanderOffset(i, t, { turbulence: 50, turbulenceSpeed: 1, seed: 9 });
        expect(Math.abs(w.x)).toBeLessThanOrEqual(100);
        expect(Math.abs(w.y)).toBeLessThanOrEqual(100);
      }
    }
  });

  it('actually moves particles in the ballistic sim, differently per particle', () => {
    const calm = simulateParticles(cfg(), 2);
    const turb = simulateParticles(cfg({ turbulence: 40 }), 2);
    const offsets = turb.map((p, i) => Math.hypot(p.x - calm[i]!.x, p.y - calm[i]!.y));
    expect(offsets.some((d) => d > 1)).toBe(true);
    // Not a uniform shove: two particles should wander DIFFERENT amounts.
    expect(new Set(offsets.map((d) => Math.round(d * 10))).size).toBeGreaterThan(1);
  });
});

describe('stateful curl field', () => {
  it('is deterministic in (position, time, seed)', () => {
    const f = curlForce(37, -12, 1.5, { turbulence: 100, turbulenceScale: 80, turbulenceSpeed: 1, seed: 5 });
    expect(curlForce(37, -12, 1.5, { turbulence: 100, turbulenceScale: 80, turbulenceSpeed: 1, seed: 5 })).toEqual(f);
    expect(curlForce(37, -12, 1.5, { turbulence: 100, turbulenceScale: 80, turbulenceSpeed: 1, seed: 6 })).not.toEqual(f);
  });

  it('is DIVERGENCE-FREE — the property that makes it swirl, not clump', () => {
    // ∇·F ≈ 0 sampled by finite differences at scattered points. A plain
    // "noise added to velocity" field fails this, and the visible symptom is
    // particles collecting in the noise's bright spots like static.
    const c = { turbulence: 100, turbulenceScale: 60, turbulenceSpeed: 1, seed: 11 };
    const h = 0.5;
    for (const [px, py] of [[0, 0], [40, 25], [-33, 71], [120, -90], [7, 300]] as const) {
      const fxp = curlForce(px + h, py, 0.7, c).x;
      const fxm = curlForce(px - h, py, 0.7, c).x;
      const fyp = curlForce(px, py + h, 0.7, c).y;
      const fym = curlForce(px, py - h, 0.7, c).y;
      const div = (fxp - fxm) / (2 * h) + (fyp - fym) / (2 * h);
      // Tolerance scaled to the force magnitude at play (~100).
      expect(Math.abs(div)).toBeLessThan(1.5);
    }
  });

  it('EVOLVES over time rather than being a frozen texture', () => {
    const c = { turbulence: 100, turbulenceScale: 60, turbulenceSpeed: 1, seed: 11 };
    const early = curlForce(10, 10, 0.2, c);
    const late = curlForce(10, 10, 3.7, c);
    expect(Math.hypot(late.x - early.x, late.y - early.y)).toBeGreaterThan(1);
  });

  it('scrubbing a turbulent stateful sim matches playing through', () => {
    // The replay contract with the field on: curl is a pure function of
    // (position, time, seed), so a hostile access order must not diverge.
    const c = cfg({ simMode: 'stateful', turbulence: 150, turbulenceScale: 50 });
    const sim = createStatefulParticleSim(c, { fps: 30, floorY: 1e9, restitution: 0, damping: 1 });
    const cache = new SimulationCache(sim, { snapshotInterval: 10 });
    cache.stateAt(80);
    cache.stateAt(5);
    cache.stateAt(40);
    const scrubbed = cache.stateAt(90);

    const ref = new SimulationCache(createStatefulParticleSim(c, { fps: 30, floorY: 1e9, restitution: 0, damping: 1 }));
    expect(scrubbed).toEqual(ref.stateAt(90));
  });

  it('bends trajectories in the stateful sim', () => {
    const calm = statefulAt(cfg({ simMode: 'stateful', speed: 100 }), 60);
    const turb = statefulAt(cfg({ simMode: 'stateful', speed: 100, turbulence: 400, turbulenceScale: 40 }), 60);
    const spread = (ps: typeof calm): number => {
      const ys = ps.map((p) => p.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    // Straight-line emission at spread 0 has near-zero vertical scatter; the
    // curl field disperses it.
    expect(spread(turb)).toBeGreaterThan(spread(calm) + 5);
  });
});
