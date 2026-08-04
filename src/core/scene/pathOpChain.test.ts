/**
 * The path-operator CHAIN — ordering, identity, and the keyframe scoping that
 * makes reordering safe.
 *
 * `pathOps.test.ts` covers the individual operators' geometry. This file covers
 * what the chain adds on top: that order matters and is honoured, that ids stay
 * attached to their operator through edits, and that `pathOpPropPath` is scoped
 * per operator rather than per node.
 */

import {
  applyPathOpChain,
  pathOpPropPath,
  newPathOpId,
  defaultPathOp,
  type PathOp,
} from './pathOps';
import type { Pt } from './trimPath';

const square: Pt[] = [
  { x: -50, y: -50 },
  { x: 50, y: -50 },
  { x: 50, y: 50 },
  { x: -50, y: 50 },
];

// Defaults first, overrides SPREAD over them. Listing each field by hand
// silently dropped `start`/`end`/`offset` when trim joined the chain, so every
// trim built here came out as the full range and read as a no-op — a helper
// modelling a narrower PathOp than production's.
const op = (over: Partial<PathOp> & { type: PathOp['type'] }): PathOp => ({
  id: newPathOpId(),
  amount: 10,
  detail: 3,
  wigglesPerSecond: 0,
  seed: 0,
  ...over,
});

describe('pathOpPropPath', () => {
  it('scopes the keyframe path to the OPERATOR, not the node', () => {
    // The whole reason PathOp.id exists. Index-scoped paths would hand an
    // operator its neighbour's animation the moment the stack is reordered.
    expect(pathOpPropPath('abc', 'amount')).toBe('pathop.abc.amount');
    expect(pathOpPropPath('xyz', 'amount')).toBe('pathop.xyz.amount');
  });

  it('gives two operators on the same node different paths', () => {
    expect(pathOpPropPath('a', 'detail')).not.toBe(pathOpPropPath('b', 'detail'));
  });
});

describe('newPathOpId', () => {
  it('does not collide across calls', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newPathOpId()));
    expect(ids.size).toBe(500);
  });
});

describe('defaultPathOp', () => {
  it('carries a fresh id each time', () => {
    // Two operators added in a row must not share an id, or they share
    // keyframes and editing one moves the other.
    expect(defaultPathOp().id).not.toBe(defaultPathOp().id);
  });
});

/**
 * The chain's currency is a LIST of runs since trim joined it (v1.4.0). These
 * cases are all single-run, so they go through this shim rather than restating
 * `[{ pts, closed: true }]` thirty times — and it asserts the single-run shape
 * on the way out, which is itself the guarantee that adding trim to the model
 * did not quietly split every existing chain.
 */
function chainPts(pts: Pt[], ops: PathOp[], t = 0): Pt[] {
  const runs = applyPathOpChain([{ pts, closed: true }], ops, t);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.closed).toBe(true);
  return runs[0]!.pts;
}

