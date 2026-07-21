/**
 * Particle simulation — pure, deterministic, no canvas. Pins the emission model,
 * the ballistic position, determinism/scrub-stability and the particle cap.
 */

import { simulateParticles, resolveParticleConfig, particlePropPath, DEFAULT_PARTICLE_CONFIG, type ParticleConfig } from './particleSim';

const cfg = (over: Partial<ParticleConfig> = {}): ParticleConfig => ({ ...DEFAULT_PARTICLE_CONFIG, ...over });

describe('emission', () => {
  test('no particles before any time or with zero birth rate', () => {
    expect(simulateParticles(cfg(), 0)).toEqual([]);
    expect(simulateParticles(cfg({ birthRate: 0 }), 5)).toEqual([]);
  });

  test('emits roughly birthRate·min(time,life) particles', () => {
    const p = simulateParticles(cfg({ birthRate: 80, lifetime: 2, lifetimeRandom: 0 }), 1);
    // born in [0,1] at rate 80 → ~81 indices, all still alive (age<2)
    expect(p.length).toBeGreaterThan(60);
    expect(p.length).toBeLessThanOrEqual(81);
  });

  test('particles past their lifetime are gone', () => {
    // at t=10 with life 2 (no random), only indices born in [8,10] survive
    const p = simulateParticles(cfg({ birthRate: 50, lifetime: 2, lifetimeRandom: 0 }), 10);
    for (const q of p) expect(q.age01).toBeLessThan(1);
    // ~100 alive (2s × 50/s), not 500
    expect(p.length).toBeLessThan(120);
  });
});

describe('determinism (scrub stability)', () => {
  test('same config + time → identical particles', () => {
    const a = simulateParticles(cfg(), 3.14159);
    const b = simulateParticles(cfg(), 3.14159);
    expect(a).toEqual(b);
  });

  test('different seed → different arrangement', () => {
    const a = simulateParticles(cfg({ seed: 1 }), 1);
    const b = simulateParticles(cfg({ seed: 2 }), 1);
    expect(a).not.toEqual(b);
  });
});

describe('physics', () => {
  test('gravity pulls particles down over their life', () => {
    // direction 0 (rightward, no vertical velocity) + downward gravity → y grows
    const p = simulateParticles(
      cfg({ direction: 0, spread: 0, gravityY: 500, gravityX: 0, speedRandom: 0, emitterType: 'point' }),
      1,
    );
    // the OLDEST particle (index 0, born at t=0, age=1) has fallen furthest
    const oldest = p[0]!;
    expect(oldest.y).toBeGreaterThan(0);
    // y = ½·g·t² = 0.5·500·1 = 250
    expect(oldest.y).toBeCloseTo(250, 0);
  });

  test('size and opacity interpolate from start to end over life', () => {
    const p = simulateParticles(
      cfg({ sizeStart: 10, sizeEnd: 2, opacityStart: 1, opacityEnd: 0, lifetimeRandom: 0 }),
      1,
    );
    for (const q of p) {
      expect(q.size).toBeLessThanOrEqual(10);
      expect(q.size).toBeGreaterThanOrEqual(2);
      expect(q.opacity).toBeGreaterThanOrEqual(0);
      expect(q.opacity).toBeLessThanOrEqual(1);
    }
  });
});

describe('performance cap', () => {
  test('never exceeds maxParticles', () => {
    const p = simulateParticles(cfg({ birthRate: 100000, maxParticles: 200, lifetime: 5 }), 3);
    expect(p.length).toBeLessThanOrEqual(201); // inclusive range → +1
  });
});

describe('resolveParticleConfig (per-param keyframing)', () => {
  test('numeric overrides apply; untouched fields keep static values', () => {
    const base = cfg({ birthRate: 10, gravityY: 100 });
    const out = resolveParticleConfig(base, (p) =>
      p === particlePropPath('gravityY') ? 500 : undefined,
    );
    expect(out.gravityY).toBe(500);
    expect(out.birthRate).toBe(10);
  });

  test('returns the same object when nothing is keyframed', () => {
    const base = cfg({});
    expect(resolveParticleConfig(base, () => undefined)).toBe(base);
  });

  test('colors recompose from channel tracks, keeping stored channels for the rest', () => {
    const base = cfg({ colorStart: '#000000' });
    const out = resolveParticleConfig(base, (p) =>
      p === particlePropPath('colorStart_r') ? 255 : undefined,
    );
    expect(out.colorStart).toBe('#ff0000');
    expect(out.colorEnd).toBe(base.colorEnd);
  });

  test('an animated config changes the simulation output', () => {
    const base = cfg({ gravityY: 0, gravityX: 0, speed: 0, spread: 0 });
    const still = simulateParticles(resolveParticleConfig(base, () => undefined), 1);
    const pulled = simulateParticles(
      resolveParticleConfig(base, (p) => (p === particlePropPath('gravityY') ? 1000 : undefined)),
      1,
    );
    expect(still.length).toBeGreaterThan(0);
    expect(pulled.length).toBeGreaterThan(0);
    // Gravity pulls every particle downward relative to the still config.
    expect(Math.max(...pulled.map((q) => q.y))).toBeGreaterThan(Math.max(...still.map((q) => q.y)));
  });
});
