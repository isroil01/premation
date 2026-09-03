import {
  fitPixelsPerSecond,
  getTimelineViewport,
  setTimelineViewportWidth,
  subscribeTimelineViewport,
  registerTimelineScroll,
  scrollTimelineTo,
  FIT_PADDING_PX,
} from './timelineViewport';

afterEach(() => setTimelineViewportWidth(0));

describe('fitPixelsPerSecond', () => {
  it('fills the viewport minus the padding', () => {
    // 824px of lanes, 24px of padding, 10s of comp → 80px/s.
    expect(fitPixelsPerSecond({ spanSeconds: 10, viewportWidth: 824 })).toBe(80);
  });

  it('defaults its padding to the lanes offset plus air', () => {
    expect(FIT_PADDING_PX).toBe(24);
    expect(fitPixelsPerSecond({ spanSeconds: 1, viewportWidth: 100 })).toBe(100 - FIT_PADDING_PX);
    expect(fitPixelsPerSecond({ spanSeconds: 1, viewportWidth: 100, paddingPx: 0 })).toBe(100);
  });

  it('clamps into the zoom range', () => {
    // A very long comp in a narrow panel would want a sub-pixel zoom.
    expect(
      fitPixelsPerSecond({ spanSeconds: 100000, viewportWidth: 800, minPixelsPerSecond: 4 }),
    ).toBe(4);
    // A very short work area would want an enormous one.
    expect(
      fitPixelsPerSecond({ spanSeconds: 0.01, viewportWidth: 800, maxPixelsPerSecond: 800 }),
    ).toBe(800);
  });

  it('returns null rather than guessing when there is nothing to fit', () => {
    // No timeline mounted: leave the user's zoom alone.
    expect(fitPixelsPerSecond({ spanSeconds: 10, viewportWidth: 0 })).toBeNull();
    // Padding eats the whole panel.
    expect(fitPixelsPerSecond({ spanSeconds: 10, viewportWidth: 20 })).toBeNull();
    // Empty or inverted span.
    expect(fitPixelsPerSecond({ spanSeconds: 0, viewportWidth: 800 })).toBeNull();
    expect(fitPixelsPerSecond({ spanSeconds: -5, viewportWidth: 800 })).toBeNull();
  });
});

describe('the viewport store', () => {
  it('starts unmeasured', () => {
    expect(getTimelineViewport().width).toBe(0);
  });

  it('publishes rounded widths to subscribers', () => {
    const seen: number[] = [];
    const off = subscribeTimelineViewport((s) => seen.push(s.width));
    setTimelineViewportWidth(640.4);
    expect(getTimelineViewport().width).toBe(640);
    expect(seen).toEqual([640]);
    off();
    setTimelineViewportWidth(700);
    expect(seen).toEqual([640]);
  });

  it('does not notify when the width is unchanged — this fires per resize frame', () => {
    setTimelineViewportWidth(500);
    let calls = 0;
    const off = subscribeTimelineViewport(() => calls++);
    setTimelineViewportWidth(500);
    setTimelineViewportWidth(500.2);
    expect(calls).toBe(0);
    setTimelineViewportWidth(501);
    expect(calls).toBe(1);
    off();
  });

  it('never reports a negative width', () => {
    setTimelineViewportWidth(-40);
    expect(getTimelineViewport().width).toBe(0);
  });
});

describe('the scroll hook', () => {
  it('routes to the registered scroller and clamps at zero', () => {
    const seen: number[] = [];
    const off = registerTimelineScroll((px) => seen.push(px));
    scrollTimelineTo(120);
    scrollTimelineTo(-30);
    expect(seen).toEqual([120, 0]);
    off();
  });

  it('is a silent no-op with no timeline mounted', () => {
    expect(() => scrollTimelineTo(50)).not.toThrow();
  });

  it('unregistering a stale handle does not detach the current one', () => {
    const first: number[] = [];
    const second: number[] = [];
    const offFirst = registerTimelineScroll((px) => first.push(px));
    const offSecond = registerTimelineScroll((px) => second.push(px));
    // A remount registers before the old effect's cleanup runs.
    expect(offFirst()).toBe(false);
    scrollTimelineTo(10);
    expect(second).toEqual([10]);
    expect(first).toEqual([]);
    expect(offSecond()).toBe(true);
  });
});
