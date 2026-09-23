/**
 * Controls and project I/O: history, gestures (coalescing, Esc), batches
 * (atomicity), transport, and New/Open/Save/Revert. Plus the coexistence rules
 * with the pre-API history recorders (ENGINE_API.md "B2 implementation notes").
 */

import { COMMANDS, type CommandType } from '@motion/engine-api';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { updateNodeComponentProp } from '@core/inspector/InspectorAPI';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { performUndo, performRedo } from '@stores/historyStore';
import { setupEngine, sec, docDiff, type Harness } from '../__testHelpers__/harness';
import { buildScene } from '../__testHelpers__/scene';

jest.useFakeTimers();

let h: Harness;
beforeEach(async () => { h = await setupEngine(); });
afterEach(async () => { await h.dispose(); });

const pos = (layer: string) => ({ layer, path: 'transform/position' });
const v2 = (x: number, y: number) => ({ kind: 'vec2' as const, value: { x, y } });

/** Every control and io command is exercised somewhere in this file. */
export const CONTROLS_COVERED: CommandType[] = [
  'undo', 'redo', 'jumpToHistory', 'beginGesture', 'endGesture', 'clearHistory', 'setHistoryLimit',
  'newProject', 'openProject', 'saveProject', 'revertProject', 'collectFiles', 'setAutosave', 'reloadItems',
  'play', 'pause', 'seek', 'step', 'setLoop', 'setPreviewQuality', 'setAudioPreview', 'setActiveComposition',
  'setViewport', 'closeViewport', 'setCacheBudget', 'purgeCache', 'setInteracting',
  'startJob', 'cancelJob', 'setPluginEnabled',
];

test('the list above covers every non-edit command', () => {
  const nonEdit = (Object.keys(COMMANDS) as CommandType[]).filter((t) => COMMANDS[t].kind !== 'edit');
  expect(nonEdit.filter((t) => !CONTROLS_COVERED.includes(t))).toEqual([]);
  expect(nonEdit.length).toBe(30);
});

test('undo / redo / jumpToHistory walk one linear history; empty stacks are typed errors', async () => {
  const r0 = await h.engine.execute({ type: 'undo' });
  expect(!r0.ok && r0.error.code).toBe('nothingToUndo');
  const s = await buildScene(h);
  const docs = [h.doc()];
  await h.run({ type: 'renameLayer', layer: s.A, name: 'One' });
  docs.push(h.doc());
  await h.run({ type: 'renameLayer', layer: s.A, name: 'Two' });
  docs.push(h.doc());
  const hist = await h.query({ type: 'getHistory' });
  const pos0 = hist.position;
  expect(hist.entries.slice(-2).map((e) => e.label)).toEqual(['Rename Layer', 'Rename Layer']);
  const step = await h.run({ type: 'jumpToHistory', position: pos0 - 2 });
  expect(step.position).toBe(pos0 - 2);
  expect(docDiff(docs[0]!, h.doc())).toEqual([]);
  await h.run({ type: 'jumpToHistory', position: pos0 });
  expect(docDiff(docs[2]!, h.doc())).toEqual([]);
  const rr = await h.engine.execute({ type: 'redo' });
  expect(!rr.ok && rr.error.code).toBe('nothingToRedo');
  // Undo is a revision: the document moves FORWARD.
  const rev = h.engine.documentRevision;
  await h.run({ type: 'undo' });
  expect(h.engine.documentRevision).toBe(rev + 1);
});

test('a gesture of 60 drag writes is ONE entry keeping the first inverse and the last value', async () => {
  const s = await buildScene(h);
  const before = h.doc();
  const entries = getCommandSystem().getHistory().getEntries().length;
  const { gesture } = await h.run({ type: 'beginGesture', label: 'Move' });
  for (let i = 1; i <= 60; i++) await h.run({ type: 'setProperty', prop: pos(s.A), value: v2(i, i * 2) });
  // Undo inside a gesture is refused.
  const u = await h.engine.execute({ type: 'undo' });
  expect(!u.ok && u.error.code).toBe('gestureOpen');
  await h.run({ type: 'endGesture', gesture, commit: true });
  const after = h.doc();
  expect(getCommandSystem().getHistory().getEntries().length).toBe(entries + 1);
  expect(getCommandSystem().getHistory().getEntries().at(-1)!.label).toBe('Move');
  const vals = await h.query({ type: 'getPropertyValues', props: [pos(s.A)], time: 0, evaluated: false });
  expect(vals.values[0]!.value).toEqual(v2(60, 120));
  await h.run({ type: 'undo' });
  expect(docDiff(before, h.doc())).toEqual([]);
  await h.run({ type: 'redo' });
  expect(docDiff(after, h.doc())).toEqual([]);
});

