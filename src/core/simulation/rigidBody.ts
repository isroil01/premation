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

const DEG = Math.PI / 180;
const radiusOf = (b: Body): number => b.halfW;

/** 2D cross products. `crossSV` is ω × r (a scalar spins a vector). */
const crossVV = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

/** A contact: where, which way, how deep. Normal points FROM a TOWARD b. */
interface Contact {
  nx: number;
  ny: number;
  depth: number;
  /** Contact points in world space (1 for circles, up to 2 for boxes). */
  px: number[];
  py: number[];
}

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
      const isCircle = s.cfg.shape === 'circle';
      // A circle uses the smaller half-extent, so it stays inside the layer's
      // box rather than poking out of the narrow axis.
      const halfW = isCircle
        ? Math.max(0.5, Math.min(s.width, s.height) / 2)
        : Math.max(0.5, s.width / 2);
      const halfH = isCircle ? halfW : Math.max(0.5, s.height / 2);
      // Standard inertia: ½mr² for a disc, m(w²+h²)/12 for a box.
      const inertia = isCircle
        ? 0.5 * mass * halfW * halfW
        : (mass * ((halfW * 2) ** 2 + (halfH * 2) ** 2)) / 12;
      return {
        id: s.id,
        kind: s.cfg.kind,
        shape: s.cfg.shape,
        halfW,
        halfH,
        x: s.x,
        y: s.y,
        vx: 0,
        vy: 0,
        angle: (s.rotation ?? 0) * DEG,
        omega: 0,
        invMass: dynamic ? 1 / mass : 0,
        invInertia: dynamic && s.cfg.rotate ? 1 / inertia : 0,
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
      b.omega *= d;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.angle += b.omega * dt;
    }

    // ── Resolve ──────────────────────────────────────────────────────
    const passes = Math.max(1, Math.floor(world.iterations));
    for (let it = 0; it < passes; it++) {
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          const c = collide(bodies[i]!, bodies[j]!);
          if (c) resolveContact(bodies[i]!, bodies[j]!, c);
        }
      }
      if (world.bounds) for (const b of bodies) resolveBounds(b, world.bounds);
    }
    return prev;
  };

  const clone = (s: PhysicsState): PhysicsState => ({ bodies: s.bodies.map((b) => ({ ...b })) });

  return { init, step, clone };
}

// ── Collision detection ───────────────────────────────────────────────

/** The box's four corners in world space. Zero angle short-circuits the trig —
 *  the common case, since rotation is opt-in. */
function corners(b: Body): Array<{ x: number; y: number }> {
  if (b.angle === 0) {
    return [
      { x: b.x - b.halfW, y: b.y - b.halfH },
      { x: b.x + b.halfW, y: b.y - b.halfH },
      { x: b.x + b.halfW, y: b.y + b.halfH },
      { x: b.x - b.halfW, y: b.y + b.halfH },
    ];
  }
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  const out: Array<{ x: number; y: number }> = [];
  for (const [lx, ly] of [[-b.halfW, -b.halfH], [b.halfW, -b.halfH], [b.halfW, b.halfH], [-b.halfW, b.halfH]] as const) {
    out.push({ x: b.x + lx * c - ly * s, y: b.y + lx * s + ly * c });
  }
  return out;
}

function collide(a: Body, b: Body): Contact | null {
  if (a.invMass === 0 && b.invMass === 0) return null;
  if (a.shape === 'circle' && b.shape === 'circle') return circleCircle(a, b);
  if (a.shape === 'circle') {
    const c = circleBox(a, b);
    return c ? { ...c, nx: -c.nx, ny: -c.ny } : null; // normal must point a→b
  }
  if (b.shape === 'circle') return circleBox(b, a);
  return boxBox(a, b);
}

function circleCircle(a: Body, b: Body): Contact | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const r = radiusOf(a) + radiusOf(b);
  const dist = Math.hypot(dx, dy);
  if (dist >= r) return null;
  // Two circles exactly on top of each other have no normal to speak of.
  // Picking one deterministically beats dividing by zero and beats a random
  // nudge, which would break the replay contract.
  const nx = dist < 1e-9 ? 1 : dx / dist;
  const ny = dist < 1e-9 ? 0 : dy / dist;
  return {
    nx, ny, depth: r - dist,
    px: [a.x + nx * radiusOf(a)], py: [a.y + ny * radiusOf(a)],
  };
}

