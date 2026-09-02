/**
 * The surgery, against a real timeline.
 *
 * Nothing here mocks the controller. The whole point of the operation is what
 * the clip bars look like afterwards — how many there are, where they start,
 * and whether the comp still adds up — and a mocked `splitClip` would assert
 * that this file calls the functions it calls, which is not a fact anybody
 * needs. Nothing calls a provider here either — `deleteTimeRanges` and
 * `transcribeScope` are the two halves of this module that touch a document
 * and not a network.
 *
 * The regression this file exists for: ripple-deleting a range by calling the
 * per-layer ripple delete once per layer shifts later clips ONCE PER LAYER. A
 * video with its separate audio layer is two layers, so every later clip moved
 * twice as far as it should, and the symptom was a comp that went progressively
 * out of sync after each cut rather than an obviously broken one.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { getTimelineController } from '@core/timeline/TimelineController';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { CommandSystem, getCommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import type { CommandServices } from '@core/commands/Command';
import type { SceneNode } from '@core/types';
import { deleteTimeRanges, transcribeScope } from './transcriptOps';
import { useTranscriptStore } from './transcriptStore';

const FPS = 30;

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

/** A bare layer node — kind only matters for the timeline in that it has one. */
function addLayer(id: string, kind: 'video' | 'audio' | 'text'): void {
  defaultSceneGraph.addChild('comp_root', {
    id,
    name: id,
    parent: 'comp_root',
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{
      id: `${id}_t`,
      type: 'Transform',
      props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, width: 64, height: 48 },
    }],
  } as unknown as SceneNode);
}

/** Put a node's single bar at [startSec, endSec]. */
function setBar(nodeId: string, startSec: number, endSec: number): void {
  const controller = getTimelineController();
  const layer = controller.getLayersForNode(nodeId)[0];
  if (!layer) throw new Error(`no clip for ${nodeId}`);
  // End before start, always — the note in `insertCaptionLayers` explains why:
  // moving the head first can invert the bar, and the clamp that fixes it is
  // what silently produces one-frame clips.
  controller.trimClipTo(layer.id, 'end', endSec);
  controller.trimClipTo(layer.id, 'start', startSec);
}

/** Every bar in the comp as `[startFrame, endFrame]`, in time order. */
function bars(): Array<[number, number]> {
  return getTimelineController()
    .layersOfComp('comp_root')
    .map((l) => [l.start, l.end] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as CommandServices, getState: () => ({}) }));
  getTimelineController().reset();
  resetScene();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Main', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  useProjectStore.getState().actions.replaceComps({
    comp_root: {
      id: 'comp_root', name: 'Main', width: 1920, height: 1080, fps: FPS,
      durationSeconds: 10, background: '#101014', transparent: false, startFrame: 0,
    },
  });
  const proj = useProjectStore.getState();
  proj.actions.setActiveTab(proj.actions.openTab('comp_root', ['comp_root'], 'Main'));
  useSelectionStore.getState().clear();
  useTranscriptStore.setState({
    byComp: {}, selected: [], anchorId: null, query: '', phase: 'idle', restrictToSelection: false,
  });
  getTimelineController().setFrameRate(FPS);
  getTimelineController().setDurationSeconds(10);
});

