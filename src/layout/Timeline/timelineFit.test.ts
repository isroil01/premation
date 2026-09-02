/**
 * The controller is mocked: this suite is about the fit ARITHMETIC and the
 * zoom-then-scroll ordering, neither of which needs a real timeline engine.
 */

const controller = {
  durationSeconds: 10,
  workArea: null as null | { start: number; end: number },
  setPixelsPerSecond: jest.fn(),
  getWorkArea: (): null | { start: number; end: number } => controller.workArea,
};

jest.mock('@core/timeline/TimelineController', () => ({
  getTimelineController: () => controller,
}));

import {
  fitTimelineToRange,
  fitTimelineToComposition,
  fitTimelineToWorkArea,
  hasWorkArea,
  TIMELINE_ZOOM_MAX,
  TIMELINE_ZOOM_MIN,
} from './timelineFit';
import { registerTimelineScroll, setTimelineViewportWidth } from './timelineViewport';

let scrolled: number[] = [];
let unregister: (() => boolean) | null = null;

beforeEach(() => {
  controller.durationSeconds = 10;
  controller.workArea = null;
  controller.setPixelsPerSecond.mockClear();
  scrolled = [];
  unregister = registerTimelineScroll((px) => scrolled.push(px));
  // 824px of lanes leaves 800 after the 24px fit padding.
  setTimelineViewportWidth(824);
});

/** The scroll is deferred to the next frame — run it. */
const flushFrame = async (): Promise<void> => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

afterEach(async () => {
  // Detach FIRST, then drain: a fit this test never flushed would otherwise
  // fire during the next test's flush and land in its recording.
  unregister?.();
  unregister = null;
  setTimelineViewportWidth(0);
  await flushFrame();
});

describe('fitTimelineToRange', () => {
  it('zooms so the span exactly fills the lanes', () => {
    const result = fitTimelineToRange(0, 10);
    expect(result).toEqual({ pixelsPerSecond: 80, scrollLeft: 0 });
    expect(controller.setPixelsPerSecond).toHaveBeenCalledWith(80, 0);
  });

  it('scrolls the span to the left edge, but only after the zoom lands', async () => {
    const result = fitTimelineToRange(4, 8);
    // 4s of span in 800 usable px → 200px/s; 4s × 200 = 800px of scroll.
    expect(result).toEqual({ pixelsPerSecond: 200, scrollLeft: 800 });
    // The lanes are still at the OLD zoom this tick — scrolling now would be
    // clamped away by the browser.
    expect(scrolled).toEqual([]);
    await flushFrame();
    expect(scrolled).toEqual([800]);
  });

  it('does nothing when no timeline is mounted to measure', async () => {
    setTimelineViewportWidth(0);
    expect(fitTimelineToRange(0, 10)).toBeNull();
    expect(controller.setPixelsPerSecond).not.toHaveBeenCalled();
    await flushFrame();
    expect(scrolled).toEqual([]);
  });

  it('does nothing for an empty or inverted range', () => {
    expect(fitTimelineToRange(3, 3)).toBeNull();
    expect(fitTimelineToRange(8, 2)).toBeNull();
    expect(controller.setPixelsPerSecond).not.toHaveBeenCalled();
  });

  it('stays inside the zoom limits', () => {
    expect(fitTimelineToRange(0, 100000)?.pixelsPerSecond).toBe(TIMELINE_ZOOM_MIN);
    expect(fitTimelineToRange(0, 0.001)?.pixelsPerSecond).toBe(TIMELINE_ZOOM_MAX);
  });
});

describe('fitTimelineToComposition', () => {
  it('fits the comp duration from zero', () => {
    controller.durationSeconds = 20;
    expect(fitTimelineToComposition()).toEqual({ pixelsPerSecond: 40, scrollLeft: 0 });
    expect(controller.setPixelsPerSecond).toHaveBeenCalledWith(40, 0);
  });
});

describe('fitTimelineToWorkArea', () => {
  it('is a no-op — not a zoom to nothing — when no work area is set', () => {
    expect(hasWorkArea()).toBe(false);
    expect(fitTimelineToWorkArea()).toBeNull();
    expect(controller.setPixelsPerSecond).not.toHaveBeenCalled();
  });

  it('fits and scrolls to the work area when one is set', async () => {
    controller.workArea = { start: 2, end: 6 };
    expect(hasWorkArea()).toBe(true);
    expect(fitTimelineToWorkArea()).toEqual({ pixelsPerSecond: 200, scrollLeft: 400 });
    await flushFrame();
    expect(scrolled).toEqual([400]);
  });
});
