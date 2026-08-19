/**
 * Per-layer SimulationCache registry for stateful particles.
 *
 * One cache per texture key (layer id). Reset when the resolved config
 * signature or fps changes — different parameters are a different history.
 */

import { SimulationCache } from '@core/simulation/simulationCore';
import type { ParticleConfig } from './particleSim';
import {
  createStatefulParticleSim,
  type ParticleSoA,
} from './statefulParticleSim';

interface Entry {
  signature: string;
  cache: SimulationCache<ParticleSoA>;
}

const caches = new Map<string, Entry>();

function configSignature(cfg: ParticleConfig, fps: number): string {
  // Everything that affects the step history must be in here.
  return JSON.stringify({
    fps,
    seed: cfg.seed,
    birthRate: cfg.birthRate,
    maxParticles: cfg.maxParticles,
    lifetime: cfg.lifetime,
    lifetimeRandom: cfg.lifetimeRandom,
    speed: cfg.speed,
    speedRandom: cfg.speedRandom,
    direction: cfg.direction,
    spread: cfg.spread,
    gravityX: cfg.gravityX,
    gravityY: cfg.gravityY,
    emitterType: cfg.emitterType,
    emitterWidth: cfg.emitterWidth,
    emitterHeight: cfg.emitterHeight,
    bounceFloor: cfg.bounceFloor ?? 160,
    bounceRestitution: cfg.bounceRestitution ?? 0.65,
    bounceDamping: cfg.bounceDamping ?? 0.998,
    // The field params shape every step, so they are part of the history —
    // omitting one here means a turbulence tweak silently replays the OLD sim.
    windX: cfg.windX ?? 0,
    windY: cfg.windY ?? 0,
    turbulence: cfg.turbulence ?? 0,
    turbulenceScale: cfg.turbulenceScale ?? 100,
    turbulenceSpeed: cfg.turbulenceSpeed ?? 1,
  });
}

export function statefulParticleCache(
  key: string,
  cfg: ParticleConfig,
  fps: number,
): SimulationCache<ParticleSoA> {
  const signature = configSignature(cfg, fps);
  let entry = caches.get(key);
  if (!entry || entry.signature !== signature) {
    const sim = createStatefulParticleSim(cfg, {
      fps,
      floorY: cfg.bounceFloor ?? 160,
      restitution: cfg.bounceRestitution ?? 0.65,
      damping: cfg.bounceDamping ?? 0.998,
    });
    entry = { signature, cache: new SimulationCache(sim, { snapshotInterval: 30 }) };
    caches.set(key, entry);
  }
  return entry.cache;
}

/** Drop caches for keys no longer active (layer deleted). */
export function retainStatefulParticleCaches(activeKeys: ReadonlySet<string>): void {
  for (const key of caches.keys()) {
    if (!activeKeys.has(key)) caches.delete(key);
  }
}

/** Test helper — wipe every cache. */
export function clearStatefulParticleCaches(): void {
  caches.clear();
}
