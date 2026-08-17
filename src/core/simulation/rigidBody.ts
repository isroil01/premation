/**
 * 2D rigid-body dynamics for layers.
 *
 * ── Why hand-written rather than Rapier ─────────────────────────────────────
 *
 * Rapier is the obvious reach, and it was rejected deliberately. It arrives as
 * WASM, which in this app means loosening the Content-Security-Policy to allow
 * `wasm-unsafe-eval` — a security-policy change made to get a falling-box
 * effect, and one that then applies to every page the renderer ever loads. It
 * also brings a second physics vocabulary into a codebase that already
 * hand-writes its particle emitter and its bounce generator, and a second
 * determinism story into one that already has a strict one (below).
 *
 * What is actually needed for motion graphics — things falling, landing,
 * stacking, knocking into each other — is a few hundred lines. When a real
 * constraint solver is needed (joints, ragdolls, continuous collision), that is
 * the moment to have the dependency conversation, with a concrete need to point
 * at rather than in advance.
 *
 * ── Determinism ─────────────────────────────────────────────────────────────
 *
 * This is a `Simulation<S>` and runs under `SimulationCache`, so it inherits
 * the one invariant that file exists for: `stateAt(f)` must not depend on which
 * frames were asked for before it. That is why `step` reads nothing ambient —
 * no wall clock, no RNG, no store — and why body ORDER is fixed by id: iterating
 * a Map or an object's keys would make the resolution order depend on insertion
 * history, and two runs would drift apart in the fourth decimal and then
 * visibly.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 *
 * **No rotation.** Bodies translate; they do not spin. Angular dynamics needs
 * contact points, an inertia tensor and friction torque, and a half-built
 * version of that is worse than none: boxes jitter, stacks creep, and the bug
 * looks like a physics bug rather than a missing feature. Boxes are therefore
 * axis-aligned (AABB), which is exactly true while nothing rotates. A layer's
 * own rotation still renders — it just does not participate in collision.
 *
 * That is an honest limit rather than a hidden one: falling, landing, stacking
 * and knocking about all work; a tumbling domino does not.
 */

import type { Simulation } from './simulationCore';

export type BodyKind = 'static' | 'dynamic';
export type ColliderShape = 'circle' | 'box';

/** Per-layer physics settings, as authored. */
export interface PhysicsBodyConfig {
  enabled: boolean;
  kind: BodyKind;
  shape: ColliderShape;
  /** Dynamic only. Non-positive is treated as 1 — a zero-mass dynamic body is
   *  a division by zero, not an "infinitely light" one. */
  mass: number;
  /** 0 = dead stop, 1 = bounces back at full speed. */
  restitution: number;
  /** 0..1 tangential velocity lost on contact. */
  friction: number;
  /** Fraction of velocity retained per second. 1 = frictionless space. */
  damping: number;
}

export const DEFAULT_PHYSICS_BODY: PhysicsBodyConfig = {
  enabled: false,
  kind: 'dynamic',
  shape: 'box',
  mass: 1,
  restitution: 0.4,
  friction: 0.2,
  damping: 0.999,
};

export interface PhysicsWorld {
  gravityX: number;
  gravityY: number;
  /** Walls. Null lets bodies fall out of frame forever, which is a legitimate
   *  thing to want and the only way to get an object to LEAVE the shot. */
  bounds: { left: number; top: number; right: number; bottom: number } | null;
  /** Solver passes per frame. More passes settle stacks; each costs a sweep. */
  iterations: number;
}

export const DEFAULT_PHYSICS_WORLD: PhysicsWorld = {
  gravityX: 0,
  gravityY: 1800,
  bounds: null,
  iterations: 4,
};

/** One body, as the solver holds it. */
export interface Body {
  id: string;
  kind: BodyKind;
  shape: ColliderShape;
  /** Half-extents for a box; `halfW` doubles as the radius for a circle. */
  halfW: number;
  halfH: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 0 for static — the algebra then treats it as immovable with no branches. */
  invMass: number;
  restitution: number;
  friction: number;
  damping: number;
}

export interface PhysicsState {
  bodies: Body[];
}

/** A body's starting pose, taken from the layer at frame 0. */
export interface BodySeed {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  cfg: PhysicsBodyConfig;
}

const radiusOf = (b: Body): number => b.halfW;

/**
 * Build the solver.
 *
 * `seeds` are sorted by id so the resolution order is a property of the scene
 * rather than of the order layers happened to be created in — see the header.
 */
