/**
 * Force and displacement fields for particles: wind and turbulence.
 *
 * ── One name, two honest implementations ────────────────────────────────────
 *
 * "Turbulence" means something different to each simulation mode, and gluing
 * one implementation onto both would break one of their contracts:
 *
 *  • The BALLISTIC emitter is a closed form — particle `i`'s position is a
 *    formula in `age`, which is what makes scrubbing free. Its turbulence must
 *    therefore also be a formula in age: {@link wanderOffset} is a seeded sum
 *    of sinusoids, a smooth per-particle drift. It cannot swirl (a swirl is
 *    history), but it wanders convincingly and costs nothing.
 *
 *  • The STATEFUL sim steps frame by frame, so it can afford the real thing:
 *    {@link curlForce} samples a CURL-NOISE field at the particle's position.
 *    Curl of a scalar field is divergence-free by construction — the property
 *    that makes particles swirl around eddies instead of clumping into the
 *    noise's bright spots, which is exactly what naive "add noise to velocity"
 *    does and exactly why it reads as static rather than wind.
 *
 * Both are pure functions of (inputs, seed) — nothing ambient — so the
 * ballistic form stays scrub-exact and the stateful form keeps
 * `SimulationCache`'s replay invariant.
 */

import type { ParticleConfig } from './particleSim';

/** Same construction as particleSim's hash01; duplicated for the same reason
 *  the cloner duplicated it — that one is private, and coupling three modules
 *  to one module's private helper is worse than three copies of four lines. */
function hash01(i: number, salt: number, seed: number): number {
  let n = (i | 0) * 374761393 + (salt | 0) * 668265263 + (seed | 0) * 2246822519;
  n = (n ^ (n >>> 13)) * 1274126177;
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967296;
}

// ── Ballistic: per-particle wander ────────────────────────────────────

/**
 * Smooth displacement for particle `i` at `age`, in px. Starts at exactly 0 —
 * a particle must be BORN on the emitter, and a turbulence that teleports
 * births reads as a broken emitter rather than as wind.
 *
 * Two octaves per axis with incommensurate frequencies, so the path does not
 * visibly loop within a particle's lifetime. Deliberately only two: this runs
 * per particle per frame, and the difference between two and five octaves is
 * invisible at particle sizes while the cost is not (the expression system
 * already learned that lesson the hard way).
 */
export function wanderOffset(
  i: number,
  age: number,
  cfg: Pick<ParticleConfig, 'turbulence' | 'turbulenceSpeed' | 'seed'>,
): { x: number; y: number } {
  const amp = cfg.turbulence ?? 0;
  if (amp <= 0) return { x: 0, y: 0 };
  const speed = cfg.turbulenceSpeed ?? 1;
  const seed = cfg.seed | 0;
  const t = age * speed;

  const axis = (saltA: number, saltB: number): number => {
    const f1 = 0.7 + hash01(i, saltA, seed) * 1.1;        // 0.7..1.8 Hz
    const f2 = 1.9 + hash01(i, saltA + 10, seed) * 1.7;   // 1.9..3.6 Hz
    const p1 = hash01(i, saltB, seed) * Math.PI * 2;
    const p2 = hash01(i, saltB + 10, seed) * Math.PI * 2;
    // `sin(p + ft) − sin(p)` is zero at t=0 whatever the phase — the birth
    // guarantee, carried by algebra instead of by a fade-in that would also
    // suppress the wander of young particles.
    const w1 = Math.sin(p1 + f1 * Math.PI * 2 * t) - Math.sin(p1);
    const w2 = Math.sin(p2 + f2 * Math.PI * 2 * t) - Math.sin(p2);
    return (w1 + 0.5 * w2) / 1.5;
  };

  return { x: amp * axis(20, 21), y: amp * axis(22, 23) };
}

// ── Stateful: curl-noise force ────────────────────────────────────────

/** Smoothstep-interpolated value noise on a hashed integer lattice, in [-1,1].
 *  `t` is a third lattice axis, so the field EVOLVES rather than being a
 *  frozen texture the particles fly through. */
function valueNoise(x: number, y: number, t: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const ti = Math.floor(t);
  const fx = x - xi;
  const fy = y - yi;
  const ft = t - ti;
  const sm = (v: number): number => v * v * (3 - 2 * v);
  const sx = sm(fx);
  const sy = sm(fy);
  const st = sm(ft);

  const corner = (dx: number, dy: number, dt: number): number =>
    hash01((xi + dx) * 73856093 ^ (yi + dy) * 19349663 ^ (ti + dt) * 83492791, 7, seed) * 2 - 1;

  const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
  const plane = (dt: number): number =>
    lerp(
      lerp(corner(0, 0, dt), corner(1, 0, dt), sx),
      lerp(corner(0, 1, dt), corner(1, 1, dt), sx),
      sy,
    );
  return lerp(plane(0), plane(1), st);
}

/**
 * The turbulence force at a point, px/s².
 *
 * F = strength · (∂n/∂y, −∂n/∂x): the curl of the scalar noise. Divergence-
 * free by construction, which is what makes the motion read as fluid — see the
 * header. The derivative is a central finite difference; `EPS` is in NOISE
 * space, so it is independent of `turbulenceScale`.
 */
export function curlForce(
  x: number,
  y: number,
  timeSec: number,
  cfg: Pick<ParticleConfig, 'turbulence' | 'turbulenceScale' | 'turbulenceSpeed' | 'seed'>,
): { x: number; y: number } {
  const amp = cfg.turbulence ?? 0;
  if (amp <= 0) return { x: 0, y: 0 };
  const scale = Math.max(1, cfg.turbulenceScale ?? 100);
  const speed = cfg.turbulenceSpeed ?? 1;
  const seed = cfg.seed | 0;

  const nx = x / scale;
  const ny = y / scale;
  const nt = timeSec * speed;
  const EPS = 0.25;

  const dndy = (valueNoise(nx, ny + EPS, nt, seed) - valueNoise(nx, ny - EPS, nt, seed)) / (2 * EPS);
  const dndx = (valueNoise(nx + EPS, ny, nt, seed) - valueNoise(nx - EPS, ny, nt, seed)) / (2 * EPS);
  return { x: amp * dndy, y: -amp * dndx };
}