test('endGesture{commit:false} (Esc) reverts every edit of the gesture and records nothing', async () => {
  const s = await buildScene(h);
  const before = h.doc();
  const n = getCommandSystem().getHistory().getEntries().length;
  const { gesture } = await h.run({ type: 'beginGesture', label: 'Drag' });
  await h.run({ type: 'setProperty', prop: pos(s.A), value: v2(5, 5) });
  await h.run({ type: 'moveLayersInTime', layers: [s.B], delta: sec(1), ripple: false });
  await h.run({ type: 'endGesture', gesture, commit: false });
  expect(docDiff(before, h.doc())).toEqual([]);
  expect(getCommandSystem().getHistory().getEntries().length).toBe(n);
  const e = await h.engine.execute({ type: 'endGesture', gesture: 0, commit: true });
  expect(!e.ok && e.error.code).toBe('noGesture');
  await h.run({ type: 'beginGesture', label: 'x' });
  const nested = await h.engine.execute({ type: 'beginGesture', label: 'y' });
  expect(!nested.ok && nested.error.code).toBe('gestureOpen');
});

test('close() commits an open gesture (nothing the user saw is lost)', async () => {
  const s = await buildScene(h);
  await h.run({ type: 'beginGesture', label: 'Scrub' });
  await h.run({ type: 'setProperty', prop: pos(s.A), value: v2(9, 9) });
  const n = getCommandSystem().getHistory().getEntries().length;
  await h.engine.close();
  expect(getCommandSystem().getHistory().getEntries().length).toBe(n + 1);
});

test('a batch is atomic: a failing command k rolls back 0…k−1 and names k', async () => {
  const s = await buildScene(h);
  const before = h.doc();
  const rev = h.engine.documentRevision;
  const r = await h.engine.batch('Align', [
    { type: 'setProperty', prop: pos(s.A), value: v2(1, 1) },
    { type: 'renameLayer', layer: s.B, name: 'Bee' },
    { type: 'setProperty', prop: { layer: s.A, path: 'transform/nope' }, value: v2(1, 1) },
  ]);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error.code).toBe('notFound');
    expect(r.error.commandIndex).toBe(2);
  }
  expect(docDiff(before, h.doc())).toEqual([]);
  expect(h.engine.documentRevision).toBe(rev);
  const ok = await h.batch('Align', [
    { type: 'setProperty', prop: pos(s.A), value: v2(1, 1) },
    { type: 'renameLayer', layer: s.B, name: 'Bee' },
  ]);
  expect(ok).toHaveLength(2);
  expect(getCommandSystem().getHistory().getEntries().at(-1)!.label).toBe('Align');
  await h.run({ type: 'undo' });
  expect(docDiff(before, h.doc())).toEqual([]);
  const ctl = await h.engine.batch('x', [{ type: 'undo' }]);
  expect(!ctl.ok && ctl.error.code).toBe('invalidArgument');
});

test('typed errors change nothing: type mismatch, animated without time, conflict, cycle, locked', async () => {
  const s = await buildScene(h);
  const before = h.doc();
  const tm = await h.engine.execute({ type: 'setProperty', prop: pos(s.A), value: { kind: 'string', value: 'x' } });
  expect(!tm.ok && tm.error.code).toBe('typeMismatch');
  const an = await h.engine.execute({ type: 'setProperty', prop: pos(s.B), value: v2(1, 1) });
  expect(!an.ok && an.error.code).toBe('animated');
  const cf = await h.engine.execute({ type: 'renameLayer', layer: s.A, name: 'x' }, { baseRevision: 1 });
  expect(!cf.ok && cf.error.code).toBe('conflict');
  await h.run({ type: 'setParent', layers: [s.B], parent: s.P, keepWorldTransform: true });
  const cy = await h.engine.execute({ type: 'setParent', layers: [s.P], parent: s.B, keepWorldTransform: true });
  expect(!cy.ok && cy.error.code).toBe('cycle');
  await h.run({ type: 'undo' });
  expect(docDiff(before, h.doc())).toEqual([]);
  await h.run({ type: 'setLayerSwitches', layers: [s.A], patch: { locked: true } });
  const lk = await h.engine.execute({ type: 'deleteLayers', layers: [s.A] });
  expect(!lk.ok && lk.error.code).toBe('locked');
});

