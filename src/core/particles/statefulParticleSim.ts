/**
 * Stateful particle emitter — history-dependent, seeded-replay.
 *
 * The closed-form emitter in `particleSim.ts` cannot bounce: position at t is a
 * formula with no memory. This module implements `Simulation<ParticleSoA>` so
 * `SimulationCache.stateAt(f)` can scrub and export bit-identically.
 *
 * First slice: continuous emission + ballistic integrate + optional floor
 * bounce. Turbulence, trails, collisions between particles, 3D, and
 * layer-as-particle stay out of scope.
 */

import { parseHex } from '@core/effects/canvas2dEffects';
import type { Simulation } from '@core/simulation/simulationCore';
import type { Particle, ParticleConfig, ParticleShape } from './particleSim';

export interface StatefulParticleOptions {
  /** Comp frame rate — steps are one frame each. */
  fps: number;
  /** Floor Y in emitter-local px (positive = down). Bounce when y ≥ this. */
  floorY: number;
  /** Velocity retained on bounce, 0..1. */
  restitution: number;
  /** Per-frame velocity multiplier (air drag), 0..1. 1 = none. */
  damping: number;
}

export interface ParticleSoA {
  /** Birth index used for hash RNG — stable for the slot's life. */
  id: Float64Array;
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  /** Age in seconds. */
  age: Float64Array;
  /** Lifetime in seconds. */
  life: Float64Array;
  /** 1 = alive, 0 = free slot. */
  alive: Float64Array;
  /** Fractional births waiting to spawn (single accumulator, length 1). */
  emitAcc: Float64Array;
  /** Next birth index for hash salts. */
  nextId: Float64Array;
}

