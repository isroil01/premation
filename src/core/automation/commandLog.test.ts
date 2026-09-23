/**
 * B5 exit criterion (NATIVE_CORE_PLAN §5): "replay of recorded sessions
 * reproduces documents exactly".
 *
 * A session is scripted through the REAL UI edit paths — the menu/timeline
 * edit functions the editor's clicks call (layout/Menu/appEdits), a pointer
 * drag as a `GestureSession`, the undo/redo the History panel sends — plus an
 * AI turn through the tool registry and a user script through the sandbox
 * host. The recorded log (as JSON lines, the file format) is replayed into a
 * fresh engine instance; the saved project JSON must be byte-identical and
 * the undo stack equal.
 */

import { engine, engineIdle, localEngine } from '@core/engine/engineInstance';
import { edit, GestureSession } from '@core/engine/uiEdits';
import { propertyStopwatchEdit, propertyKeyToggleEdit, createLayerEdit, toggleTrackSwitchEdit, centreInCompEdit } from '@layout/Menu/appEdits';
import { runToolTurn } from '@core/ai/aiTurn';
import { runScript } from '@core/scripting/scriptHost';
import { InProcessScriptWorker } from '@core/scripting/inProcessScriptWorker.testkit';
import type { LocalEngine } from '@core/engine/LocalEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import { setupRecordingAppEngine, historyLabels } from './__testHelpers__/recordingAppEngine';
import { recordSession, replaySession, isRecording, CommandLogUnavailable, logFromJsonl } from './commandLog';

let h: Harness & { engine: LocalEngine };
beforeEach(async () => { h = await setupRecordingAppEngine(); });
afterEach(async () => { await h.dispose(); });

async function save(path: string): Promise<string> {
  const e = localEngine()!;
  const r = await e.execute({ type: 'saveProject', path, copy: true });
  if (!r.ok) throw new Error(r.error.message);
  return JSON.stringify(h.files.get(path));
}

async function history(): Promise<{ labels: string[]; position: number }> {
  const r = await localEngine()!.query({ type: 'getHistory' });
  if (!r.ok) throw new Error(r.error.message);
  return { labels: r.value.entries.map((e) => e.label), position: r.value.position };
}

async function scriptedSession(): Promise<void> {
  // Menu: New Null ×2 (Layer ▸ New ▸ Null Object).
  const a = (await createLayerEdit('null', { name: 'Anchor' }))!;
  const b = (await createLayerEdit('null', { name: 'Follower' }))!;
  // Composition ▸ Centre In Frame, a timeline eye click, a lock click and back.
  await centreInCompEdit([b], { width: 1920, height: 1080 }, 0);
  await toggleTrackSwitchEdit(a, 'visible');
  await toggleTrackSwitchEdit(a, 'locked');
  await toggleTrackSwitchEdit(a, 'locked');
  // Inspector: the stopwatch at 0 s, a diamond at 1 s.
  await propertyStopwatchEdit(b, ['rotation'], 0);
  await propertyKeyToggleEdit(b, 'rotation', 1);
  // A viewport drag: 12 pointer moves, one entry.
  const g = new GestureSession('Move');
  for (let i = 1; i <= 12; i++) {
    g.send({ type: 'setProperty', prop: { layer: a, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 100 + i * 10, y: 200 + i * 5 } } });
  }
  await g.end();
  // A rename typed in the Layers panel.
  await edit('Rename Layer', { type: 'renameLayer', layer: a, name: 'Anchor (renamed)' });
  // History panel: undo twice, redo once (the redo stack survives in the log).
  await engine().undo();
  await engine().undo();
  await engine().redo();
  // An AI turn (no model: the tool calls a library emitter would make).
  const turn = await runToolTurn('AI: add a spinner', [
    { name: 'create_layer', args: { id: 's', kind: 'null', name: 'Spinner', x: 400, y: 300 } },
    { name: 'set_keyframes', args: { keyframes: [
      { nodeId: 's', prop: 'rotation', t: 0, value: 0, easing: 'easeInOut' },
      { nodeId: 's', prop: 'rotation', t: 2, value: 360 },
      { nodeId: 's', prop: 'y', t: 0, value: 300 },
      { nodeId: 's', prop: 'y', t: 2, value: 600 },
    ] } },
    { name: 'reparent_layer', args: { nodeId: 's', parentId: b } },
  ]);
  expect(turn.outcome.kind).toBe('engine');
  // A user script.
  const script = await runScript(`
    // @permissions document.read, document.write
    const doc = await premation.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    const comp = doc.comps.find((c) => c.layers.length > 0).id;
    const { layer } = await premation.execute({ type: 'createLayer', comp, kind: 'null', name: 'Scripted', init: [] });
    await premation.execute({ type: 'setProperty', prop: { layer, path: 'transform/rotation' }, value: { kind: 'scalar', value: 33 } });
  `, { name: 'Tidy', consent: () => true, workerFactory: () => new InProcessScriptWorker() });
  expect(script).toMatchObject({ ok: true, outcome: 'engine' });
  await engineIdle();
}

describe('record → replay', () => {
  it('reproduces a UI + AI + script session exactly: saved project JSON and undo stack', async () => {
    const rec = await recordSession();
    await scriptedSession();
    const jsonl = rec.stop();
    expect(rec.writesAroundEngine).toBe(0);
    const savedLive = await save('C:/p/live.motion');
    const historyLive = await history();
    expect(historyLive.labels).toEqual(historyLabels());
    expect(historyLive.labels).toEqual(expect.arrayContaining(['AI: add a spinner', 'Script: Tidy', 'Move']));
    expect(logFromJsonl(jsonl).records.length).toBeGreaterThan(20);

    const replay = await replaySession(jsonl);           // a FRESH app engine instance
    expect(replay.mismatches).toEqual([]);
    expect(localEngine()).not.toBe(h.engine);
    const savedReplay = await save('C:/p/replay.motion');
    expect(savedReplay).toBe(savedLive);
    expect(await history()).toEqual(historyLive);

    // The replayed session is a live one: its undo stack walks back identically.
    await engine().undo();
    expect(historyLabels().length).toBe(historyLive.labels.length);
  });

  it('refuses to record on an engine that does not keep a log', async () => {
    // A LocalEngine built with recordLog: false hands out a fresh header each time.
    const fake = { commandLog: () => ({ header: {}, records: [] }) } as unknown as LocalEngine;
    expect(isRecording(fake)).toBe(false);
    await expect(recordSession({ engine: fake })).rejects.toThrow(CommandLogUnavailable);
    expect(isRecording(h.engine)).toBe(true);
  });

  it('says when a session wrote around the engine (a legacy AI turn): its replay would not be exact', async () => {
    const rec = await recordSession();
    const turn = await runToolTurn('AI: legacy', [{ name: 'create_layer', args: { kind: 'shape', name: 'Box', fill: '#ff0000' } }]);
    expect(turn.outcome.kind).toBe('snapshot');
    await createLayerEdit('null', { name: 'After' });
    rec.stop();
    expect(rec.writesAroundEngine).toBeGreaterThan(0);
  });

  it('refuses a file that is not a command log', async () => {
    await expect(replaySession(JSON.stringify({ header: {} }))).rejects.toThrow(CommandLogUnavailable);
  });
});
