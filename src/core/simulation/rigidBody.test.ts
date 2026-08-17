/**
 * The rigid-body solver.
 *
 * Physics fails in ways that look like physics: a stack that slowly sinks, a
 * box that launches sideways out of a shallow overlap, a body that settles at
 * the wrong frame rate. So most of these assert CONSERVED properties and
 * invariants rather than exact positions — the positions are an implementation
 * detail, the invariants are the contract.
 *
 * The determinism tests are the load-bearing ones. This runs under
 * `SimulationCache`, whose whole reason for existing is that `stateAt(f)` must
 * not depend on the order frames were requested in — a preview and an export
 * that disagree is the failure this codebase calls disqualifying.
 */

import { createRigidBodySim, DEFAULT_PHYSICS_BODY, DEFAULT_PHYSICS_WORLD, type BodySeed, type PhysicsWorld } from './rigidBody';
import { SimulationCache } from './simulationCore';

const FPS = 60;

const seed = (id: string, x: number, y: number, patch: Partial<BodySeed['cfg']> = {}, size = 20): BodySeed => ({
  id, x, y, width: size, height: size,
  cfg: { ...DEFAULT_PHYSICS_BODY, enabled: true, ...patch },
});

const world = (patch: Partial<PhysicsWorld> = {}): PhysicsWorld => ({ ...DEFAULT_PHYSICS_WORLD, ...patch });

/** Run to `frame` by plain stepping — the reference history. */
function runTo(seeds: BodySeed[], w: PhysicsWorld, frame: number) {
  const sim = createRigidBodySim(seeds, w, FPS);
  let s = sim.init();
  for (let f = 1; f <= frame; f++) s = sim.step(s, f);
  return s;
}

const byId = (s: { bodies: Array<{ id: string }> }, id: string) =>
  s.bodies.find((b) => b.id === id)! as never as { id: string; x: number; y: number; vx: number; vy: number };

describe('integration', () => {
  it('a dynamic body falls under gravity', () => {
    const s = runTo([seed('a', 0, 0)], world({ gravityY: 1000 }), 30);
    expect(byId(s, 'a').y).toBeGreaterThan(0);
  });

  it('a static body does not move, whatever the gravity', () => {
    const s = runTo([seed('a', 0, 0, { kind: 'static' })], world({ gravityY: 5000 }), 60);
    expect(byId(s, 'a').y).toBe(0);
    expect(byId(s, 'a').vy).toBe(0);
  });

  it('a zero or negative mass is treated as 1, not as a division by zero', () => {
    const s = runTo([seed('a', 0, 0, { mass: 0 }), seed('b', 0, 0, { mass: -5 })], world(), 10);
    expect(Number.isFinite(byId(s, 'a').y)).toBe(true);
    expect(Number.isFinite(byId(s, 'b').y)).toBe(true);
  });

  it('damping is per SECOND, so the frame rate does not change the motion', () => {
    // A per-frame multiplier would make a 60fps render settle twice as fast as
    // a 30fps one — a preview and an export that disagree.
    const w = world({ gravityY: 1000, bounds: null });
    const at30 = (() => {
      const sim = createRigidBodySim([seed('a', 0, 0, { damping: 0.5 })], w, 30);
      let s = sim.init();
      for (let f = 1; f <= 30; f++) s = sim.step(s, f);
      return byId(s, 'a').y;
    })();
    const at60 = (() => {
      const sim = createRigidBodySim([seed('a', 0, 0, { damping: 0.5 })], w, 60);
      let s = sim.init();
      for (let f = 1; f <= 60; f++) s = sim.step(s, f);
      return byId(s, 'a').y;
    })();
    // One second of simulation either way; the integrator differs slightly, so
    // this is a closeness check, not equality.
    expect(Math.abs(at30 - at60) / Math.max(1, at30)).toBeLessThan(0.05);
  });
});

