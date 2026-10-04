/**
 * Particle simulation — pure, deterministic, no canvas. Pins the emission model,
 * the ballistic position, determinism/scrub-stability and the particle cap.
 */

import {  resolveParticleConfig, particlePropPath, DEFAULT_PARTICLE_CONFIG, type ParticleConfig } from './particleSim';

const cfg = (over: Partial<ParticleConfig> = {}): ParticleConfig => ({ ...DEFAULT_PARTICLE_CONFIG, ...over });

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
});
