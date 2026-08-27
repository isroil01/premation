/**
 * Deleting a layer from the TIMELINE must delete the layer.
 *
 * Reported: "in the timeline I select an object, right-click, and the popup has
 * two delete buttons which is confusing — and none of them completely deletes
 * the layer. If you delete from the left sidebar layer tab it deletes, but from
 * the timeline row it does not."
 *
 * Both halves of that were true:
 *
 *   • Two entries, "Delete Clip (Del)" and "Ripple Delete Clip" — one word
 *     apart, and nothing on screen said what the difference was.
 *   • Neither deleted anything durable. Both called into the timeline engine,
 *     which removes the clip BAR; the scene node survived. So the row stayed
 *     with no bar on it, and the next `syncFromScene` — any structural scene
 *     change at all — found a node with no clip and seeded it a fresh
 *     full-length bar. The layer came back.
 *
 * The Scene tree's delete "worked" only because it removes the node, which is
 * the thing that actually owns a layer's existence. Both routes share one
 * primitive now (`deleteLayerNode`).
 */

import { getTimelineController } from './TimelineController';
import { deleteSelectedLayers } from '@core/scene/sceneInsert';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { defaultAnimation } from '@motion/animation';
import { CommandSystem, setCommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import type { CommandServices } from '@core/commands/Command';
import type { SceneNode } from '@core/types';

function addLayer(id: string, parent: string): void {
  defaultSceneGraph.addChild(parent, {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 10, y: 10, width: 20, height: 20 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#fff' } },
    ],
  } as never);
}

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as CommandServices, getState: () => ({}) }));
  getTimelineController().reset();
  resetScene();
  defaultAnimation.clear?.();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Main', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  useProjectStore.getState().actions.replaceComps({
    comp_root: {
      id: 'comp_root', name: 'Main', width: 1920, height: 1080, fps: 30,
      durationSeconds: 10, background: '#101014', transparent: false, startFrame: 0,
    },
  });
  const proj = useProjectStore.getState();
  proj.actions.setActiveTab(proj.actions.openTab('comp_root', ['comp_root'], 'Main'));
  useSelectionStore.getState().clear();
});

describe('deleting a layer from a clip bar', () => {
  it('removes the scene node, not just the bar', () => {
    const c = getTimelineController();
    addLayer('rect', 'comp_root');
    c.syncFromScene('comp_root');

    const clip = c.getLayersForNode('rect')[0]!;
    expect(c.deleteLayerForClip(clip.id)).toBe(true);

    expect(defaultSceneGraph.getNode('rect')).toBeUndefined();
    expect(c.getLayersForNode('rect')).toHaveLength(0);
  });

  it('stays deleted through a reconcile — the layer does not come back', () => {
    // THE bug. `syncFromScene` seeds a full-length bar for any node that has
    // none, so removing only the bar was a delete that undid itself.
    const c = getTimelineController();
    addLayer('rect', 'comp_root');
    c.syncFromScene('comp_root');

    c.deleteLayerForClip(c.getLayersForNode('rect')[0]!.id);
    c.syncFromScene('comp_root');
    c.syncFromScene('comp_root');

    expect(c.timeline.getTracks()[0]!.layers).toHaveLength(0);
  });

  it('leaves other layers alone', () => {
    const c = getTimelineController();
    addLayer('keep_a', 'comp_root');
    addLayer('drop', 'comp_root');
    addLayer('keep_b', 'comp_root');
    c.syncFromScene('comp_root');

    c.deleteLayerForClip(c.getLayersForNode('drop')[0]!.id);
    c.syncFromScene('comp_root');

    expect(defaultSceneGraph.getNode('keep_a')).toBeTruthy();
    expect(defaultSceneGraph.getNode('keep_b')).toBeTruthy();
    expect(defaultSceneGraph.getNode('drop')).toBeUndefined();
  });

  it('takes the layer’s animation with it', () => {
    const c = getTimelineController();
    addLayer('rect', 'comp_root');
    c.syncFromScene('comp_root');
    defaultAnimation.setKeyframe('rect', 'x', 0, 0);
    defaultAnimation.setKeyframe('rect', 'x', 1, 100);
    expect(defaultAnimation.tracksFor('rect').length).toBeGreaterThan(0);

    c.deleteLayerForClip(c.getLayersForNode('rect')[0]!.id);

    // Orphan tracks would ride every autosave forever, and a future layer that
    // minted the same id would inherit them.
    expect(defaultAnimation.tracksFor('rect')).toHaveLength(0);
  });

  it('refuses a locked layer', () => {
    const c = getTimelineController();
    addLayer('rect', 'comp_root');
    c.syncFromScene('comp_root');
    const clip = c.getLayersForNode('rect')[0]!;
    clip.locked = true;

    expect(c.deleteLayerForClip(clip.id)).toBe(false);
    expect(defaultSceneGraph.getNode('rect')).toBeTruthy();
  });

  it('matches what the Scene tree does — same layer, same outcome', () => {
    const c = getTimelineController();
    addLayer('via_timeline', 'comp_root');
    addLayer('via_sidebar', 'comp_root');
    c.syncFromScene('comp_root');

    c.deleteLayerForClip(c.getLayersForNode('via_timeline')[0]!.id);
    useSelectionStore.getState().set(['via_sidebar']);
    deleteSelectedLayers();
    c.syncFromScene('comp_root');

    expect(defaultSceneGraph.getNode('via_timeline')).toBeUndefined();
    expect(defaultSceneGraph.getNode('via_sidebar')).toBeUndefined();
    expect(c.timeline.getTracks()[0]!.layers).toHaveLength(0);
  });
});