describe('world bounds', () => {
  const floor = world({ gravityY: 2000, bounds: { left: -500, top: -500, right: 500, bottom: 100 } });

  it('a falling body comes to rest ON the floor, not through it', () => {
    const s = runTo([seed('a', 0, -400, { restitution: 0 })], floor, 240);
    // Half-height 10, floor at 100.
    expect(byId(s, 'a').y).toBeCloseTo(90, 1);
  });

  it('does not sink over time once settled', () => {
    // Sinking is the classic symptom of positional correction fighting gravity.
    const a = runTo([seed('a', 0, -400, { restitution: 0 })], floor, 240);
    const b = runTo([seed('a', 0, -400, { restitution: 0 })], floor, 600);
    expect(byId(b, 'a').y).toBeCloseTo(byId(a, 'a').y, 3);
  });

  it('a bouncy body rebounds, a dead one does not', () => {
    const bouncy = runTo([seed('a', 0, -400, { restitution: 0.9 })], floor, 70);
    const dead = runTo([seed('a', 0, -400, { restitution: 0 })], floor, 70);
    expect(byId(bouncy, 'a').vy).toBeLessThan(byId(dead, 'a').vy);
  });

  it('no body ever leaves the bounds', () => {
    const seeds = Array.from({ length: 8 }, (_, i) => seed(`b${i}`, i * 12 - 40, -300 + i * 7, { restitution: 0.6 }));
    const s = runTo(seeds, floor, 400);
    for (const b of s.bodies) {
      expect(b.x).toBeGreaterThanOrEqual(-500 - 1e-6);
      expect(b.x).toBeLessThanOrEqual(500 + 1e-6);
      expect(b.y).toBeLessThanOrEqual(100 + 1e-6);
    }
  });

  it('without bounds a body keeps falling, so things can leave the shot', () => {
    const s = runTo([seed('a', 0, 0)], world({ gravityY: 2000, bounds: null }), 300);
    expect(byId(s, 'a').y).toBeGreaterThan(1000);
  });
});

describe('collisions', () => {
  it('two overlapping circles push apart', () => {
    const w = world({ gravityY: 0 });
    const s = runTo([seed('a', 0, 0, { shape: 'circle' }), seed('b', 5, 0, { shape: 'circle' })], w, 20);
    expect(Math.abs(byId(s, 'b').x - byId(s, 'a').x)).toBeGreaterThan(15);
  });

  it('two overlapping boxes push apart along the SHALLOW axis', () => {
    // Separating along the deep axis would shove a body the long way out and
    // read as a launch.
    const w = world({ gravityY: 0 });
    const seeds = [seed('a', 0, 0), seed('b', 18, 4)]; // overlap 2 in x, 16 in y
    const s = runTo(seeds, w, 5);
    // Pushed apart in x; y barely moved.
    expect(byId(s, 'b').x - byId(s, 'a').x).toBeGreaterThan(18);
    expect(Math.abs(byId(s, 'b').y - byId(s, 'a').y)).toBeCloseTo(4, 0);
  });

  it('a light body moves more than a heavy one', () => {
    const w = world({ gravityY: 0 });
    const s = runTo([seed('a', 0, 0, { mass: 100 }), seed('b', 5, 0, { mass: 1 })], w, 10);
    expect(Math.abs(byId(s, 'b').x - 5)).toBeGreaterThan(Math.abs(byId(s, 'a').x - 0));
  });

  it('a dynamic body cannot push a static one', () => {
    const w = world({ gravityY: 0 });
    const s = runTo([seed('wall', 0, 0, { kind: 'static' }), seed('ball', 5, 0)], w, 20);
    expect(byId(s, 'wall').x).toBe(0);
    expect(byId(s, 'ball').x).toBeGreaterThan(5);
  });

  it('two static bodies are left alone', () => {
    const w = world({ gravityY: 0 });
    const s = runTo([seed('a', 0, 0, { kind: 'static' }), seed('b', 5, 0, { kind: 'static' })], w, 20);
    expect(byId(s, 'a').x).toBe(0);
    expect(byId(s, 'b').x).toBe(5);
  });

  it('perfectly coincident circles separate instead of producing NaN', () => {
    const w = world({ gravityY: 0 });
    const s = runTo([seed('a', 0, 0, { shape: 'circle' }), seed('b', 0, 0, { shape: 'circle' })], w, 10);
    for (const b of s.bodies) {
      expect(Number.isFinite(b.x)).toBe(true);
      expect(Number.isFinite(b.y)).toBe(true);
    }
    expect(Math.abs(byId(s, 'b').x - byId(s, 'a').x)).toBeGreaterThan(0);
  });

  it('separating bodies are not sucked back together', () => {
    // Applying an impulse when the relative velocity is already separating
    // would pull them in — an attractive force from a collision solver.
    const w = world({ gravityY: 0 });
    const sim = createRigidBodySim([seed('a', 0, 0), seed('b', 25, 0)], w, FPS);
    const s = sim.init();
    s.bodies[0]!.vx = -100;
    s.bodies[1]!.vx = 100;
    let cur = s;
    for (let f = 1; f <= 10; f++) cur = sim.step(cur, f);
    expect(byId(cur, 'a').vx).toBeLessThan(0);
    expect(byId(cur, 'b').vx).toBeGreaterThan(0);
  });

  it('a stack of boxes settles without sinking through each other', () => {
    const w = world({ gravityY: 2000, bounds: { left: -200, top: -600, right: 200, bottom: 0 }, iterations: 8 });
    const seeds = [seed('a', 0, -100, { restitution: 0 }), seed('b', 0, -140, { restitution: 0 }), seed('c', 0, -180, { restitution: 0 })];
    const s = runTo(seeds, w, 400);
    const ys = s.bodies.map((b) => b.y).sort((p, q) => p - q);
    // Three 20px boxes stacked on a floor at y=0: centres near -50, -30, -10.
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]! - ys[i - 1]!).toBeGreaterThan(15);
    }
    expect(ys[ys.length - 1]!).toBeCloseTo(-10, 0);
  });
});

