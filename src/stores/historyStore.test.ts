/**
 * History recording — the debounce race and the missing baseline entry.
 *
 * The race: edits schedule a snapshot 700ms out. Press Ctrl+Z inside that
 * window and undo popped the PREVIOUS entry, whose "before" predates the
 * still-unrecorded edit — so one keystroke silently discarded two actions.
 * Nothing caught it because the debounce lived in a closure in Providers, with
 * no way to observe or flush it.
 */

import { useHistoryStore, performUndo, performRedo, StoreSnapshotCommand } from './historyStore';
import { CommandSystem, getCommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

jest.useFakeTimers();

// The CommandSystem is a boot-time singleton the app installs in Providers.
beforeAll(() => {
  setCommandSystem(
    new CommandSystem({
      getState: () => ({}),
      services: {
        undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
        selection: { get: () => [], set: () => {}, clear: () => {} },
        panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
        workspace: { setActive: () => {}, getActive: () => '' },
        get: () => undefined,
      },
    }),
  );
});

function node(id: string, x: number): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y: 0 } }],
  } as unknown as SceneNode;
}

/** Move the layer — a real, observable scene edit. */
function moveTo(x: number): void {
  defaultSceneGraph.setLocalTransform('a', { x, y: 0, rotation: 0 });
}

function xOf(): number | undefined {
  const n = defaultSceneGraph.getNode('a');
  const t = n?.components.find((c) => c.type === 'Transform');
  return t?.props.x as number | undefined;
}

beforeEach(() => {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultSceneGraph.addNode(node('a', 0));

  useHistoryStore.getState().reset();
  useHistoryStore.getState().record('Open', true);
});

describe('baseline entry', () => {
  it('records "Open" so the original state is reachable', () => {
    // record() used to push nothing when there was no previous state, leaving
    // the document's opening state with no row to jump back to.
    const entries = getCommandSystem().getHistory().getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe('Open');
  });

  it('marks deliberate entries as named, and auto-captures as not', () => {
    moveTo(50);
    useHistoryStore.getState().record();

    const entries = getCommandSystem().getHistory().getEntries();
    expect(entries[0]!.named).toBe(true);   // Open
    expect(entries[1]!.named).toBe(false);  // auto edit
  });
});

describe('debounced recording', () => {
  it('coalesces a burst of edits into one entry', () => {
    for (const x of [10, 20, 30]) {
      moveTo(x);
      useHistoryStore.getState().schedule();
    }
    jest.advanceTimersByTime(700);

    expect(getCommandSystem().getHistory().getEntries()).toHaveLength(2); // Open + one edit
  });

  it('records nothing when the state did not actually change', () => {
    useHistoryStore.getState().schedule();
    jest.advanceTimersByTime(700);
    expect(getCommandSystem().getHistory().getEntries()).toHaveLength(1);
  });
});

describe('undo during the debounce window (the race)', () => {
  it('does not discard the pending edit', () => {
    moveTo(100);
    useHistoryStore.getState().schedule();

    // Ctrl+Z before the 700ms snapshot lands.
    performUndo();

    // The pending edit is flushed and undone — so we're back at the baseline,
    // NOT somewhere before it with the edit silently gone.
    expect(xOf()).toBe(0);
    expect(getCommandSystem().getHistory().getEntries()).toHaveLength(2);
  });

  it('undoes exactly one action per keystroke', () => {
    moveTo(10);
    useHistoryStore.getState().record();
    moveTo(20);
    useHistoryStore.getState().record();

    // Third edit still inside the debounce window.
    moveTo(30);
    useHistoryStore.getState().schedule();

    performUndo();
    expect(xOf()).toBe(20); // the pending edit, and only it

    performUndo();
    expect(xOf()).toBe(10); // one more

    performUndo();
    expect(xOf()).toBe(0);
  });

  it('redoes the flushed edit', () => {
    moveTo(100);
    useHistoryStore.getState().schedule();
    performUndo();
    expect(xOf()).toBe(0);

    performRedo();
    expect(xOf()).toBe(100);
  });

  it('leaves no stale timer to fire after an undo', () => {
    moveTo(100);
    useHistoryStore.getState().schedule();
    performUndo();

    const before = getCommandSystem().getHistory().getEntries().length;
    jest.advanceTimersByTime(2000);

    // A surviving timer would snapshot the post-undo state as a brand-new edit.
    expect(getCommandSystem().getHistory().getEntries()).toHaveLength(before);
  });
});

describe('runRestoring', () => {
  it('suppresses recording while restoring', () => {
    const before = getCommandSystem().getHistory().getEntries().length;
    useHistoryStore.getState().runRestoring(() => {
      moveTo(999);
      useHistoryStore.getState().record();
    });
    expect(getCommandSystem().getHistory().getEntries()).toHaveLength(before);
  });

  it('clears the flag even when the restore throws', () => {
    expect(() =>
      useHistoryStore.getState().runRestoring(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(useHistoryStore.getState().restoring).toBe(false);
  });
});

describe('StoreSnapshotCommand', () => {
  it('defaults to not-named', () => {
    const s = { scene: { version: '1', nodes: [] }, anim: { tracks: {}, expressions: {} } };
    expect(new StoreSnapshotCommand('x', s, s).named).toBe(false);
  });
});
