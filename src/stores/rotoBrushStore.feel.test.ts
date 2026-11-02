/**
 * The brush store's feel: hardness, one-write strokes, the press queued
 * behind a short job, and background tracking that blocks nothing.
 */

import { useRotoBrushStore } from './rotoBrushStore';

beforeEach(() => {
  const s = useRotoBrushStore.getState();
  s.setNode(null);
  s.setNode('layer');
  s.setBusy(false);
  s.setTracking(false);
  s.setHardness(100);
  s.setSize(24);
});

describe('hardness', () => {
  it('clamps to 0…100 and rounds', () => {
    const s = useRotoBrushStore.getState();
    s.setHardness(140);
    expect(useRotoBrushStore.getState().hardness).toBe(100);
    s.setHardness(-5);
    expect(useRotoBrushStore.getState().hardness).toBe(0);
    s.setHardness(42.6);
    expect(useRotoBrushStore.getState().hardness).toBe(43);
    s.setHardness(Number.NaN);
    expect(useRotoBrushStore.getState().hardness).toBe(100);
  });

  it('rides on every stroke made, whether painted live or committed at once', () => {
    const s = useRotoBrushStore.getState();
    s.setHardness(35);
    s.begin('fg', { x: 0, y: 0 }, 1);
    expect(useRotoBrushStore.getState().live?.hardness).toBe(35);
    s.cancelLive();
    const stroke = s.addStroke('bg', [{ x: 1, y: 2 }, { x: 3, y: 4 }], 2);
    expect(stroke.hardness).toBe(35);
    expect(stroke.kind).toBe('bg');
    expect(stroke.time).toBe(2);
    expect(useRotoBrushStore.getState().strokes).toEqual([stroke]);
  });
});

describe('a press during a short job', () => {
  it('runs at once when nothing is in flight', () => {
    const run = jest.fn();
    expect(useRotoBrushStore.getState().queuePress(run)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('is held while busy and runs when the job returns; a newer press replaces it', () => {
    const s = useRotoBrushStore.getState();
    s.setBusy(true);
    const first = jest.fn();
    const second = jest.fn();
    expect(s.queuePress(first)).toBe(false);
    expect(s.queuePress(second)).toBe(false);
    expect(first).not.toHaveBeenCalled();
    s.setBusy(true, 0.5);
    expect(second).not.toHaveBeenCalled();
    s.setBusy(false);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(useRotoBrushStore.getState().queued).toBeNull();
  });

  it('is dropped when the layer changes (it was aimed at the old one)', () => {
    const s = useRotoBrushStore.getState();
    s.setBusy(true);
    const run = jest.fn();
    s.queuePress(run);
    s.setNode('other');
    s.setBusy(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('background tracking', () => {
  it('is its own flag with its own progress, never busy', () => {
    const s = useRotoBrushStore.getState();
    s.setTracking(true, 0.42);
    let st = useRotoBrushStore.getState();
    expect(st.tracking).toBe(true);
    expect(st.trackingProgress).toBeCloseTo(0.42);
    expect(st.busy).toBe(false);
    s.setTracking(true, 7);
    expect(useRotoBrushStore.getState().trackingProgress).toBe(1);
    s.setTracking(false);
    st = useRotoBrushStore.getState();
    expect(st.tracking).toBe(false);
    expect(st.trackingProgress).toBe(0);
  });

  it('does not hold a press: queuePress runs at once while only tracking', () => {
    const s = useRotoBrushStore.getState();
    s.setTracking(true, 0.1);
    const run = jest.fn();
    expect(s.queuePress(run)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
