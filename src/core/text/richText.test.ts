import {
  applyStyleToRange,
  normalizeRuns,
  reindexRuns,
  styleOverRange,
} from './richText';
import type { RichRun } from './textLayout';

const red = { fill: '#ff0000' };
const bold = { fontWeight: '700' };

describe('normalizeRuns', () => {
  it('drops runs that are empty, inverted, or carry no style', () => {
    const runs: RichRun[] = [
      { start: 2, end: 2, style: red },
      { start: 5, end: 3, style: red },
      { start: 0, end: 3, style: {} },
    ];
    expect(normalizeRuns(runs, 10)).toEqual([]);
  });

  it('clamps runs to the text length', () => {
    expect(normalizeRuns([{ start: -4, end: 99, style: red }], 3)).toEqual([
      { start: 0, end: 3, style: red },
    ]);
  });

  it('coalesces adjacent runs with identical styles', () => {
    const runs: RichRun[] = [
      { start: 0, end: 2, style: red },
      { start: 2, end: 4, style: red },
    ];
    expect(normalizeRuns(runs, 4)).toEqual([{ start: 0, end: 4, style: red }]);
  });

  it('does not coalesce adjacent runs with different styles', () => {
    const runs: RichRun[] = [
      { start: 0, end: 2, style: red },
      { start: 2, end: 4, style: bold },
    ];
    expect(normalizeRuns(runs, 4)).toHaveLength(2);
  });

  it('splits an overlap into disjoint spans, merging styles field-wise', () => {
    const runs: RichRun[] = [
      { start: 0, end: 4, style: red },
      { start: 2, end: 6, style: bold },
    ];
    expect(normalizeRuns(runs, 6)).toEqual([
      { start: 0, end: 2, style: { fill: '#ff0000' } },
      { start: 2, end: 4, style: { fill: '#ff0000', fontWeight: '700' } },
      { start: 4, end: 6, style: { fontWeight: '700' } },
    ]);
  });

  it('resolves a same-field overlap last-wins', () => {
    const runs: RichRun[] = [
      { start: 0, end: 4, style: { fill: '#ff0000' } },
      { start: 0, end: 4, style: { fill: '#00ff00' } },
    ];
    expect(normalizeRuns(runs, 4)).toEqual([{ start: 0, end: 4, style: { fill: '#00ff00' } }]);
  });

  it('returns nothing for empty text', () => {
    expect(normalizeRuns([{ start: 0, end: 4, style: red }], 0)).toEqual([]);
  });

  it('is idempotent', () => {
    const once = normalizeRuns(
      [
        { start: 0, end: 4, style: red },
        { start: 2, end: 6, style: bold },
      ],
      6,
    );
    expect(normalizeRuns(once, 6)).toEqual(once);
  });
});

describe('applyStyleToRange', () => {
  it('adds a run over a previously unstyled range', () => {
    expect(applyStyleToRange([], 1, 3, red, 5)).toEqual([{ start: 1, end: 3, style: red }]);
  });

  it('layers onto an existing run without dropping its other fields', () => {
    const runs: RichRun[] = [{ start: 0, end: 5, style: red }];
    expect(applyStyleToRange(runs, 1, 3, bold, 5)).toEqual([
      { start: 0, end: 1, style: { fill: '#ff0000' } },
      { start: 1, end: 3, style: { fill: '#ff0000', fontWeight: '700' } },
      { start: 3, end: 5, style: { fill: '#ff0000' } },
    ]);
  });

  it('clears a field when the style passes it as undefined', () => {
    const runs: RichRun[] = [{ start: 0, end: 5, style: { ...red, ...bold } }];
    expect(applyStyleToRange(runs, 0, 5, { fill: undefined }, 5)).toEqual([
      { start: 0, end: 5, style: { fontWeight: '700' } },
    ]);
  });

  it('clearing the only field removes the run entirely', () => {
    const runs: RichRun[] = [{ start: 0, end: 5, style: red }];
    expect(applyStyleToRange(runs, 0, 5, { fill: undefined }, 5)).toEqual([]);
  });

  it('clears only within the range, leaving the rest of the run intact', () => {
    const runs: RichRun[] = [{ start: 0, end: 6, style: red }];
    expect(applyStyleToRange(runs, 2, 4, { fill: undefined }, 6)).toEqual([
      { start: 0, end: 2, style: red },
      { start: 4, end: 6, style: red },
    ]);
  });

  it('normalizes without changing anything when the range is empty', () => {
    const runs: RichRun[] = [{ start: 0, end: 3, style: red }];
    expect(applyStyleToRange(runs, 2, 2, bold, 5)).toEqual(runs);
  });

  it('tolerates a backwards range (selection dragged right to left)', () => {
    expect(applyStyleToRange([], 4, 1, red, 5)).toEqual([{ start: 1, end: 4, style: red }]);
  });
});

