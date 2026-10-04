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
 * stacking, knocking into each other, tumbling — is a few hundred lines. When
 * a real constraint solver is needed (joints, ragdolls, continuous collision),
 * that is the moment to have the dependency conversation, with a concrete need
 * to point at rather than in advance.
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
 * ── Rotation, and how it stays compatible ───────────────────────────────────
 *
 * Rotation is OPT-IN PER BODY (`rotate`), and the mechanism is the reason that
 * is safe: a body that does not rotate carries `invInertia = 0`, which makes
 * every angular term in the impulse algebra vanish — the effective mass loses
 * its `(r×n)²·invI` contributions, no torque is ever applied, and the maths
 * reduces EXACTLY to the translation-only solver this file shipped with. A
 * scene saved before rotation existed therefore re-simulates bit-identically
 * after the update, which matters because a simulation IS its history.
 *
 * A rotating box is a real OBB: collision runs SAT over both boxes' axes with
 * a clipped two-point contact manifold (two points is what keeps a resting box
 * from rocking on a single corner), and impulses are applied AT the contact,
 * so an off-centre hit produces the torque that makes a tumble read as one.
 * A rotating circle picks up spin from friction alone — rolling is emergent,
 * not scripted.
 */

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
  /**
   * Let this body SPIN. Off by default so every scene simulated before this
   * existed replays bit-identically; on, the collider becomes a real oriented
   * box (or a rolling circle) and impulses land at the contact point.
   */
  rotate: boolean;
}

export const DEFAULT_PHYSICS_BODY: PhysicsBodyConfig = {
  enabled: false,
  kind: 'dynamic',
  shape: 'box',
  mass: 1,
  restitution: 0.4,
  friction: 0.2,
  damping: 0.999,
  rotate: false,
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
  /** Radians. Rendered in degrees; kept in radians for the trig. */
  angle: number;
  /** Angular velocity, rad/s. */
  omega: number;
  /** 0 for static — the algebra then treats it as immovable with no branches. */
  invMass: number;
  /** 0 for static AND for rotation-locked bodies — same trick, same algebra. */
  invInertia: number;
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
  /** Degrees, matching the layer's own rotation property. */
  rotation?: number;
  width: number;
  height: number;
  cfg: PhysicsBodyConfig;
}
