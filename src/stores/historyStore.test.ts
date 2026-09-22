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
import type { CommandContext } from '@core/commands/Command';
import { captureSharedState } from '@core/commands/snapshotSharing';
import { setUnifiedHistory } from '@core/config/flags';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useProjectStore } from './projectStore';
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
    // record used to push nothing when there was no previous state, leaving
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

/**
 * The unified history (NATIVE_CORE_PLAN §4 T1): a snapshot restore puts clip
 * geometry back in EVERY composition, not only the one the active tab shows —
 * the `SceneGraphChanged` subscriber only ever synced the active comp.
 */
describe('StoreSnapshotCommand restores clip geometry (unified history)', () => {
  const FPS = 30;
  const ctx = {} as CommandContext;

  function compNode(id: string, name: string): SceneNode {
    return {
      id, name, parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
    } as unknown as SceneNode;
  }

  function addLayer(id: string, parent: string): void {
    defaultSceneGraph.addChild(parent, {
      id, name: id, parent, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 10, y: 10 } }],
    } as never);
  }

  const comp = (id: string, name: string) => ({
    id, name, width: 1920, height: 1080, fps: FPS,
    durationSeconds: 10, background: '#101014', transparent: false, startFrame: 0,
  });

  /** `[start, end]` of the node's bars, in start order. */
  function barsOf(nodeId: string): Array<[number, number]> {
    return getTimelineController().getLayersForNode(nodeId).map((l) => [l.start, l.end]);
  }

  beforeEach(() => {
    setUnifiedHistory(true);
    getTimelineController().reset();
    defaultSceneGraph.addNode(compNode('comp_root', 'Main'));
    defaultSceneGraph.addNode(compNode('comp_b', 'Pre-comp'));
    addLayer('r', 'comp_root');
    addLayer('b', 'comp_b');
    const proj = useProjectStore.getState();
    proj.actions.resetTabs();
    proj.actions.replaceComps({ comp_root: comp('comp_root', 'Main'), comp_b: comp('comp_b', 'Pre-comp') });
    proj.actions.setActiveTab(proj.actions.openTab('comp_root', ['comp_root'], 'Main'));
    // Both timelines exist and mirror their scene; comp_b is NOT the active one.
    getTimelineController().syncFromScene('comp_root');
    expect(getTimelineController().timelineForComp('comp_b')).not.toBeNull();
    expect(barsOf('b')).toEqual([[0, 300]]);
  });

  afterEach(() => {
    setUnifiedHistory(false);
    getTimelineController().reset();
  });

  it('undo puts a trimmed bar back in the non-active comp, writing only the bar that differs', () => {
    const c = getTimelineController();
    const reg = c.timelineForComp('comp_b')!;
    const before = captureSharedState();

    const bar = c.getLayersForNode('b')[0]!;
    reg.timeline.history.silently(() => {
      reg.timeline.trimLayer(bar.id, 'end', 100);
      reg.timeline.setLayerStart(bar.id, 20);
    });
    c.invalidateLayerIndex();
    // Trim the end to 100 (duration 100), then MOVE the bar to 20: [20, 120].
    expect(barsOf('b')).toEqual([[20, 120]]);
    const after = captureSharedState();
    expect(after.clips!.comp_b!.b).toEqual([{ start: 20, duration: 100, sourceIn: 0, sourceDuration: null }]);

    const updated: string[] = [];
    const subs = [
      reg.timeline.events.on('LayerUpdated', ({ layer }) => updated.push(layer.id)),
      c.timelineForComp('comp_root')!.timeline.events.on('LayerUpdated', ({ layer }) => updated.push(layer.id)),
    ];
    const cmd = new StoreSnapshotCommand('x', before, after);
    cmd.undo(ctx);
    expect(barsOf('b')).toEqual([[0, 300]]);
    expect(barsOf('r')).toEqual([[0, 300]]);
    // The bar kept its id (no re-seed) and only IT was announced — the
    // untouched bar in the active comp was not rewritten.
    expect(c.getLayersForNode('b')[0]!.id).toBe(bar.id);
    expect(updated).toEqual([bar.id]);

    cmd.execute(ctx);
    expect(barsOf('b')).toEqual([[20, 120]]);
    expect(updated).toEqual([bar.id, bar.id]);
    for (const s of subs) s.dispose();
  });

  it('a bar the snapshot has and the live timeline lacks is seeded; one it lacks is removed', () => {
    const c = getTimelineController();
    const reg = c.timelineForComp('comp_b')!;
    // A second bar on the node (a legacy multi-bar node / a transition).
    reg.timeline.history.silently(() => {
      reg.timeline.trimLayer(c.getLayersForNode('b')[0]!.id, 'end', 100);
      reg.timeline.addLayer(reg.trackId, { sourceId: 'b', name: 'b', clip: { start: 150, duration: 50 } });
    });
    c.invalidateLayerIndex();
    expect(barsOf('b')).toEqual([[0, 100], [150, 200]]);
    const two = captureSharedState();

    reg.timeline.history.silently(() => reg.timeline.removeLayer(c.getLayersForNode('b')[1]!.id));
    c.invalidateLayerIndex();
    expect(barsOf('b')).toEqual([[0, 100]]);
    const one = captureSharedState();

    const cmd = new StoreSnapshotCommand('x', two, one);
    cmd.undo(ctx);
    expect(barsOf('b')).toEqual([[0, 100], [150, 200]]);
    // Seeded deterministically: the base id is taken by the first bar.
    expect(c.getLayersForNode('b')[1]!.id).toBe('clip:b:1');

    cmd.execute(ctx);
    expect(barsOf('b')).toEqual([[0, 100]]);
  });

  it('a snapshot entry for a node the restored scene does not hold seeds nothing', () => {
    const c = getTimelineController();
    const before = captureSharedState();
    // The node goes away with its bar (as `deleteLayerNode` + the sync do).
    defaultSceneGraph.removeNode('b');
    c.syncFromScene('comp_b');
    const after = captureSharedState();
    expect(after.clips!.comp_b).toEqual({});

    // Redo of a delete whose "after" was captured before the sync ran: the
    // stale entry must not resurrect a bar for a node that is not there.
    const stale = { ...after, clips: before.clips };
    new StoreSnapshotCommand('x', before, stale).execute(ctx);
    expect(defaultSceneGraph.getNode('b')).toBeUndefined();
    expect(c.layersOfComp('comp_b')).toHaveLength(0);
  });
});
