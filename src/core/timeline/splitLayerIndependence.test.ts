/**
 * Split has to produce two INDEPENDENT layers.
 *
 * Reported (issue #13): "I was trying to split a layer into two, then I want to
 * select the last part and delete, but it can't do it."
 *
 * The cause was that `Timeline.splitLayer` gave the new right-hand bar the same
 * `sourceId` as the left. Everything above the engine addresses a layer by its
 * SCENE NODE id — selection, the inspector, delete — so two bars over one node
 * were never two layers:
 *
 *   • selecting the right half selected the left one;
 *   • deleting removed the shared node, and the reconciler then dropped BOTH
 *     bars with it;
 *   • editing a property on one half moved the other.
 *
 * These tests pin the three properties that make the halves genuinely separate:
 * distinct nodes, independent deletion, and one undo entry that puts the whole
 * thing back.
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
  // Split records ONE undo entry spanning the clip geometry and the cloned
  // scene node, so the tests need a real history to record into.
  setCommandSystem(new CommandSystem({ services: {} as CommandServices, getState: () => ({}) }));
  // The controller is an app-wide singleton, so its per-comp timelines survive
  // between tests. Without this reset each test inherits the previous one's
  // clips and splits a bar that was already split.
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
  const tabId = proj.actions.openTab('comp_root', ['comp_root'], 'Main');
  proj.actions.setActiveTab(tabId);
  useSelectionStore.getState().clear();
});

describe('split produces two independent layers', () => {
  it('backs each half with its own scene node', () => {
    const c = getTimelineController();
    addLayer('rect', 'comp_root');
    c.syncFromScene('comp_root');

    const original = c.getLayersForNode('rect')[0]!;
    const rightId = c.splitClip(original.id, 2);
    expect(rightId).toBeTruthy();

    const right = c.timeline.getLayer(rightId!)!;
    expect(right.sourceId).toBeTruthy();
    expect(right.sourceId).not.toBe('rect');
    // …and that node really is in the scene, not a dangling id.
    expect(defaultSceneGraph.getNode(right.sourceId!)).toBeTruthy();

    // One bar each, not two bars on one node.
    expect(c.getLayersForNode('rect')).toHaveLength(1);
    expect(c.getLayersForNode(right.sourceId!)).toHaveLength(1);
  });

  it('splits the bar at the right frame, left keeps the head', () => {
    const c = getTimelineController();
    addLayer('rect', 'comp_root');
    c.syncFromScene('comp_root');

    const original = c.getLayersForNode('rect')[0]!;
    const startFrame = original.start;
    const endFrame = original.end;
    const rightId = c.splitClip(original.id, 2)!;      // 2s @ 30fps → frame 60

    const left = c.timeline.getLayer(original.id)!;
    const right = c.timeline.getLayer(rightId)!;
    expect(left.start).toBe(startFrame);
    expect(left.end).toBe(60);
    expect(right.start).toBe(60);
    expect(right.end).toBe(endFrame);
  });

  it('deleting the second half leaves the first half alone', () => {
    const c = getTimelineController();
    addLayer('rect', 'comp_root');
    c.syncFromScene('comp_root');

    const original = c.getLayersForNode('rect')[0]!;
    const rightId = c.splitClip(original.id, 2)!;
    const rightNodeId = c.timeline.getLayer(rightId)!.sourceId!;

    useSelectionStore.getState().set([rightNodeId]);
    deleteSelectedLayers();
    c.syncFromScene('comp_root');

    expect(defaultSceneGraph.getNode(rightNodeId)).toBeUndefined();
    expect(defaultSceneGraph.getNode('rect')).toBeTruthy();
    // The surviving half still has exactly one bar, and it is the head.
    const survivors = c.getLayersForNode('rect');
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.start).toBe(0);
    expect(survivors[0]!.end).toBe(60);
  });

  it('gives the halves independent properties', () => {
    const c = getTimelineController();
    addLayer('rect', 'comp_root');
    c.syncFromScene('comp_root');

    const original = c.getLayersForNode('rect')[0]!;
    const rightId = c.splitClip(original.id, 2)!;
    const rightNodeId = c.timeline.getLayer(rightId)!.sourceId!;

    const rightNode = defaultSceneGraph.getNode(rightNodeId)!;
    const rightTransform = rightNode.components.find((k) => k.type === 'Transform')!;
    rightTransform.props.x = 999;

    const leftNode = defaultSceneGraph.getNode('rect')!;
    const leftTransform = leftNode.components.find((k) => k.type === 'Transform')!;
    expect(leftTransform.props.x).toBe(10);
    // Distinct component ids too — a shared id would collide on save/load.
    expect(rightTransform.id).not.toBe(leftTransform.id);
  });

  it('places the right half directly above the original in the layer stack', () => {
    const c = getTimelineController();
    addLayer('under', 'comp_root');
    addLayer('rect', 'comp_root');
    addLayer('over', 'comp_root');
    c.syncFromScene('comp_root');

    const original = c.getLayersForNode('rect')[0]!;
    const rightId = c.splitClip(original.id, 2)!;
    const rightNodeId = c.timeline.getLayer(rightId)!.sourceId!;

    const order = defaultSceneGraph.getChildren('comp_root').map((n) => n.id);
    expect(order).toEqual(['under', 'rect', rightNodeId, 'over']);
  });

  it('refuses a split outside the bar', () => {
    const c = getTimelineController();
    addLayer('rect', 'comp_root');
    c.syncFromScene('comp_root');

    const original = c.getLayersForNode('rect')[0]!;
    const nodeCountBefore = defaultSceneGraph.getChildren('comp_root').length;
    // The bar spans the whole 10s comp; 20s is past its end.
    expect(c.splitClip(original.id, 20)).toBeNull();
    // A refused split must not leave an orphan clone behind.
    expect(defaultSceneGraph.getChildren('comp_root')).toHaveLength(nodeCountBefore);
  });

  it('selects the new right halves after Split at Playhead', () => {
    const c = getTimelineController();
    addLayer('rect', 'comp_root');
    c.syncFromScene('comp_root');
    c.timeline.seek(60);

    c.splitSelectedAtPlayhead(['rect']);

    const selected = useSelectionStore.getState().ids;
    expect(selected).toHaveLength(1);
    expect(selected[0]).not.toBe('rect');
    expect(defaultSceneGraph.getNode(selected[0]!)).toBeTruthy();
  });

  it('splits each bar once, not the halves it just made', () => {
    const c = getTimelineController();
    addLayer('rect', 'comp_root');
    c.syncFromScene('comp_root');
    c.timeline.seek(60);

    c.splitSelectedAtPlayhead(['rect']);

    // One split → exactly two bars on the track, never a runaway loop.
    const track = c.timeline.getTrack(c.timeline.getTracks()[0]!.id)!;
    expect(track.layers).toHaveLength(2);
  });
});

describe('split is one undo entry', () => {
  it('undo restores the single original bar and drops the cloned node', () => {
    const c = getTimelineController();
    addLayer('rect', 'comp_root');
    c.syncFromScene('comp_root');

    const original = c.getLayersForNode('rect')[0]!;
    const originalEnd = original.end;
    const rightId = c.splitClip(original.id, 2)!;
    const rightNodeId = c.timeline.getLayer(rightId)!.sourceId!;

    const history = getCommandSystem().getHistory();
    // ONE entry, not two — the clip split and the node clone are one act to
    // the user, and half-undoing left a bar pointing at a deleted node.
    expect(history.getEntries().map((e) => e.label)).toEqual(['Split Layer']);

    history.undo();

    expect(defaultSceneGraph.getNode(rightNodeId)).toBeUndefined();
    const bars = c.getLayersForNode('rect');
    expect(bars).toHaveLength(1);
    expect(bars[0]!.end).toBe(originalEnd);
  });

  it('redo splits again', () => {
    const c = getTimelineController();
    addLayer('rect', 'comp_root');
    c.syncFromScene('comp_root');

    const original = c.getLayersForNode('rect')[0]!;
    c.splitClip(original.id, 2);

    const history = getCommandSystem().getHistory();
    history.undo();
    history.redo();

    const left = c.timeline.getLayer(original.id)!;
    expect(left.end).toBe(60);
    // The right half is back, on its own node, in the scene.
    const track = c.timeline.getTrack(c.timeline.getTracks()[0]!.id)!;
    expect(track.layers).toHaveLength(2);
    const right = track.layers.find((l) => l.id !== original.id)!;
    expect(right.sourceId).not.toBe('rect');
    expect(defaultSceneGraph.getNode(right.sourceId!)).toBeTruthy();
  });
});
