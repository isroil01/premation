/**
 * The snapshot history entry (`StoreSnapshotCommand`) — what the remaining
 * whole-document snapshot entries (the AI turn's gap fallback, the document
 * transaction, the plugin handle gesture) push, and its one restore path.
 */

import { StoreSnapshotCommand } from './snapshotCommand';
import { CommandSystem, setCommandSystem } from './CommandSystem';
import type { CommandContext } from './Command';
import { captureSharedState } from './snapshotSharing';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useProjectStore } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

beforeEach(() => {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
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
