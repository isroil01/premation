/**
 * The keys `useTimelineKeys` owns, pressed for real.
 *
 * Every bug here was a key that REACHED nothing: the controller methods behind
 * them were fine (or fixable in isolation) and the handler never called them.
 * So the medium is a `keydown` dispatched on the element that had focus, not a
 * call to the controller — that is the only place "Alt+Page Down does nothing"
 * is observable.
 */

import { renderHook } from '@testing-library/react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useSelectionStore } from '@stores/selectionStore';
import type { SceneNode } from '@core/types';
import { useTimelineKeys } from './useTimelineKeys';

const ROOT = 'comp_root';

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: ROOT, name: 'Composition 1', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  defaultSceneGraph.addChild(ROOT, {
    id: 'a', name: 'a', parent: ROOT, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: 'a_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, width: 50, height: 50 } },
    ],
  } as unknown as SceneNode);
  const c = getTimelineController();
  c.reset();
  c.getLayersForNode('a');
  c.syncFromScene(ROOT);
  useSelectionStore.getState().set(['a']);
  document.body.innerHTML = '';
});

const bar = () => getTimelineController().getLayersForNode('a')[0]!;

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

  it('Alt+Page Down moves the layer one frame later and leaves the playhead alone', () => {
    renderHook(() => useTimelineKeys());
    const c = getTimelineController();
    c.timeline.seek(10);
    const e = press(window, { key: 'PageDown', altKey: true });
    expect(bar().start).toBe(1);
    expect(Math.round(c.timeline.currentFrame)).toBe(10);
    expect(e.defaultPrevented).toBe(true);
  });

  it('Alt+Page Up moves it one frame earlier', () => {
    renderHook(() => useTimelineKeys());
    getTimelineController().setClipStart(bar().id, 1); // 30 frames
    press(window, { key: 'PageUp', altKey: true });
    expect(bar().start).toBe(29);
  });

  it('Shift makes it ten frames, both ways', () => {
    renderHook(() => useTimelineKeys());
    press(window, { key: 'PageDown', altKey: true, shiftKey: true });
    expect(bar().start).toBe(10);
    press(window, { key: 'PageUp', altKey: true, shiftKey: true });
    expect(bar().start).toBe(0);
  });

  it('is undoable', () => {
    renderHook(() => useTimelineKeys());
    press(window, { key: 'PageDown', altKey: true, shiftKey: true });
    expect(bar().start).toBe(10);
    getCommandSystem().getHistory().undo();
    expect(bar().start).toBe(0);
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
  it('moves the out point of a full-length layer to the playhead', () => {
    renderHook(() => useTimelineKeys());
    const c = getTimelineController();
    c.timeline.seek(60);
    press(window, { key: ']' });
    expect(bar().end).toBe(60);
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
