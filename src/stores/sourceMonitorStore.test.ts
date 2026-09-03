/**
 * The source monitor's in/out arithmetic.
 *
 * These marks decide what gets inserted into the edit, so the invariants are
 * not cosmetic: a range with `out <= in` would reach `Clip.trimEnd` and be
 * clamped to a one-frame bar — an insert that looks like it worked and isn't
 * the shot. The clamp-at-the-store rule (rather than at each of the four
 * action buttons) is what this file pins.
 */

import { useSourceMonitorStore, sourceRange, clampSourceTime, currentSourceRange } from './sourceMonitorStore';

const reset = (): void => useSourceMonitorStore.getState().close();
beforeEach(reset);

describe('clampSourceTime', () => {
  it('clamps into [0, duration]', () => {
    expect(clampSourceTime(-3, 10)).toBe(0);
    expect(clampSourceTime(4, 10)).toBe(4);
    expect(clampSourceTime(40, 10)).toBe(10);
  });
  it('an UNKNOWN duration (0) still clamps at zero', () => {
    expect(clampSourceTime(-1, 0)).toBe(0);
    expect(clampSourceTime(99, 0)).toBe(99);
  });
  it('non-finite input lands at 0 instead of poisoning comparisons', () => {
    expect(clampSourceTime(NaN, 10)).toBe(0);
    expect(clampSourceTime(Infinity, 0)).toBe(0);
  });
});

describe('open / close', () => {
  it('opening an asset shows it from the top with no marks', () => {
    useSourceMonitorStore.getState().open('a1', 8);
    const s = useSourceMonitorStore.getState();
    expect(s).toMatchObject({ assetId: 'a1', duration: 8, time: 0, inPoint: null, outPoint: null, playing: false });
  });

  it('opening a DIFFERENT asset drops the previous marks', () => {
    const s = useSourceMonitorStore.getState();
    s.open('a1', 8);
    s.setIn(2);
    s.setOut(5);
    s.open('a2', 3);
    expect(useSourceMonitorStore.getState()).toMatchObject({ assetId: 'a2', inPoint: null, outPoint: null, time: 0 });
  });

  it('re-opening the SAME asset keeps the range — a double-click is not a reset', () => {
    const s = useSourceMonitorStore.getState();
    s.open('a1', 8);
    s.setIn(2);
    s.setOut(5);
    s.setTime(4);
    useSourceMonitorStore.getState().open('a1', 8);
    expect(useSourceMonitorStore.getState()).toMatchObject({ inPoint: 2, outPoint: 5, time: 4 });
  });

  it('close empties everything', () => {
    const s = useSourceMonitorStore.getState();
    s.open('a1', 8);
    s.setIn(1);
    s.setPlaying(true);
    useSourceMonitorStore.getState().close();
    expect(useSourceMonitorStore.getState()).toMatchObject({ assetId: null, duration: 0, inPoint: null, playing: false });
  });
});

describe('marks are clamped to the asset duration', () => {
  it('a mark past the end lands on the end', () => {
    const s = useSourceMonitorStore.getState();
    s.open('a1', 6);
    s.setOut(99);
    expect(useSourceMonitorStore.getState().outPoint).toBe(6);
  });

  it('a negative mark lands on zero', () => {
    const s = useSourceMonitorStore.getState();
    s.open('a1', 6);
    s.setIn(-4);
    expect(useSourceMonitorStore.getState().inPoint).toBe(0);
  });

  it('marks default to the current playhead', () => {
    const s = useSourceMonitorStore.getState();
    s.open('a1', 6);
    s.setTime(2.5);
    useSourceMonitorStore.getState().setIn();
    useSourceMonitorStore.getState().setTime(4);
    useSourceMonitorStore.getState().setOut();
    expect(useSourceMonitorStore.getState()).toMatchObject({ inPoint: 2.5, outPoint: 4 });
  });

  it('a duration learned LATE re-clamps marks made against an unknown length', () => {
    const s = useSourceMonitorStore.getState();
    s.open('a1'); // no probed duration — the browser import path
    s.setIn(1);
    s.setOut(20);
    expect(useSourceMonitorStore.getState().outPoint).toBe(20);
    useSourceMonitorStore.getState().setDuration(5);
    expect(useSourceMonitorStore.getState()).toMatchObject({ inPoint: 1, outPoint: 5, duration: 5 });
  });
});

describe('in <= out is enforced', () => {
  it('marking IN past the out point drops the out', () => {
    const s = useSourceMonitorStore.getState();
    s.open('a1', 10);
    s.setOut(3);
    useSourceMonitorStore.getState().setIn(7);
    expect(useSourceMonitorStore.getState()).toMatchObject({ inPoint: 7, outPoint: null });
  });

  it('marking OUT before the in point drops the in', () => {
    const s = useSourceMonitorStore.getState();
    s.open('a1', 10);
    s.setIn(7);
    useSourceMonitorStore.getState().setOut(3);
    expect(useSourceMonitorStore.getState()).toMatchObject({ inPoint: null, outPoint: 3 });
  });

  it('marks at the SAME instant cannot both stand — a zero-length range is not a range', () => {
    const s = useSourceMonitorStore.getState();
    s.open('a1', 10);
    s.setIn(4);
    useSourceMonitorStore.getState().setOut(4);
    expect(useSourceMonitorStore.getState()).toMatchObject({ inPoint: null, outPoint: 4 });
  });

  it('clearInOut leaves the playhead alone', () => {
    const s = useSourceMonitorStore.getState();
    s.open('a1', 10);
    s.setIn(2); s.setOut(5); s.setTime(3);
    useSourceMonitorStore.getState().clearInOut();
    expect(useSourceMonitorStore.getState()).toMatchObject({ inPoint: null, outPoint: null, time: 3 });
  });
});

describe('sourceRange', () => {
  it('is the marked span when both marks exist', () => {
    expect(sourceRange({ duration: 10, inPoint: 2, outPoint: 5 })).toEqual({ inSec: 2, outSec: 5 });
  });
  it('falls back to the whole clip when nothing is marked', () => {
    expect(sourceRange({ duration: 10, inPoint: null, outPoint: null })).toEqual({ inSec: 0, outSec: 10 });
  });
  it('an in point alone runs to the end', () => {
    expect(sourceRange({ duration: 10, inPoint: 4, outPoint: null })).toEqual({ inSec: 4, outSec: 10 });
  });
  it('an out point alone runs from the head', () => {
    expect(sourceRange({ duration: 10, inPoint: null, outPoint: 4 })).toEqual({ inSec: 0, outSec: 4 });
  });
  it('is null with no length known and no out point — there is nothing to insert', () => {
    expect(sourceRange({ duration: 0, inPoint: 1, outPoint: null })).toBeNull();
  });
  it('is null for a degenerate span', () => {
    expect(sourceRange({ duration: 10, inPoint: 5, outPoint: 5 })).toBeNull();
  });

  it('currentSourceRange reads the live store', () => {
    const s = useSourceMonitorStore.getState();
    s.open('a1', 10);
    s.setIn(1);
    useSourceMonitorStore.getState().setOut(6);
    expect(currentSourceRange()).toEqual({ inSec: 1, outSec: 6 });
  });
});

describe('transport', () => {
  it('toggles', () => {
    const s = useSourceMonitorStore.getState();
    s.open('a1', 10);
    useSourceMonitorStore.getState().togglePlay();
    expect(useSourceMonitorStore.getState().playing).toBe(true);
    useSourceMonitorStore.getState().togglePlay();
    expect(useSourceMonitorStore.getState().playing).toBe(false);
  });
});
