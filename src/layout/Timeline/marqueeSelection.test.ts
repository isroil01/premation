/**
 * Marquee selection geometry — pure hit-math tests.
 *
 * Coordinate model under test: keyframe x = time * pps; row i spans
 * [i * trackHeight, (i + 1) * trackHeight]. pps = 100, trackHeight = 30
 * throughout, so times map to px 1:1 with two zeros.
 */

import {
  combineMarqueeSelection,
  exceedsDragThreshold,
  KEYFRAME_HALF_WIDTH_PX,
  marqueeHitKeyframeIds,
  normalizeMarqueeRect,
  type MarqueeRow,
} from './marqueeSelection';

const OPTS = { pixelsPerSecond: 100, trackHeight: 30 };

/** rows: 0 = collapsed summary, 1 = prop A, 2 = prop B, 3 = expanded summary (empty). */
const rows: MarqueeRow[] = [
  {
    keyframes: [
      { id: 'sum@0.5', time: 0.5 },
      { id: 'sum@2', time: 2 },
    ],
  },
  {
    keyframes: [
      { id: 'a@1', time: 1 },
      { id: 'a@3', time: 3 },
    ],
  },
  {
    keyframes: [
      { id: 'b@1', time: 1 },
      { id: 'b@5', time: 5 },
    ],
  },
  { keyframes: [] },
];

describe('normalizeMarqueeRect', () => {
  it('orders corners regardless of drag direction', () => {
    expect(normalizeMarqueeRect(10, 20, 3, 4)).toEqual({ left: 3, top: 4, right: 10, bottom: 20 });
    expect(normalizeMarqueeRect(3, 4, 10, 20)).toEqual({ left: 3, top: 4, right: 10, bottom: 20 });
  });

  it('yields a degenerate (zero-area) rect for a stationary pointer', () => {
    expect(normalizeMarqueeRect(7, 8, 7, 8)).toEqual({ left: 7, top: 8, right: 7, bottom: 8 });
  });
});

describe('exceedsDragThreshold', () => {
  it('treats movement at or under 3px as a click', () => {
    expect(exceedsDragThreshold(0, 0)).toBe(false);
    expect(exceedsDragThreshold(3, 0)).toBe(false);
    expect(exceedsDragThreshold(2, 2)).toBe(false); // hypot ≈ 2.83
  });

  it('treats movement over 3px (either axis or diagonal) as a drag', () => {
    expect(exceedsDragThreshold(4, 0)).toBe(true);
    expect(exceedsDragThreshold(0, -4)).toBe(true);
    expect(exceedsDragThreshold(3, 3)).toBe(true); // hypot ≈ 4.24
  });

  it('honors a custom threshold', () => {
    expect(exceedsDragThreshold(5, 0, 10)).toBe(false);
    expect(exceedsDragThreshold(11, 0, 10)).toBe(true);
  });
});

describe('marqueeHitKeyframeIds', () => {
  it('selects keyframes inside the rect on a single row', () => {
    // Row 1 only (y 35..55), times 0.8..1.2 → catches a@1 only.
    const hits = marqueeHitKeyframeIds(rows, { left: 80, top: 35, right: 120, bottom: 55 }, OPTS);
    expect(hits).toEqual(new Set(['a@1']));
  });

  it('selects across every row the rect spans, including collapsed summary rows', () => {
    // Rows 0..2 (y 10..80), times 0.9..2.1 → sum@2, a@1, b@1.
    const hits = marqueeHitKeyframeIds(rows, { left: 90, top: 10, right: 210, bottom: 80 }, OPTS);
    expect(hits).toEqual(new Set(['sum@2', 'a@1', 'b@1']));
  });

  it('excludes rows entirely above or below the rect', () => {
    // Row 2 only (y 65..85) — a@1/sum keyframes on other rows stay out.
    const hits = marqueeHitKeyframeIds(rows, { left: 0, top: 65, right: 600, bottom: 85 }, OPTS);
    expect(hits).toEqual(new Set(['b@1', 'b@5']));
  });

  it('returns nothing for expanded summary rows (property rows own the keyframes)', () => {
    // Row 3 only (y 95..115) spans the whole width — row 3 is empty.
    const hits = marqueeHitKeyframeIds(rows, { left: 0, top: 95, right: 600, bottom: 115 }, OPTS);
    expect(hits.size).toBe(0);
  });

  it('grazes a diamond within the half-width tolerance', () => {
    // a@1 center at x=100. Rect right edge at 100 - HALF → still touches;
    // one px further left → misses.
    const graze = 100 - KEYFRAME_HALF_WIDTH_PX;
    expect(
      marqueeHitKeyframeIds(rows, { left: 50, top: 35, right: graze, bottom: 55 }, OPTS),
    ).toEqual(new Set(['a@1']));
    expect(
      marqueeHitKeyframeIds(rows, { left: 50, top: 35, right: graze - 1, bottom: 55 }, OPTS),
    ).toEqual(new Set());
  });

  it('handles a zero-height rect (horizontal drag) inside one row', () => {
    const hits = marqueeHitKeyframeIds(rows, { left: 0, top: 45, right: 400, bottom: 45 }, OPTS);
    expect(hits).toEqual(new Set(['a@1', 'a@3']));
  });

  it('clamps to the row list bounds for oversized rects', () => {
    const hits = marqueeHitKeyframeIds(rows, { left: 0, top: -500, right: 9999, bottom: 9999 }, OPTS);
    expect(hits).toEqual(new Set(['sum@0.5', 'sum@2', 'a@1', 'a@3', 'b@1', 'b@5']));
  });

  it('returns empty for empty rows or a degenerate track height', () => {
    expect(marqueeHitKeyframeIds([], { left: 0, top: 0, right: 100, bottom: 100 }, OPTS).size).toBe(0);
    expect(
      marqueeHitKeyframeIds(rows, { left: 0, top: 0, right: 100, bottom: 100 }, {
        pixelsPerSecond: 100,
        trackHeight: 0,
      }).size,
    ).toBe(0);
  });

  it('respects a custom keyframe half-width', () => {
    const opts = { ...OPTS, keyframeHalfWidthPx: 0 };
    // Exact-edge rect at x=100 still hits (inclusive), x=99 misses.
    expect(
      marqueeHitKeyframeIds(rows, { left: 100, top: 35, right: 100, bottom: 55 }, opts),
    ).toEqual(new Set(['a@1']));
    expect(
      marqueeHitKeyframeIds(rows, { left: 98, top: 35, right: 99, bottom: 55 }, opts),
    ).toEqual(new Set());
  });
});

describe('combineMarqueeSelection', () => {
  const base = new Set(['keep@1', 'keep@2']);
  const hits = new Set(['new@1', 'keep@2']);

  it('replaces the selection on a plain drag', () => {
    expect(combineMarqueeSelection(base, hits, false)).toEqual(new Set(['new@1', 'keep@2']));
  });

  it('unions with the pre-drag selection when additive (Shift)', () => {
    expect(combineMarqueeSelection(base, hits, true)).toEqual(
      new Set(['keep@1', 'keep@2', 'new@1']),
    );
  });

  it('additive with zero hits leaves the base selection intact', () => {
    expect(combineMarqueeSelection(base, new Set(), true)).toEqual(base);
  });

  it('returns fresh Set instances (never mutates inputs)', () => {
    const out = combineMarqueeSelection(base, hits, true);
    expect(out).not.toBe(base);
    expect(base).toEqual(new Set(['keep@1', 'keep@2']));
    expect(hits).toEqual(new Set(['new@1', 'keep@2']));
  });
});