/** Circle vs (possibly oriented) box. Normal points from the BOX toward the
 *  circle; `collide` flips it when the argument order was the other way. */
function circleBox(circle: Body, box: Body): Contact | null {
  // Into the box's local frame, where it is axis-aligned again.
  const c = Math.cos(-box.angle);
  const s = Math.sin(-box.angle);
  const dx = circle.x - box.x;
  const dy = circle.y - box.y;
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;

  const qx = Math.max(-box.halfW, Math.min(box.halfW, lx));
  const qy = Math.max(-box.halfH, Math.min(box.halfH, ly));
  let nxL: number;
  let nyL: number;
  let depth: number;
  if (qx === lx && qy === ly) {
    // Centre INSIDE the box: push out along the nearest face.
    const px = box.halfW - Math.abs(lx);
    const py = box.halfH - Math.abs(ly);
    if (px < py) { nxL = lx < 0 ? -1 : 1; nyL = 0; depth = px + radiusOf(circle); }
    else { nxL = 0; nyL = ly < 0 ? -1 : 1; depth = py + radiusOf(circle); }
  } else {
    const ddx = lx - qx;
    const ddy = ly - qy;
    const d = Math.hypot(ddx, ddy);
    if (d >= radiusOf(circle)) return null;
    nxL = d < 1e-9 ? 1 : ddx / d;
    nyL = d < 1e-9 ? 0 : ddy / d;
    depth = radiusOf(circle) - d;
  }
  // Back to world space.
  const cw = Math.cos(box.angle);
  const sw = Math.sin(box.angle);
  const nx = nxL * cw - nyL * sw;
  const ny = nxL * sw + nyL * cw;
  return {
    nx, ny, depth,
    px: [circle.x - nx * radiusOf(circle)],
    py: [circle.y - ny * radiusOf(circle)],
  };
}

/**
 * OBB vs OBB: SAT over both boxes' face axes, then the incident face clipped
 * against the reference face's side planes for a two-point manifold.
 *
 * Two points, not one, is what keeps a resting box from rocking: a single
 * averaged contact under a flat box sits at its centre, any torque noise tips
 * it, and the "physics" reads as a haunted table.
 */
