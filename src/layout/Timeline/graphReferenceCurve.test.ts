import {
  polylinePath,
  snapshotReferenceCurves,
  valueToY,
  yToValue,
} from './graphReferenceCurve';

const key = (nodeId: string, prop: string): string => `${nodeId}:${prop}`;

describe('valueToY / yToValue', () => {
  it('puts the maximum at the top and the minimum at the bottom', () => {
    expect(valueToY(100, 0, 100, 200)).toBe(0);
    expect(valueToY(0, 0, 100, 200)).toBe(200);
    expect(valueToY(50, 0, 100, 200)).toBe(100);
  });

  it('centres a degenerate range instead of dividing by zero', () => {
    expect(valueToY(5, 5, 5, 200)).toBe(100);
  });

  it('round-trips', () => {
    expect(yToValue(valueToY(37, -10, 90, 180), -10, 90, 180)).toBeCloseTo(37, 9);
  });
});

describe('polylinePath', () => {
  it('projects seconds to pixels and values to y', () => {
    const d = polylinePath([[0, 0], [1, 100]], 50, 0, 100, 200);
    expect(d).toBe('M0.00,200.00L50.00,0.00');
  });

  it('scales with zoom — the same data at 2x pps is 2x wide', () => {
    const a = polylinePath([[0, 0], [2, 0]], 100, 0, 1, 100);
    const b = polylinePath([[0, 0], [2, 0]], 200, 0, 1, 100);
    expect(a.endsWith('L200.00,100.00')).toBe(true);
    expect(b.endsWith('L400.00,100.00')).toBe(true);
  });

  it('is empty for an empty polyline (never "M")', () => {
    expect(polylinePath([], 100, 0, 1, 100)).toBe('');
  });
});

describe('snapshotReferenceCurves', () => {
  const paths = [
    { nodeId: 'n1', prop: 'x', samples: [[0, 0], [1, 10]] as ReadonlyArray<readonly [number, number]> },
    { nodeId: 'n1', prop: 'opacity', samples: [[0, 100]] as ReadonlyArray<readonly [number, number]> },
  ];

  it('keys every visible curve by track', () => {
    const snap = snapshotReferenceCurves(paths, key);
    expect([...snap.keys()]).toEqual(['n1:x', 'n1:opacity']);
    expect(snap.get('n1:x')!.points).toEqual([[0, 0], [1, 10]]);
  });

  it('holds data-space points, so a later zoom cannot invalidate it', () => {
    const snap = snapshotReferenceCurves(paths, key);
    const ghost = snap.get('n1:x')!;
    // Same ghost, two zoom levels — the projection differs, the memory does not.
    expect(polylinePath(ghost.points, 100, 0, 10, 100)).toBe('M0.00,100.00L100.00,0.00');
    expect(polylinePath(ghost.points, 200, 0, 10, 100)).toBe('M0.00,100.00L200.00,0.00');
    expect(ghost.points).toEqual([[0, 0], [1, 10]]);
  });

  it('does not follow the sampler when it produces a new set of paths', () => {
    const snap = snapshotReferenceCurves(paths, key);
    const resampled = [{ nodeId: 'n1', prop: 'x', samples: [[0, 999]] as ReadonlyArray<readonly [number, number]> }];
    snapshotReferenceCurves(resampled, key); // a later pass, deliberately ignored
    expect(snap.get('n1:x')!.points).toEqual([[0, 0], [1, 10]]);
  });
});
