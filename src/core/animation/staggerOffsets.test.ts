import {
  clampOffsetsToStart,
  quantizeOffsets,
  staggerOffsets,
  STAGGER_MODES,
  type StaggerMode,
} from './staggerOffsets';

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

describe('staggerOffsets — degenerate input', () => {
  it('returns nothing for no rows', () => {
    expect(staggerOffsets(0, { mode: 'cascade', step: 1 })).toEqual([]);
  });
  it('is flat for a single row', () => {
    expect(staggerOffsets(1, { mode: 'cascade', step: 1 })).toEqual([0]);
  });
  it('is flat for a zero step, whatever the mode', () => {
    for (const { id } of STAGGER_MODES) {
      expect(staggerOffsets(5, { mode: id, step: 0 })).toEqual([0, 0, 0, 0, 0]);
    }
  });
});

describe('staggerOffsets — cascade', () => {
  it('steps one row at a time', () => {
    expect(staggerOffsets(4, { mode: 'cascade', step: 0.5 })).toEqual([0, 0.5, 1, 1.5]);
  });
  it('runs backwards on a negative step', () => {
    expect(staggerOffsets(3, { mode: 'cascade', step: -1 })).toEqual([0, -1, -2]);
  });
  it('reverse walks the rows bottom-up', () => {
    expect(staggerOffsets(4, { mode: 'cascade', step: 1, reverse: true })).toEqual([3, 2, 1, 0]);
  });
});

describe('staggerOffsets — zigzag', () => {
  it('alternates at constant amplitude', () => {
    expect(staggerOffsets(5, { mode: 'zigzag', step: 2 })).toEqual([0, 2, 0, 2, 0]);
  });
  it('does not grow with the row count', () => {
    const wide = staggerOffsets(20, { mode: 'zigzag', step: 1 });
    expect(Math.max(...wide)).toBe(1);
    expect(Math.min(...wide)).toBe(0);
  });
});

describe('staggerOffsets — center', () => {
  it('fans out symmetrically from the middle of an odd selection', () => {
    expect(staggerOffsets(5, { mode: 'center', step: 1 })).toEqual([2, 1, 0, 1, 2]);
  });
  it('splits the middle on an even selection', () => {
    expect(staggerOffsets(4, { mode: 'center', step: 1 })).toEqual([1.5, 0.5, 0.5, 1.5]);
  });
});

describe('staggerOffsets — wave', () => {
  it('starts and ends at zero and swings both ways', () => {
    const w = staggerOffsets(9, { mode: 'wave', step: 1 });
    expect(near(w[0]!, 0)).toBe(true);
    expect(near(w[8]!, 0)).toBe(true);
    expect(Math.max(...w)).toBeGreaterThan(0);
    expect(Math.min(...w)).toBeLessThan(0);
  });
  it('scales its amplitude with the selection size', () => {
    const small = Math.max(...staggerOffsets(5, { mode: 'wave', step: 1 }));
    const large = Math.max(...staggerOffsets(21, { mode: 'wave', step: 1 }));
    expect(large).toBeGreaterThan(small);
  });
});

describe('staggerOffsets — random', () => {
  it('is deterministic for a seed', () => {
    const a = staggerOffsets(8, { mode: 'random', step: 1, seed: 7 });
    const b = staggerOffsets(8, { mode: 'random', step: 1, seed: 7 });
    expect(a).toEqual(b);
  });
  it('differs between seeds', () => {
    const a = staggerOffsets(8, { mode: 'random', step: 1, seed: 1 });
    const b = staggerOffsets(8, { mode: 'random', step: 1, seed: 2 });
    expect(a).not.toEqual(b);
  });
  it('stays inside the reach of a cascade of the same step', () => {
    const r = staggerOffsets(10, { mode: 'random', step: 1, seed: 3 });
    expect(Math.min(...r)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...r)).toBeLessThanOrEqual(9);
  });
});

describe('staggerOffsets — balance', () => {
  it('sums to zero in every mode, so the group does not drift', () => {
    for (const { id } of STAGGER_MODES) {
      const offsets = staggerOffsets(7, { mode: id as StaggerMode, step: 1.5, balance: true });
      expect(near(sum(offsets), 0)).toBe(true);
    }
  });
  it('keeps the relative spacing it balances', () => {
    const raw = staggerOffsets(4, { mode: 'cascade', step: 1 });
    const bal = staggerOffsets(4, { mode: 'cascade', step: 1, balance: true });
    for (let i = 1; i < raw.length; i++) {
      expect(near(raw[i]! - raw[i - 1]!, bal[i]! - bal[i - 1]!)).toBe(true);
    }
  });
});

describe('quantizeOffsets', () => {
  it('snaps to the frame grid', () => {
    const fd = 1 / 30;
    expect(quantizeOffsets([0, 0.02, 0.05], fd).map((t) => Math.round(t / fd))).toEqual([0, 1, 2]);
  });
  it('quantizes the finished shape, not each term', () => {
    // A wave whose amplitude is under a frame must land on its nearest
    // representable shape, not collapse to flat.
    const fd = 1 / 30;
    const w = quantizeOffsets(staggerOffsets(9, { mode: 'wave', step: 0.02 }), fd);
    expect(w.some((t) => t !== 0)).toBe(true);
  });
  it('leaves offsets alone when there is no grid', () => {
    expect(quantizeOffsets([0.123], 0)).toEqual([0.123]);
  });
});

describe('clampOffsetsToStart', () => {
  it('leaves offsets that already clear the floor', () => {
    expect(clampOffsetsToStart([1, 2], [0, 0.5])).toEqual([0, 0.5]);
  });
  it('shifts the whole group rather than flattening it against zero', () => {
    const starts = [0, 1];
    const offsets = [-0.5, -0.5];
    const out = clampOffsetsToStart(starts, offsets);
    expect(out).toEqual([0, 0]);
    // The relative spacing survived — this is the bit a per-row clamp breaks.
    expect(out[1]! - out[0]!).toBe(offsets[1]! - offsets[0]!);
  });
  it('preserves a pattern that straddles zero', () => {
    const starts = [0, 0, 0];
    const offsets = [-2, 0, 2];
    const out = clampOffsetsToStart(starts, offsets);
    expect(out).toEqual([0, 2, 4]);
  });
  it('honours a non-zero floor', () => {
    expect(clampOffsetsToStart([0], [0], 5)).toEqual([5]);
  });
});
