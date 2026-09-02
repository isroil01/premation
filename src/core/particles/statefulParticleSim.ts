/**
 * Stateful particle emitter — history-dependent, seeded-replay.
 *
 * The closed-form emitter in `particleSim.ts` cannot bounce: position at t is a
 * formula with no memory. This module implements `Simulation<ParticleSoA>` so
 * `SimulationCache.stateAt(f)` can scrub and export bit-identically.
 *
 * First slice: continuous emission + ballistic integrate + optional floor
 * bounce. Wind and curl-noise turbulence joined 2026-08-18 (particleField.ts).
 * Trails, collisions between particles, 3D, and layer-as-particle stay out of
 * scope.
 */

import { parseHex } from '@core/effects/canvas2dEffects';
import { curlForce } from './particleField';
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
  /**
   * Position history ring, `ringSize` slots per particle, interleaved x,y.
   * Length 0 when trails are off, so a trail-free sim carries no dead weight.
   * The write head is derived from the frame (`frame % ringSize`), so the ring
   * needs no per-particle cursor — every live particle writes every frame.
   */
  trailRing: Float64Array;
  /** Depth px and z velocity — simulated always, projected only when the
   *  config's perspective is on. */
  z: Float64Array;
  vz: Float64Array;
  /** 0 = emitter-born, 1 = sub-emitted child. Children never sub-emit. */
  generation: Float64Array;
  /** Frames each slot has been alive — bounds how far back its ring is REAL,
   *  so a fresh particle cannot exhume the previous occupant's trail. */
  aliveFrames: Float64Array;
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

/**
 * The trail ring's geometry, derived in ONE place: the sim writes with it and
 * `particlesFromSoA` reads with it, and two derivations would let the reader
 * walk a different ring than the writer filled. Ring slots are points × stride
 * frames, capped — the ring is cloned into every SimulationCache snapshot, so
 * history is priced in frames.
 */
export function trailRingSpec(
  cfg: Pick<ParticleConfig, 'trailLength' | 'trailSpacing'>,
  fps: number,
): { points: number; stride: number; ringSize: number } {
  const points = Math.min(24, Math.max(0, Math.floor(cfg.trailLength ?? 0)));
  const stride = Math.max(1, Math.round((cfg.trailSpacing ?? 1 / 30) * Math.max(1, fps)));
  // +1: the head slot holds the CURRENT frame, so reaching back the full
  // points×stride needs that many slots BESIDES it. At exactly points×stride
  // the oldest read wrapped onto the head and the trail's last point was a
  // phantom copy of the particle's own position — found by probing, invisible
  // in the maths.
  return { points, stride, ringSize: points > 0 ? Math.min(121, points * stride + 1) : 0 };
}

