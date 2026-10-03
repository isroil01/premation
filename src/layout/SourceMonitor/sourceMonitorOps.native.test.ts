/**
 * A marked SOURCE range must arrive in the comp as the trimmed clip it
 * describes — not as the whole file with the range written down somewhere.
 *
 * The failure this pins is silent by construction: `insertMedia` has no
 * opinion about time, so an insert that forgets the trim still produces a
 * perfectly good clip — the whole rush, starting at frame 0. Nothing errors.
 * The user sees the right clip in the right comp and only later notices it is
 * the wrong three seconds. So the assertions here are on `Clip` itself
 * (`sourceIn`, `duration`, `start`, in FRAMES) rather than on the fact that an
 * insert happened.
 *
 * B3: the insert (the router run off-document → `pasteLayers`), the range,
 * the overwrite trims and the splits go through the engine API — ONE undo
 * entry, and undo restores the document.
 */

import { seekPlayhead } from '@core/timeline/timelineView';
import { timingBarFrames } from '@core/mirror/compFacts';
import { documentMirror } from '@stores/documentMirror';
import { insertFromSource, sourceRangeEdit, overwriteUnder, compEndSeconds, newCompFromRange } from './sourceMonitorOps';
import { useProjectStore } from '@stores/projectStore';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { useSelectionStore } from '@stores/selectionStore';
import { setupAppEngine, historyLabels, settleEdits } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';

/** The footage, imported through the engine (the fake port: 640×360, 30 fps, 10 s from its name). */
let ASSET: ImportedAsset;

/**
 * The timeline as the editor reads it: a layer's bar in frames of the 30 fps
 * comp (the mirror's timing), the comp's bars, and the playhead.
 */
const c = {
  seekSeconds: (s: number): void => seekPlayhead(s),
  getLayersForNode: (id: string): Array<{ clip: ReturnType<typeof timingBarFrames> }> => {
    const l = documentMirror().layer(id);
    return l ? [{ clip: timingBarFrames(l.timing, 30) }] : [];
  },
  layersOfComp: (): Array<ReturnType<typeof timingBarFrames>> =>
    (documentMirror().comp('comp_root')?.layers ?? []).map((id) => timingBarFrames(documentMirror().layer(id)!.timing, 30)),
};
const getTimelineController = (): typeof c => c;

let h: Harness;

beforeEach(async () => {
  h = await setupAppEngine();
  // A 30 fps, 10 s composition (the fixture every assertion below counts in).
  await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { frameRate: { num: 30, den: 1 }, duration: 10 * 705_600_000 } });
  const { items: [id] } = await h.run({ type: 'importFiles', files: [{ path: 'C:/m/clip_10s.mp4', asSequence: false, createComposition: false }] });
  await settleEdits();
  ASSET = useAssetStore.getState().assets.find((a) => a.id === id)!;
});

afterEach(async () => {
  await h.dispose();
});

describe('insertFromSource', () => {
  it('lands the MARKED part of the file, at the playhead — one entry, undoable', async () => {
    const c = getTimelineController();
    c.seekSeconds(1);
    const before = (await h.doc());
    const entries = (await historyLabels()).length;

    const nodeId = await insertFromSource(ASSET, { inSec: 2, outSec: 5 }, { at: 'playhead' });
    await settleEdits();
    expect(nodeId).not.toBeNull();
    expect(useSelectionStore.getState().ids).toEqual([nodeId]);

    const clip = c.getLayersForNode(nodeId!)[0]!.clip;
    // 30fps: two seconds in, three seconds long, parked one second along.
    expect(clip.sourceIn).toBe(60);
    expect(clip.duration).toBe(90);
    expect(clip.start).toBe(30);
    // The layer AND its range are one entry: undo takes both back.
    expect((await historyLabels()).slice(entries)).toEqual(['Insert from Source']);
    const after = (await h.doc());

    await h.run({ type: 'undo' });
    expect((await docView()).getNode(nodeId!)).toBeUndefined();
    expect(c.getLayersForNode(nodeId!)).toHaveLength(0);
    expect((await h.doc())).toBe(before);
    await h.run({ type: 'redo' });
    expect((await h.doc())).toBe(after);
    expect(c.getLayersForNode(nodeId!)[0]!.clip).toMatchObject({ sourceIn: 60, duration: 90, start: 30 });
  });

  it('an unmarked clip inserts whole — the range falls back to the file', async () => {
    const c = getTimelineController();
    const nodeId = await insertFromSource(ASSET, { inSec: 0, outSec: 10 }, { at: 'time', seconds: 0 });
    await settleEdits();
    const clip = c.getLayersForNode(nodeId!)[0]!.clip;
    expect(clip.sourceIn).toBe(0);
    expect(clip.duration).toBe(300);
  });

  it('“add to comp end” starts where the last clip finishes, not at the playhead', async () => {
    const c = getTimelineController();
    c.seekSeconds(4); // deliberately NOT where the answer should be
    await insertFromSource(ASSET, { inSec: 0, outSec: 2 }, { at: 'time', seconds: 0 });
    await settleEdits();

    const second = await insertFromSource(ASSET, { inSec: 4, outSec: 6 }, { at: 'end' });
    await settleEdits();
    const clip = c.getLayersForNode(second!)[0]!.clip;
    expect(clip.start).toBe(60); // frame 60 = the first clip's 2s end
    expect(clip.sourceIn).toBe(120);
    expect(clip.duration).toBe(60);
  });

  it('compEndSeconds is 0 in an empty comp', async () => {
    expect(compEndSeconds()).toBe(0);
  });
});

