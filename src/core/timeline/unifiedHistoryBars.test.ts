/**
 * Unified history (NATIVE_CORE_PLAN §4 T1) — the controller's two halves.
 *
 *   A. An engine command flushes the pending scene capture FIRST. The engine
 *      push emits `UndoStackChanged`, whose baseline sync re-captures
 *      `lastState`; a scene edit still inside the 700 ms debounce then compared
 *      equal to that new baseline and never reached the undo stack (design note
 *      S2). Not flag-gated — it is strictly safer.
 *
 *   B. With the flag on, a bar seeded for a scene node is `clip:<nodeId>` (a
 *      taken id gets the smallest free `:<n>` suffix) so a snapshot can address
 *      it across a restore. Existing ids are never rewritten; flag off keeps the
 *      engine-minted `layer_…`.
 */

import { getTimelineController } from './TimelineController';
import { precomposeSelected } from '@core/scene/sceneInsert';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setUnifiedHistory } from '@core/config/flags';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useHistoryStore, attachHistoryBaselineSync } from '@stores/historyStore';
import { defaultAnimation } from '@motion/animation';
import { CommandSystem, setCommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
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

function labels(): string[] {
  return getCommandSystem().getHistory().getEntries().map((e) => e.label);
}

let baselineSync: { dispose(): void } | null = null;

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
  // One layer in the scene BEFORE the "Open" baseline, so a scene entry's
  // "before" contains it and undoing that entry edits the node, not removes it.
  addLayer('rect', 'comp_root');
  // The app wires the baseline sync at boot; without it the S2 loss below
  // cannot happen, so the flush test would pass vacuously.
  baselineSync = attachHistoryBaselineSync();
  useHistoryStore.getState().reset();
  useHistoryStore.getState().record('Open', true);
});

afterEach(() => {
  baselineSync?.dispose();
  baselineSync = null;
  useHistoryStore.getState().reset();
  setUnifiedHistory(false);
  jest.clearAllTimers();
});

describe('A — engine push flushes the pending scene capture first', () => {
  it('a mid-debounce scene edit becomes its own entry ahead of the engine command', () => {
    const c = getTimelineController();
    c.syncFromScene('comp_root');
    const bar = c.getLayersForNode('rect')[0]!;
    expect(labels()).toEqual(['Open']);

    // A real scene edit, scheduled the way NodeUpdated schedules it — and the
    // 700 ms window has NOT elapsed when the engine command arrives.
    defaultSceneGraph.setLocalTransform('rect', { x: 50, y: 10, rotation: 0 });
    useHistoryStore.getState().schedule('node:rect:x');
    expect(labels()).toEqual(['Open']);

    c.setClipStart(bar.id, 1);

    expect(labels()).toEqual(['Open', 'Edit 1', 'Move Layer']);
    // Nothing left pending: the timer was consumed by the flush.
    jest.runAllTimers();
    expect(labels()).toEqual(['Open', 'Edit 1', 'Move Layer']);
  });

  it('undoing both steps returns the scene edit as well as the geometry', () => {
    const c = getTimelineController();
    c.syncFromScene('comp_root');
    const bar = c.getLayersForNode('rect')[0]!;

    defaultSceneGraph.setLocalTransform('rect', { x: 50, y: 10, rotation: 0 });
    useHistoryStore.getState().schedule('node:rect:x');
    c.setClipStart(bar.id, 1);

    const h = getCommandSystem().getHistory();
    useHistoryStore.getState().runRestoring(() => { h.undo(); h.undo(); });

    const x = defaultSceneGraph.getNode('rect')!.components.find((k) => k.type === 'Transform')!.props.x;
    expect(x).toBe(10);
    expect(c.getLayersForNode('rect')[0]!.start).toBe(0);
  });
});

describe('B — deterministic bar ids', () => {
  it('flag off: the engine mints layer_… ids', () => {
    const c = getTimelineController();
    c.syncFromScene('comp_root');
    expect(c.getLayersForNode('rect')[0]!.id).toMatch(/^layer_/);
  });

  it('flag on: a seeded bar is clip:<nodeId>', () => {
    setUnifiedHistory(true);
    const c = getTimelineController();
    c.syncFromScene('comp_root');
    expect(c.getLayersForNode('rect')[0]!.id).toBe('clip:rect');
  });

  it('flag on: a second seed for the same node gets the smallest free :n', () => {
    setUnifiedHistory(true);
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

  it('flag on: precompose re-seeds the moved bars deterministically in the precomp', () => {
    setUnifiedHistory(true);
    const c = getTimelineController();
    c.syncFromScene('comp_root');
    useSelectionStore.getState().set(['rect']);
    precomposeSelected();
    expect(c.getLayersForNode('rect')[0]!.id).toBe('clip:rect');
  });

  it('restoring a document keeps the ids it persisted, flag on or off', () => {
    const c = getTimelineController();
    c.syncFromScene('comp_root');
    const minted = c.getLayersForNode('rect')[0]!.id;
    expect(minted).toMatch(/^layer_/);
    const doc = c.capture();

    setUnifiedHistory(true);
    c.reset();
    c.restore(doc);
    c.syncFromScene('comp_root');

    const bars = c.getLayersForNode('rect');
    expect(bars).toHaveLength(1);
    expect(bars[0]!.id).toBe(minted);
  });
});