describe('ripple delete closes the gap', () => {
  it('pulls a later clip left by the deleted layer’s duration', () => {
    const c = getTimelineController();
    addLayer('first', 'comp_root');
    addLayer('second', 'comp_root');
    c.syncFromScene('comp_root');

    // first: 0..60, second: 60..120 — butted up against each other.
    const first = c.getLayersForNode('first')[0]!;
    const second = c.getLayersForNode('second')[0]!;
    c.timeline.trimLayer(first.id, 'end', 60);
    c.timeline.setLayerStart(second.id, 60);
    c.timeline.trimLayer(second.id, 'end', 120);
    c.invalidateLayerIndex();

    c.deleteLayerForClip(c.getLayersForNode('first')[0]!.id, { ripple: true });
    c.syncFromScene('comp_root');

    expect(defaultSceneGraph.getNode('first')).toBeUndefined();
    const moved = c.getLayersForNode('second')[0]!;
    expect(moved.start).toBe(0);
    expect(moved.end).toBe(60);
  });

  it('deletes the layer just as completely as the plain delete', () => {
    const c = getTimelineController();
    addLayer('rect', 'comp_root');
    c.syncFromScene('comp_root');

    c.deleteLayerForClip(c.getLayersForNode('rect')[0]!.id, { ripple: true });
    c.syncFromScene('comp_root');

    expect(defaultSceneGraph.getNode('rect')).toBeUndefined();
    expect(c.timeline.getTracks()[0]!.layers).toHaveLength(0);
  });
});

describe('undo brings the layer back', () => {
  it('restores the node, its place in the stack and its bar geometry', () => {
    const c = getTimelineController();
    addLayer('under', 'comp_root');
    addLayer('rect', 'comp_root');
    addLayer('over', 'comp_root');
    c.syncFromScene('comp_root');

    // Give the bar geometry no scene snapshot carries.
    const clip = c.getLayersForNode('rect')[0]!;
    c.timeline.setLayerStart(clip.id, 30);
    c.timeline.trimLayer(clip.id, 'end', 200);
    c.invalidateLayerIndex();

    c.deleteLayerForClip(c.getLayersForNode('rect')[0]!.id);
    expect(defaultSceneGraph.getNode('rect')).toBeUndefined();

    const history = getCommandSystem().getHistory();
    expect(history.getEntries().map((e) => e.label)).toContain('Delete Layer');
    history.undo();

    expect(defaultSceneGraph.getNode('rect')).toBeTruthy();
    // Back where it was in the stack, not appended to the bottom.
    expect(defaultSceneGraph.getChildren('comp_root').map((n) => n.id)).toEqual([
      'under', 'rect', 'over',
    ]);
    const restored = c.getLayersForNode('rect')[0]!;
    expect(restored.start).toBe(30);
    expect(restored.end).toBe(200);
  });

  it('restores the layer’s animation', () => {
    const c = getTimelineController();
    addLayer('rect', 'comp_root');
    c.syncFromScene('comp_root');
    defaultAnimation.setKeyframe('rect', 'x', 0, 0);
    defaultAnimation.setKeyframe('rect', 'x', 1, 100);
    const before = defaultAnimation.tracksFor('rect').length;

    c.deleteLayerForClip(c.getLayersForNode('rect')[0]!.id);
    getCommandSystem().getHistory().undo();

    expect(defaultAnimation.tracksFor('rect')).toHaveLength(before);
  });

  it('puts a rippled neighbour back where it was', () => {
    const c = getTimelineController();
    addLayer('first', 'comp_root');
    addLayer('second', 'comp_root');
    c.syncFromScene('comp_root');

    const first = c.getLayersForNode('first')[0]!;
    const second = c.getLayersForNode('second')[0]!;
    c.timeline.trimLayer(first.id, 'end', 60);
    c.timeline.setLayerStart(second.id, 60);
    c.timeline.trimLayer(second.id, 'end', 120);
    c.invalidateLayerIndex();

    c.deleteLayerForClip(c.getLayersForNode('first')[0]!.id, { ripple: true });
    expect(c.getLayersForNode('second')[0]!.start).toBe(0);

    getCommandSystem().getHistory().undo();

    expect(defaultSceneGraph.getNode('first')).toBeTruthy();
    expect(c.getLayersForNode('second')[0]!.start).toBe(60);
  });

  it('records ONE entry, not one per domain', () => {
    const c = getTimelineController();
    addLayer('rect', 'comp_root');
    c.syncFromScene('comp_root');

    const history = getCommandSystem().getHistory();
    const before = history.getEntries().length;
    c.deleteLayerForClip(c.getLayersForNode('rect')[0]!.id);

    expect(history.getEntries().length).toBe(before + 1);
  });
});
