/**
 * Wiggle Transform — the chain-level operator that gives each RUN one
 * smoothly-varying random affine transform (AE's shape operator of the same
 * name).
 *
 * The geometry contracts here mirror Roughen's ("Size is the most it can
 * move", determinism, phase-0 static), plus the two things only a chain-level
 * operator can promise: that runs are independent (which is what makes
 * Repeater → Wiggle Transform a swarm), and that correlation dials them back
 * into one body.
 *
 * Also holds the regression for `resolveOne` dropping fields: `correlation`
 * never survived `resolvePathOps` before this operator landed — the inspector
 * control worked in unit tests (which call `roughen()` directly) and did
 * nothing in the render path (which resolves the chain first).
 */

import {
  applyPathOpChain,
  defaultWiggleTransformOp,
  defaultPathOpOf,
  newPathOpId,
  pathOpPropPath,
  readPathOps,
  resolvePathOps,
  type PathOp,
  type PolyRun,
} from './pathOps';
import type { Pt } from './trimPath';
import type { SceneNode } from '@core/types';

const square: Pt[] = [
  { x: -50, y: -50 },
  { x: 50, y: -50 },
  { x: 50, y: 50 },
  { x: -50, y: 50 },
];

const run = (pts: Pt[] = square): PolyRun => ({ pts: pts.map((p) => ({ ...p })), closed: true });

const wt = (over: Partial<PathOp> = {}): PathOp => ({
  id: newPathOpId(),
  type: 'wiggleTransform',
  amount: 10,
  detail: 0,
  wigglesPerSecond: 0,
  seed: 0,
  correlation: 0,
  wiggleRotation: 0,
  wiggleScale: 0,
  anchorX: 0,
  anchorY: 0,
  ...over,
});

/** A node carrying a stored chain — the only shape `readPathOps` touches. */
const nodeWith = (ops: unknown[]): SceneNode =>
  ({ components: [{ type: 'fx', props: { pathOps: ops } }] } as unknown as SceneNode);

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

describe('determinism', () => {
  it('is a pure function of (runs, op, time)', () => {
    const op = wt({ amount: 8, wiggleRotation: 20, wiggleScale: 15, wigglesPerSecond: 3, seed: 7 });
    const a = applyPathOpChain([run()], [op], 1.234);
    const b = applyPathOpChain([run()], [op], 1.234);
    expect(a).toEqual(b);
  });

  it('different seeds decorrelate two layers', () => {
    const a = applyPathOpChain([run()], [wt({ seed: 1 })], 0);
    const b = applyPathOpChain([run()], [wt({ seed: 2 })], 0);
    expect(a[0]!.pts[0]).not.toEqual(b[0]!.pts[0]);
  });

  it('wigglesPerSecond 0 is static across time', () => {
    const op = wt({ amount: 12 });
    const a = applyPathOpChain([run()], [op], 0);
    const b = applyPathOpChain([run()], [op], 9.75);
    expect(a).toEqual(b);
  });

  it('wigglesPerSecond > 0 actually moves over time', () => {
    const op = wt({ amount: 12, wigglesPerSecond: 2 });
    const a = applyPathOpChain([run()], [op], 0);
    const b = applyPathOpChain([run()], [op], 0.4);
    expect(a[0]!.pts[0]).not.toEqual(b[0]!.pts[0]);
  });
});

describe('amplitude contracts', () => {
  it('position wiggle never displaces further than amount per axis, at any phase', () => {
    const op = wt({ amount: 6, wigglesPerSecond: 5 });
    for (const t of [0, 0.13, 0.5, 1.9, 3.33]) {
      const out = applyPathOpChain([run()], [op], t)[0]!;
      out.pts.forEach((p, i) => {
        expect(Math.abs(p.x - square[i]!.x)).toBeLessThanOrEqual(6 + 1e-9);
        expect(Math.abs(p.y - square[i]!.y)).toBeLessThanOrEqual(6 + 1e-9);
      });
    }
  });

  it('a translation-only wiggle is rigid: every vertex moves by the same delta', () => {
    const out = applyPathOpChain([run()], [wt({ amount: 10 })], 0)[0]!;
    const dx = out.pts[0]!.x - square[0]!.x;
    const dy = out.pts[0]!.y - square[0]!.y;
    out.pts.forEach((p, i) => {
      expect(p.x - square[i]!.x).toBeCloseTo(dx, 9);
      expect(p.y - square[i]!.y).toBeCloseTo(dy, 9);
    });
  });

  it('rotation-only wiggle pivots on the anchor: the anchor point itself stays fixed', () => {
    const op = wt({ amount: 0, wiggleRotation: 45, anchorX: -50, anchorY: -50 });
    const out = applyPathOpChain([run()], [op], 0)[0]!;
    // The vertex AT the anchor does not move; the far corner keeps its
    // distance to the anchor (a rotation, not a shear).
    expect(out.pts[0]!.x).toBeCloseTo(-50, 9);
    expect(out.pts[0]!.y).toBeCloseTo(-50, 9);
    expect(dist(out.pts[2]!, { x: -50, y: -50 })).toBeCloseTo(dist(square[2]!, { x: -50, y: -50 }), 9);
  });

  it('scale wiggle carries into strokeScale, compounding what the run already had', () => {
    const runs: PolyRun[] = [{ ...run(), strokeScale: 2 }];
    const out = applyPathOpChain(runs, [wt({ amount: 0, wiggleScale: 50 })], 0)[0]!;
    const factor = dist(out.pts[0]!, out.pts[1]!) / dist(square[0]!, square[1]!);
    expect(out.strokeScale).toBeCloseTo(2 * factor, 9);
  });

  it('preserves a run opacity set by an upstream repeater', () => {
    const runs: PolyRun[] = [{ ...run(), opacity: 0.5 }];
    const out = applyPathOpChain(runs, [wt({ amount: 10 })], 0)[0]!;
    expect(out.opacity).toBe(0.5);
  });
});

