/**
 * The surgery, against a real timeline: the C++ engine's.
 *
 * Nothing here mocks the timeline. The whole point of the operation is what
 * the clip bars look like afterwards — how many there are, where they start,
 * and whether the comp still adds up — and a mocked split would assert that
 * this file calls the functions it calls, which is not a fact anybody needs.
 * Nothing calls a provider here either — `deleteTimeRanges` and
 * `transcribeScope` are the two halves of this module that touch a document
 * and not a network.
 *
 * The regression this file exists for: ripple-deleting a range by calling the
 * per-layer ripple delete once per layer shifts later clips ONCE PER LAYER. A
 * video with its separate audio layer is two layers, so every later clip moved
 * twice as far as it should, and the symptom was a comp that went progressively
 * out of sync after each cut rather than an obviously broken one.
 */

import type { Command } from '@motion/engine-api';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { mirrorCompBars } from '@core/mirror/clipBars';
import { clearHistory, historyLabels, sec, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { deleteTimeRanges, transcribeScope } from './transcriptOps';
import { useTranscriptStore } from './transcriptStore';

const FPS = 30;
const COMP = 'comp_root';

let h: Harness;

/** A layer of the comp (its kind only matters in that it has a bar). */
async function addLayer(name: string): Promise<string> {
  return (await h.run({ type: 'createLayer', comp: COMP, kind: 'solid', name, init: [] } as Command) as { layer: string }).layer;
}

/** Put a layer's bar at [startSec, endSec]. */
async function setBar(layer: string, startSec: number, endSec: number): Promise<void> {
  await h.run({ type: 'setLayerTiming', items: [{ layer, inPoint: sec(startSec), outPoint: sec(endSec) }] } as Command);
}

/** Every bar in the comp as `[startFrame, endFrame]`, in time order. */
async function bars(): Promise<Array<[number, number]>> {
  await settleEdits();
  return mirrorCompBars(documentMirror(), COMP, FPS)
    .map((b) => [Math.round(b.start), Math.round(b.end)] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

beforeEach(async () => {
  h = await setupAppEngine();
  await h.run({ type: 'setCompositionSettings', comp: COMP, patch: { frameRate: { num: FPS, den: 1 }, duration: sec(10) } } as Command);
  useSelectionStore.getState().clear();
  useTranscriptStore.setState({
    byComp: {}, selected: [], anchorId: null, query: '', phase: 'idle', restrictToSelection: false,
  });
  await settleEdits();
});
afterEach(async () => {
  await h.dispose();
});

describe('deleteTimeRanges', () => {
  /** A ten-second video and its separate audio layer, both full length. */
  async function twoFullLayers(): Promise<{ vid: string; aud: string }> {
    const vid = await addLayer('vid');
    const aud = await addLayer('aud');
    await setBar(vid, 0, 10);
    await setBar(aud, 0, 10);
    await settleEdits();
    return { vid, aud };
  }

  it('splits both layers at the range and closes the gap ONCE', async () => {
    await twoFullLayers();
    await deleteTimeRanges([{ start: 4, end: 6 }]);

    // Two seconds gone from a ten-second comp: four bars, [0,4] and [4,8] on
    // each layer. If the ripple ran once per layer, the tails would sit at
    // frame 60 instead of 120 — the desync this file exists for.
    expect(await bars()).toEqual([[0, 120], [0, 120], [120, 240], [120, 240]]);
  });

  it('leaves no gap and no overlap at the seam', async () => {
    await twoFullLayers();
    await deleteTimeRanges([{ start: 4, end: 6 }]);
    const perLayer = await bars();
    expect(perLayer[0]?.[1]).toBe(perLayer[2]?.[0]);
  });

  it('deletes a clip that sits entirely inside the range', async () => {
    await twoFullLayers();
    const title = await addLayer('title');
    await setBar(title, 4.5, 5.5);
    await settleEdits();

    const result = await deleteTimeRanges([{ start: 4, end: 6 }]);
    // THREE pieces go: the title bar, and the middle third each of the video
    // and the audio once they have been split at both boundaries. The title's
    // layer goes with it.
    expect(result.deletedClips).toBe(3);
    await settleEdits();
    expect(documentMirror().layer(title)).toBeUndefined();
    expect(await bars()).toEqual([[0, 120], [0, 120], [120, 240], [120, 240]]);
  });

  it('pulls a later, untouched clip back by the length removed', async () => {
    const a = await addLayer('a');
    const b = await addLayer('b');
    await setBar(a, 0, 3);
    await setBar(b, 7, 10);
    await settleEdits();

    await deleteTimeRanges([{ start: 4, end: 6 }]);
    // `a` is before the cut and stays; `b` is entirely after it and moves.
    expect(await bars()).toEqual([[0, 90], [150, 240]]);
  });

  it('reports how much time it removed', async () => {
    await twoFullLayers();
    const result = await deleteTimeRanges([{ start: 4, end: 6 }]);
    expect(result.removedSeconds).toBeCloseTo(2, 6);
    // FOUR: each of the two layers is cut at both boundaries of the range.
    expect(result.splits).toBe(4);
  });

  it('applies several ranges without the earlier ones moving the later ones', async () => {
    const vid = await addLayer('vid');
    await setBar(vid, 0, 10);
    await settleEdits();

    // Two one-second cuts. The answer is three pieces totalling eight seconds;
    // it is only that if the second range was measured in the ORIGINAL time
    // base, which is why the ranges are applied last-first.
    await deleteTimeRanges([{ start: 2, end: 3 }, { start: 6, end: 7 }]);
    expect(await bars()).toEqual([[0, 60], [60, 150], [150, 240]]);
  });

  it('merges two adjacent ranges into one cut', async () => {
    const vid = await addLayer('vid');
    await setBar(vid, 0, 10);
    await settleEdits();

    // Two selections a hair apart are one cut, so there is ONE seam, not two.
    await deleteTimeRanges([{ start: 4, end: 5 }, { start: 5.05, end: 6 }]);
    expect(await bars()).toHaveLength(2);
  });

  it('does nothing for an empty range list', async () => {
    await twoFullLayers();
    const before = await bars();
    const result = await deleteTimeRanges([]);
    expect(result).toEqual({ removedSeconds: 0, splits: 0, deletedClips: 0 });
    expect(await bars()).toEqual(before);
  });

  it('cuts only the named layers when nodeIds narrows it — but ripples everything', async () => {
    const { vid } = await twoFullLayers();
    await deleteTimeRanges([{ start: 4, end: 6 }], { nodeIds: [vid] });

    const all = await bars();
    // The video was cut in two; the audio was NOT cut. Both timelines still
    // close the gap, which is the point: a comp where one layer's gap closed
    // and another's did not is a comp that is out of sync from there on.
    expect(all).toHaveLength(3);
    expect(all.filter(([s, e]) => s === 0 && e === 120)).toHaveLength(1);
    expect(all).toContainEqual([0, 300]);
  });

  it('records the whole edit as ONE undo entry, whatever it touched', async () => {
    await twoFullLayers();
    await clearHistory();

    await deleteTimeRanges([{ start: 4, end: 6 }]);
    await settleEdits();

    // Two splits and a ripple over four bars — and the user presses undo once.
    expect(await historyLabels()).toEqual(['Delete Transcript Selection']);
  });
});

describe('transcribeScope', () => {
  it('prefers the selected layers over the whole composition', async () => {
    const vid = await addLayer('vid');
    await setBar(vid, 2, 5);
    await settleEdits();
    useSelectionStore.getState().set([vid]);

    const scope = transcribeScope();
    expect(scope.start).toBeCloseTo(2, 3);
    expect(scope.end).toBeCloseTo(5, 3);
    expect(scope.label).toBe('selected layer');
  });

  it('falls back to the work area when nothing is selected', async () => {
    await h.run({ type: 'setWorkArea', comp: COMP, range: { start: sec(1), duration: sec(3) } } as Command);
    await settleEdits();
    const scope = transcribeScope();
    expect(scope).toMatchObject({ start: 1, end: 4, label: 'work area' });
  });

  it('falls back to the whole composition last', async () => {
    await h.run({ type: 'clearWorkArea', comp: COMP } as Command);
    await settleEdits();
    const scope = transcribeScope();
    expect(scope).toMatchObject({ start: 0, label: 'composition' });
    expect(scope.end).toBeGreaterThan(0);
  });
});
