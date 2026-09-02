import {
  nearestGaps,
  spacingCandidates,
  equalSizeCandidates,
  smartGuides,
  measureBetween,
  gapBetween,
} from '../snap/smartGuides';
import { SnapEngine } from '../snap/SnapEngine';
import * as R from '../math/Rect';

describe('nearestGaps', () => {
  it('measures the nearest neighbour on each side', () => {
    const box = R.rect(100, 100, 50, 50); // 100..150 x, 100..150 y
    const others = [
      R.rect(0, 100, 60, 50), // left, right edge 60 → gap 40
      R.rect(20, 100, 50, 50), // left, right edge 70 → gap 30 (nearer)
      R.rect(200, 120, 40, 40), // right, left edge 200 → gap 50
      R.rect(100, 0, 50, 70), // above, bottom 70 → gap 30
    ];
    const gaps = nearestGaps(box, others);
    const bySide = Object.fromEntries(gaps.map((g) => [g.side, g.distance]));
    expect(bySide['left']).toBeCloseTo(30);
    expect(bySide['right']).toBeCloseTo(50);
    expect(bySide['top']).toBeCloseTo(30);
    expect(bySide['bottom']).toBeUndefined();
  });

  it('ignores neighbours that share no band on the perpendicular axis', () => {
    const box = R.rect(100, 100, 50, 50);
    // Far above the box: it is to the left in x, but they never share a row,
    // so a "40px away" line drawn between them would cross empty space.
    const gaps = nearestGaps(box, [R.rect(0, 0, 60, 10)]);
    expect(gaps).toEqual([]);
  });

  it('ignores overlapping neighbours (no gap to report)', () => {
    const box = R.rect(100, 100, 50, 50);
    expect(nearestGaps(box, [R.rect(120, 120, 50, 50)])).toEqual([]);
  });

  it('reports the span and cross line of the gap it measured', () => {
    const box = R.rect(100, 0, 50, 100); // y 0..100
    const other = R.rect(0, 40, 60, 20); // y 40..60, right edge 60
    const g = gapBetween(box, other, 'left');
    expect(g).not.toBeNull();
    expect(g?.from).toBeCloseTo(60);
    expect(g?.to).toBeCloseTo(100);
    // Drawn through the middle of the band they share: y 40..60.
    expect(g?.cross).toBeCloseTo(50);
  });
});

describe('spacingCandidates', () => {
  it('centres a box between two neighbours when it is nearly centred already', () => {
    // A: 0..50, box: 62..112, C: 160..210 → gaps 12 and 48… far off, no candidate.
    const a = R.rect(0, 0, 50, 50);
    const c = R.rect(160, 0, 50, 50);
    expect(spacingCandidates(R.rect(62, 0, 50, 50), [a, c], 4)).toEqual([]);
    // Box at 78..128 → gaps 28 and 32; delta = +2 centres it.
    const [cand] = spacingCandidates(R.rect(78, 0, 50, 50), [a, c], 4);
    expect(cand).toBeDefined();
    expect(cand?.axis).toBe('x');
    expect(cand?.delta).toBeCloseTo(2);
    expect(cand?.gap).toBeCloseTo(30);
    expect(cand?.spans).toHaveLength(2);
    expect(cand?.spans.map((s) => Math.round(s.distance))).toEqual([30, 30]);
  });

  it('continues an existing rhythm to the left', () => {
    // B: 0..20, A: 40..60 (gap 20), box: 79..99 → gap to A is 19, wants 20.
    const b = R.rect(0, 0, 20, 20);
    const a = R.rect(40, 0, 20, 20);
    const [cand] = spacingCandidates(R.rect(79, 0, 20, 20), [a, b], 3);
    expect(cand?.axis).toBe('x');
    expect(cand?.delta).toBeCloseTo(1);
    expect(cand?.gap).toBeCloseTo(20);
    expect(cand?.spans.map((s) => Math.round(s.distance))).toEqual([20, 20]);
  });

  it('continues an existing rhythm to the right', () => {
    // box: 0..20, C: 41..61, D: 81..101 (C→D gap 20); box→C is 21, wants 20.
    const c = R.rect(41, 0, 20, 20);
    const d = R.rect(81, 0, 20, 20);
    const [cand] = spacingCandidates(R.rect(0, 0, 20, 20), [c, d], 3);
    expect(cand?.delta).toBeCloseTo(1);
    expect(cand?.gap).toBeCloseTo(20);
  });

  it('works on the vertical axis too', () => {
    const above = R.rect(0, 0, 20, 20); // 0..20
    const below = R.rect(0, 100, 20, 20); // 100..120
    // box 48..68 → gaps 28 above, 32 below → delta +2.
    const [cand] = spacingCandidates(R.rect(0, 48, 20, 20), [above, below], 4);
    expect(cand?.axis).toBe('y');
    expect(cand?.delta).toBeCloseTo(2);
  });

  it('offers nothing outside the radius', () => {
    const a = R.rect(0, 0, 20, 20);
    const b = R.rect(200, 0, 20, 20);
    expect(spacingCandidates(R.rect(50, 0, 20, 20), [a, b], 2)).toEqual([]);
  });
});