describe('runs and correlation — the chain-level payoff', () => {
  const twoRuns = (): PolyRun[] => [run(), run()];

  it('correlation 0: each run takes its own transform', () => {
    const out = applyPathOpChain(twoRuns(), [wt({ amount: 10, correlation: 0 })], 0);
    const d0 = { x: out[0]!.pts[0]!.x - square[0]!.x, y: out[0]!.pts[0]!.y - square[0]!.y };
    const d1 = { x: out[1]!.pts[0]!.x - square[0]!.x, y: out[1]!.pts[0]!.y - square[0]!.y };
    expect(d0).not.toEqual(d1);
  });

  it('correlation 100: every run takes the identical transform', () => {
    const out = applyPathOpChain(twoRuns(), [wt({ amount: 10, wiggleRotation: 30, wiggleScale: 20, correlation: 100 })], 0);
    expect(out[0]!.pts).toEqual(out[1]!.pts);
  });

  it('after a Repeater, copies wander independently; before it, the ladder moves as one body', () => {
    const rep = defaultPathOpOf('repeater');
    const repOp: PathOp = { ...rep, copies: 3, offsetX: 200, offsetY: 0 };
    const wiggle = wt({ amount: 10 });

    // Repeater → Wiggle: the copies' pairwise offsets are perturbed.
    const swarm = applyPathOpChain([run()], [repOp, wiggle], 0);
    const gap01 = dist(swarm[0]!.pts[0]!, swarm[1]!.pts[0]!);
    const gap12 = dist(swarm[1]!.pts[0]!, swarm[2]!.pts[0]!);
    expect(Math.abs(gap01 - gap12)).toBeGreaterThan(1e-6);

    // Wiggle → Repeater: one run wiggles, THEN is copied — the ladder is rigid.
    const body = applyPathOpChain([run()], [wiggle, repOp], 0);
    const g01 = dist(body[0]!.pts[0]!, body[1]!.pts[0]!);
    const g12 = dist(body[1]!.pts[0]!, body[2]!.pts[0]!);
    expect(g01).toBeCloseTo(g12, 9);
  });
});

describe('resolution and storage', () => {
  it('an all-zero-amplitude Wiggle Transform is dropped as inert', () => {
    const node = nodeWith([wt({ amount: 0, wiggleRotation: 0, wiggleScale: 0 })]);
    expect(resolvePathOps(node, undefined)).toHaveLength(0);
  });

  it('the default operator is live, not inert', () => {
    const node = nodeWith([defaultWiggleTransformOp()]);
    expect(resolvePathOps(node, undefined)).toHaveLength(1);
  });

  it('stored wiggle fields survive the read (coercion keeps them)', () => {
    const stored = wt({ amount: 4, wiggleRotation: 33, wiggleScale: 12, correlation: 80 });
    const [read] = readPathOps(nodeWith([stored]));
    expect(read!.wiggleRotation).toBe(33);
    expect(read!.wiggleScale).toBe(12);
    expect(read!.correlation).toBe(80);
  });

  it('REGRESSION: correlation survives resolvePathOps (it used to be dropped)', () => {
    const node = nodeWith([wt({ correlation: 80 })]);
    const [resolved] = resolvePathOps(node, undefined);
    expect(resolved!.correlation).toBe(80);
  });

  it('samples animated wiggle params from the value map', () => {
    const op = wt({ amount: 1 });
    const node = nodeWith([op]);
    const av = new Map<string, number>([
      [pathOpPropPath(op.id, 'wiggleRotation'), 25],
      [pathOpPropPath(op.id, 'wiggleScale'), 40],
      [pathOpPropPath(op.id, 'correlation'), 66],
    ]);
    const [resolved] = resolvePathOps(node, av);
    expect(resolved!.wiggleRotation).toBe(25);
    expect(resolved!.wiggleScale).toBe(40);
    expect(resolved!.correlation).toBe(66);
  });

  it('clamps a keyframe that dips an amplitude below zero', () => {
    const op = wt({ amount: 1 });
    const node = nodeWith([op]);
    const av = new Map<string, number>([[pathOpPropPath(op.id, 'wiggleRotation'), -30]]);
    const [resolved] = resolvePathOps(node, av);
    expect(resolved!.wiggleRotation).toBe(0);
  });
});