describe('sourceRangeEdit', () => {
  it('is null for a node with no clip bar', async () => {
    expect(sourceRangeEdit('nope', { inSec: 0, outSec: 1 }, 0)).toBeNull();
  });
});

describe('overwrite', () => {
  it('trims the clip the new one lands on the tail of — with the insert, one entry', async () => {
    const c = getTimelineController();
    // An existing clip covering 0–6s.
    const first = await insertFromSource(ASSET, { inSec: 0, outSec: 6 }, { at: 'time', seconds: 0 });
    await settleEdits();

    // A new one over 4–7s, with overwrite.
    const entries = (await historyLabels()).length;
    const second = await insertFromSource(ASSET, { inSec: 0, outSec: 3 }, { at: 'time', seconds: 4 }, { overwrite: true });
    await settleEdits();

    expect(c.getLayersForNode(first!)[0]!.clip.duration).toBe(120); // 0–4s
    const newClip = c.getLayersForNode(second!)[0]!.clip;
    expect(newClip.start).toBe(120);
    expect(newClip.duration).toBe(90);
    // The insert, the range and the trims: ONE entry.
    expect((await historyLabels()).slice(entries)).toEqual(['Overwrite from Source']);
  });

  it('splits a clip that spans the whole insert, leaving a hole', async () => {
    const c = getTimelineController();
    const first = await insertFromSource(ASSET, { inSec: 0, outSec: 10 }, { at: 'time', seconds: 0 });
    await settleEdits();
    const before = c.layersOfComp().length;

    await insertFromSource(ASSET, { inSec: 0, outSec: 2 }, { at: 'time', seconds: 4 }, { overwrite: true });
    await settleEdits();

    expect(c.getLayersForNode(first!)[0]!.clip.duration).toBe(120); // trimmed to 0–4s
    // +1 for the inserted clip, +1 for the right-hand piece of the split
    // (a new layer, AE's split — the left part keeps the original's id).
    expect(c.layersOfComp().length).toBe(before + 2);
    const right = c.layersOfComp().find((l) => l.start === 180);
    expect(right).toBeDefined();
  });

  it('leaves a clip that sits ENTIRELY inside the range alone, and says so', async () => {
    const c = getTimelineController();
    const inner = await insertFromSource(ASSET, { inSec: 0, outSec: 2 }, { at: 'time', seconds: 3 });
    await settleEdits();
    const covered = await overwriteUnder('none', 2, 6);
    expect(covered).toBe(1);
    expect(c.getLayersForNode(inner!)[0]!.clip.duration).toBe(60);
  });

  it('a plain Insert touches nothing else', async () => {
    const c = getTimelineController();
    const first = await insertFromSource(ASSET, { inSec: 0, outSec: 6 }, { at: 'time', seconds: 0 });
    await settleEdits();
    await insertFromSource(ASSET, { inSec: 0, outSec: 3 }, { at: 'time', seconds: 4 });
    await settleEdits();
    expect(c.getLayersForNode(first!)[0]!.clip.duration).toBe(180);
  });
});

describe('newCompFromRange', () => {
  it('a comp that IS the marked shot: conformed, trimmed, shortened — one entry, undoable', async () => {
    const c = getTimelineController();
    const before = (await h.doc());
    const entries = (await historyLabels()).length;

    const comp = await newCompFromRange(ASSET, { inSec: 2, outSec: 5 });
    await settleEdits();
    expect(comp).not.toBeNull();
    expect(useProjectStore.getState().comps[comp!]).toMatchObject({ name: 'clip_10s', width: 640, height: 360, fps: 30, durationSeconds: 3 });
    const [layer] = (await docView()).layerIdsOfComp(comp!);
    expect(useSelectionStore.getState().ids).toEqual([layer]);
    // The marked part of the file, from the comp's first frame.
    expect(c.getLayersForNode(layer!)[0]!.clip).toMatchObject({ sourceIn: 60, duration: 90, start: 0 });
    expect((await historyLabels()).slice(entries)).toEqual(['New Comp from Range']);

    const after = (await h.doc());
    await h.run({ type: 'undo' });
    expect((await h.doc())).toBe(before);
    expect(useProjectStore.getState().comps[comp!]).toBeUndefined();
    await h.run({ type: 'redo' });
    expect((await h.doc())).toBe(after);
  });
});