function alloc(n: number, ringSize: number): ParticleSoA {
  return {
    trailRing: new Float64Array(n * ringSize * 2),
    z: new Float64Array(n),
    vz: new Float64Array(n),
    generation: new Float64Array(n),
    aliveFrames: new Float64Array(n),
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
    trailRing: s.trailRing.slice(),
    z: s.z.slice(),
    vz: s.vz.slice(),
    generation: s.generation.slice(),
    aliveFrames: s.aliveFrames.slice(),
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
  s.z[slot] = (hash01(i, 6, seed) - 0.5) * (cfg.emitterDepth ?? 0);
  s.vz[slot] = (hash01(i, 8, seed) * 2 - 1) * (cfg.speedZ ?? 0);
  s.generation[slot] = 0;
  s.vx[slot] = Math.cos(dir) * speed;
  s.vy[slot] = Math.sin(dir) * speed;
  s.age[slot] = 0;
  s.life[slot] = life;
  s.alive[slot] = 1;
  s.aliveFrames[slot] = 0;
}

/** Current visual radius of a live slot — the size ramp at its age, halved. */
function radiusAt(s: ParticleSoA, i: number, cfg: ParticleConfig): number {
  const life = s.life[i]!;
  const a01 = life > 0 ? Math.min(1, s.age[i]! / life) : 1;
  return Math.max(0, lerp(cfg.sizeStart, cfg.sizeEnd, a01)) / 2;
}

/** Spawn one sub-emitted child at a burst point. Generation 1: never bursts. */
function spawnChildInto(
  s: ParticleSoA,
  slot: number,
  childId: number,
  at: { x: number; y: number; z: number },
  cfg: ParticleConfig,
): void {
  const seed = cfg.seed | 0;
  const dir = hash01(childId, 30, seed) * Math.PI * 2;
  const speed = (cfg.subSpeed ?? 120) * (0.5 + hash01(childId, 31, seed));
  s.id[slot] = childId;
  s.x[slot] = at.x;
  s.y[slot] = at.y;
  s.z[slot] = at.z;
  s.vz[slot] = 0;
  s.vx[slot] = Math.cos(dir) * speed;
  s.vy[slot] = Math.sin(dir) * speed;
  s.age[slot] = 0;
  s.life[slot] = Math.max(0.05, cfg.subLifetime ?? 0.6);
  s.alive[slot] = 1;
  s.generation[slot] = 1;
  s.aliveFrames[slot] = 0;
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
  const { ringSize } = trailRingSpec(cfg, fps);
  const subDeath = cfg.subEmit === 'death';
  const subBounce = cfg.subEmit === 'bounce';
  const collide = cfg.collide === true;
  const collideRest = Math.max(0, Math.min(1, cfg.collideRestitution ?? 0.7));

  return {
    init(): ParticleSoA {
      const s = alloc(n, ringSize);
      s.emitAcc[0] = 0;
      s.nextId[0] = 0;
      return s;
    },

    step(prev: ParticleSoA, frame: number): ParticleSoA {
      const s = prev;
      /** Sub-emit events collected DURING integration and spawned after it —
       *  spawning mid-loop would let a child be integrated in its birth frame
       *  or, worse, recycle the slot of a particle the loop has not reached. */
      const births: Array<{ x: number; y: number; z: number; parentId: number }> = [];
      // Integrate living particles.
      for (let i = 0; i < n; i++) {
        if (s.alive[i]! < 0.5) continue;
        // Wind is constant acceleration alongside gravity; turbulence is the
        // curl-noise force sampled AT the particle — a pure function of
        // (position, time, seed), which is what keeps the replay contract.
        const turb = curlForce(s.x[i]!, s.y[i]!, frame * dt, cfg);
        const vx = s.vx[i]! * damping + (cfg.gravityX + (cfg.windX ?? 0) + turb.x) * dt;
        let vy = s.vy[i]! * damping + (cfg.gravityY + (cfg.windY ?? 0) + turb.y) * dt;
        const x = s.x[i]! + vx * dt;
        let y = s.y[i]! + vy * dt;
        const age = s.age[i]! + dt;
        if (age >= s.life[i]!) {
          // A dying PARENT can burst. Children (generation 1) never do — one
          // generation, or a firework cascades unbounded.
          if (subDeath && s.generation[i]! < 0.5) {
            births.push({ x: s.x[i]!, y: s.y[i]!, z: s.z[i]!, parentId: s.id[i]! });
          }
          s.alive[i] = 0;
          continue;
        }
        // Floor bounce — the history-dependent interrupt closed-form cannot do.
        if (y >= floorY) {
          y = floorY;
          if (vy > 0) {
            if (subBounce && s.generation[i]! < 0.5) {
              births.push({ x, y, z: s.z[i]!, parentId: s.id[i]! });
            }
            vy = -vy * restitution;
          }
          // Kill near-rest contact chatter (resting on the floor).
          if (Math.abs(vy) < 0.5) vy = 0;
        }
        s.x[i] = x;
        s.y[i] = y;
        s.z[i] = s.z[i]! + s.vz[i]! * dt;
        s.vx[i] = vx;
        s.vy[i] = vy;
        s.age[i] = age;
        // Record AFTER integration and bounce, so the trail shows where the
        // particle actually was — including the corner of a bounce, which is
        // the one thing the closed form can never draw.
        if (ringSize > 0) {
          const head = ((frame % ringSize) + ringSize) % ringSize;
          s.trailRing[(i * ringSize + head) * 2] = x;
          s.trailRing[(i * ringSize + head) * 2 + 1] = y;
          s.aliveFrames[i] = s.aliveFrames[i]! + 1;
        }
      }

      // Particle-particle collisions: equal-mass circles, push-apart plus a
      // restitution impulse along the normal. O(n²) in fixed index order —
      // deterministic, and at the 500-particle cap still cheap. 2D on purpose:
      // z is a projection axis here, and colliding in a depth nobody tuned
      // would separate visually-overlapping particles for invisible reasons.
      if (collide) {
        for (let i = 0; i < n; i++) {
          if (s.alive[i]! < 0.5) continue;
          const ri = radiusAt(s, i, cfg);
          for (let j = i + 1; j < n; j++) {
            if (s.alive[j]! < 0.5) continue;
            const dx = s.x[j]! - s.x[i]!;
            const dy = s.y[j]! - s.y[i]!;
            const r = ri + radiusAt(s, j, cfg);
            const dist = Math.hypot(dx, dy);
            if (dist >= r || r <= 0) continue;
            const nx = dist < 1e-9 ? 1 : dx / dist;
            const ny = dist < 1e-9 ? 0 : dy / dist;
            const push = (r - dist) / 2;
            s.x[i]! -= nx * push;
            s.y[i]! -= ny * push;
            s.x[j]! += nx * push;
            s.y[j]! += ny * push;
            const vn = (s.vx[j]! - s.vx[i]!) * nx + (s.vy[j]! - s.vy[i]!) * ny;
            if (vn < 0) {
              const jn = (-(1 + collideRest) * vn) / 2;
              s.vx[i]! -= jn * nx;
              s.vy[i]! -= jn * ny;
              s.vx[j]! += jn * nx;
              s.vy[j]! += jn * ny;
            }
          }
        }
      }

      // Spawn the collected sub-emit bursts.
      for (const b of births) {
        const count = Math.min(16, Math.max(0, Math.floor(cfg.subCount ?? 0)));
        for (let k = 0; k < count; k++) {
          const slot = findFreeSlot(s);
          const j = (b.parentId | 0) * 977 + k;
          spawnChildInto(s, slot, j, b, cfg);
        }
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
  /** Frame the state corresponds to + fps — needed to locate the ring head.
   *  Omitted (older callers, trail-free configs) → no trails are read. */
  opts?: { frame?: number; fps?: number },
): Particle[] {
  const spec = opts?.fps !== undefined ? trailRingSpec(cfg, opts.fps) : null;
  const readTrail = (i: number): Array<{ x: number; y: number }> | undefined => {
    if (!spec || spec.ringSize === 0 || opts?.frame === undefined) return undefined;
    if (s.trailRing.length < s.alive.length * spec.ringSize * 2) return undefined;
    const { ringSize, stride, points } = spec;
    const head = ((opts.frame % ringSize) + ringSize) % ringSize;
    // Only as far back as this SLOT has been alive — a fresh particle in a
    // recycled slot must not exhume the previous occupant's trail.
    const maxBack = Math.min(points * stride, ringSize - 1, Math.max(0, s.aliveFrames[i]! - 1));
    const out: Array<{ x: number; y: number }> = [];
    for (let k = stride; k <= maxBack; k += stride) {
      const slot = ((head - k) % ringSize + ringSize) % ringSize;
      out.push({
        x: s.trailRing[(i * ringSize + slot) * 2]!,
        y: s.trailRing[(i * ringSize + slot) * 2 + 1]!,
      });
    }
    return out.length > 0 ? out : undefined;
  };
  const out: Particle[] = [];
  const shape: ParticleShape = cfg.shape;
  for (let i = 0; i < s.alive.length; i++) {
    if (s.alive[i]! < 0.5) continue;
    const life = s.life[i]!;
    const age = s.age[i]!;
    const age01 = life > 0 ? Math.min(1, age / life) : 1;
    const size = Math.max(0, lerp(cfg.sizeStart, cfg.sizeEnd, age01));
    const opacity = lerp(cfg.opacityStart, cfg.opacityEnd, age01);
    const trail = readTrail(i);
    // Children render at the config's size ramp scaled down — same ramp, same
    // colours, smaller, which is what makes a burst read as debris OF the
    // parent rather than as a second emitter.
    const genScale = s.generation[i]! >= 0.5 ? Math.max(0, cfg.subSizeScale ?? 0.5) : 1;
    out.push({
      ...(trail ? { trail } : {}),
      // The SoA's own birth index — stable while the slot lives, which is
      // exactly the span a baked layer covers. See `Particle.index`.
      //
      // Children are NEGATED rather than reported raw: `spawnChildInto` salts
      // them `parentId·977 + k`, which for parent 0 yields 0…15 — the same
      // numbers the emitter's first sixteen particles carry. Harmless while
      // the id was only an RNG salt; a straight collision of IDENTITY for
      // anything that groups samples by it.
      index: s.generation[i]! >= 0.5 ? -(s.id[i]! + 1) : s.id[i]!,
      z: s.z[i]!,
      x: s.x[i]!,
      y: s.y[i]!,
      size: size * genScale,
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