describe('equalSizeCandidates', () => {
  it('matches a neighbour of nearly the same width', () => {
    const box = R.rect(0, 0, 98, 40);
    const other = R.rect(300, 300, 100, 77);
    const [cand] = equalSizeCandidates(box, [other], 3);
    expect(cand?.axis).toBe('x');
    expect(cand?.delta).toBeCloseTo(2);
    expect(cand?.size).toBeCloseTo(100);
    expect(cand?.other).toBe(other);
  });

  it('says nothing when no neighbour is close in size', () => {
    expect(equalSizeCandidates(R.rect(0, 0, 50, 50), [R.rect(0, 0, 90, 90)], 3)).toEqual([]);
  });
});

describe('measureBetween', () => {
  it('measures both axes between two named boxes', () => {
    const a = R.rect(100, 100, 50, 50);
    const b = R.rect(200, 300, 50, 50);
    const gaps = measureBetween(a, b);
    const byAxis = Object.fromEntries(gaps.map((g) => [g.axis, g.distance]));
    expect(byAxis['x']).toBeCloseTo(50); // 200 − 150
    expect(byAxis['y']).toBeCloseTo(150); // 300 − 150
  });

  it('answers even when the boxes share no band (unlike nearestGaps)', () => {
    const a = R.rect(0, 0, 10, 10);
    const b = R.rect(100, 100, 10, 10);
    expect(nearestGaps(a, [b])).toEqual([]);
    expect(measureBetween(a, b)).toHaveLength(2);
  });

  it('reports no span on an axis the two overlap on', () => {
    const a = R.rect(0, 0, 100, 20);
    const b = R.rect(20, 60, 40, 20); // overlaps a in x
    const gaps = measureBetween(a, b);
    expect(gaps.map((g) => g.axis)).toEqual(['y']);
    expect(gaps[0]?.distance).toBeCloseTo(40);
  });
});

describe('smartGuides', () => {
  it('keeps at most one spacing candidate per axis', () => {
    const others = [R.rect(0, 0, 20, 20), R.rect(41, 0, 20, 20), R.rect(81, 0, 20, 20)];
    const info = smartGuides(R.rect(120, 0, 20, 20), others, 3);
    expect(info.spacing.filter((c) => c.axis === 'x').length).toBeLessThanOrEqual(1);
  });
});

describe('SnapEngine equal-spacing snapping', () => {
  const engine = (): SnapEngine => {
    const e = new SnapEngine();
    // Alignment targets are supplied separately per test; these settings only
    // decide which SOURCES are allowed.
    e.setSettings({ toGrid: false, toGuides: false, toObjects: true });
    return e;
  };

  it('snaps a rect to make two gaps equal when nothing aligns', () => {
    const a = R.rect(0, 0, 20, 20);
    const c = R.rect(100, 0, 20, 20);
    // box 49..69 → gaps 29 and 31 → delta +1 makes both 30.
    const result = engine().snapRect(R.rect(49, 0, 20, 20), [], 3, [a, c]);
    expect(result.delta.x).toBeCloseTo(1);
    expect(result.snapped).toBe(true);
    expect(result.spacing).toHaveLength(1);
    expect(result.spacing[0]?.gap).toBeCloseTo(30);
  });

  it('lets alignment win the axis it claimed', () => {
    const a = R.rect(0, 0, 20, 20);
    const c = R.rect(100, 0, 20, 20);
    // An edge target at x=48 is within reach of the box's left edge (49), so
    // the x axis is taken by alignment and spacing must not fight it.
    const result = engine().snapRect(R.rect(49, 0, 20, 20), [
      { axis: 'x', position: 48, source: 'object-edge' },
    ], 3, [a, c]);
    expect(result.delta.x).toBeCloseTo(-1);
    expect(result.spacing).toEqual([]);
  });

  it('is inert when smart guides are off', () => {
    const e = engine();
    e.setSettings({ smartGuides: false });
    const result = e.snapRect(R.rect(49, 0, 20, 20), [], 3, [
      R.rect(0, 0, 20, 20),
      R.rect(100, 0, 20, 20),
    ]);
    expect(result.delta.x).toBe(0);
    expect(result.spacing).toEqual([]);
  });

  it('is byte-identical to the old call when no neighbours are passed', () => {
    const e = engine();
    const targets = SnapEngine.objectTargets([R.rect(200, 0, 100, 100)]);
    const moving = R.rect(97, 0, 100, 40);
    expect(e.snapRect(moving, targets, 5)).toEqual({
      ...e.snapRect(moving, targets, 5, []),
    });
  });
});