describe('deleteTimeRanges', () => {
  /** A ten-second video and its separate audio layer, both full length. */
  function twoFullLayers(): void {
    addLayer('vid', 'video');
    addLayer('aud', 'audio');
    const controller = getTimelineController();
    controller.syncFromScene('comp_root');
    setBar('vid', 0, 10);
    setBar('aud', 0, 10);
  }

  it('splits both layers at the range and closes the gap ONCE', async () => {
    twoFullLayers();
    await deleteTimeRanges([{ start: 4, end: 6 }]);

    // Two seconds gone from a ten-second comp: four bars, [0,4] and [4,8] on
    // each layer. If the ripple ran once per layer, the tails would sit at
    // frame 60 instead of 120 — the desync this file exists for.
    expect(bars()).toEqual([[0, 120], [0, 120], [120, 240], [120, 240]]);
  });

  it('leaves no gap and no overlap at the seam', async () => {
    twoFullLayers();
    await deleteTimeRanges([{ start: 4, end: 6 }]);
    const perLayer = bars();
    expect(perLayer[0]?.[1]).toBe(perLayer[2]?.[0]);
  });

  it('deletes a clip that sits entirely inside the range', async () => {
    twoFullLayers();
    addLayer('title', 'text');
    getTimelineController().syncFromScene('comp_root');
    setBar('title', 4.5, 5.5);

    const result = await deleteTimeRanges([{ start: 4, end: 6 }]);
    // THREE pieces go: the title bar, and the middle third each of the video
    // and the audio once they have been split at both boundaries. The title's
    // scene node goes with it — a deleted clip that leaves its layer behind is
    // the bug `deleteLayerForClip` was written to fix.
    expect(result.deletedClips).toBe(3);
    expect(defaultSceneGraph.getNode('title')).toBeUndefined();
    expect(bars()).toEqual([[0, 120], [0, 120], [120, 240], [120, 240]]);
  });

  it('pulls a later, untouched clip back by the length removed', async () => {
    addLayer('a', 'video');
    addLayer('b', 'video');
    getTimelineController().syncFromScene('comp_root');
    setBar('a', 0, 3);
    setBar('b', 7, 10);

    await deleteTimeRanges([{ start: 4, end: 6 }]);
    // `a` is before the cut and stays; `b` is entirely after it and moves.
    expect(bars()).toEqual([[0, 90], [150, 240]]);
  });

  it('reports how much time it removed', async () => {
    twoFullLayers();
    const result = await deleteTimeRanges([{ start: 4, end: 6 }]);
    expect(result.removedSeconds).toBeCloseTo(2, 6);
    // FOUR: each of the two layers is cut at both boundaries of the range.
    expect(result.splits).toBe(4);
  });

  it('applies several ranges without the earlier ones moving the later ones', async () => {
    addLayer('vid', 'video');
    getTimelineController().syncFromScene('comp_root');
    setBar('vid', 0, 10);

    // Two one-second cuts. The answer is three pieces totalling eight seconds;
    // it is only that if the second range was measured in the ORIGINAL time
    // base, which is why the ranges are applied last-first.
    await deleteTimeRanges([{ start: 2, end: 3 }, { start: 6, end: 7 }]);
    expect(bars()).toEqual([[0, 60], [60, 150], [150, 240]]);
  });

  it('merges two adjacent ranges into one cut', async () => {
    addLayer('vid', 'video');
    getTimelineController().syncFromScene('comp_root');
    setBar('vid', 0, 10);

    // Two selections a hair apart are one cut, so there is ONE seam, not two.
    await deleteTimeRanges([{ start: 4, end: 5 }, { start: 5.05, end: 6 }]);
    expect(bars()).toHaveLength(2);
  });

  it('does nothing for an empty range list', async () => {
    twoFullLayers();
    const before = bars();
    const result = await deleteTimeRanges([]);
    expect(result).toEqual({ removedSeconds: 0, splits: 0, deletedClips: 0 });
    expect(bars()).toEqual(before);
  });

  it('cuts only the named layers when nodeIds narrows it — but ripples everything', async () => {
    twoFullLayers();
    await deleteTimeRanges([{ start: 4, end: 6 }], { nodeIds: ['vid'] });

    const all = bars();
    // The video was cut in two; the audio was NOT cut. Both timelines still
    // close the gap, which is the point: a comp where one layer's gap closed
    // and another's did not is a comp that is out of sync from there on.
    expect(all).toHaveLength(3);
    expect(all.filter(([s, e]) => s === 0 && e === 120)).toHaveLength(1);
    expect(all).toContainEqual([0, 300]);
  });

  it('records the whole edit as ONE undo entry, whatever it touched', async () => {
    twoFullLayers();
    const history = getCommandSystem().getHistory();
    history.clear();

    await deleteTimeRanges([{ start: 4, end: 6 }]);

    // Two splits (each of which mints a scene node) and a ripple over four
    // bars — and the user presses undo once.
    const labels = history.getEntries().map((e) => e.label);
    expect(labels).toEqual(['Delete Transcript Selection']);
  });
});

describe('transcribeScope', () => {
  it('prefers the selected layers over the whole composition', () => {
    addLayer('vid', 'video');
    getTimelineController().syncFromScene('comp_root');
    setBar('vid', 2, 5);
    useSelectionStore.getState().set(['vid']);

    const scope = transcribeScope();
    expect(scope.start).toBeCloseTo(2, 3);
    expect(scope.end).toBeCloseTo(5, 3);
    expect(scope.label).toBe('selected layer');
  });

  it('falls back to the work area when nothing is selected', () => {
    getTimelineController().setWorkArea(1, 4);
    const scope = transcribeScope();
    expect(scope).toMatchObject({ start: 1, end: 4, label: 'work area' });
  });

  it('falls back to the whole composition last', () => {
    getTimelineController().clearWorkArea();
    const scope = transcribeScope();
    expect(scope).toMatchObject({ start: 0, label: 'composition' });
    expect(scope.end).toBeGreaterThan(0);
  });
});