describe('styleOverRange', () => {
  it('reports a field shared by the whole range', () => {
    const runs: RichRun[] = [{ start: 0, end: 5, style: red }];
    const { style, mixed } = styleOverRange(runs, 1, 4, 5);
    expect(style.fill).toBe('#ff0000');
    expect(mixed.size).toBe(0);
  });

  it('marks a field mixed when the range spans differing runs', () => {
    // The inspector must show "Mixed" here — displaying the first character's
    // value would overwrite the rest of the selection on the next edit.
    const runs: RichRun[] = [
      { start: 0, end: 2, style: { fill: '#ff0000' } },
      { start: 2, end: 4, style: { fill: '#00ff00' } },
    ];
    const { style, mixed } = styleOverRange(runs, 0, 4, 4);
    expect(mixed.has('fill')).toBe(true);
    expect(style.fill).toBeUndefined();
  });

  it('marks a field mixed when only part of the range is styled', () => {
    const runs: RichRun[] = [{ start: 0, end: 2, style: red }];
    const { mixed } = styleOverRange(runs, 0, 4, 4);
    expect(mixed.has('fill')).toBe(true);
  });

  it('reports nothing for an empty range', () => {
    const { style, mixed } = styleOverRange([{ start: 0, end: 4, style: red }], 2, 2, 4);
    expect(style).toEqual({});
    expect(mixed.size).toBe(0);
  });
});

describe('reindexRuns', () => {
  it('shifts runs right when text is inserted before them', () => {
    const runs: RichRun[] = [{ start: 4, end: 7, style: red }];
    expect(reindexRuns(runs, 'the cat', 'oh the cat')).toEqual([
      { start: 7, end: 10, style: red },
    ]);
  });

  it('leaves runs alone when text is appended after them', () => {
    const runs: RichRun[] = [{ start: 0, end: 3, style: red }];
    expect(reindexRuns(runs, 'the', 'the cat')).toEqual([{ start: 0, end: 3, style: red }]);
  });

  it('shifts runs left when text is deleted before them', () => {
    const runs: RichRun[] = [{ start: 7, end: 10, style: red }];
    expect(reindexRuns(runs, 'oh the cat', 'the cat')).toEqual([
      { start: 4, end: 7, style: red },
    ]);
  });

  it('collapses a run whose characters were all deleted', () => {
    const runs: RichRun[] = [{ start: 0, end: 3, style: red }];
    expect(reindexRuns(runs, 'the cat', ' cat')).toEqual([]);
  });

  it('drops every run when the text is cleared', () => {
    expect(reindexRuns([{ start: 0, end: 3, style: red }], 'the', '')).toEqual([]);
  });

  it('keeps a run that is entirely after a replaced span', () => {
    const runs: RichRun[] = [{ start: 4, end: 7, style: red }];
    // 'the' -> 'a': the span before shrinks by two, so the run slides left.
    expect(reindexRuns(runs, 'the cat', 'a cat')).toEqual([{ start: 2, end: 5, style: red }]);
  });

  it('counts in code points, not UTF-16 units', () => {
    const runs: RichRun[] = [{ start: 1, end: 2, style: red }];
    // Inserting one astral char before the run must shift it by exactly 1.
    expect(reindexRuns(runs, 'ab', '𝐀ab')).toEqual([{ start: 2, end: 3, style: red }]);
  });
});
