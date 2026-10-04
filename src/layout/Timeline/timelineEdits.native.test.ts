/**
 * The timeline's bar / work-area / marker edits through the engine API (B3).
 *
 * Pinned for every gesture: ONE undo entry with the legacy label, the geometry
 * the legacy clip math produced (clamps included), and an exact undo / redo
 * round trip of the document.
 */

import { flicksToSeconds } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { timingBarFrames } from '@core/mirror/compFacts';
import { seekPlayhead } from '@core/timeline/timelineView';
import { useSelectionStore } from '@stores/selectionStore';
import { setupAppEngine, historyLabels, settleEdits } from '@core/engine/__testHelpers__/appEngine';
import { sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import {
  activeCompId,
  deleteMarkers,
  editMarker,
  moveBar,
  moveBars,
  nudgeSelectedLayers,
  rippleDeleteLayers,
  rollBars,
  setCompDuration,
  setWorkArea,
  setWorkAreaIn,
  setWorkAreaOut,
  slideBar,
  slipBar,
  splitLayersAt,
  trimBar,
} from './timelineEdits';

let h: Harness;
const COMP = 'comp_root';

async function layer(kind: 'solid' | 'video', name: string, source?: string): Promise<string> {
  const id = (await h.run({ type: 'createLayer', comp: COMP, kind, name, ...(source ? { source } : {}), init: [] })).layer;
  await settleEdits();
  return id;
}

/** A layer's bar in frames of the 30 fps comp, as the timeline draws it (the mirror's timing). */
const bar = (id: string) => timingBarFrames(documentMirror().layer(id)!.timing, 30);
/** The timeline's id for a layer's bar. */
const clipId = (id: string) => `clip:${id}`;
const comp = () => documentMirror().comp(COMP)!;
/** The work area in comp seconds, null when it is the whole composition. */
const workArea = (): { start: number; end: number } | null => {
  const st = comp().settings;
  if (st.workArea.start === 0 && st.workArea.duration === st.duration) return null;
  return { start: flicksToSeconds(st.workArea.start), end: flicksToSeconds(st.workArea.start + st.workArea.duration) };
};
const markers = () => comp().markers.map((m) => ({ ...m, time: flicksToSeconds(m.time) }));

/** The document before a call, and a check that undo/redo round-trip it. */
async function roundTrip(run: () => Promise<unknown>, label: string): Promise<void> {
  const before = (await h.doc());
  const entries = (await historyLabels()).length;
  await run();
  await settleEdits();
  const after = (await h.doc());
  expect(after).not.toBe(before);
  expect((await historyLabels()).length).toBe(entries + 1);
  expect((await historyLabels()).at(-1)).toBe(label);
  await h.run({ type: 'undo' });
  expect((await h.doc())).toBe(before);
  await h.run({ type: 'redo' });
  expect((await h.doc())).toBe(after);
  await settleEdits();
}

beforeEach(async () => {
  h = await setupAppEngine();
});

afterEach(async () => {
  await h.dispose();
});

describe('bars', () => {
  it('the timeline edits the composition the engine calls comp_root', async () => {
    expect(activeCompId()).toBe(COMP);
  });

  it('move: whole frames, one entry', async () => {
    const A = await layer('solid', 'A');
    await roundTrip(() => moveBar(clipId(A), 1.01), 'Move Layer');
    expect(bar(A).start).toBe(30);
  });

  it('a multi-bar drag is ONE entry for every bar', async () => {
    const A = await layer('solid', 'A');
    const B = await layer('solid', 'B');
    await roundTrip(() => moveBars([{ clipId: clipId(A), start: 1 }, { clipId: clipId(B), start: 2 }], 'Stagger Layers'), 'Stagger Layers');
    expect(bar(A).start).toBe(30);
    expect(bar(B).start).toBe(60);
  });

  it('a locked bar stays put', async () => {
    const A = await layer('solid', 'A');
    await h.run({ type: 'setLayerSwitches', layers: [A], patch: { locked: true } });
    const entries = (await historyLabels()).length;
    await moveBar(clipId(A), 1);
    expect(bar(A).start).toBe(0);
    expect((await historyLabels()).length).toBe(entries);
  });

  it('trim both edges', async () => {
    const A = await layer('solid', 'A');
    await roundTrip(async () => { await trimBar(clipId(A), 'start', 1); }, 'Trim Layer');
    expect(bar(A)).toMatchObject({ start: 30, sourceIn: 30 });
    const end = bar(A).start + bar(A).duration;
    await roundTrip(async () => { await trimBar(clipId(A), 'end', 2); }, 'Trim Layer');
    expect(bar(A).start + bar(A).duration).toBe(60);
    expect(end).toBeGreaterThan(60);
  });

  it('a trim past the footage end clamps like the legacy clip math', async () => {
    const { items: [f] } = await h.run({ type: 'importFiles', files: [{ path: 'C:/m/a.mp4', asSequence: false, createComposition: false }] });
    const V = await layer('video', 'V', f);
    const dur = bar(V).duration; // 4 s of footage
    await trimBar(clipId(V), 'end', 9);
    await settleEdits();
    expect(bar(V).duration).toBe(dur);
  });

  it('ripple trim of the tail pulls later layers left', async () => {
    const A = await layer('solid', 'A');
    const B = await layer('solid', 'B');
    await h.run({ type: 'setLayerTiming', items: [
      { layer: A, inPoint: 0, outPoint: sec(2), startTime: 0 },
      { layer: B, inPoint: sec(2), outPoint: sec(4), startTime: sec(2) },
    ] });
    await settleEdits();
    await roundTrip(async () => { await trimBar(clipId(A), 'end', 1, { ripple: true }); }, 'Ripple Trim Layer');
    expect(bar(A).duration).toBe(30);
    expect(bar(B).start).toBe(30);
  });

  it('slip moves the source, not the bar', async () => {
    const { items: [f] } = await h.run({ type: 'importFiles', files: [{ path: 'C:/m/a.mp4', asSequence: false, createComposition: false }] });
    const V = await layer('video', 'V', f);
    await trimBar(clipId(V), 'end', 2);
    await settleEdits();
    await roundTrip(() => slipBar(clipId(V), 1), 'Slip Layer');
    expect(bar(V)).toMatchObject({ start: 0, sourceIn: 30, duration: 60 });
  });

  it('slide trims the abutting neighbours', async () => {
    const [A, B, C] = [await layer('solid', 'A'), await layer('solid', 'B'), await layer('solid', 'C')];
    await h.run({ type: 'setLayerTiming', items: [
      { layer: A, inPoint: 0, outPoint: sec(1), startTime: 0 },
      { layer: B, inPoint: sec(1), outPoint: sec(2), startTime: sec(1) },
      { layer: C, inPoint: sec(2), outPoint: sec(3), startTime: sec(2) },
    ] });
    await settleEdits();
    await roundTrip(() => slideBar(clipId(B), 1.5), 'Slide Layer');
    expect(bar(B).start).toBe(45);
    expect(bar(A).start + bar(A).duration).toBe(45);
    expect(bar(C).start).toBe(75);
  });

  it('roll moves the cut between two bars', async () => {
    const [A, B] = [await layer('solid', 'A'), await layer('solid', 'B')];
    await h.run({ type: 'setLayerTiming', items: [
      { layer: A, inPoint: 0, outPoint: sec(1), startTime: 0 },
      { layer: B, inPoint: sec(1), outPoint: sec(2), startTime: sec(1) },
    ] });
    await settleEdits();
    await roundTrip(() => rollBars(clipId(A), clipId(B), 0.5), 'Roll Edit');
    expect(bar(A).duration).toBe(45);
    expect(bar(B).start).toBe(45);
  });

  it('split: one entry, the right halves selected (Ctrl+Shift+D)', async () => {
    const [A, B] = [await layer('solid', 'A'), await layer('solid', 'B')];
    const before = (await h.doc());
    const right = await splitLayersAt([A, B], 1, { selectRight: true });
    await settleEdits();
    expect(right).toHaveLength(2);
    expect(useSelectionStore.getState().ids).toEqual(right);
    expect((await historyLabels()).at(-1)).toBe('Split Layers');
    expect(bar(A).duration).toBe(30);
    await h.run({ type: 'undo' });
    expect((await h.doc())).toBe(before);
  });

  it('ripple delete closes the gap', async () => {
    const [A, B] = [await layer('solid', 'A'), await layer('solid', 'B')];
    await h.run({ type: 'setLayerTiming', items: [
      { layer: A, inPoint: 0, outPoint: sec(1), startTime: 0 },
      { layer: B, inPoint: sec(1), outPoint: sec(2), startTime: sec(1) },
    ] });
    await settleEdits();
    await roundTrip(() => rippleDeleteLayers([A]), 'Ripple Delete Layer');
    expect(bar(B).start).toBe(0);
  });

  it('Alt+PageDown nudges every selected layer in one entry', async () => {
    const [A, B] = [await layer('solid', 'A'), await layer('solid', 'B')];
    expect(nudgeSelectedLayers([A, B], 3)).toBe(true);
    await settleEdits();
    expect((await historyLabels()).at(-1)).toBe('Nudge Layers');
    expect([bar(A).start, bar(B).start]).toEqual([3, 3]);
    expect(nudgeSelectedLayers([], 3)).toBe(false);
  });
});

describe('work area, duration, markers', () => {
  it('drag the band / B / N', async () => {
    await roundTrip(() => setWorkArea(1, 3), 'Work Area');
    expect(workArea()).toEqual({ start: 1, end: 3 });
    seekPlayhead(2);
    await setWorkAreaIn();
    expect(workArea()).toEqual({ start: 2, end: 3 });
    seekPlayhead(4);
    await setWorkAreaOut();
    expect(workArea()).toEqual({ start: 2, end: 4 });
  });

  it('the duration field', async () => {
    await roundTrip(() => setCompDuration(4), 'Set Duration');
    expect(Math.round(flicksToSeconds(comp().settings.duration) * 30)).toBe(120);
  });

  it('move / rename / delete a comp marker', async () => {
    const { ids: [m] } = await h.run({ type: 'addMarkers', markers: [{ owner: { comp: COMP }, time: sec(1), duration: 0, name: 'M', comment: '', label: 0 }] });
    await roundTrip(() => editMarker(m!, { time: 2 }), 'Move Marker');
    expect(markers()[0]!.time).toBe(2);
    await roundTrip(() => editMarker(m!, { label: 'Beat', comment: 'x' }), 'Edit Marker');
    expect(markers()[0]!.name).toBe('Beat');
    // An edit that changes nothing records nothing (the legacy `same` check).
    const entries = (await historyLabels()).length;
    await editMarker(m!, { label: 'Beat' });
    expect((await historyLabels()).length).toBe(entries);
    await roundTrip(() => deleteMarkers([m!]), 'Remove Marker');
    expect(markers()).toHaveLength(0);
  });
});
