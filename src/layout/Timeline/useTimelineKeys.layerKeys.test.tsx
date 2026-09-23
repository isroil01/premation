/**
 * The keys `useTimelineKeys` owns, pressed for real.
 *
 * Every bug here was a key that REACHED nothing: the controller methods behind
 * them were fine (or fixable in isolation) and the handler never called them.
 * So the medium is a `keydown` dispatched on the element that had focus, not a
 * call to the controller — that is the only place "Alt+Page Down does nothing"
 * is observable.
 */

import { act, renderHook } from '@testing-library/react';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useSelectionStore } from '@stores/selectionStore';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { useTimelineKeys } from './useTimelineKeys';

// The bar edits go through the engine API (B3): the scene is built through
// the engine too, and every press is awaited (`engineIdle`) before reading.
let h: Harness & { engine: LocalEngine };
let A = '';

beforeEach(async () => {
  h = await setupAppEngine();
  A = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'a', init: [] })).layer;
  const c = getTimelineController();
  c.syncFromScene('comp_root');
  useSelectionStore.getState().set([A]);
  document.body.innerHTML = '';
});

afterEach(async () => {
  await h.dispose();
});

async function idle(): Promise<void> {
  await act(async () => { await engineIdle(); });
}

const bar = () => getTimelineController().getLayersForNode(A)[0]!;

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

/** A focused element inside a surface that claims `j` / `k`, as the timeline root does. */
function timelineRow(): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-shortcut-claim', 'delete backspace j k');
  const row = document.createElement('div');
  row.tabIndex = 0;
  root.appendChild(row);
  document.body.appendChild(root);
  return row;
}

describe('Alt+Page Down / Page Up — nudge the selected layers', () => {
  it('POSITIVE CONTROL: unmodified Page Down is still "next frame", not a nudge', () => {
    renderHook(() => useTimelineKeys());
    const c = getTimelineController();
    c.timeline.seek(10);
    press(window, { key: 'PageDown' });
    expect(Math.round(c.timeline.currentFrame)).toBe(11);
    expect(bar().start).toBe(0);
  });

  it('Alt+Page Down moves the layer one frame later and leaves the playhead alone', async () => {
    renderHook(() => useTimelineKeys());
    const c = getTimelineController();
    c.timeline.seek(10);
    const e = press(window, { key: 'PageDown', altKey: true });
    await idle();
    expect(bar().start).toBe(1);
    expect(historyLabels().at(-1)).toBe('Nudge Layer');
    expect(Math.round(c.timeline.currentFrame)).toBe(10);
    expect(e.defaultPrevented).toBe(true);
  });

  it('Alt+Page Up moves it one frame earlier', async () => {
    renderHook(() => useTimelineKeys());
    await h.run({ type: 'moveLayersInTime', layers: [A], delta: 705_600_000, ripple: false }); // 1 s = 30 frames
    press(window, { key: 'PageUp', altKey: true });
    await idle();
    expect(bar().start).toBe(29);
  });

  it('Shift makes it ten frames, both ways', async () => {
    renderHook(() => useTimelineKeys());
    press(window, { key: 'PageDown', altKey: true, shiftKey: true });
    await idle();
    expect(bar().start).toBe(10);
    press(window, { key: 'PageUp', altKey: true, shiftKey: true });
    await idle();
    expect(bar().start).toBe(0);
  });

  it('is undoable, one entry per press', async () => {
    renderHook(() => useTimelineKeys());
    const before = historyLabels().length;
    press(window, { key: 'PageDown', altKey: true, shiftKey: true });
    await idle();
    expect(bar().start).toBe(10);
    expect(historyLabels().length).toBe(before + 1);
    await h.run({ type: 'undo' });
    expect(bar().start).toBe(0);
    await h.run({ type: 'redo' });
    expect(bar().start).toBe(10);
  });

  it('leaves the key alone with no layer selected', () => {
    renderHook(() => useTimelineKeys());
    useSelectionStore.getState().set([]);
    const e = press(window, { key: 'PageDown', altKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(bar().start).toBe(0);
  });

  it('other Alt chords still fall through untouched', () => {
    renderHook(() => useTimelineKeys());
    const c = getTimelineController();
    c.timeline.seek(10);
    press(window, { key: 'Home', altKey: true });
    expect(Math.round(c.timeline.currentFrame)).toBe(10);
  });
});

describe('] from the keyboard', () => {
  it('moves the out point of a full-length layer to the playhead', async () => {
    renderHook(() => useTimelineKeys());
    const c = getTimelineController();
    c.timeline.seek(60);
    press(window, { key: ']' });
    await idle();
    expect(bar().end).toBe(60);
    expect(historyLabels().at(-1)).toBe('Move Layer Out Point');
  });
});

describe('J / K — previous / next keyframe only where the timeline claimed them', () => {
  it('K from the timeline goes to the next keyframe', () => {
    renderHook(() => useTimelineKeys());
    const next = jest.spyOn(getTimelineController(), 'goToNextKeyframe').mockImplementation(() => undefined as never);
    const prev = jest.spyOn(getTimelineController(), 'goToPrevKeyframe').mockImplementation(() => undefined as never);
    const row = timelineRow();
    press(row, { key: 'k' });
    press(row, { key: 'j' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(prev).toHaveBeenCalledTimes(1);
    next.mockRestore();
    prev.mockRestore();
  });

  it('J / K from anywhere else are NOT keyframe navigation — they are the shuttle’s', () => {
    // Before: J stepped keyframes from any panel the shuttle did not own, while
    // K was eaten by a global chord — one half of a pair, working alone.
    renderHook(() => useTimelineKeys());
    const next = jest.spyOn(getTimelineController(), 'goToNextKeyframe').mockImplementation(() => undefined as never);
    const prev = jest.spyOn(getTimelineController(), 'goToPrevKeyframe').mockImplementation(() => undefined as never);
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    const ej = press(elsewhere, { key: 'j' });
    press(elsewhere, { key: 'k' });
    press(window, { key: 'j' });
    expect(next).not.toHaveBeenCalled();
    expect(prev).not.toHaveBeenCalled();
    expect(ej.defaultPrevented).toBe(false);
    next.mockRestore();
    prev.mockRestore();
  });
});
