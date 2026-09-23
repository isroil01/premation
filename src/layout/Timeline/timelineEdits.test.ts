/**
 * The timeline's bar / work-area / marker edits through the engine API (B3).
 *
 * Pinned for every gesture: ONE undo entry with the legacy label, the geometry
 * the legacy clip math produced (clamps included), and an exact undo / redo
 * round trip of the document.
 */

import { getTimelineController } from '@core/timeline/TimelineController';
import { useSelectionStore } from '@stores/selectionStore';
import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { sec, type Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
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

let h: Harness & { engine: LocalEngine };
const COMP = 'comp_root';

async function layer(kind: 'solid' | 'video', name: string, source?: string): Promise<string> {
  return (await h.run({ type: 'createLayer', comp: COMP, kind, name, ...(source ? { source } : {}), init: [] })).layer;
}

const c = () => getTimelineController();
const bar = (id: string) => c().getLayersForNode(id)[0]!.clip.toJSON();
const clipId = (id: string) => c().getLayersForNode(id)[0]!.id;

/** The document before a call, and a check that undo/redo round-trip it. */
async function roundTrip(run: () => Promise<unknown>, label: string): Promise<void> {
  const before = h.doc();
  const entries = historyLabels().length;
  await run();
  await engineIdle();
  const after = h.doc();
  expect(after).not.toBe(before);
  expect(historyLabels().length).toBe(entries + 1);
  expect(historyLabels().at(-1)).toBe(label);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
  await h.run({ type: 'redo' });
  expect(h.doc()).toBe(after);
}

beforeEach(async () => {
  h = await setupAppEngine();
});

afterEach(async () => {
  await h.dispose();
});

describe('bars', () => {
  it('the timeline edits the composition the engine calls comp_root', () => {
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
    const entries = historyLabels().length;
    await moveBar(clipId(A), 1);
    expect(bar(A).start).toBe(0);
    expect(historyLabels().length).toBe(entries);
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
    await engineIdle();
    expect(bar(V).duration).toBe(dur);
  });

  it('ripple trim of the tail pulls later layers left', async () => {
    const A = await layer('solid', 'A');
    const B = await layer('solid', 'B');
    await h.run({ type: 'setLayerTiming', items: [
      { layer: A, inPoint: 0, outPoint: sec(2), startTime: 0 },
      { layer: B, inPoint: sec(2), outPoint: sec(4), startTime: sec(2) },
    ] });
    await roundTrip(async () => { await trimBar(clipId(A), 'end', 1, { ripple: true }); }, 'Ripple Trim Layer');
    expect(bar(A).duration).toBe(30);
    expect(bar(B).start).toBe(30);
  });

  it('slip moves the source, not the bar', async () => {
    const { items: [f] } = await h.run({ type: 'importFiles', files: [{ path: 'C:/m/a.mp4', asSequence: false, createComposition: false }] });
    const V = await layer('video', 'V', f);
    await trimBar(clipId(V), 'end', 2);
    await engineIdle();
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
    await roundTrip(() => rollBars(clipId(A), clipId(B), 0.5), 'Roll Edit');
    expect(bar(A).duration).toBe(45);
    expect(bar(B).start).toBe(45);
  });

  it('split: one entry, the right halves selected (Ctrl+Shift+D)', async () => {
    const [A, B] = [await layer('solid', 'A'), await layer('solid', 'B')];
    const before = h.doc();
    const right = await splitLayersAt([A, B], 1, { selectRight: true });
    await engineIdle();
    expect(right).toHaveLength(2);
    expect(useSelectionStore.getState().ids).toEqual(right);
    expect(historyLabels().at(-1)).toBe('Split Layers');
    expect(bar(A).duration).toBe(30);
    await h.run({ type: 'undo' });
    expect(h.doc()).toBe(before);
  });

  it('ripple delete closes the gap', async () => {
    const [A, B] = [await layer('solid', 'A'), await layer('solid', 'B')];
    await h.run({ type: 'setLayerTiming', items: [
      { layer: A, inPoint: 0, outPoint: sec(1), startTime: 0 },
      { layer: B, inPoint: sec(1), outPoint: sec(2), startTime: sec(1) },
    ] });
    await roundTrip(() => rippleDeleteLayers([A]), 'Ripple Delete Layer');
    expect(bar(B).start).toBe(0);
  });

  it('Alt+PageDown nudges every selected layer in one entry', async () => {
    const [A, B] = [await layer('solid', 'A'), await layer('solid', 'B')];
    expect(nudgeSelectedLayers([A, B], 3)).toBe(true);
    await engineIdle();
    expect(historyLabels().at(-1)).toBe('Nudge Layers');
    expect([bar(A).start, bar(B).start]).toEqual([3, 3]);
    expect(nudgeSelectedLayers([], 3)).toBe(false);
  });
});

describe('work area, duration, markers', () => {
  it('drag the band / B / N', async () => {
    await roundTrip(() => setWorkArea(1, 3), 'Work Area');
    expect(c().getWorkArea()).toEqual({ start: 1, end: 3 });
    c().timeline.seek(60);
    await setWorkAreaIn();
    expect(c().getWorkArea()).toEqual({ start: 2, end: 3 });
    c().timeline.seek(120);
    await setWorkAreaOut();
    expect(c().getWorkArea()).toEqual({ start: 2, end: 4 });
  });

  it('the duration field', async () => {
    await roundTrip(() => setCompDuration(4), 'Set Duration');
    expect(c().timeline.duration).toBe(120);
  });

  it('move / rename / delete a comp marker', async () => {
    const { ids: [m] } = await h.run({ type: 'addMarkers', markers: [{ owner: { comp: COMP }, time: sec(1), duration: 0, name: 'M', comment: '', label: 0 }] });
    await roundTrip(() => editMarker(m!, { time: 2 }), 'Move Marker');
    expect(c().getMarkers()[0]!.time).toBe(2);
    await roundTrip(() => editMarker(m!, { label: 'Beat', comment: 'x' }), 'Edit Marker');
    expect(c().getMarkers()[0]!.label).toBe('Beat');
    // An edit that changes nothing records nothing (the legacy `same` check).
    const entries = historyLabels().length;
    await editMarker(m!, { label: 'Beat' });
    expect(historyLabels().length).toBe(entries);
    await roundTrip(() => deleteMarkers([m!]), 'Remove Marker');
    expect(c().getMarkers()).toHaveLength(0);
  });
});