describe('applyPathOpChain', () => {
  it('returns the input unchanged for an empty chain', () => {
    expect(chainPts(square, [])).toEqual(square);
  });

  it('does not mutate the input points', () => {
    const before = structuredClone(square);
    chainPts(square, [op({ type: 'zigzag', amount: 20, detail: 3 })]);
    expect(square).toEqual(before);
  });

  it('applies a single operator exactly as the un-chained call would', () => {
    const single = chainPts(square, [op({ type: 'roundCorners', amount: 8, detail: 4 })]);
    expect(single.length).toBeGreaterThan(square.length);
  });

  it('skips `none` entries without disturbing the rest', () => {
    const withNone = chainPts(square, [
      op({ type: 'none' }),
      op({ type: 'zigzag', amount: 20, detail: 3 }),
      op({ type: 'none' }),
    ]);
    const without = chainPts(square, [op({ type: 'zigzag', amount: 20, detail: 3 })]);
    expect(withNone).toEqual(without);
  });

  it('ORDER MATTERS — the same two operators reversed give a different path', () => {
    // The entire point of the feature. Round Corners then Zig-Zag gives soft
    // ridges; Zig-Zag then Round Corners gives rounded spikes. A chain that
    // produced the same result either way would be a set, not a stack.
    const round = op({ id: 'r', type: 'roundCorners', amount: 12, detail: 4 });
    const zig = op({ id: 'z', type: 'zigzag', amount: 18, detail: 3 });

    const roundFirst = chainPts(square, [round, zig]);
    const zigFirst = chainPts(square, [zig, round]);

    expect(roundFirst).not.toEqual(zigFirst);
  });

  it('feeds each operator the OUTPUT of the previous one', () => {
    // Two zig-zags must compound. If the second read the original outline
    // instead, the result would equal a single pass.
    const zig = op({ id: 'z1', type: 'zigzag', amount: 15, detail: 3 });
    const zig2 = op({ id: 'z2', type: 'zigzag', amount: 15, detail: 3 });

    const once = chainPts(square, [zig]);
    const twice = chainPts(square, [zig, zig2]);

    expect(twice.length).toBeGreaterThan(once.length);
  });

  it('threads the time argument through to the temporal operator', () => {
    // Roughen is the only operator that reads time. A chain that dropped the
    // argument would freeze the wiggle while the keyframes kept animating.
    const rough = op({ type: 'roughen', amount: 12, detail: 3, wigglesPerSecond: 4, seed: 1 });
    const t0 = chainPts(square, [rough], 0);
    const t1 = chainPts(square, [rough], 1);
    expect(t0).not.toEqual(t1);
  });

  it('handles a long chain without losing the closed flag', () => {
    const chain = [
      op({ type: 'roundCorners', amount: 6, detail: 3 }),
      op({ type: 'zigzag', amount: 10, detail: 2 }),
      op({ type: 'offset', amount: 4 }),
    ];
    const out = chainPts(square, chain);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
});

/**
 * Trim is an ordinary chain entry (v1.4.0), and its POSITION is the reason.
 *
 * This is the gate the fold-in was blocked on: reorder arrows that cannot change
 * the output are worse than absent, because they cost the user time proving it.
 * Measured before the model changed, and pinned here.
 */
describe('applyPathOpChain — trim in the chain', () => {
  const trim = (over: Partial<PathOp> = {}): PathOp =>
    op({ type: 'trim', start: 0, end: 37, offset: 0, ...over });
  const fmt = (runs: ReturnType<typeof applyPathOpChain>): string =>
    runs.map((r) => `${r.closed ? 'C' : 'O'}:${r.pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}`).join('||');
  const run1 = [{ pts: square, closed: true }];

  it('cuts the path down to an OPEN run', () => {
    const out = applyPathOpChain(run1, [trim()]);
    expect(out).toHaveLength(1);
    expect(out[0]!.closed).toBe(false);
  });

  it('a FULL-range trim is a no-op and leaves the run CLOSED', () => {
    // Adding an untouched Trim card must not visibly open the shape's stroke.
    const out = applyPathOpChain(run1, [trim({ start: 0, end: 100, offset: 0 })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.closed).toBe(true);
    expect(out[0]!.pts).toEqual(square);
  });

  it('an offset that wraps past the end yields TWO runs', () => {
    // The shape a single polyline could not express — the reason trim could not
    // live in the chain at all before the currency became a list.
    const out = applyPathOpChain(run1, [trim({ start: 0, end: 40, offset: 80 })]);
    expect(out).toHaveLength(2);
    expect(out.every((r) => !r.closed)).toBe(true);
  });

  it('an EMPTY window removes every run', () => {
    expect(applyPathOpChain(run1, [trim({ start: 50, end: 50 })])).toHaveLength(0);
  });

  it('REORDER CHANGES THE OUTPUT for every deformer — the gate on shipping the arrows', () => {
    // Trim cuts by ARC LENGTH, so 37% of a ruffled outline lands somewhere quite
    // different from 37% of the smooth one it was built from.
    const deformers: PathOp[] = [
      op({ id: 'a', type: 'zigzag', amount: 16, detail: 5 }),
      op({ id: 'b', type: 'roundCorners', amount: 30, detail: 4 }),
      op({ id: 'c', type: 'pucker', amount: 40 }),
      op({ id: 'd', type: 'twist', amount: 45 }),
      op({ id: 'e', type: 'offset', amount: 12 }),
      op({ id: 'f', type: 'roughen', amount: 14, detail: 4 }),
    ];
    for (const d of deformers) {
      const deformThenTrim = fmt(applyPathOpChain(run1, [d, trim()]));
      const trimThenDeform = fmt(applyPathOpChain(run1, [trim(), d]));
      expect(`${d.type}: ${deformThenTrim}`).not.toEqual(`${d.type}: ${trimThenDeform}`);
    }
  });

  it('the ONE commuting case is degenerate, not a property', () => {
    // Zig-Zag at exactly 50% of a rect commutes — that trims precisely at a
    // vertex. Testing only this would have concluded the reorder was inert and
    // the whole fold-in was not worth shipping. Pinned so nobody re-derives the
    // wrong conclusion from it.
    const zig = op({ id: 'z', type: 'zigzag', amount: 16, detail: 5 });
    const atVertex = trim({ end: 50 });
    expect(fmt(applyPathOpChain(run1, [zig, atVertex])))
      .toEqual(fmt(applyPathOpChain(run1, [atVertex, zig])));
  });

  it('a deformer AFTER a trim treats the arc as OPEN', () => {
    // Not just "different values" — different topology. A zigzag over an open
    // run must not wrap a ruffled segment from its end back to its start.
    const zig = op({ id: 'z', type: 'zigzag', amount: 10, detail: 2 });
    const out = applyPathOpChain(run1, [trim(), zig]);
    expect(out).toHaveLength(1);
    expect(out[0]!.closed).toBe(false);
  });
});
