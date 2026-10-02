/**
 * The drop readout: recent pressure, from counters that only ever grow.
 *
 * The bug this replaces was an indicator that could not clear. Platform drop
 * counters are cumulative per element and the elements are reused across loop
 * passes, so a raw total against a fixed threshold went red on one rough pass
 * and stayed red for the session — a warning reading "still broken" over a
 * perfect picture. The property under test is therefore the CLEARING as much
 * as the counting.
 */

import { DropRateWindow } from './videoPlaybackDiag';

const counts = (entries: Record<string, number>): Map<string, number> =>
  new Map(Object.entries(entries));

describe('DropRateWindow', () => {
  it('reports the delta, not the lifetime total', () => {
    const w = new DropRateWindow(4000);
    // The element arrives with 300 lifetime drops — a rough pass that already
    // happened. That history is a baseline, not news.
    expect(w.sample(0, counts({ a: 300 }))).toBe(0);
    expect(w.sample(500, counts({ a: 312 }))).toBe(12);
  });

  it('CLEARS once playback recovers — the whole point', () => {
    const w = new DropRateWindow(4000);
    w.sample(0, counts({ a: 0 }));
    expect(w.sample(500, counts({ a: 200 }))).toBe(200);   // rough pass
    // Smooth from here on: the counter stops moving.
    let recent = 200;
    for (let t = 1000; t <= 6000; t += 500) recent = w.sample(t, counts({ a: 200 }));
    // The old readout would still say 200 here, red, forever.
    expect(recent).toBe(0);
  });

  it('sums sustained pressure across the window instead of one tick', () => {
    const w = new DropRateWindow(4000);
    w.sample(0, counts({ a: 0 }));
    let recent = 0;
    // 5 drops per half-second tick — small per tick, real over the window.
    for (let t = 500; t <= 4000; t += 500) recent = w.sample(t, counts({ a: t / 100 }));
    expect(recent).toBe(40);
  });

  it('never reads a recreated element as negative drops', () => {
    const w = new DropRateWindow(4000);
    w.sample(0, counts({ a: 500 }));
    // The entry was torn down and a fresh element re-created under the same
    // key: its counter restarts at zero. That is not minus five hundred drops.
    expect(w.sample(500, counts({ a: 0 }))).toBe(0);
    expect(w.sample(1000, counts({ a: 7 }))).toBe(7);
  });

  it('does not re-count history when a paused element comes back', () => {
    const w = new DropRateWindow(4000);
    w.sample(0, counts({ a: 100 }));
    // Layer leaves the live set for a few ticks (no sample for `a`)…
    w.sample(500, counts({}));
    w.sample(1000, counts({}));
    // …and returns with the same lifetime counter. Nothing happened.
    expect(w.sample(1500, counts({ a: 100 }))).toBe(0);
  });

  it('tracks elements independently', () => {
    const w = new DropRateWindow(4000);
    w.sample(0, counts({ a: 10, b: 10 }));
    expect(w.sample(500, counts({ a: 10, b: 25 }))).toBe(15);
  });
});
