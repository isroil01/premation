/**
 * Unified history (NATIVE_CORE_PLAN §4 T1) — deterministic bar ids: a bar
 * seeded for a scene node is `clip:<nodeId>` (a taken id gets the smallest free
 * `:<n>` suffix) so a snapshot can address it across a restore. Existing ids
 * are never rewritten. (Always on since the flag and the 700 ms recorder were
 * removed, B5 round 2.)
 */

import { getTimelineController } from './TimelineController';
import { precomposeSelected } from '@core/scene/sceneInsert';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { defaultAnimation } from '@motion/animation';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import type { CommandServices } from '@core/commands/Command';
import type { SceneNode } from '@core/types';

jest.useFakeTimers();

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
  const tabId = proj.actions.openTab('comp_root', ['comp_root'], 'Main');
  proj.actions.setActiveTab(tabId);
  useSelectionStore.getState().clear();
  addLayer('rect', 'comp_root');
});

afterEach(() => {
  jest.clearAllTimers();
});

describe('deterministic bar ids', () => {
  it('a seeded bar is clip:<nodeId>', () => {
    const c = getTimelineController();
    c.syncFromScene('comp_root');
    expect(c.getLayersForNode('rect')[0]!.id).toBe('clip:rect');
  });

  it('a second seed for the same node gets the smallest free :n', () => {
    const c = getTimelineController();
    const trackId = c.timeline.getTracks()[0]!.id;
    // A legacy document can hold the base id already (a pre-T1 multi-bar
    // node); the new seed must not collide with it.
    c.timeline.history.silently(() => {
      c.timeline.addLayer(trackId, { id: 'clip:late', clip: { start: 0, duration: 30 } });
      c.timeline.addLayer(trackId, { id: 'clip:late:1', clip: { start: 30, duration: 30 } });
    });
    addLayer('late', 'comp_root');
    c.syncFromScene('comp_root');
    expect(c.getLayersForNode('late')[0]!.id).toBe('clip:late:2');
    // The ones that were already there are untouched.
    expect(c.timeline.getLayer('clip:late')).toBeTruthy();
    expect(c.timeline.getLayer('clip:late:1')).toBeTruthy();
  });

  it('precompose re-seeds the moved bars deterministically in the precomp', () => {
    const c = getTimelineController();
    c.syncFromScene('comp_root');
    useSelectionStore.getState().set(['rect']);
    precomposeSelected();
    expect(c.getLayersForNode('rect')[0]!.id).toBe('clip:rect');
  });

  it('restoring a document keeps the ids it persisted', () => {
    const c = getTimelineController();
    c.syncFromScene('comp_root');
    const minted = c.getLayersForNode('rect')[0]!.id;
    const doc = c.capture();

    c.reset();
    c.restore(doc);
    c.syncFromScene('comp_root');

    const bars = c.getLayersForNode('rect');
    expect(bars).toHaveLength(1);
    expect(bars[0]!.id).toBe(minted);
  });
});
