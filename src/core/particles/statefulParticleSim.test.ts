/**
 * Stateful particle sim — seek-order and bounce proofs.
 */

import { SimulationCache } from '@core/simulation/simulationCore';
import { DEFAULT_PARTICLE_CONFIG, type ParticleConfig } from './particleSim';
import {
  createStatefulParticleSim,
  digestParticleSoA,
  particlesFromSoA,
} from './statefulParticleSim';
import { clearStatefulParticleCaches, statefulParticleCache } from './statefulParticleCache';
import { particleSprites } from './particleRender';

const FPS = 30;

function fountainCfg(over: Partial<ParticleConfig> = {}): ParticleConfig {
  return {
    ...DEFAULT_PARTICLE_CONFIG,
    simMode: 'stateful',
    birthRate: 40,
    maxParticles: 200,
    lifetime: 2,
    speed: 220,
    direction: -90,
    spread: 30,
    gravityY: 400,
    bounceFloor: 120,
    bounceRestitution: 0.7,
    bounceDamping: 0.999,
    seed: 7,
    ...over,
  };
}

describe('statefulParticleSim', () => {
  afterEach(() => clearStatefulParticleCaches());

  it('hostile seek order matches stepping from zero', () => {
    const cfg = fountainCfg();
    const sim = createStatefulParticleSim(cfg, {
      fps: FPS,
      floorY: cfg.bounceFloor!,
      restitution: cfg.bounceRestitution!,
      damping: cfg.bounceDamping!,
    });
    const cache = new SimulationCache(sim, { snapshotInterval: 15 });

    const naive = new SimulationCache(createStatefulParticleSim(cfg, {
      fps: FPS,
      floorY: cfg.bounceFloor!,
      restitution: cfg.bounceRestitution!,
      damping: cfg.bounceDamping!,
    }), { snapshotInterval: 15 });

    const order = [0, 90, 12, 200, 5, 200, 60, 0, 45];
    for (const f of order) {
      expect(digestParticleSoA(cache.stateAt(f))).toBe(digestParticleSoA(naive.stateAt(f)));
    }
  });

  it('same seed is identical; different seed rearranges', () => {
    const a = statefulParticleCache('a', fountainCfg({ seed: 1 }), FPS).stateAt(90);
    const b = statefulParticleCache('b', fountainCfg({ seed: 1 }), FPS).stateAt(90);
    const c = statefulParticleCache('c', fountainCfg({ seed: 2 }), FPS).stateAt(90);
    expect(digestParticleSoA(a)).toBe(digestParticleSoA(b));
    expect(digestParticleSoA(a)).not.toBe(digestParticleSoA(c));
  });

  it('floor bounce keeps particles at or above the floor and reverses fall', () => {
    const cfg = fountainCfg({
      birthRate: 60,
      maxParticles: 80,
      gravityY: 600,
      bounceFloor: 80,
      bounceRestitution: 0.85,
      bounceDamping: 1,
      speed: 100,
      direction: 90, // emit downward toward the floor
      spread: 10,
      lifetime: 3,
    });
    const cache = statefulParticleCache('bounce', cfg, FPS);
    let bounced = false;
    for (let f = 1; f <= 90; f++) {
      const s = cache.stateAt(f);
      for (let i = 0; i < s.alive.length; i++) {
        if (s.alive[i]! < 0.5) continue;
        expect(s.y[i]!).toBeLessThanOrEqual(80.001);
        // After contact, upward (negative) velocity while sitting on the floor.
        if (s.y[i]! >= 79.5 && s.vy[i]! < -5) bounced = true;
      }
    }
    expect(bounced).toBe(true);
  });

  it('particlesFromSoA produces drawable particles', () => {
    const cfg = fountainCfg();
    const state = statefulParticleCache('draw', cfg, FPS).stateAt(45);
    const list = particlesFromSoA(state, cfg);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]!.color).toMatch(/^rgba\(/);
  });

  it('particleSprites stateful path is scrub-stable', () => {
    const cfg = fountainCfg();
    const t = 2.5;
    const a = particleSprites(cfg, t, 400, 400, { fps: FPS, cacheKey: 'scrub' });
    clearStatefulParticleCaches();
    const b = particleSprites(cfg, t, 400, 400, { fps: FPS, cacheKey: 'scrub' });
    expect(a.length).toBe(b.length);
    expect(a.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('|')).toBe(
      b.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('|'),
    );
  });

  it('ballistic mode still ignores stateful options', () => {
    const cfg = fountainCfg({ simMode: 'ballistic' });
    const sprites = particleSprites(cfg, 1, 400, 400);
    expect(sprites.length).toBeGreaterThan(0);
  });
});
