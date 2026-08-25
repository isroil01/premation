/**
 * Zoom-settle filter — the raster scale holds during a gesture and adopts
 * (with one repaint) at rest. See rasterScaleSettle.ts for why.
 */

import { createRasterScaleSettle } from './rasterScaleSettle';

describe('createRasterScaleSettle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('adopts the first sample immediately (export / fresh backend)', () => {
    const s = createRasterScaleSettle(() => {});
    expect(s.sample(2)).toBe(2);
    expect(s.sample(2)).toBe(2);
  });

  it('holds the settled scale while the input keeps moving', () => {
    const s = createRasterScaleSettle(() => {});
    s.sample(1);
    // A zoom gesture: every frame a new scale.
    expect(s.sample(1.2)).toBe(1);
    jest.advanceTimersByTime(100);
    expect(s.sample(1.5)).toBe(1);
    jest.advanceTimersByTime(100);
    expect(s.sample(2)).toBe(1);
  });

  it('adopts the final scale after the quiet window, firing the repaint once', () => {
    const onSettled = jest.fn();
    const s = createRasterScaleSettle(onSettled);
    s.sample(1);
    s.sample(2);
    s.sample(3);
    expect(onSettled).not.toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(s.sample(3)).toBe(3);
  });

  it('a moving input keeps resetting the window — no mid-gesture adoption', () => {
    const onSettled = jest.fn();
    const s = createRasterScaleSettle(onSettled, 160);
    s.sample(1);
    for (let i = 0; i < 10; i++) {
      s.sample(1 + i * 0.1);
      jest.advanceTimersByTime(100); // always inside the 160ms window
    }
    expect(onSettled).not.toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('float jitter on a parked viewport does not churn the timer', () => {
    const onSettled = jest.fn();
    const s = createRasterScaleSettle(onSettled);
    const scale = 0.310666666666667;
    const jittered = scale + scale * 1e-8; // within the relative epsilon
    s.sample(scale);
    expect(s.sample(jittered)).toBe(scale);
    jest.advanceTimersByTime(1000);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('dispose cancels a pending adoption', () => {
    const onSettled = jest.fn();
    const s = createRasterScaleSettle(onSettled);
    s.sample(1);
    s.sample(2);
    s.dispose();
    jest.advanceTimersByTime(1000);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('ignores degenerate samples', () => {
    const s = createRasterScaleSettle(() => {});
    expect(s.sample(0)).toBe(1);
    expect(s.sample(NaN)).toBe(1);
    s.sample(2);
    expect(s.sample(-1)).toBe(2);
  });
});
