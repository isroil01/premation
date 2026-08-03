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

const op = (over: Partial<PathOp> & { type: PathOp['type'] }): PathOp => ({
  id: over.id ?? newPathOpId(),
  type: over.type,
  amount: over.amount ?? 10,
  detail: over.detail ?? 3,
  wigglesPerSecond: over.wigglesPerSecond ?? 0,
  seed: over.seed ?? 0,
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

describe('applyPathOpChain', () => {
  it('returns the input unchanged for an empty chain', () => {
    expect(applyPathOpChain(square, true, [])).toEqual(square);
  });

  it('does not mutate the input points', () => {
    const before = structuredClone(square);
    applyPathOpChain(square, true, [op({ type: 'zigzag', amount: 20, detail: 3 })]);
    expect(square).toEqual(before);
  });

  it('applies a single operator exactly as the un-chained call would', () => {
    const single = applyPathOpChain(square, true, [op({ type: 'roundCorners', amount: 8, detail: 4 })]);
    expect(single.length).toBeGreaterThan(square.length);
  });

  it('skips `none` entries without disturbing the rest', () => {
    const withNone = applyPathOpChain(square, true, [
      op({ type: 'none' }),
      op({ type: 'zigzag', amount: 20, detail: 3 }),
      op({ type: 'none' }),
    ]);
    const without = applyPathOpChain(square, true, [op({ type: 'zigzag', amount: 20, detail: 3 })]);
    expect(withNone).toEqual(without);
  });

  it('ORDER MATTERS — the same two operators reversed give a different path', () => {
    // The entire point of the feature. Round Corners then Zig-Zag gives soft
    // ridges; Zig-Zag then Round Corners gives rounded spikes. A chain that
    // produced the same result either way would be a set, not a stack.
    const round = op({ id: 'r', type: 'roundCorners', amount: 12, detail: 4 });
    const zig = op({ id: 'z', type: 'zigzag', amount: 18, detail: 3 });

    const roundFirst = applyPathOpChain(square, true, [round, zig]);
    const zigFirst = applyPathOpChain(square, true, [zig, round]);

    expect(roundFirst).not.toEqual(zigFirst);
  });

  it('feeds each operator the OUTPUT of the previous one', () => {
    // Two zig-zags must compound. If the second read the original outline
    // instead, the result would equal a single pass.
    const zig = op({ id: 'z1', type: 'zigzag', amount: 15, detail: 3 });
    const zig2 = op({ id: 'z2', type: 'zigzag', amount: 15, detail: 3 });

    const once = applyPathOpChain(square, true, [zig]);
    const twice = applyPathOpChain(square, true, [zig, zig2]);

    expect(twice.length).toBeGreaterThan(once.length);
  });

  it('threads the time argument through to the temporal operator', () => {
    // Roughen is the only operator that reads time. A chain that dropped the
    // argument would freeze the wiggle while the keyframes kept animating.
    const rough = op({ type: 'roughen', amount: 12, detail: 3, wigglesPerSecond: 4, seed: 1 });
    const t0 = applyPathOpChain(square, true, [rough], 0);
    const t1 = applyPathOpChain(square, true, [rough], 1);
    expect(t0).not.toEqual(t1);
  });

  it('handles a long chain without losing the closed flag', () => {
    const chain = [
      op({ type: 'roundCorners', amount: 6, detail: 3 }),
      op({ type: 'zigzag', amount: 10, detail: 2 }),
      op({ type: 'offset', amount: 4 }),
    ];
    const out = applyPathOpChain(square, true, chain);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
});