test('clearHistory and setHistoryLimit keep the document and trim the stack', async () => {
  const s = await buildScene(h);
  const doc = h.doc();
  await h.run({ type: 'setHistoryLimit', entries: 3 });
  expect((await h.query({ type: 'getHistory' })).entries.length).toBe(3);
  await h.run({ type: 'clearHistory' });
  expect((await h.query({ type: 'getHistory' })).entries.length).toBe(0);
  expect(h.doc()).toBe(doc);
  void s;
  const bad = await h.engine.execute({ type: 'setHistoryLimit', entries: 0 });
  expect(!bad.ok && bad.error.code).toBe('outOfRange');
});

test('new / save / open / revert / collect; io never enters history', async () => {
  const s = await buildScene(h);
  await h.run({ type: 'saveProject', path: 'C:/p/a.motion', copy: false });
  const saved = h.doc();
  await h.run({ type: 'renameLayer', layer: s.A, name: 'Changed' });
  await h.run({ type: 'revertProject' });
  expect(docDiff(saved, h.doc())).toEqual([]);
  expect((await h.query({ type: 'getHistory' })).entries.length).toBe(0);
  await h.run({ type: 'newProject' });
  expect(h.doc()).not.toBe(saved);
  await h.run({ type: 'openProject', path: 'C:/p/a.motion' });
  expect(docDiff(saved, h.doc())).toEqual([]);
  const missing = await h.engine.execute({ type: 'openProject', path: 'C:/p/none.motion' });
  expect(!missing.ok && missing.error.code).toBe('io');
  const col = await h.engine.execute({ type: 'collectFiles', folder: 'C:/out', onlyUsed: true });
  expect(!col.ok && col.error.code).toBe('unsupported'); // no collect port attached in the harness
  expect(h.batches.some((b) => b.events.some((e) => e.type === 'documentReset'))).toBe(true);
  await h.run({ type: 'setAutosave', enabled: true, intervalSeconds: 60, keep: 5 });
  expect(h.engine.autosave).toEqual({ enabled: true, intervalSeconds: 60, keep: 5 });
  await h.run({ type: 'reloadItems', items: [] });
});

test('transport controls report through ephemeral events and never touch the document', async () => {
  const s = await buildScene(h);
  const doc = h.doc();
  const rev = h.engine.documentRevision;
  h.batches.length = 0;
  await h.run({ type: 'setActiveComposition', comp: s.comp });
  await h.run({ type: 'seek', time: sec(2), mode: 'exact' });
  await h.run({ type: 'step', frames: 3 });
  await h.run({ type: 'setLoop', mode: 'pingPong' });
  await h.run({ type: 'play', rate: 2, range: 'workArea', audio: false, cacheFirst: false });
  await h.run({ type: 'pause', returnToStart: false });
  await h.run({ type: 'setPreviewQuality', resolution: 'half', fastPreview: 'adaptive', draft3d: false, motionBlur: true, adaptiveFloor: 'quarter' });
  await h.run({ type: 'setAudioPreview', muted: true, volume: 0.5, scrubAudio: false });
  await h.run({ type: 'setViewport', viewport: 1, width: 800, height: 450, devicePixelRatio: 2, zoom: 1, pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true });
  await h.run({ type: 'closeViewport', viewport: 1 });
  await h.run({ type: 'setCacheBudget', ramMegabytes: 4096, diskMegabytes: 0, diskPath: '' });
  await h.run({ type: 'purgeCache', kind: 'all' });
  await h.run({ type: 'setInteracting', interacting: true });
  expect(h.engine.transport.time).toBe(sec(2) + Math.round((3 * 705_600_000) / 30));
  const ph = h.batches.flatMap((b) => b.events).filter((e) => e.type === 'playhead');
  expect(ph.length).toBeGreaterThan(0);
  expect(h.batches.filter((b) => b.fromRevision !== b.toRevision).map((b) => b.events.map((e) => e.type))).toEqual([]);
  expect(h.doc()).toBe(doc);
  expect(h.engine.documentRevision).toBe(rev);
  const bad = await h.engine.execute({ type: 'closeViewport', viewport: 7 });
  expect(!bad.ok && bad.error.code).toBe('notFound');
  const job = await h.engine.execute({ type: 'startJob', job: { kind: 'render', value: { items: [] } }, apply: true });
  expect(!job.ok && job.error.code).toBe('unsupported');
  const cancel = await h.engine.execute({ type: 'cancelJob', job: 'nope' });
  expect(!cancel.ok && cancel.error.code).toBe('notFound');
  const plug = await h.engine.execute({ type: 'setPluginEnabled', plugin: 'none.such', enabled: false });
  expect(!plug.ok && plug.error.code).toBe('notFound');
});

