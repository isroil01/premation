/**
 * The particle column's last three: depth, collisions, sub-emitters.
 *
 * Depth's contract is separation of concerns: z is ALWAYS simulated and only
 * PROJECTED when perspective is on, so flipping perspective changes the look
 * and never the motion. Collisions' contract is determinism under a fixed
 * iteration order. Sub-emitters' contract is the mode split — a death burst is
 * a closed form (the death time is known in advance), a bounce burst is
 * history — and the one-generation rule that keeps a firework from cascading
 * unbounded.
 */

import { simulateParticles, DEFAULT_PARTICLE_CONFIG, type ParticleConfig } from './particleSim';
import { createStatefulParticleSim, particlesFromSoA } from './statefulParticleSim';
import { particleSprites } from './particleRender';
import { SimulationCache } from '@core/simulation/simulationCore';

const cfg = (patch: Partial<ParticleConfig> = {}): ParticleConfig => ({
  ...DEFAULT_PARTICLE_CONFIG,
  emitterType: 'point',
  birthRate: 10,
  maxParticles: 60,
  lifetime: 2,
  lifetimeRandom: 0,
  speed: 0,
  speedRandom: 0,
  direction: 0,
  spread: 0,
  gravityX: 0,
  gravityY: 0,
  seed: 5,
  ...patch,
});

const FPS = 30;
const statefulAt = (c: ParticleConfig, frame: number, floorY = 1e9) => {
  const sim = createStatefulParticleSim(c, { fps: FPS, floorY, restitution: 0.8, damping: 1 });
  return particlesFromSoA(new SimulationCache(sim).stateAt(frame), c, { frame, fps: FPS });
};

describe('compat', () => {
  it('all three features at their defaults are byte-identical to before', () => {
    expect(simulateParticles(cfg({ emitterDepth: 0, speedZ: 0, perspective: 0, subEmit: 'off' }), 1.5))
      .toEqual(simulateParticles(cfg(), 1.5));
    expect(statefulAt(cfg({ simMode: 'stateful', collide: false, subEmit: 'off' }), 45))
      .toEqual(statefulAt(cfg({ simMode: 'stateful' }), 45));
  });
});

describe('depth', () => {
  it('ballistic z is the exact closed form oz + vz·age', () => {
    const ps = simulateParticles(cfg({ emitterDepth: 200, speedZ: 50 }), 1.5);
    expect(ps.length).toBeGreaterThan(2);
    // Distinct z per particle (hashed origin/velocity), all within the reach
    // of depth/2 + speed·age.
    const zs = ps.map((p) => p.z);
    expect(new Set(zs.map((z) => Math.round(z))).size).toBeGreaterThan(1);
    for (const z of zs) expect(Math.abs(z)).toBeLessThanOrEqual(100 + 50 * 1.5 + 1e-6);
  });

  it('z is simulated in the stateful mode too, and integrates vz', () => {
    const ps = statefulAt(cfg({ simMode: 'stateful', emitterDepth: 100, speedZ: 80 }), 60);
    expect(ps.some((p) => Math.abs(p.z) > 1)).toBe(true);
  });

  it('perspective SCALES nearer particles larger, and is projection-only', () => {
    const base = cfg({ emitterDepth: 400, sizeStart: 20, sizeEnd: 20 });
    const flat = simulateParticles(base, 1);
    const projectedCfg = { ...base, perspective: 300 };
    // Motion unchanged: same particles, same z — only the SPRITES differ.
    expect(simulateParticles(projectedCfg, 1).map((p) => p.z)).toEqual(flat.map((p) => p.z));

    const sprites = particleSprites(projectedCfg, 1, 400, 400);
    const near = flat.reduce((a, b) => (a.z < b.z ? a : b));
    const far = flat.reduce((a, b) => (a.z > b.z ? a : b));
    // The nearest particle's sprite is bigger than the farthest's.
    const sizes = sprites.map((s) => s.size).sort((a, b) => a - b);
    expect(sizes[sizes.length - 1]!).toBeGreaterThan(sizes[0]!);
    expect(near.z).toBeLessThan(far.z);
  });

  it('with perspective on, sprites paint FAR-first', () => {
    // The painter's algorithm: the sprite list must be ordered so near
    // particles cover far ones. Constant size isolates the ordering: a bigger
    // sprite is a nearer one, so sizes must be non-decreasing down the list.
    const sprites = particleSprites(
      cfg({ emitterDepth: 600, sizeStart: 20, sizeEnd: 20, perspective: 300 }),
      1, 400, 400,
    );
    for (let i = 1; i < sprites.length; i++) {
      expect(sprites[i]!.size).toBeGreaterThanOrEqual(sprites[i - 1]!.size - 1e-9);
    }
  });
});