function boxBox(a: Body, b: Body): Contact | null {
  const axesOf = (o: Body): Array<{ x: number; y: number; extent: number }> => {
    const c = Math.cos(o.angle);
    const s = Math.sin(o.angle);
    return [
      { x: c, y: s, extent: o.halfW },
      { x: -s, y: c, extent: o.halfH },
    ];
  };
  const projectedRadius = (o: Body, ax: { x: number; y: number }): number => {
    const [u, v] = axesOf(o);
    return o.halfW * Math.abs(u!.x * ax.x + u!.y * ax.y) + o.halfH * Math.abs(v!.x * ax.x + v!.y * ax.y);
  };

  const tx = b.x - a.x;
  const ty = b.y - a.y;
  let best: { depth: number; nx: number; ny: number; ref: Body; inc: Body } | null = null;

  for (const [owner, other] of [[a, b], [b, a]] as const) {
    for (const axis of axesOf(owner)) {
      const dist = Math.abs(tx * axis.x + ty * axis.y);
      const overlap = axis.extent + projectedRadius(other, axis) - dist;
      if (overlap <= 0) return null; // separating axis — no contact at all
      if (!best || overlap < best.depth) {
        // Orient the normal from a toward b, whoever owns the axis.
        const toward = tx * axis.x + ty * axis.y >= 0 ? 1 : -1;
        best = { depth: overlap, nx: axis.x * toward, ny: axis.y * toward, ref: owner, inc: other };
      }
    }
  }
  if (!best) return null;

  // Reference face: the `ref` box's face most anti-/aligned with the normal
  // (pointing at the incident box). Incident face: the `inc` face most
  // anti-aligned with it. Clip incident corners to the reference side planes.
  const refN = best.ref === a ? { x: best.nx, y: best.ny } : { x: -best.nx, y: -best.ny };
  const incCorners = corners(best.inc);
  // Penetration past the reference FACE, not past the reference centre. The
  // face plane sits `refExtent` out along the normal; measuring from the
  // centre put every incident corner "outside" by the ref's own half-extent,
  // so the manifold filter rejected both points, the single-point fallback
  // fired every time, and a perfectly centred hit resolved off-centre — the
  // target walked away spinning at 3.5 rad/s from a symmetric collision.
  const refExtent = projectedRadius(best.ref, refN);
  const depthOf = (p: { x: number; y: number }): number =>
    refExtent - ((p.x - best!.ref.x) * refN.x + (p.y - best!.ref.y) * refN.y);
  const sorted = [...incCorners].sort((p, q) => depthOf(q) - depthOf(p));
  const edge = [sorted[0]!, sorted[1]!];

  // Side planes of the reference face: the ref axis PERPENDICULAR to refN.
  const rc = Math.cos(best.ref.angle);
  const rs = Math.sin(best.ref.angle);
  const axes = [
    { x: rc, y: rs, extent: best.ref.halfW },
    { x: -rs, y: rc, extent: best.ref.halfH },
  ];
  // Pick the axis most perpendicular to the normal as the side direction.
  const side = Math.abs(axes[0]!.x * refN.x + axes[0]!.y * refN.y)
    < Math.abs(axes[1]!.x * refN.x + axes[1]!.y * refN.y)
    ? axes[0]!
    : axes[1]!;

  const clip = (p: { x: number; y: number }): { x: number; y: number } => {
    // Clamp along the side direction to the reference face's span. 1D clip —
    // cheap, deterministic, and enough for convex boxes.
    const along = (p.x - best!.ref.x) * side.x + (p.y - best!.ref.y) * side.y;
    const clamped = Math.max(-side.extent, Math.min(side.extent, along));
    return { x: p.x + (clamped - along) * side.x, y: p.y + (clamped - along) * side.y };
  };

  const px: number[] = [];
  const py: number[] = [];
  for (const p of edge) {
    // Keep only points actually past the reference face (within slop).
    if (depthOf(p) > -0.05) {
      const q = clip(p);
      px.push(q.x);
      py.push(q.y);
    }
  }
  if (px.length === 0) {
    const q = clip(edge[0]!);
    px.push(q.x);
    py.push(q.y);
  }
  return { nx: best.nx, ny: best.ny, depth: best.depth, px, py };
}

// ── Resolution ────────────────────────────────────────────────────────

/** Baumgarte-style positional correction. `SLOP` is the penetration we accept
 *  so resting contacts do not jitter; `PERCENT` is how much of the rest we fix
 *  per pass, so stacks converge without launching. */
const SLOP = 0.05;
const PERCENT = 0.8;