describe('coexistence with the pre-API recorders', () => {
  test('an engine entry and a debounced UI edit interleave in one linear history', async () => {
    const s = await buildScene(h);
    const t = defaultSceneGraph.getNode(s.A)!.components.find((c) => c.type === 'Transform')!;
    const d0 = h.doc();
    await h.run({ type: 'renameLayer', layer: s.A, name: 'API' });
    const d1 = h.doc();
    // A legacy UI write: recorded by the 700 ms debounce.
    expect(updateNodeComponentProp(defaultSceneGraph, s.A, t.id, 'x', 777)).toBe(true);
    jest.advanceTimersByTime(800);
    const d2 = h.doc();
    // The engine command after it flushes nothing extra and records its own entry.
    await h.run({ type: 'renameLayer', layer: s.A, name: 'API2' });
    await h.run({ type: 'undo' });
    expect(docDiff(d2, h.doc())).toEqual([]);
    // The next undo is the UI's debounced entry (a foreign entry → mirror resync).
    h.batches.length = 0;
    await h.run({ type: 'undo' });
    expect(docDiff(d1, h.doc())).toEqual([]);
    expect(h.batches.some((b) => b.events.some((e) => e.type === 'documentReset'))).toBe(true);
    await h.run({ type: 'undo' });
    expect(docDiff(d0, h.doc())).toEqual([]);
    // The app's own Ctrl+Z path drives engine entries too.
    performRedo();
    expect(docDiff(d1, h.doc())).toEqual([]);
    performUndo();
    expect(docDiff(d0, h.doc())).toEqual([]);
  });

  test('an engine command flushes a pending debounced edit into its own entry first', async () => {
    const s = await buildScene(h);
    const t = defaultSceneGraph.getNode(s.A)!.components.find((c) => c.type === 'Transform')!;
    const n = getCommandSystem().getHistory().getEntries().length;
    updateNodeComponentProp(defaultSceneGraph, s.A, t.id, 'x', 5);
    // Inside the 700 ms window:
    await h.run({ type: 'renameLayer', layer: s.B, name: 'Bee' });
    const labels = getCommandSystem().getHistory().getEntries().slice(n).map((e) => e.label);
    expect(labels).toHaveLength(2);
    expect(labels[1]).toBe('Rename Layer');
    jest.advanceTimersByTime(800);
    // …and nothing is recorded twice afterwards.
    expect(getCommandSystem().getHistory().getEntries().length).toBe(n + 2);
  });

  test('a document change outside the engine sends documentReset{resync} before the next request', async () => {
    const s = await buildScene(h);
    const t = defaultSceneGraph.getNode(s.A)!.components.find((c) => c.type === 'Transform')!;
    updateNodeComponentProp(defaultSceneGraph, s.A, t.id, 'x', 1);
    h.batches.length = 0;
    await h.run({ type: 'renameLayer', layer: s.B, name: 'Bee' });
    const first = h.batches[0]!;
    expect(first.events[0]!.type).toBe('documentReset');
  });
});
