/**
 * Particle sim-to-renderable conversion — pure functions only (no canvas).
 * Pins field-space placement, determinism, transfer-mode mapping, star
 * geometry and the raster signature contract the texture cache keys on.
 */

import { DEFAULT_PARTICLE_CONFIG, type ParticleConfig } from './particleSim';
import {
  particleSprites,
  particleCompositeOp,
  starPoints,
  particleFieldSignature,
} from './particleRender';

const cfg = (over: Partial<ParticleConfig> = {}): ParticleConfig => ({ ...DEFAULT_PARTICLE_CONFIG, ...over });

describe('particleSprites (field mapping)', () => {
  test('emitter sits at the field centre', () => {
    // Frozen particles (no speed, no gravity, point emitter) all sit exactly
    // at the emitter origin → field centre.
    const s = particleSprites(
      cfg({ speed: 0, speedRandom: 0, gravityX: 0, gravityY: 0, emitterType: 'point' }),
      1,
      1920,
      1080,
    );
    expect(s.length).toBeGreaterThan(0);
    for (const p of s) {
      expect(p.x).toBeCloseTo(960, 6);
      expect(p.y).toBeCloseTo(540, 6);
    }
  });

  test('ballistic offset lands in field space (centre + closed-form position)', () => {
    // direction 0 = +x, no spread/randoms, no gravity → x = cx + speed·age.
    const c = cfg({
      birthRate: 10, lifetime: 2, lifetimeRandom: 0,
      speed: 100, speedRandom: 0, direction: 0, spread: 0,
      gravityX: 0, gravityY: 0, emitterType: 'point',
    });
    const s = particleSprites(c, 1, 400, 400);
    // Oldest particle: index 0, born at t=0, age 1 → x = 200 + 100.
    const oldest = s[0]!;
    expect(oldest.x).toBeCloseTo(300, 4);
    expect(oldest.y).toBeCloseTo(200, 4);
  });

  test('deterministic: same inputs → identical sprite lists', () => {
    const a = particleSprites(cfg(), 2.5, 800, 600);
    const b = particleSprites(cfg(), 2.5, 800, 600);
    expect(a).toEqual(b);
  });

  test('size and opacity over life are carried through', () => {
    const c = cfg({
      birthRate: 1, lifetime: 1, lifetimeRandom: 0,
      sizeStart: 10, sizeEnd: 0, opacityStart: 1, opacityEnd: 0,
      speed: 0, speedRandom: 0, gravityY: 0,
    });
    // At t=0.5 the particle born at t=0 is half-way through its life.
    const s = particleSprites(c, 0.5, 100, 100);
    const oldest = s[0]!;
    expect(oldest.size).toBeCloseTo(5, 4);
    expect(oldest.opacity).toBeCloseTo(0.5, 4);
  });
});

describe('particleCompositeOp', () => {
  test("'add' maps to canvas additive, 'normal' to source-over", () => {
    expect(particleCompositeOp('add')).toBe('lighter');
    expect(particleCompositeOp('normal')).toBe('source-over');
  });
});

describe('starPoints', () => {
  test('alternates outer/inner radii around the origin', () => {
    const pts = starPoints(10, 4, 5);
    expect(pts).toHaveLength(10);
    for (let i = 0; i < pts.length; i++) {
      const r = Math.hypot(pts[i]!.x, pts[i]!.y);
      expect(r).toBeCloseTo(i % 2 === 0 ? 10 : 4, 6);
    }
    // First point straight up (canvas y grows downward).
    expect(pts[0]!.x).toBeCloseTo(0, 6);
    expect(pts[0]!.y).toBeCloseTo(-10, 6);
  });
});

describe('particleFieldSignature', () => {
  test('stable for identical inputs, sensitive to every pixel-affecting input', () => {
    const base = particleFieldSignature(cfg(), 1, 1920, 1080, 1);
    expect(particleFieldSignature(cfg(), 1, 1920, 1080, 1)).toBe(base);
    expect(particleFieldSignature(cfg(), 1.01, 1920, 1080, 1)).not.toBe(base);
    expect(particleFieldSignature(cfg({ birthRate: 81 }), 1, 1920, 1080, 1)).not.toBe(base);
    expect(particleFieldSignature(cfg(), 1, 1280, 1080, 1)).not.toBe(base);
    expect(particleFieldSignature(cfg(), 1, 1920, 1080, 2)).not.toBe(base);
  });
});
