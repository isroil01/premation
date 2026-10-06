/**
 * The tracker store's two load-bearing behaviours: it must not leave the
 * viewport armed for a click that will never come, and it must be able to
 * tell a GLOBAL shortcut to stand down.
 *
 * The second one has a source-level guard as well as a unit test, and that
 * deserves an explanation. Escape is bound to `BuiltinCommands.Deselect`
 * through `ShortcutManager`, which listens on window in the CAPTURE phase and
 * is registered at app boot — so a listener mounted later by the Track Motion
 * panel cannot win the chord, with or without `stopImmediatePropagation`. The
 * only supported way for a transient mode to take a bound chord is for the
 * competing command to report itself DISABLED, which lets the event fall
 * through. That coupling lives in a closure inside a 900-line provider file
 * and is invisible from here; deleting it does not fail a type check, does not
 * fail a render test, and reappears as "Escape closes the tracker panel",
 * which reads like a layout bug rather than a shortcut one.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPickArmed, pointCountFor, samplesAt, spliceResult, useTrackerStore } from './trackerStore';

beforeEach(() => {
  useTrackerStore.getState().clear();
});

describe('isPickArmed', () => {
  it('is false when the tracker is idle', () => {
    expect(isPickArmed()).toBe(false);
  });

  it('is true only while waiting for the viewport click', () => {
    useTrackerStore.getState().activate('video_1');
    useTrackerStore.getState().setAutoPhase('picking');
    expect(isPickArmed()).toBe(true);

    useTrackerStore.getState().setAutoPhase('analyzing');
    expect(isPickArmed()).toBe(false);
  });

  it('goes false when the pick turns into a run', () => {
    useTrackerStore.getState().activate('video_1');
    useTrackerStore.getState().setAutoPhase('picking');
    useTrackerStore.getState().finishTracking(null, 'done');
    expect(isPickArmed()).toBe(false);
  });

  it('goes false when the panel closes mid-pick', () => {
    // Closing the section unmounts the overlay; an armed phase left behind
    // would keep a global chord suppressed with nothing on screen to explain
    // why Escape had stopped deselecting.
    useTrackerStore.getState().activate('video_1');
    useTrackerStore.getState().setAutoPhase('picking');
    useTrackerStore.getState().disarm();
    expect(isPickArmed()).toBe(false);
  });

  it('goes false when the tracker moves to another layer', () => {
    useTrackerStore.getState().activate('video_1');
    useTrackerStore.getState().setAutoPhase('picking');
    useTrackerStore.getState().activate('video_2');
    expect(isPickArmed()).toBe(false);
  });
});

describe('the Escape/Deselect stand-down', () => {
  it('is wired into the Deselect command, which is where Escape is decided', () => {
    const src = readFileSync(join(process.cwd(), 'src/providers/Providers.tsx'), 'utf8');
    const start = src.indexOf('BuiltinCommands.Deselect');
    expect(start).toBeGreaterThan(-1);
    // The binding runs from the id to its `execute` — `enabled` sits between.
    const binding = src.slice(start, src.indexOf('execute:', start));
    expect(binding).toContain("shortcut: { key: 'Escape' }");
    expect(binding).toContain('isPickArmed()');
  });
});

describe('tracker workflow (AE parity 3.6)', () => {
  const smp = (t: number, x: number) => ({ compTime: t, x, y: 0, confidence: 0.9, coasted: false });
  const result = (xs: Array<[number, number]>) => ({ tracks: [xs.map(([t, x]) => smp(t, x))], sourceWidth: 100, sourceHeight: 100, status: 'completed' as const });

  it('splices a forward walk after the origin and a backward one before it', () => {
    const held = result([[0, 0], [1, 1], [2, 2], [3, 3]]);
    const fwd = spliceResult(held, result([[2, 20], [3, 30]]), 'forward', 2);
    expect(fwd.tracks[0]!.map((s) => s.x)).toEqual([0, 1, 20, 30]);
    const back = spliceResult(held, result([[0, -10], [1, -11]]), 'backward', 1);
    expect(back.tracks[0]!.map((s) => s.x)).toEqual([-10, -11, 2, 3]);
    expect(spliceResult(held, result([[5, 5]]), 'both', 1).tracks[0]!.map((s) => s.x)).toEqual([5]);
  });

  it('a handle dragged with a track held corrects that frame and keeps the track', () => {
    const st = useTrackerStore.getState();
    st.clear();
    st.activate('v');
    st.setMode('stabilize', 100, 100);
    st.finishTracking(result([[0, 0], [0.5, 5], [1, 10]]), null);
    st.syncToTime(0.5);
    expect(useTrackerStore.getState().points[0]).toEqual({ x: 5, y: 0 });
    useTrackerStore.getState().setPoint(0, 7, 3);
    const s = useTrackerStore.getState();
    expect(s.result?.tracks[0]![1]).toMatchObject({ x: 7, y: 3, confidence: 1, coasted: false });
    expect(s.corrections).toEqual([0.5]);
    expect(samplesAt(s.result!, 1)).toEqual([{ x: 10, y: 0 }]);
  });

  it('stabilize with rotation adds the second point; turning it off removes it', () => {
    const st = useTrackerStore.getState();
    st.clear();
    st.activate('v');
    st.setMode('stabilize', 100, 100);
    st.seedPoints(100, 100);
    expect(useTrackerStore.getState().points).toHaveLength(1);
    st.setStabilize(true, false, 100, 100);
    expect(useTrackerStore.getState().points).toHaveLength(2);
    expect(pointCountFor('stabilize', true)).toBe(2);
    st.setStabilize(false, false, 100, 100);
    expect(useTrackerStore.getState().points).toHaveLength(1);
  });
});
