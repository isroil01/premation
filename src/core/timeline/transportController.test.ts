/**
 * The shared transport controller: JKL rates, K+J / K+L stepping, in/out
 * summaries — all against a fake driver, so the tests
 * describe the contract both viewers rely on rather than either viewer.
 */

import {
  createShuttle,
  threePointSummary,
  type TransportDriver,
} from './transportController';

type FakeDriver = TransportDriver & { time: number; paused: number };

function fakeDriver(over: Partial<TransportDriver> = {}): FakeDriver {
  const d: FakeDriver = {
    time: 1,
    paused: 0,
    getTime: () => d.time,
    duration: () => 10,
    fps: () => 30,
    seek: (t: number) => { d.time = t; },
    pause: () => { d.paused++; },
    ...over,
  };
  return d;
}

/** Manual interval timers so a "tick" is a function call, not wall-clock. */
function fakeTimers(): { opts: { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (h: unknown) => void; now: () => number }; tick: (ms: number) => void; active: () => number } {
  const timers = new Map<number, () => void>();
  let id = 0;
  let clock = 0;
  return {
    opts: {
      setInterval: (fn) => { timers.set(++id, fn); return id; },
      clearInterval: (h) => { timers.delete(h as number); },
      now: () => clock,
    },
    tick: (ms) => {
      clock += ms;
      for (const fn of [...timers.values()]) fn();
    },
    active: () => timers.size,
  };
}

describe('createShuttle — JKL rates', () => {
  it('L walks 1× → 2× → 4× and caps there; J mirrors in reverse', () => {
    const t = fakeTimers();
    const s = createShuttle(fakeDriver(), t.opts);
    s.pressL(); expect(s.rate()).toBe(1);
    s.pressL(); expect(s.rate()).toBe(2);
    s.pressL(); expect(s.rate()).toBe(4);
    s.pressL(); expect(s.rate()).toBe(4);
    s.pressJ(); expect(s.rate()).toBe(-1);
    s.pressJ(); expect(s.rate()).toBe(-2);
    s.pressJ(); expect(s.rate()).toBe(-4);
    s.pressJ(); expect(s.rate()).toBe(-4);
    s.pressL(); expect(s.rate()).toBe(1);
    s.dispose();
  });

  it('K stops and pauses the driver; the rate change is announced', () => {
    const t = fakeTimers();
    const d = fakeDriver();
    const rates: number[] = [];
    const s = createShuttle(d, { ...t.opts, onRateChange: (r) => rates.push(r) });
    s.pressL();
    s.pressK();
    expect(s.rate()).toBe(0);
    expect(d.paused).toBeGreaterThan(0);
    expect(rates).toEqual([1, 0]);
    s.dispose();
  });

  it('a timer-driven shuttle moves the playhead by rate × dt and clamps at the ends', () => {
    const t = fakeTimers();
    const d = fakeDriver();
    const s = createShuttle(d, t.opts);
    s.pressJ(); // −1×
    t.tick(500);
    expect(d.time).toBeCloseTo(0.5, 5);
    t.tick(1000); // would go below zero → clamps and stops
    expect(d.time).toBe(0);
    expect(s.rate()).toBe(0);
    expect(t.active()).toBe(0);
    s.dispose();
  });

  it('a driver with native forward playback takes over and no timer runs', () => {
    const t = fakeTimers();
    const rates: number[] = [];
    const d = fakeDriver({ playForward: (r) => { rates.push(r); return true; } });
    const s = createShuttle(d, t.opts);
    s.pressL();
    expect(rates).toEqual([1]);
    expect(t.active()).toBe(0);
    s.pressJ(); // reverse still needs the timer
    expect(t.active()).toBe(1);
    s.dispose();
  });
});

describe('createShuttle — K held steps frames', () => {
  it('K+J / K+L step exactly one frame and never start a shuttle', () => {
    const t = fakeTimers();
    const d = fakeDriver();
    const s = createShuttle(d, t.opts);
    s.keyDown('k');
    expect(s.kHeld()).toBe(true);
    s.keyDown('l');
    expect(d.time).toBeCloseTo(1 + 1 / 30, 9);
    expect(s.rate()).toBe(0);
    s.keyDown('j');
    s.keyDown('j');
    expect(d.time).toBeCloseTo(1 - 1 / 30, 9);
    s.keyUp('k');
    expect(s.kHeld()).toBe(false);
    s.keyDown('l');
    expect(s.rate()).toBe(1);
    s.dispose();
  });

  it('a held K stops a running shuttle once, and key repeat does not re-fire', () => {
    const t = fakeTimers();
    const d = fakeDriver();
    const s = createShuttle(d, t.opts);
    s.pressL();
    s.keyDown('k');
    s.keyDown('k');
    expect(s.rate()).toBe(0);
    expect(d.paused).toBe(1);
    s.dispose();
  });

  it('stepFrames clamps to [0, duration]', () => {
    const t = fakeTimers();
    const d = fakeDriver();
    const s = createShuttle(d, t.opts);
    d.time = 0;
    s.stepFrames(-5);
    expect(d.time).toBe(0);
    d.time = 9.99;
    s.stepFrames(5);
    expect(d.time).toBe(10);
    s.dispose();
  });
});

describe('threePointSummary', () => {
  it('fills a missing in with 0 and a missing out with the duration', () => {
    expect(threePointSummary(null, null, 4)).toEqual({ inSec: 0, outSec: 4, durationSec: 4 });
    expect(threePointSummary(1, null, 4)).toEqual({ inSec: 1, outSec: 4, durationSec: 3 });
    expect(threePointSummary(null, 2.5, 4)).toEqual({ inSec: 0, outSec: 2.5, durationSec: 2.5 });
  });
  it('rejects an empty or inverted range and an unknown duration with no out', () => {
    expect(threePointSummary(3, 2, 4)).toBeNull();
    expect(threePointSummary(2, 2, 4)).toBeNull();
    expect(threePointSummary(null, null, 0)).toBeNull();
  });
});
