/**
 * Undo must never step BEHIND the document you opened.
 *
 * The "Open" baseline is captured during boot, right after `seedDefaultScene()`.
 * A project loads afterwards and asynchronously, so history's `lastState` still
 * described the STARTER scene — which made the load itself an undoable entry
 * whose "before" was that starter content. One Ctrl+Z after opening a project
 * replaced it. That is a data-loss bug, not a usability one.
 */

import { useHistoryStore, baselineHistory, performUndo } from './historyStore';
import { getCommandSystem, setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { bumpScene } from './sceneStore';
import type { SceneNode } from '@core/types';

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

function addNode(id: string, parent: string | null): void {
  const node = {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: parent ? 'shape' : 'group' } }],
  } as unknown as SceneNode;
  if (parent) defaultSceneGraph.addChild(parent, node as never);
  else defaultSceneGraph.addNode(node);
}

function layerNames(): string[] {
  const out: string[] = [];
  defaultSceneGraph.traverse((n) => out.push(n.name ?? ''));
  return out;
}

describe('history baseline after a load', () => {
  beforeEach(() => {
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
    resetScene();
    getCommandSystem().getHistory().clear();
    useHistoryStore.getState().reset();
  });

  it('undo does not reach back into the pre-load scene', () => {
    // Boot: starter content, baselined.
    addNode('comp_root', null);
    addNode('starter_shape', 'comp_root');
    baselineHistory('Open');

    // A project loads over the top — this is what `restoreDocument` does.
    defaultSceneGraph.removeNode('starter_shape');
    addNode('user_layer', 'comp_root');
    baselineHistory('Open'); // ← the fix: the loaded doc is the new baseline

    // The user makes one edit, then undoes it.
    addNode('edit_layer', 'comp_root');
    bumpScene();
    useHistoryStore.getState().record('Add layer');
    performUndo();

    const names = layerNames();
    expect(names).toContain('user_layer');   // their project survives
    expect(names).not.toContain('edit_layer'); // their edit is undone
    expect(names).not.toContain('starter_shape'); // the starter scene stays gone
  });

  it('re-baselining clears the stack, so there is nothing behind the load', () => {
    addNode('comp_root', null);
    addNode('starter_shape', 'comp_root');
    baselineHistory('Open');
    addNode('mid_edit', 'comp_root');
    bumpScene();
    useHistoryStore.getState().record('Edit');
    expect(getCommandSystem().getHistory().getEntries().length).toBe(2);

    baselineHistory('Open');
    // Only the fresh baseline remains — undo cannot walk into a document that
    // is no longer loaded. (The baseline entry itself is a no-op: it is pushed
    // with before === after, so undoing it changes nothing.)
    const entries = getCommandSystem().getHistory().getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]!.label).toBe('Open');
  });

  it('a restore run through runRestoring is not recorded as an edit', () => {
    addNode('comp_root', null);
    baselineHistory('Open');
    // What a cross-window document push does.
    useHistoryStore.getState().runRestoring(() => {
      addNode('from_other_window', 'comp_root');
      bumpScene();
    });
    const before = getCommandSystem().getHistory().getEntries().length;
    useHistoryStore.getState().record('should not appear');
    // No NEW entry: runRestoring re-baselines `lastState`, so the synced
    // document reads as "no local change" rather than as an undoable edit.
    expect(getCommandSystem().getHistory().getEntries().length).toBe(before);
  });
});