function resolveContact(a: Body, b: Body, c: Contact): void {
  const invSum = a.invMass + b.invMass;
  if (invSum <= 0) return;

  // Positional correction along the normal, split by inverse mass. EXACT when
  // neither body rotates — that is the solver this file shipped with, and a
  // pre-rotation scene must replay bit-identically. Slop-and-percent when
  // either rotates: full correction at a contact point off the centroid adds
  // potential energy every frame, and a settling box then rocks forever on
  // the energy the correction pumps in.
  const rotating = a.invInertia !== 0 || b.invInertia !== 0;
  const corr = rotating
    ? (Math.max(c.depth - SLOP, 0) * PERCENT) / invSum
    : c.depth / invSum;
  a.x -= c.nx * corr * a.invMass;
  a.y -= c.ny * corr * a.invMass;
  b.x += c.nx * corr * b.invMass;
  b.y += c.ny * corr * b.invMass;

  // Impulses for ALL contact points are computed from the SAME pre-state and
  // applied together. Sequential per-point application looks equivalent and is
  // not: point 1's impulse changes the velocity point 2 sees, so a perfectly
  // CENTRED two-point hit resolves asymmetrically and the target walks away
  // spinning — measured at 3.5 rad/s before this was simultaneous.
  const n = c.px.length;
  const jns: number[] = new Array(n).fill(0);
  const geom = c.px.map((_, i) => {
    const rax = c.px[i]! - a.x;
    const ray = c.py[i]! - a.y;
    const rbx = c.px[i]! - b.x;
    const rby = c.py[i]! - b.y;
    return { rax, ray, rbx, rby };
  });

  const e = Math.min(a.restitution, b.restitution);
  for (let i = 0; i < n; i++) {
    const g = geom[i]!;
    const relVx = b.vx - b.omega * g.rby - (a.vx - a.omega * g.ray);
    const relVy = b.vy + b.omega * g.rbx - (a.vy + a.omega * g.rax);
    const vn = relVx * c.nx + relVy * c.ny;
    if (vn > 0) continue; // separating — resolving again would suck them together
    const raCrossN = crossVV(g.rax, g.ray, c.nx, c.ny);
    const rbCrossN = crossVV(g.rbx, g.rby, c.nx, c.ny);
    const effMass = invSum + raCrossN * raCrossN * a.invInertia + rbCrossN * rbCrossN * b.invInertia;
    if (effMass <= 0) continue;
    jns[i] = (-(1 + e) * vn) / effMass / n;
  }
  for (let i = 0; i < n; i++) {
    const jn = jns[i]!;
    if (jn === 0) continue;
    const g = geom[i]!;
    const raCrossN = crossVV(g.rax, g.ray, c.nx, c.ny);
    const rbCrossN = crossVV(g.rbx, g.rby, c.nx, c.ny);
    a.vx -= jn * c.nx * a.invMass;
    a.vy -= jn * c.ny * a.invMass;
    a.omega -= raCrossN * jn * a.invInertia;
    b.vx += jn * c.nx * b.invMass;
    b.vy += jn * c.ny * b.invMass;
    b.omega += rbCrossN * jn * b.invInertia;
  }

  // Coulomb friction at the same points, clamped by each point's normal
  // impulse — computed from the post-normal state, applied simultaneously for
  // the same symmetry reason. This is where a rolling circle gets its spin:
  // the tangential impulse at the rim IS the torque.
  const f = Math.max(a.friction, b.friction);
  if (f <= 0) return;
  const tx = -c.ny;
  const ty = c.nx;
  const jts: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (jns[i] === 0) continue;
    const g = geom[i]!;
    const relVx = b.vx - b.omega * g.rby - (a.vx - a.omega * g.ray);
    const relVy = b.vy + b.omega * g.rbx - (a.vy + a.omega * g.rax);
    const vt = relVx * tx + relVy * ty;
    const raCrossT = crossVV(g.rax, g.ray, tx, ty);
    const rbCrossT = crossVV(g.rbx, g.rby, tx, ty);
    const effMassT = invSum + raCrossT * raCrossT * a.invInertia + rbCrossT * rbCrossT * b.invInertia;
    if (effMassT <= 0) continue;
    const maxT = Math.abs(jns[i]!) * f;
    jts[i] = Math.max(-maxT, Math.min(maxT, -vt / effMassT / n));
  }
  for (let i = 0; i < n; i++) {
    const jt = jts[i]!;
    if (jt === 0) continue;
    const g = geom[i]!;
    const raCrossT = crossVV(g.rax, g.ray, tx, ty);
    const rbCrossT = crossVV(g.rbx, g.rby, tx, ty);
    a.vx -= jt * tx * a.invMass;
    a.vy -= jt * ty * a.invMass;
    a.omega -= raCrossT * jt * a.invInertia;
    b.vx += jt * tx * b.invMass;
    b.vy += jt * ty * b.invMass;
    b.omega += rbCrossT * jt * b.invInertia;
  }
}

/**
 * Keep a body inside the world box.
 *
 * Position is corrected EXACTLY (no slop) so a settled body reads as resting
 * on the wall, not hovering in it. Impulses land at the touching feature —
 * the deepest corner(s) of a box, the rim point of a circle — which is what
 * gives a tilted box the torque to fall flat and a circle its roll. Corners
 * within an epsilon of each other are averaged: a flat box then contacts at
 * the middle of its face and no phantom torque rocks it.
 */
