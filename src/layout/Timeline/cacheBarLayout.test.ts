import { coalesceCacheBarRanges, layoutCacheBarSegments } from './cacheBarLayout';

describe('layoutCacheBarSegments', () => {
  it('returns empty for no ranges', () => {
    expect(layoutCacheBarSegments([], 100, 0)).toEqual([]);
  });

  it('pixel-snaps a single span', () => {
    expect(layoutCacheBarSegments([{ start: 1.001, end: 2.002 }], 100, 10)).toEqual([
      { left: 110, width: 101 },
    ]);
  });

  it('bridges a 1px rounding gap between adjacent spans', () => {
    const segments = layoutCacheBarSegments(
      [
        { start: 0, end: 1 },
        { start: 1.005, end: 2 },
      ],
      33.33,
      0,
    );
    expect(segments).toHaveLength(2);
    const a = segments[0]!;
    const b = segments[1]!;
    expect(a.left + a.width).toBeGreaterThanOrEqual(b.left);
  });

  it('preserves real multi-frame gaps as separate segments', () => {
    const segments = layoutCacheBarSegments(
      [
        { start: 0, end: 0.5 },
        { start: 2, end: 2.5 },
      ],
      100,
      0,
    );
    expect(segments).toHaveLength(2);
    const a = segments[0]!;
    const b = segments[1]!;
    expect(a.left + a.width).toBeLessThan(b.left);
  });
});

describe('coalesceCacheBarRanges', () => {
  it('merges 1-frame preview gaps into one span', () => {
    const fps = 30;
    const frame = 1 / fps;
    expect(
      coalesceCacheBarRanges(
        [
          { start: 0, end: frame },
          { start: 2 * frame, end: 3 * frame },
          { start: 4 * frame, end: 5 * frame },
        ],
        fps,
        40,
      ),
    ).toEqual([{ start: 0, end: 5 * frame }]);
  });

  it('keeps large scrub gaps separate', () => {
    expect(
      coalesceCacheBarRanges(
        [{ start: 0, end: 0.5 }, { start: 2, end: 2.5 }],
        30,
        100,
      ),
    ).toEqual([{ start: 0, end: 0.5 }, { start: 2, end: 2.5 }]);
  });
});
