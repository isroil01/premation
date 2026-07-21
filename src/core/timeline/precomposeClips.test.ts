/**
 * Precompose must not lose the time domain.
 *
 * Before this fix, `syncFromScene` mirrored only the immediate children of a
 * comp root: precomposing a trimmed/split layer reparented it under the new
 * group, the next sync saw its clips as orphans, and every trim, split and
 * clip position was silently deleted. Clips now MOVE into the precomp's own
 * timeline (transferNodeClips), and `getLayersForNode` resolves clips from
 * the registry of the node's PARENT — so nested layers keep their edits both
 * in the drill-down tab and in the parent-comp render.
 */

import { getTimelineController } from './TimelineController';
import { precomposeSelected } from '@core/scene/sceneInsert';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
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
  resetScene();
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

describe('precompose keeps timeline edits', () => {
  it('moves trims, splits and markers into the precomp timeline', () => {
    const controller = getTimelineController();
    addLayer('shape_a', 'comp_root');
    addLayer('shape_b', 'comp_root');
    controller.syncFromScene('comp_root');

    // Author time edits on shape_a: trim + move.
    const before = controller.getLayersForNode('shape_a');
    expect(before.length).toBeGreaterThan(0);
    const layer = before[0]!;
    const timeline = controller.timeline;
    timeline.trimLayer(layer.id, 'start', 30);
    timeline.setLayerStart(layer.id, 45);
    controller.invalidateLayerIndex();
    const edited = controller.getLayersForNode('shape_a')[0]!;
    expect(edited.clip.start).toBe(45);

    // Precompose both layers.
    useSelectionStore.getState().set(['shape_a', 'shape_b']);
    precomposeSelected();

    const precompId = useSelectionStore.getState().ids[0]!;
    expect(defaultSceneGraph.getNode(precompId)).toBeTruthy();
    expect(defaultSceneGraph.getNode('shape_a')!.parent).toBe(precompId);

    // The clip geometry survived, now owned by the precomp's timeline.
    const after = controller.getLayersForNode('shape_a');
    expect(after.length).toBe(1);
    expect(after[0]!.clip.start).toBe(45);
    expect(after[0]!.clip.duration).toBe(edited.clip.duration);

    // And the parent comp no longer holds a clip for the nested node.
    const parentReg = controller.capture()['comp_root'];
    const parentSources = (parentReg?.tracks ?? []).flatMap((t) =>
      (t.layers ?? []).map((l) => l.sourceId),
    );
    expect(parentSources).not.toContain('shape_a');
  });

  it('is a no-op when the source comp has no timeline yet', () => {
    const controller = getTimelineController();
    addLayer('shape_c', 'comp_root');
    // Never sync — no registry entries for comp_root beyond what exists.
    expect(() =>
      controller.transferNodeClips(['shape_c'], 'ghost_comp', 'other_ghost'),
    ).not.toThrow();
  });
});