function resolveBounds(b: Body, bounds: NonNullable<PhysicsWorld['bounds']>): void {
  if (b.invMass === 0) return;

  const walls: Array<{ nx: number; ny: number; support: () => { depth: number; px: number; py: number } | null }> = [
    { nx: 1, ny: 0, support: () => deepestAgainst(b, -1, 0, bounds.left, (p) => bounds.left - p) },
    { nx: -1, ny: 0, support: () => deepestAgainst(b, 1, 0, bounds.right, (p) => p - bounds.right) },
    { nx: 0, ny: 1, support: () => deepestAgainst(b, 0, -1, bounds.top, (p) => bounds.top - p) },
    { nx: 0, ny: -1, support: () => deepestAgainst(b, 0, 1, bounds.bottom, (p) => p - bounds.bottom) },
  ];

  for (const wall of walls) {
    const hit = wall.support();
    if (!hit) continue;

    // Positional correction along the inward normal. EXACT for a non-rotating
    // body — its resting height is then the wall precisely, the behaviour this
    // solver has always had. Slop-and-percent for a rotating one: full
    // correction at a single corner adds potential energy every frame, and a
    // tilted box then rocks forever on the energy the correction pumps in
    // (measured: 2.5 rad/s of permanent rocking before this split).
    const corr = b.invInertia === 0
      ? hit.depth
      : Math.max(hit.depth - SLOP, 0) * PERCENT;
    b.x += wall.nx * corr;
    b.y += wall.ny * corr;

    const rx = hit.px + wall.nx * hit.depth - b.x;
    const ry = hit.py + wall.ny * hit.depth - b.y;
    const relVx = b.vx - b.omega * ry;
    const relVy = b.vy + b.omega * rx;
    const vn = relVx * wall.nx + relVy * wall.ny;
    if (vn >= 0) continue;

    const rCrossN = crossVV(rx, ry, wall.nx, wall.ny);
    const effMass = b.invMass + rCrossN * rCrossN * b.invInertia;
    const jn = (-(1 + b.restitution) * vn) / effMass;
    b.vx += jn * wall.nx * b.invMass;
    b.vy += jn * wall.ny * b.invMass;
    b.omega += rCrossN * jn * b.invInertia;

    if (b.friction <= 0) continue;
    const tx = -wall.ny;
    const ty = wall.nx;
    const relVx2 = b.vx - b.omega * ry;
    const relVy2 = b.vy + b.omega * rx;
    const vt = relVx2 * tx + relVy2 * ty;
    const rCrossT = crossVV(rx, ry, tx, ty);
    const effMassT = b.invMass + rCrossT * rCrossT * b.invInertia;
    let jt = -vt / effMassT;
    const maxT = Math.abs(jn) * b.friction;
    jt = Math.max(-maxT, Math.min(maxT, jt));
    b.vx += jt * tx * b.invMass;
    b.vy += jt * ty * b.invMass;
    b.omega += rCrossT * jt * b.invInertia;
  }
}

/**
 * The body's deepest point(s) against one wall, or null when clear.
 * `outward` is the direction toward the wall; `overshoot` measures how far a
 * coordinate is past it.
 */
function deepestAgainst(
  b: Body,
  outX: number,
  outY: number,
  _wallAt: number,
  overshoot: (coord: number) => number,
): { depth: number; px: number; py: number } | null {
  if (b.shape === 'circle') {
    const px = b.x + outX * radiusOf(b);
    const py = b.y + outY * radiusOf(b);
    const depth = overshoot(outX !== 0 ? px : py);
    return depth > 0 ? { depth, px, py } : null;
  }
  const pts = corners(b);
  // Two passes on purpose. A single find-and-collect loop compared each depth
  // against a running max that STARTED AT ZERO, so a corner 0.9px into the
  // floor was neither "deeper than max + window" nor able to establish the
  // max — shallow contacts returned null, the floor never fired, and a box
  // "rested" on a limit cycle of sinking past 1px and being snapped back.
  let maxDepth = 0;
  for (const p of pts) {
    const d = overshoot(outX !== 0 ? p.x : p.y);
    if (d > maxDepth) maxDepth = d;
  }
  if (maxDepth <= 0) return null;

  // The tie window is 1px, not an epsilon: a 20px box tilted under ~3° has its
  // corner depths within 1px of each other, and averaging those corners is
  // what lets a nearly-flat box contact mid-face and settle instead of
  // pivoting forever on alternating corners.
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (const p of pts) {
    const d = overshoot(outX !== 0 ? p.x : p.y);
    if (d > 0 && d >= maxDepth - 1.0) {
      sx += p.x;
      sy += p.y;
      count++;
    }
  }
  return { depth: maxDepth, px: sx / count, py: sy / count };
}