export function createRigidBodySim(
  seeds: ReadonlyArray<BodySeed>,
  world: PhysicsWorld,
  fps: number,
): Simulation<PhysicsState> {
  const dt = fps > 0 ? 1 / fps : 1 / 60;
  const ordered = [...seeds].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const init = (): PhysicsState => ({
    bodies: ordered.map((s) => {
      const dynamic = s.cfg.kind === 'dynamic';
      const mass = s.cfg.mass > 0 ? s.cfg.mass : 1;
      return {
        id: s.id,
        kind: s.cfg.kind,
        shape: s.cfg.shape,
        // A circle uses the smaller half-extent, so it stays inside the layer's
        // box rather than poking out of the narrow axis.
        halfW: s.cfg.shape === 'circle'
          ? Math.max(0.5, Math.min(s.width, s.height) / 2)
          : Math.max(0.5, s.width / 2),
        halfH: s.cfg.shape === 'circle'
          ? Math.max(0.5, Math.min(s.width, s.height) / 2)
          : Math.max(0.5, s.height / 2),
        x: s.x,
        y: s.y,
        vx: 0,
        vy: 0,
        invMass: dynamic ? 1 / mass : 0,
        restitution: Math.max(0, Math.min(1, s.cfg.restitution)),
        friction: Math.max(0, Math.min(1, s.cfg.friction)),
        damping: Math.max(0, Math.min(1, s.cfg.damping)),
      };
    }),
  });

  const step = (prev: PhysicsState, _frame: number): PhysicsState => {
    const bodies = prev.bodies;

    // ── Integrate ────────────────────────────────────────────────────
    for (const b of bodies) {
      if (b.invMass === 0) continue;
      b.vx += world.gravityX * dt;
      b.vy += world.gravityY * dt;
      // Damping is per SECOND, raised to dt, so changing the frame rate does
      // not change how quickly things slow down. A per-frame multiplier would
      // make a 60fps render settle twice as fast as a 30fps one — the classic
      // "the export looks different" bug.
      const d = Math.pow(b.damping, dt);
      b.vx *= d;
      b.vy *= d;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }

    // ── Resolve ──────────────────────────────────────────────────────
    const passes = Math.max(1, Math.floor(world.iterations));
    for (let it = 0; it < passes; it++) {
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          resolvePair(bodies[i]!, bodies[j]!);
        }
      }
      if (world.bounds) for (const b of bodies) resolveBounds(b, world.bounds);
    }
    return prev;
  };

  const clone = (s: PhysicsState): PhysicsState => ({ bodies: s.bodies.map((b) => ({ ...b })) });

  return { init, step, clone };
}

/** Push two overlapping bodies apart and exchange impulse along the normal. */
function resolvePair(a: Body, b: Body): void {
  if (a.invMass === 0 && b.invMass === 0) return;

  let nx = 0;
  let ny = 0;
  let depth = 0;

  if (a.shape === 'circle' && b.shape === 'circle') {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const r = radiusOf(a) + radiusOf(b);
    const dist = Math.hypot(dx, dy);
    if (dist >= r) return;
    depth = r - dist;
    // Two circles exactly on top of each other have no normal to speak of.
    // Picking one deterministically beats dividing by zero and beats a random
    // nudge, which would break the replay contract.
    if (dist < 1e-9) { nx = 1; ny = 0; } else { nx = dx / dist; ny = dy / dist; }
  } else {
    // Box-box and circle-box both reduce to an AABB overlap here, because
    // nothing rotates (see the header). The circle is treated as its bounding
    // square, which is why a circle is sized from the SMALLER extent.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const ox = a.halfW + b.halfW - Math.abs(dx);
    if (ox <= 0) return;
    const oy = a.halfH + b.halfH - Math.abs(dy);
    if (oy <= 0) return;
    // Separate along the axis of LEAST penetration: the other axis would shove
    // a body the long way out of a shallow overlap, which reads as a launch.
    if (ox < oy) {
      depth = ox;
      nx = dx < 0 ? -1 : 1;
      ny = 0;
    } else {
      depth = oy;
      nx = 0;
      ny = dy < 0 ? -1 : 1;
    }
  }

  const invSum = a.invMass + b.invMass;
  if (invSum <= 0) return;

  // Positional correction, split by inverse mass so a light body moves more.
  const corr = depth / invSum;
  a.x -= nx * corr * a.invMass;
  a.y -= ny * corr * a.invMass;
  b.x += nx * corr * b.invMass;
  b.y += ny * corr * b.invMass;

  // Impulse along the normal.
  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const vn = rvx * nx + rvy * ny;
  if (vn > 0) return; // already separating — resolving again would suck them together
  const e = Math.min(a.restitution, b.restitution);
  const jn = (-(1 + e) * vn) / invSum;
  a.vx -= jn * nx * a.invMass;
  a.vy -= jn * ny * a.invMass;
  b.vx += jn * nx * b.invMass;
  b.vy += jn * ny * b.invMass;

  // Friction: damp the TANGENTIAL component, so a box sliding along a floor
  // slows down instead of skating forever.
  const f = Math.max(a.friction, b.friction);
  if (f <= 0) return;
  const tx = -ny;
  const ty = nx;
  const vt = (b.vx - a.vx) * tx + (b.vy - a.vy) * ty;
  const jt = (-vt * f) / invSum;
  a.vx -= jt * tx * a.invMass;
  a.vy -= jt * ty * a.invMass;
  b.vx += jt * tx * b.invMass;
  b.vy += jt * ty * b.invMass;
}

/** Keep a body inside the world box. */
function resolveBounds(b: Body, bounds: NonNullable<PhysicsWorld['bounds']>): void {
  if (b.invMass === 0) return;
  const hw = b.halfW;
  const hh = b.halfH;

  if (b.x - hw < bounds.left) {
    b.x = bounds.left + hw;
    if (b.vx < 0) { b.vx = -b.vx * b.restitution; b.vy *= 1 - b.friction; }
  } else if (b.x + hw > bounds.right) {
    b.x = bounds.right - hw;
    if (b.vx > 0) { b.vx = -b.vx * b.restitution; b.vy *= 1 - b.friction; }
  }

  if (b.y - hh < bounds.top) {
    b.y = bounds.top + hh;
    if (b.vy < 0) { b.vy = -b.vy * b.restitution; b.vx *= 1 - b.friction; }
  } else if (b.y + hh > bounds.bottom) {
    b.y = bounds.bottom - hh;
    if (b.vy > 0) { b.vy = -b.vy * b.restitution; b.vx *= 1 - b.friction; }
  }
}
