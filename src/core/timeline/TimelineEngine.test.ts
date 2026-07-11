import { stepTimeline } from './TimelineEngine';

describe('stepTimeline', () => {
  test('advances by dt within range', () => {
    const s = stepTimeline(1, 0.5, 10, true);
    expect(s.currentTime).toBeCloseTo(1.5);
    expect(s.playing).toBe(true);
  });

  test('wraps when looping past the end', () => {
    const s = stepTimeline(9.8, 0.5, 10, true);
    expect(s.currentTime).toBeCloseTo(0.3);
    expect(s.playing).toBe(true);
  });

  test('clamps and stops at the end when not looping', () => {
    const s = stepTimeline(9.8, 0.5, 10, false);
    expect(s.currentTime).toBe(10);
    expect(s.playing).toBe(false);
  });

  test('never goes below zero', () => {
    const s = stepTimeline(0.1, -1, 10, true);
    expect(s.currentTime).toBe(0);
    expect(s.playing).toBe(true);
  });

  test('zero-duration timeline is a no-op', () => {
    const s = stepTimeline(0, 0.5, 0, true);
    expect(s.currentTime).toBe(0);
    expect(s.playing).toBe(false);
  });
});
