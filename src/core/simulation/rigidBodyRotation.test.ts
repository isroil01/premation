/**
 * Rotation.
 *
 * The compatibility assertion is the load-bearing one: rotation is opt-in, and
 * a body that has not opted in must simulate BIT-IDENTICALLY to the solver
 * before rotation existed — a simulation is its history, and a saved project
 * must not replay differently after an update.
 *
 * The behavioural tests assert the physics that makes rotation read as real —
 * a tilted box falls flat, a flat box does not rock, an off-centre hit spins,
 * a circle rolls from friction alone — rather than exact angles, which are
 * solver implementation detail.
 */

import {
  createRigidBodySim,
  DEFAULT_PHYSICS_BODY,
  DEFAULT_PHYSICS_WORLD,
  type BodySeed,
  type PhysicsWorld,
} from './rigidBody';

const FPS = 60;

const seed = (
  id: string, x: number, y: number,
  patch: Partial<BodySeed['cfg']> = {},
  extra: Partial<Pick<BodySeed, 'rotation' | 'width' | 'height'>> = {},
): BodySeed => ({
  id, x, y,
  width: extra.width ?? 20, height: extra.height ?? 20,
  rotation: extra.rotation ?? 0,
  cfg: { ...DEFAULT_PHYSICS_BODY, enabled: true, ...patch },
});

const world = (patch: Partial<PhysicsWorld> = {}): PhysicsWorld => ({ ...DEFAULT_PHYSICS_WORLD, ...patch });

function runTo(seeds: BodySeed[], w: PhysicsWorld, frame: number) {
  const sim = createRigidBodySim(seeds, w, FPS);
  let s = sim.init();
  for (let f = 1; f <= frame; f++) s = sim.step(s, f);
  return s;
}

const byId = (s: { bodies: Array<{ id: string }> }, id: string) =>
  s.bodies.find((b) => b.id === id)! as never as {
    id: string; x: number; y: number; vx: number; vy: number; angle: number; omega: number;
  };

const FLOOR = world({ gravityY: 2000, bounds: { left: -500, top: -600, right: 500, bottom: 100 } });

describe('compatibility — the reason opt-in is safe', () => {
  it('a non-rotating body simulates EXACTLY as before: zero angular state, ever', () => {
    const s = runTo(
      [seed('a', 0, -400, { restitution: 0.6 }), seed('b', 6, -300, { restitution: 0.6 })],
      FLOOR,
      300,
    );
    for (const b of s.bodies) {
      expect((b as { angle: number }).angle).toBe(0);
      expect((b as { omega: number }).omega).toBe(0);
    }
  });

  it('rotate:false and the pre-rotation default are the same config', () => {
    // DEFAULT_PHYSICS_BODY.rotate must stay false: flipping the default would
    // re-simulate every saved scene differently after the update.
    expect(DEFAULT_PHYSICS_BODY.rotate).toBe(false);
  });
});

describe('falling and landing', () => {
  it('a TILTED box falls onto the floor and ends up flat', () => {
    // The corner touches first; the impulse at that corner is the torque that
    // rotates it down. Flat = angle settles near a multiple of 90°.
    const s = runTo(
      [seed('a', 0, -200, { rotate: true, restitution: 0, friction: 0.4 }, { rotation: 25 })],
      FLOOR,
      600,
    );
    const a = byId(s, 'a');
    const deg = ((a.angle * 180) / Math.PI) % 90;
    const offFlat = Math.min(Math.abs(deg), Math.abs(90 - Math.abs(deg)));
    expect(offFlat).toBeLessThan(4);
    expect(Math.abs(a.omega)).toBeLessThan(0.5);
    // …and it rests ON the floor.
    expect(a.y).toBeLessThanOrEqual(100 - 8);
  });

  it('a FLAT box lands without picking up spin', () => {
    // The two bottom corners tie for deepest and are averaged into a mid-face
    // contact, so no phantom torque rocks it — the haunted-table failure.
    const s = runTo(
      [seed('a', 0, -300, { rotate: true, restitution: 0, friction: 0.3 })],
      FLOOR,
      400,
    );
    const a = byId(s, 'a');
    expect(Math.abs(a.angle)).toBeLessThan(0.02);
    // Rotating bodies rest via slop-and-percent correction, which converges to
    // ~1px of standing penetration under gravity — the standard Baumgarte
    // trade, accepted because exact correction at a corner pumps energy and
    // rocks the box instead. Non-rotating bodies still rest at 90 exactly.
    expect(a.y).toBeGreaterThan(89);
    expect(a.y).toBeLessThan(92);
  });

  it('the initial layer rotation seeds the body angle', () => {
    const sim = createRigidBodySim(
      [seed('a', 0, 0, { rotate: true }, { rotation: 45 })],
      world({ gravityY: 0 }),
      FPS,
    );
    expect(byId(sim.init(), 'a').angle).toBeCloseTo(Math.PI / 4, 6);
  });
});