describe('determinism — the SimulationCache contract', () => {
  const w = world({ gravityY: 1500, bounds: { left: -300, top: -300, right: 300, bottom: 200 } });
  const seeds = [
    seed('a', -50, -200, { restitution: 0.5 }),
    seed('b', 0, -150, { restitution: 0.5 }),
    seed('c', 40, -180, { restitution: 0.5 }),
  ];

  it('the same history produces bit-identical state', () => {
    expect(runTo(seeds, w, 120)).toEqual(runTo(seeds, w, 120));
  });

  it('a hostile access order matches plain stepping', () => {
    // Scrub forward, jump back, play on — each must equal stepping from 0.
    const cache = new SimulationCache(createRigidBodySim(seeds, w, FPS), { snapshotInterval: 10 });
    cache.stateAt(90);
    cache.stateAt(5);
    cache.stateAt(60);
    const scrubbed = cache.stateAt(120);
    expect(scrubbed).toEqual(runTo(seeds, w, 120));
  });

  it('body order does not depend on the order layers were declared', () => {
    // Resolution order is fixed by id, so authoring the same scene in a
    // different order cannot change the outcome.
    const forward = runTo([seeds[0]!, seeds[1]!, seeds[2]!], w, 120);
    const reversed = runTo([seeds[2]!, seeds[1]!, seeds[0]!], w, 120);
    for (const id of ['a', 'b', 'c']) {
      expect(byId(reversed, id).x).toBeCloseTo(byId(forward, id).x, 9);
      expect(byId(reversed, id).y).toBeCloseTo(byId(forward, id).y, 9);
    }
  });

  it('clone is deep, so a snapshot cannot be corrupted by later stepping', () => {
    const sim = createRigidBodySim(seeds, w, FPS);
    const s0 = sim.init();
    const snap = sim.clone(s0);
    let cur = s0;
    for (let f = 1; f <= 30; f++) cur = sim.step(cur, f);
    expect(snap.bodies[0]!.y).toBe(seeds[0]!.y);
  });
});