function hash01(i: number, salt: number, seed: number): number {
  let h = (i * 374761393 + salt * 668265263 + seed * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function lerpColor(a: string, b: string, t: number, alpha: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const r = Math.round(lerp(ca[0], cb[0], t));
  const g = Math.round(lerp(ca[1], cb[1], t));
  const bl = Math.round(lerp(ca[2], cb[2], t));
  const al = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  return `rgba(${r},${g},${bl},${al})`;
}

function alloc(n: number): ParticleSoA {
  return {
    id: new Float64Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    vx: new Float64Array(n),
    vy: new Float64Array(n),
    age: new Float64Array(n),
    life: new Float64Array(n),
    alive: new Float64Array(n),
    emitAcc: new Float64Array(1),
    nextId: new Float64Array(1),
  };
}

function cloneState(s: ParticleSoA): ParticleSoA {
  return {
    id: s.id.slice(),
    x: s.x.slice(),
    y: s.y.slice(),
    vx: s.vx.slice(),
    vy: s.vy.slice(),
    age: s.age.slice(),
    life: s.life.slice(),
    alive: s.alive.slice(),
    emitAcc: s.emitAcc.slice(),
    nextId: s.nextId.slice(),
  };
}

function spawnInto(
  s: ParticleSoA,
  slot: number,
  birthId: number,
  cfg: ParticleConfig,
): void {
  const seed = cfg.seed | 0;
  const i = birthId | 0;
  const life = Math.max(
    0.05,
    cfg.lifetime * (1 + cfg.lifetimeRandom * (hash01(i, 1, seed) * 2 - 1)),
  );
  const speed = cfg.speed * (1 + cfg.speedRandom * (hash01(i, 2, seed) * 2 - 1));
  const dirBase = (cfg.direction * Math.PI) / 180;
  const spreadRad = (cfg.spread * Math.PI) / 180;
  const dir = dirBase + spreadRad * (hash01(i, 3, seed) - 0.5);

  let ox = 0;
  let oy = 0;
  if (cfg.emitterType === 'box') {
    ox = (hash01(i, 4, seed) - 0.5) * cfg.emitterWidth;
    oy = (hash01(i, 5, seed) - 0.5) * cfg.emitterHeight;
  } else if (cfg.emitterType === 'circle') {
    const ang = hash01(i, 4, seed) * Math.PI * 2;
    const rad = Math.sqrt(hash01(i, 5, seed)) * (cfg.emitterWidth / 2);
    ox = Math.cos(ang) * rad;
    oy = Math.sin(ang) * rad;
  }

  s.id[slot] = i;
  s.x[slot] = ox;
  s.y[slot] = oy;
  s.vx[slot] = Math.cos(dir) * speed;
  s.vy[slot] = Math.sin(dir) * speed;
  s.age[slot] = 0;
  s.life[slot] = life;
  s.alive[slot] = 1;
}

function findFreeSlot(s: ParticleSoA): number {
  for (let i = 0; i < s.alive.length; i++) {
    if (s.alive[i]! < 0.5) return i;
  }
  // Cap full — recycle oldest (largest age).
  let oldest = 0;
  let maxAge = -1;
  for (let i = 0; i < s.alive.length; i++) {
    if (s.alive[i]! >= 0.5 && s.age[i]! > maxAge) {
      maxAge = s.age[i]!;
      oldest = i;
    }
  }
  return oldest;
}

/**
 * Build a frame-stepping simulation from a resolved particle config.
 * Gravity/speeds are in px/s and converted to per-frame with `fps`.
 */
export function createStatefulParticleSim(
  cfg: ParticleConfig,
  opts: StatefulParticleOptions,
): Simulation<ParticleSoA> {
  const n = Math.max(1, Math.floor(cfg.maxParticles));
  const fps = Math.max(1, opts.fps);
  const dt = 1 / fps;
  const floorY = opts.floorY;
  const restitution = Math.max(0, Math.min(1, opts.restitution));
  const damping = Math.max(0, Math.min(1, opts.damping));
  const birthPerFrame = Math.max(0, cfg.birthRate) / fps;

  return {
    init(): ParticleSoA {
      const s = alloc(n);
      s.emitAcc[0] = 0;
      s.nextId[0] = 0;
      return s;
    },

    step(prev: ParticleSoA): ParticleSoA {
      const s = prev;
      // Integrate living particles.
      for (let i = 0; i < n; i++) {
        if (s.alive[i]! < 0.5) continue;
        const vx = s.vx[i]! * damping + cfg.gravityX * dt;
        let vy = s.vy[i]! * damping + cfg.gravityY * dt;
        const x = s.x[i]! + vx * dt;
        let y = s.y[i]! + vy * dt;
        const age = s.age[i]! + dt;
        if (age >= s.life[i]!) {
          s.alive[i] = 0;
          continue;
        }
        // Floor bounce — the history-dependent interrupt closed-form cannot do.
        if (y >= floorY) {
          y = floorY;
          if (vy > 0) vy = -vy * restitution;
          // Kill near-rest contact chatter (resting on the floor).
          if (Math.abs(vy) < 0.5) vy = 0;
        }
        s.x[i] = x;
        s.y[i] = y;
        s.vx[i] = vx;
        s.vy[i] = vy;
        s.age[i] = age;
      }

      // Emit.
      let acc = s.emitAcc[0]! + birthPerFrame;
      while (acc >= 1) {
        const slot = findFreeSlot(s);
        const id = s.nextId[0]!;
        spawnInto(s, slot, id, cfg);
        s.nextId[0] = id + 1;
        acc -= 1;
      }
      s.emitAcc[0] = acc;
      return s;
    },

    clone: cloneState,
  };
}

/** Convert SoA state to the Particle list the Canvas field renderer expects. */
export function particlesFromSoA(
  s: ParticleSoA,
  cfg: ParticleConfig,
): Particle[] {
  const out: Particle[] = [];
  const shape: ParticleShape = cfg.shape;
  for (let i = 0; i < s.alive.length; i++) {
    if (s.alive[i]! < 0.5) continue;
    const life = s.life[i]!;
    const age = s.age[i]!;
    const age01 = life > 0 ? Math.min(1, age / life) : 1;
    const size = Math.max(0, lerp(cfg.sizeStart, cfg.sizeEnd, age01));
    const opacity = lerp(cfg.opacityStart, cfg.opacityEnd, age01);
    out.push({
      x: s.x[i]!,
      y: s.y[i]!,
      size,
      color: lerpColor(cfg.colorStart, cfg.colorEnd, age01, opacity),
      opacity,
      rotation: cfg.spin * age,
      age01,
      shape,
    });
  }
  return out;
}

/** Stable digest for seek-order tests. */
export function digestParticleSoA(s: ParticleSoA): string {
  let h = 0;
  for (let i = 0; i < s.alive.length; i++) {
    if (s.alive[i]! < 0.5) continue;
    h = Math.imul(h ^ (s.id[i]! | 0), 16777619);
    h = Math.imul(h ^ Math.round(s.x[i]! * 1000), 16777619);
    h = Math.imul(h ^ Math.round(s.y[i]! * 1000), 16777619);
    h = Math.imul(h ^ Math.round(s.vx[i]! * 1000), 16777619);
    h = Math.imul(h ^ Math.round(s.vy[i]! * 1000), 16777619);
  }
  h = Math.imul(h ^ Math.round(s.emitAcc[0]! * 1000), 16777619);
  h = Math.imul(h ^ (s.nextId[0]! | 0), 16777619);
  return (h >>> 0).toString(16);
}