describe('spin from contact', () => {
  it('an off-centre hit makes the target rotate', () => {
    // A moving box strikes the top edge of a resting one: the impulse lands
    // above the centroid, so the target must pick up angular velocity.
    const w = world({ gravityY: 0 });
    const sim = createRigidBodySim(
      [
        seed('mover', -60, -14, { rotate: true, friction: 0 }),
        seed('target', 0, 0, { rotate: true, friction: 0 }, { width: 20, height: 40 }),
      ],
      w,
      FPS,
    );
    let s = sim.init();
    s.bodies.find((b) => b.id === 'mover')!.vx = 300;
    for (let f = 1; f <= 30; f++) s = sim.step(s, f);
    expect(Math.abs(byId(s, 'target').omega)).toBeGreaterThan(0.1);
  });

  it('a CENTRED hit does not spin the target', () => {
    const w = world({ gravityY: 0 });
    const sim = createRigidBodySim(
      [
        seed('mover', -60, 0, { rotate: true, friction: 0 }),
        seed('target', 0, 0, { rotate: true, friction: 0 }),
      ],
      w,
      FPS,
    );
    let s = sim.init();
    s.bodies.find((b) => b.id === 'mover')!.vx = 300;
    for (let f = 1; f <= 30; f++) s = sim.step(s, f);
    expect(Math.abs(byId(s, 'target').omega)).toBeLessThan(1e-6);
  });

  it('a rolling circle: friction converts slide into spin', () => {
    // Launch a circle sideways along the floor. With friction, the contact
    // impulse at the rim is a torque — it must start rotating, and in the
    // direction that rolls it forward (positive vx → positive omega, y-down).
    const s = (() => {
      const sim = createRigidBodySim(
        [seed('ball', -300, 90, { rotate: true, shape: 'circle', restitution: 0, friction: 0.5 })],
        FLOOR,
        FPS,
      );
      let st = sim.init();
      st.bodies[0]!.vx = 400;
      for (let f = 1; f <= 60; f++) st = sim.step(st, f);
      return st;
    })();
    const ball = byId(s, 'ball');
    expect(ball.omega).toBeGreaterThan(1);
  });

  it('without friction, the same circle never spins', () => {
    const s = (() => {
      const sim = createRigidBodySim(
        [seed('ball', -300, 90, { rotate: true, shape: 'circle', restitution: 0, friction: 0 })],
        FLOOR,
        FPS,
      );
      let st = sim.init();
      st.bodies[0]!.vx = 400;
      for (let f = 1; f <= 60; f++) st = sim.step(st, f);
      return st;
    })();
    expect(Math.abs(byId(s, 'ball').omega)).toBeLessThan(1e-6);
  });
});

describe('oriented colliders are real', () => {
  it('a 45° box deflects a falling ball along its slope', () => {
    // A thin bar rotated 45° presents a slope where its AABB presents a flat
    // ledge. A ball dropped onto the slope does what balls on slopes do —
    // slides off down-slope, picking up +x velocity — so the discriminator is
    // DEFLECTION, not stopping: against the unrotated AABB the same drop
    // bounces near-vertically with vx ≈ 0, and through no collider at all it
    // falls straight down. (The first version of this test asserted the ball
    // STOPPED on the bar, which is not what a 45° slope does to a ball.)
    const w = world({ gravityY: 1000 });
    const s = runTo(
      [
        seed('bar', 0, 0, { rotate: true, kind: 'static', friction: 0.2 }, { rotation: 45, width: 120, height: 8 }),
        seed('ball', 20, -120, { rotate: true, shape: 'circle', restitution: 0.2 }),
      ],
      w,
      50,
    );
    const ball = byId(s, 'ball');
    expect(ball.vx).toBeGreaterThan(50);   // pushed down-slope
    expect(ball.x).toBeGreaterThan(40);    // carried well past where it was dropped
  });
});

describe('determinism, with rotation on', () => {
  it('the same history twice is bit-identical', () => {
    const seeds = [
      seed('a', -40, -300, { rotate: true, restitution: 0.5 }, { rotation: 10 }),
      seed('b', 0, -200, { rotate: true, restitution: 0.5 }, { rotation: -20 }),
      seed('c', 30, -260, { rotate: true, shape: 'circle', restitution: 0.5 }),
    ];
    expect(runTo(seeds, FLOOR, 240)).toEqual(runTo(seeds, FLOOR, 240));
  });

  it('declaration order still does not matter', () => {
    const seeds = [
      seed('a', -40, -300, { rotate: true, restitution: 0.4 }, { rotation: 10 }),
      seed('b', 0, -200, { rotate: true, restitution: 0.4 }),
    ];
    const fwd = runTo([seeds[0]!, seeds[1]!], FLOOR, 200);
    const rev = runTo([seeds[1]!, seeds[0]!], FLOOR, 200);
    for (const id of ['a', 'b']) {
      expect(byId(rev, id).x).toBeCloseTo(byId(fwd, id).x, 9);
      expect(byId(rev, id).angle).toBeCloseTo(byId(fwd, id).angle, 9);
    }
  });
});
