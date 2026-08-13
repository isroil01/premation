/**
 * Bouncing particles — the first history-dependent layer, and a deliberate
 * counterexample to the closed-form emitter.
 *
 * Chosen because collision is the cheapest thing that is genuinely NOT
 * expressible in closed form. `particleSim.ts` can place a particle at any time
 * with `p0 + v0·age + ½g·age²` precisely because nothing interrupts the
 * trajectory. Add a floor and it stops being solvable: the position at t=5s
 * depends on how many bounces happened, each bounce depends on the velocity at
 * impact, and that velocity depends on the bounce before it. There is no
 * formula, only replay — which is exactly the property `SimulationCache` exists
 * to hide from the renderer.
 *
 * So this is not "a nicer particle system". It is the smallest thing that
 * proves the subsystem does what it claims, and every test of the cache's
 * ordering invariant is driven through it.
 *
 * State is a struct-of-arrays of `Float64Array`, not an array of objects. Two
 * reasons, both about the invariant rather than about speed: typed arrays clone
 * exactly (`slice()` copies bits, so a snapshot cannot share a reference with
 * the state that produced it), and float64 keeps the arithmetic identical
 * across the step count — a float32 accumulation would drift differently
 * depending on how many steps were taken to reach a frame, which is precisely
 * the history-dependence the cache must NOT have.
 */

import type { Simulation } from './simulationCore';

export interface BounceConfig {
  count: number;
  /** Any integer. Two caches with the same seed and config are identical. */
  seed: number;
  /** Downward acceleration, px per frame². */
  gravity: number;
  /** Velocity retained across a wall hit, 0..1. 1 bounces forever. */
  restitution: number;
  /** Per-frame velocity multiplier, 0..1. Air drag; 1 is none. */
  damping: number;
  width: number;
  height: number;
  radius: number;
}

export const DEFAULT_BOUNCE_CONFIG: BounceConfig = {
  count: 64,
  seed: 1,
  gravity: 0.35,
  restitution: 0.72,
  damping: 0.999,
  width: 640,
  height: 360,
  radius: 4,
};

export interface BounceState {
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
}

/**
 * Integer hash → [0,1). Deterministic and self-contained.
 *
 * Deliberately not `Math.random()` seeded once at init: that would make the
 * initial state depend on how many times the generator had been pulled, so two
 * caches built from the same config could disagree — the exact class of bug the
 * `Simulation` contract forbids.
 */
function hash01(i: number, salt: number, seed: number): number {
  let h = (i * 374761393 + salt * 668265263 + seed * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function createBounceSim(config: BounceConfig): Simulation<BounceState> {
  const { count, seed, gravity, restitution, damping, width, height, radius } = config;
  const n = Math.max(0, Math.floor(count));
  const minX = radius;
  const maxX = Math.max(radius, width - radius);
  const minY = radius;
  const maxY = Math.max(radius, height - radius);

  return {
    init(): BounceState {
      const s: BounceState = {
        x: new Float64Array(n),
        y: new Float64Array(n),
        vx: new Float64Array(n),
        vy: new Float64Array(n),
      };
      for (let i = 0; i < n; i++) {
        s.x[i] = minX + hash01(i, 1, seed) * (maxX - minX);
        s.y[i] = minY + hash01(i, 2, seed) * (maxY - minY) * 0.5;
        s.vx[i] = (hash01(i, 3, seed) - 0.5) * 8;
        s.vy[i] = (hash01(i, 4, seed) - 0.5) * 4;
      }
      return s;
    },

    step(prev: BounceState): BounceState {
      // Mutates and returns `prev`. Safe by the cache's contract: it only ever
      // steps a state it privately owns, and stores clones.
      const { x, y, vx, vy } = prev;
      for (let i = 0; i < n; i++) {
        let px = x[i]!;
        let py = y[i]!;
        let ax = vx[i]! * damping;
        let ay = (vy[i]! + gravity) * damping;
        px += ax;
        py += ay;

        // Reflect, then clamp. Clamping matters as much as reflecting: without
        // it a particle that overshoots the wall in one step stays outside,
        // reflects again next frame, and buzzes against the boundary forever.
        if (px < minX) { px = minX; ax = Math.abs(ax) * restitution; }
        else if (px > maxX) { px = maxX; ax = -Math.abs(ax) * restitution; }
        if (py < minY) { py = minY; ay = Math.abs(ay) * restitution; }
        else if (py > maxY) { py = maxY; ay = -Math.abs(ay) * restitution; }

        x[i] = px; y[i] = py; vx[i] = ax; vy[i] = ay;
      }
      return prev;
    },

    clone(s: BounceState): BounceState {
      // `slice()` on a typed array copies the buffer. A spread or Object.assign
      // would share it, and every snapshot would silently track the live state.
      return { x: s.x.slice(), y: s.y.slice(), vx: s.vx.slice(), vy: s.vy.slice() };
    },
  };
}

/** Stable digest of a state, for asserting two histories agree exactly. */
export function bounceDigest(s: BounceState): string {
  let h = 0;
  const put = (v: number): void => {
    // Fixed precision so the digest compares VALUES, not float formatting.
    const t = Math.round(v * 1e6);
    h = (Math.imul(h, 31) + (t | 0)) | 0;
  };
  for (let i = 0; i < s.x.length; i++) { put(s.x[i]!); put(s.y[i]!); put(s.vx[i]!); put(s.vy[i]!); }
  return (h >>> 0).toString(16);
}
