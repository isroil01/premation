/**
 * Unrelated edits must not share an undo step.
 *
 * History coalesces a burst into one entry so a drag is one Ctrl+Z. But the
 * window was a plain 700 ms timer with no notion of WHAT was being edited, so
 * anything that happened to land inside it merged: recolour one layer, nudge
 * another, and a single Ctrl+Z took back both with no way to recover just one.
 *
 * `schedule(key)` keeps the coalescing for a burst on the same target and
 * commits the pending entry when the target changes.
 *
 * LIMIT, deliberately encoded below: snapshots are captured when the entry is
 * committed, not when the edit happened, so the first change of the NEW target
 * lands in the previous entry. Each action still gets its own undo step — but
 * the boundary is off by one event. Only per-operation commands fix that
 * properly; this is a mitigation, not a cure.
 */

import { useHistoryStore } from './historyStore';
import { getCommandSystem, setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

let seq = 0;
/** Mutate the graph so each scheduled entry has something to record. */
function touchScene(): void {
  const id = `n_${(seq += 1)}`;
  defaultSceneGraph.addNode({
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
}

const entries = (): number => getCommandSystem().getHistory().getEntries().length;

describe('history granularity', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
    resetScene();
    useHistoryStore.getState().reset();
    touchScene();
    useHistoryStore.getState().record('base', true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('coalesces a burst on ONE target into a single entry', () => {
    const before = entries();
    for (let i = 0; i < 5; i++) {
      touchScene();
      useHistoryStore.getState().schedule('node:a:x');
    }
    jest.advanceTimersByTime(1000);
    expect(entries()).toBe(before + 1);
  });

  it('commits the pending entry when the edit target changes', () => {
    const before = entries();
    touchScene();
    useHistoryStore.getState().schedule('node:a:x');
    // A different layer, well inside the 700 ms window: this commits A.
    touchScene();
    useHistoryStore.getState().schedule('node:b:fill');
    // …and B's burst carries on, as a real edit does.
    touchScene();
    useHistoryStore.getState().schedule('node:b:fill');
    jest.advanceTimersByTime(1000);
    // Two actions → two undo steps, not one.
    expect(entries()).toBe(before + 2);
  });

  it('treats a structural change as its own action', () => {
    const before = entries();
    touchScene();
    useHistoryStore.getState().schedule('node:a:x');
    touchScene();
    useHistoryStore.getState().schedule('scene');
    touchScene();
    useHistoryStore.getState().schedule('scene');
    jest.advanceTimersByTime(1000);
    expect(entries()).toBe(before + 2);
  });

  it('still coalesces when no key is supplied (old callers unchanged)', () => {
    const before = entries();
    touchScene();
    useHistoryStore.getState().schedule();
    touchScene();
    useHistoryStore.getState().schedule();
    jest.advanceTimersByTime(1000);
    expect(entries()).toBe(before + 1);
  });
});
