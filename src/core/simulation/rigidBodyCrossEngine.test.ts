/**
 * Cross-engine parity of rigid-body layer physics (D2 leftovers): the solver
 * (`rigidBody.ts`), its seek cache (`simulationCore.ts`) and `physicsPosesAt`.
 * The C++ port is `native/engine/src/scene/rigid_body.cpp`, checked against the
 * same frozen fixture by `native/engine/tests/test_rigid_body_parity.cpp`,
 * which must reproduce every pose bit for bit (V8's Math through motion::js).
 *
 * Frames are asked in a deliberately hostile order (backward seeks, a far jump,
 * frame 0 last) — the cache contract is that the answer never depends on it.
 *
 * The fixture is frozen data. `PARITY_WRITE_TS=1` wrote it once from this
 * engine; otherwise this test only checks the TypeScript has not drifted.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { physicsPosesAt, resetPhysicsCaches } from './physicsBodies';
import { DEFAULT_PHYSICS_BODY, DEFAULT_PHYSICS_WORLD, type BodySeed, type PhysicsWorld } from './rigidBody';

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/rigid_body_parity.json');

interface Case {
  name: string;
  fps: number;
  world: PhysicsWorld;
  seeds: BodySeed[];
  frames: number[];
}

const WALLS = { left: 0, top: 0, right: 1920, bottom: 1080 };
const W = (over: Partial<PhysicsWorld> = {}): PhysicsWorld => ({ ...DEFAULT_PHYSICS_WORLD, bounds: WALLS, ...over });
const body = (id: string, x: number, y: number, w: number, h: number, cfg: Partial<BodySeed['cfg']> = {}, rotation = 0): BodySeed => ({
  id, x, y, width: w, height: h, rotation, cfg: { ...DEFAULT_PHYSICS_BODY, enabled: true, ...cfg },
});
const HOSTILE = [120, 10, 45, 1, 200, 61, 0, 299];

const CASES: Case[] = [
  { name: 'box-falls-rests', fps: 30, world: W(), seeds: [body('a', 960, 200, 120, 80)], frames: HOSTILE },
  {
    name: 'tilted-box-tumbles', fps: 30, world: W(),
    seeds: [body('box', 700, 300, 200, 60, { rotate: true, restitution: 0.3, friction: 0.5 }, 25)], frames: HOSTILE,
  },
  {
    name: 'circles-and-wall', fps: 24, world: W({ gravityX: 200 }),
    seeds: [
      body('c1', 400, 500, 90, 90, { shape: 'circle', rotate: true }),
      body('c2', 520, 420, 60, 60, { shape: 'circle', mass: 3, restitution: 0.8 }),
      body('wall', 1200, 700, 80, 700, { kind: 'static' }),
    ],
    frames: HOSTILE,
  },
  {
    name: 'rotating-stack', fps: 60, world: W({ iterations: 8 }),
    seeds: [
      body('s1', 960, 900, 300, 100, { rotate: true, friction: 0.6 }),
      body('s2', 975, 760, 260, 100, { rotate: true, friction: 0.6 }, 4),
      body('s3', 940, 600, 220, 100, { rotate: true, friction: 0.6, mass: 0.5 }, -7),
    ],
    frames: HOSTILE,
  },
  {
    name: 'circle-rolls-on-ramp', fps: 30, world: W({ bounds: null }),
    seeds: [
      body('ramp', 900, 700, 1200, 40, { kind: 'static' }, 12),
      body('ball', 500, 400, 80, 80, { shape: 'circle', rotate: true, friction: 0.9 }),
      body('crate', 1100, 400, 100, 100, { rotate: true, damping: 0.9 }, 45),
    ],
    frames: HOSTILE,
  },
  {
    name: 'no-bounds-free-fall', fps: 25, world: W({ bounds: null, gravityY: -300 }),
    seeds: [body('up', 100, 100, 50, 50, { mass: 0 }), body('b', 300, 100, 10, 10, { shape: 'circle' })],
    frames: [5, 0, 50],
  },
];

describe('rigid-body physics cross-engine fixture', () => {
  it('matches the frozen poses', () => {
    resetPhysicsCaches();
    const rows = CASES.map((c) => ({
      name: c.name,
      fps: c.fps,
      world: c.world,
      seeds: c.seeds.map((s) => ({ id: s.id, x: s.x, y: s.y, rotation: s.rotation ?? 0, width: s.width, height: s.height, cfg: s.cfg })),
      frames: c.frames.map((f) => {
        const poses = physicsPosesAt(c.name, c.seeds, c.world, c.fps, f);
        return {
          frame: f,
          poses: [...poses.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, p]) => ({ id, ...p })),
        };
      }),
    }));
    const text = JSON.stringify({ comment: 'Frozen from rigidBodyCrossEngine.test.ts; checked by test_rigid_body_parity.cpp.', rows });
    if (process.env.PARITY_WRITE_TS === '1') writeFileSync(OUT, text + '\n');
    expect(existsSync(OUT)).toBe(true);
    expect(JSON.parse(readFileSync(OUT, 'utf8'))).toEqual(JSON.parse(text));
    // The fixture exercises spin, rest and walls.
    expect(rows.some((r) => r.frames.some((f) => f.poses.some((p) => p.rotation !== undefined && p.rotation !== 0)))).toBe(true);
  });
});
