import { scaleGrip, scaleSelection, selectionSpan } from './keyframeTimeScale';

const sel = (...ts: number[]): Map<string, number> =>
  new Map(ts.map((t, i) => [`k${i}`, t]));

describe('scaleGrip', () => {
  it('recognises the first and last keyframe', () => {
    const s = sel(1, 2, 3);
    expect(scaleGrip(s, 'k0')).toBe('start');
    expect(scaleGrip(s, 'k2')).toBe('end');
  });

  it('refuses an interior keyframe — there is no end to anchor against', () => {
    expect(scaleGrip(sel(1, 2, 3), 'k1')).toBeNull();
  });

  it('refuses a selection with nothing to scale', () => {
    expect(scaleGrip(sel(4), 'k0')).toBeNull();          // one keyframe
    expect(scaleGrip(sel(2, 2, 2), 'k0')).toBeNull();    // zero-width span
    expect(scaleGrip(sel(1, 2), 'nope')).toBeNull();     // not in the selection
  });

  it('treats a tie at an end as that end', () => {
    // Several keyframes stacked on the first frame are all legitimately the
    // start; scaling anchors on the far end either way.
    expect(scaleGrip(sel(1, 1, 5), 'k1')).toBe('start');
  });
});

describe('scaleSelection', () => {
  it('doubles the span when the end is dragged out by its own width', () => {
    const out = scaleSelection(sel(0, 1, 2), 'k2', 2)!;
    expect(out.get('k0')).toBeCloseTo(0);
    expect(out.get('k1')).toBeCloseTo(2);
    expect(out.get('k2')).toBeCloseTo(4);
  });

  it('holds the opposite end EXACTLY still', () => {
    // Not "close to" — a fixed end that drifts by an ulp is an off-by-one-frame
    // that only surfaces much later.
    const out = scaleSelection(sel(3, 5, 9), 'k2', 4)!;
    expect(out.get('k0')).toBe(3);
  });

  it('anchors on the end when the START is dragged', () => {
    const out = scaleSelection(sel(0, 2, 4), 'k0', 2)!;
    expect(out.get('k2')).toBe(4);      // far end pinned
    expect(out.get('k0')).toBeCloseTo(2);
    expect(out.get('k1')).toBeCloseTo(3); // midpoint stays proportional
  });

  it('preserves proportional spacing, not just the endpoints', () => {
    // An uneven selection is the only kind that can catch a scale that merely
    // moves the ends and redistributes the middle evenly.
    const out = scaleSelection(sel(0, 1, 5, 10), 'k3', 10)!;
    const at = (k: string): number => out.get(k)!;
    expect((at('k1') - at('k0')) / (at('k3') - at('k0'))).toBeCloseTo(1 / 10);
    expect((at('k2') - at('k0')) / (at('k3') - at('k0'))).toBeCloseTo(5 / 10);
  });

  it('never reverses the keyframe order, however far it is dragged', () => {
    // A negative factor would play the animation backwards while still looking
    // like a perfectly plausible result.
    const before = sel(2, 4, 8);
    for (const dt of [-6, -20, -1000]) {
      const out = scaleSelection(before, 'k2', dt)!;
      const times = [...out.values()];
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
  });

  it('collapses to a single instant rather than crossing the anchor', () => {
    const out = scaleSelection(sel(0, 1, 2), 'k2', -2)!;
    expect([...out.values()]).toEqual([0, 0, 0]);
  });

  describe('minSpan floor', () => {
    it('never squeezes the selection below the floor', () => {
      // Without this, an over-shot drag stacks every keyframe on one time and
      // the commit loop keeps only the last — a drag that deletes keyframes.
      const out = scaleSelection(sel(0, 1, 2), 'k2', -100, 0.5)!;
      const times = [...out.values()];
      expect(Math.max(...times) - Math.min(...times)).toBeCloseTo(0.5);
    });

    it('keeps every keyframe at a distinct time when the floor applies', () => {
      const out = scaleSelection(sel(0, 1, 2, 3), 'k3', -99, 1 / 30)!;
      expect(new Set(out.values()).size).toBe(4);
    });

    it('does not interfere with a drag that stays above the floor', () => {
      const floored = scaleSelection(sel(0, 1, 2), 'k2', 2, 1 / 30)!;
      const free = scaleSelection(sel(0, 1, 2), 'k2', 2)!;
      expect([...floored.values()]).toEqual([...free.values()]);
    });
  });

  it('never produces a negative time', () => {
    const out = scaleSelection(sel(1, 2, 3), 'k0', -50)!;
    for (const t of out.values()) expect(t).toBeGreaterThanOrEqual(0);
  });

  it('returns null when the gesture does not apply, so the caller can fall back', () => {
    expect(scaleSelection(sel(1, 2, 3), 'k1', 1)).toBeNull();
    expect(scaleSelection(sel(7), 'k0', 1)).toBeNull();
  });

  it('a zero drag is the identity', () => {
    const before = sel(1, 3, 7);
    expect([...scaleSelection(before, 'k2', 0)!.values()]).toEqual([1, 3, 7]);
  });
});

describe('selectionSpan', () => {
  it('is null for an empty selection', () => {
    expect(selectionSpan(new Map())).toBeNull();
  });
});
