/**
 * The ruler's tick ladder, and the bound that makes deep zoom survivable.
 *
 * Two things are pinned here that a screenshot would not catch: that the
 * spacing the ruler picks is FRAME-aligned once a frame is wide enough to see
 * (the editor snaps to frames, so a ruler that draws 100ms gridlines at that
 * zoom is drawing a grid nothing uses), and that generating ticks for a long
 * comp at a deep zoom does not materialize a tick per millisecond of it.
 */

import { generateRulerTicks } from './RulerStack';

const FPS = 30;
const FRAME = 1 / FPS;
const OFFSET = 8;

/** The gap between adjacent ticks, in seconds, at a given zoom. */
const minorSpacing = (ticks: { x: number }[], pps: number): number =>
  ticks.length < 2 ? NaN : (ticks[1]!.x - ticks[0]!.x) / pps;

const majors = (ticks: { major: boolean }[]): number => ticks.filter((t) => t.major).length;

describe('generateRulerTicks — spacing ladder', () => {
  it('uses seconds when zoomed out', () => {
    const ticks = generateRulerTicks(60, 100, FPS, 0, OFFSET, { t0: 0, t1: 10 });
    // 1s majors at 100px; minors a fifth of that.
    expect(minorSpacing(ticks, 100)).toBeCloseTo(0.2, 6);
  });

  it('subdivides onto the FRAME grid once a frame is wide enough', () => {
    // 600 px/s → a frame is 20px, so 5 frames clears the 100px major target.
    const ticks = generateRulerTicks(10, 600, FPS, 0, OFFSET, { t0: 0, t1: 1 });
    const spacing = minorSpacing(ticks, 600);
    // Every minor lands on a whole number of frames.
    expect(spacing / FRAME).toBeCloseTo(Math.round(spacing / FRAME), 6);
  });

  it('puts a tick exactly on each frame boundary at frame-level zoom', () => {
    const pps = 600;
    const ticks = generateRulerTicks(10, pps, FPS, 0, OFFSET, { t0: 0, t1: 0.5 });
    const times = ticks.map((t) => (t.x - OFFSET) / pps);
    for (const t of times) {
      expect(Math.abs(t / FRAME - Math.round(t / FRAME))).toBeLessThan(1e-6);
    }
  });

  it('keeps subdividing below a frame at extreme zoom', () => {
    // Sub-frame times are reachable (the Ctrl+arrow nudge), so the ruler has
    // to be able to show where they land.
    const ticks = generateRulerTicks(10, 4000, FPS, 0, OFFSET, { t0: 0, t1: 0.1 });
    expect(minorSpacing(ticks, 4000)).toBeLessThan(FRAME);
  });

  it('never picks a spacing that would crowd the labels', () => {
    for (const pps of [4, 20, 100, 400, 800, 2000, 4000]) {
      const ticks = generateRulerTicks(60, pps, FPS, 0, OFFSET, { t0: 0, t1: 60 / pps * 100 });
      if (ticks.length < 2) continue;
      const majorGapPx = minorSpacing(ticks, pps) * 5 * pps;
      expect(majorGapPx).toBeGreaterThanOrEqual(100 - 1e-6);
    }
  });

  it('orders the ladder correctly at a low frame rate', () => {
    // At 12fps ten frames is 0.83s, which sorts ABOVE half a second — a fixed
    // spelling of the ladder would be out of order for one rate or the other.
    const ticks = generateRulerTicks(60, 200, 12, 0, OFFSET, { t0: 0, t1: 5 });
    const spacing = minorSpacing(ticks, 200);
    expect(spacing).toBeGreaterThan(0);
    expect(spacing * 5 * 200).toBeGreaterThanOrEqual(100 - 1e-6);
  });
});

describe('generateRulerTicks — windowing', () => {
  it('generates only within the window', () => {
    const pps = 100;
    const ticks = generateRulerTicks(600, pps, FPS, 0, OFFSET, { t0: 100, t1: 104 });
    const times = ticks.map((t) => (t.x - OFFSET) / pps);
    expect(Math.min(...times)).toBeGreaterThan(99);
    expect(Math.max(...times)).toBeLessThan(105);
  });

  it('does not explode on a long comp at the deepest zoom', () => {
    // The regression this guards: full-comp generation at a sub-frame spacing
    // is ~900k objects for a ten-minute comp, which hangs the panel on a zoom.
    const ticks = generateRulerTicks(600, 4000, FPS, 0, OFFSET, { t0: 0, t1: 0.25 });
    expect(ticks.length).toBeLessThan(500);
  });

  it('covers the window edges, so a page boundary has no gap', () => {
    const pps = 100;
    const w = { t0: 10, t1: 14 };
    const ticks = generateRulerTicks(600, pps, FPS, 0, OFFSET, w);
    const times = ticks.map((t) => (t.x - OFFSET) / pps);
    // At least one tick at or before the window start and at or after its end.
    expect(Math.min(...times)).toBeLessThanOrEqual(w.t0);
    expect(Math.max(...times)).toBeGreaterThanOrEqual(w.t1);
  });

  it('covers the whole comp when given no window', () => {
    const pps = 100;
    const ticks = generateRulerTicks(5, pps, FPS, 0, OFFSET);
    const times = ticks.map((t) => (t.x - OFFSET) / pps);
    expect(Math.min(...times)).toBeCloseTo(0, 6);
    expect(Math.max(...times)).toBeCloseTo(5, 6);
  });

  it('is empty for a window past the end of the comp', () => {
    expect(generateRulerTicks(5, 100, FPS, 0, OFFSET, { t0: 50, t1: 60 })).toEqual([]);
  });

  it('survives a zero frame rate', () => {
    expect(() => generateRulerTicks(5, 100, 0, 0, OFFSET, { t0: 0, t1: 5 })).not.toThrow();
  });
});

describe('generateRulerTicks — labels', () => {
  it('labels majors and marks minors', () => {
    const ticks = generateRulerTicks(10, 100, FPS, 0, OFFSET, { t0: 0, t1: 5 });
    expect(majors(ticks)).toBeGreaterThan(0);
    expect(ticks.length).toBeGreaterThan(majors(ticks));
  });

  it('reads in frames at frame-level zoom', () => {
    const ticks = generateRulerTicks(10, 600, FPS, 0, OFFSET, { t0: 0, t1: 1 });
    const label = ticks.find((t) => t.major)?.label ?? '';
    expect(label).toMatch(/f$/);
  });

  it('reads in seconds when zoomed out', () => {
    const ticks = generateRulerTicks(60, 100, FPS, 0, OFFSET, { t0: 0, t1: 10 });
    expect(ticks.find((t) => t.major && t.x > OFFSET)?.label ?? '').toMatch(/s$/);
  });

  it('gives sub-frame labels a decimal, so neighbours stay distinct', () => {
    const ticks = generateRulerTicks(1, 4000, FPS, 0, OFFSET, { t0: 0, t1: 0.05 });
    const labels = ticks.filter((t) => t.major).map((t) => t.label);
    expect(labels.length).toBeGreaterThan(1);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('adds the comp start offset to the label but not to the position', () => {
    const pps = 100;
    const startSec = 10;
    const ticks = generateRulerTicks(5, pps, FPS, startSec, OFFSET, { t0: 0, t1: 5 });
    const first = ticks.find((t) => t.major)!;
    expect(first.x).toBeCloseTo(OFFSET, 6); // position is 0-based
    expect(first.label).toBe('10s'); // label carries the offset
  });
});