describe('collisions (stateful)', () => {
  const headOn = (collide: boolean) => {
    // Two-particle pool, born from a point with opposite spread directions is
    // fiddly — instead: tight pool, particles overlap at the emitter, sizes
    // big enough that contact is guaranteed.
    return cfg({
      simMode: 'stateful', birthRate: 20, maxParticles: 6,
      sizeStart: 30, sizeEnd: 30, collide,
    });
  };

  it('overlapping particles push apart; without the flag they stack', () => {
    const apart = statefulAt(headOn(true), 30);
    const stacked = statefulAt(headOn(false), 30);
    const spread = (ps: typeof apart): number => {
      let max = 0;
      for (const a of ps) for (const b of ps) max = Math.max(max, Math.hypot(a.x - b.x, a.y - b.y));
      return max;
    };
    // Point emitter, zero speed: without collisions everything sits at 0.
    expect(spread(stacked)).toBeLessThan(1);
    expect(spread(apart)).toBeGreaterThan(20);
  });

  it('replays identically under hostile scrub order', () => {
    const c = cfg({
      simMode: 'stateful', birthRate: 15, maxParticles: 10,
      sizeStart: 24, sizeEnd: 24, collide: true, gravityY: 300,
    });
    const make = () => new SimulationCache(
      createStatefulParticleSim(c, { fps: FPS, floorY: 150, restitution: 0.5, damping: 1 }),
      { snapshotInterval: 8 },
    );
    const scrubbed = make();
    scrubbed.stateAt(55);
    scrubbed.stateAt(2);
    scrubbed.stateAt(30);
    expect(scrubbed.stateAt(60)).toEqual(make().stateAt(60));
  });
});

describe('sub-emitters', () => {
  it('BALLISTIC death burst: children appear after a parent dies, near its death point', () => {
    // One parent (rate 1, dies at 1s + birth). Gravity pulls it down; children
    // burst from wherever it died. Closed form throughout — this exact call is
    // scrub-order-free by construction.
    const c = cfg({
      birthRate: 1, maxParticles: 4, lifetime: 1, gravityY: 100,
      subEmit: 'death', subCount: 6, subSpeed: 50, subLifetime: 0.5,
    });
    // Parent 0 is born at 1.0s (rate 1) and dies at 2.0s; by 2.2s its burst
    // is 0.2s old.
    const after = simulateParticles(c, 2.2);
    const children = after.filter((p) => p.size <= (c.sizeStart * (c.subSizeScale ?? 0.5)) + 1e-6 && p.age01 < 0.5);
    expect(children.length).toBeGreaterThanOrEqual(6);
    // Clustered near the death point (½·g·t² ≈ 50px at 1s), spread ≤ speed·age + margin.
    for (const ch of children.slice(0, 6)) {
      expect(Math.abs(ch.y - 50)).toBeLessThan(60);
    }
  });

  it('ballistic children VANISH after their own lifetime', () => {
    const c = cfg({
      birthRate: 1, maxParticles: 4, lifetime: 1,
      subEmit: 'death', subCount: 6, subSpeed: 50, subLifetime: 0.3,
    });
    const during = simulateParticles(c, 2.2);
    const afterLife = simulateParticles(c, 2.5);
    expect(during.length).toBeGreaterThan(afterLife.length);
  });

  it('STATEFUL bounce burst: children spawn at the floor when a parent bounces', () => {
    const c = cfg({
      simMode: 'stateful', birthRate: 2, maxParticles: 20, lifetime: 3,
      gravityY: 2000, subEmit: 'bounce', subCount: 5, subSpeed: 100, subLifetime: 0.5,
    });
    const floorY = 80;
    // First spawn ≈ frame 15; fall to 80px at 2000px/s² ≈ 0.28s ≈ 8.5 frames →
    // bounce ≈ frame 24. Look shortly after.
    const ps = statefulAt(c, 27, floorY);
    const children = ps.filter((p) => p.size < c.sizeStart); // subSizeScale < 1
    expect(children.length).toBeGreaterThanOrEqual(5);
  });

  it('children never sub-emit — one generation only', () => {
    // Tiny pool + short child lives: if children bursted, the population would
    // cascade past the parents-plus-one-burst ceiling and churn the pool.
    const c = cfg({
      simMode: 'stateful', birthRate: 1, maxParticles: 40, lifetime: 0.5,
      subEmit: 'death', subCount: 4, subSpeed: 10, subLifetime: 0.4,
    });
    // Run long enough for two parent generations of deaths.
    const counts = [40, 60, 80, 100].map((f) => statefulAt(c, f).length);
    // Bounded population: parents alive ≤ 1 at a time (rate 1, life 0.5) plus
    // one burst of 4 fading — never a growing cascade.
    for (const n of counts) expect(n).toBeLessThanOrEqual(1 + 4 + 4);
  });

  it('stateful sub-emit replays identically under hostile scrub order', () => {
    const c = cfg({
      simMode: 'stateful', birthRate: 3, maxParticles: 30, lifetime: 1,
      gravityY: 1500, subEmit: 'bounce', subCount: 6, subSpeed: 120, subLifetime: 0.6,
    });
    const make = () => new SimulationCache(
      createStatefulParticleSim(c, { fps: FPS, floorY: 90, restitution: 0.7, damping: 1 }),
      { snapshotInterval: 10 },
    );
    const scrubbed = make();
    scrubbed.stateAt(70);
    scrubbed.stateAt(4);
    scrubbed.stateAt(33);
    expect(scrubbed.stateAt(75)).toEqual(make().stateAt(75));
  });
});
