/**
 * B5 exit criterion (NATIVE_CORE_PLAN §5): "replay of recorded sessions
 * reproduces documents exactly".
 *
 * A session is scripted through the REAL UI edit paths — the menu/timeline
 * edit functions the editor's clicks call (layout/Menu/appEdits), a pointer
 * drag as a `GestureSession`, the undo/redo the History panel sends — plus an
 * AI turn through the tool registry and a user script through the sandbox
 * host. The engine's command log (as JSON lines, the file format) is replayed
 * into the engine reset to the log's start document; the document and the
 * undo stack must come back equal.
 */

import { unwrap, type DocumentSnapshot } from '@motion/engine-api';
import { engine, engineIdle } from '@core/engine/engineInstance';
import { edit, GestureSession } from '@core/engine/uiEdits';
import { propertyStopwatchEdit, propertyKeyToggleEdit, createLayerEdit, toggleTrackSwitchEdit, centreInCompEdit } from '@layout/Menu/appEdits';
import { runToolTurn } from '@core/ai/aiTurn';
import { runScript } from '@core/scripting/scriptHost';
import { InProcessScriptWorker } from '@core/scripting/inProcessScriptWorker.testkit';
import { setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { recordSession, replaySession, CommandLogUnavailable, logFromJsonl } from './commandLog';
import { performUndo, performRedo, performJumpTo } from '@stores/historyStore';
import { activeCompRootId } from '@core/scene/activeComp';
import { documentMirror } from '@stores/documentMirror';

let h: Harness;
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

/** The document as the engine describes it, minus what moves with every request. */
async function content(): Promise<Omit<DocumentSnapshot, 'revision' | 'dirty' | 'projectPath'>> {
  await engineIdle();
  const d = unwrap(await engine().query({ type: 'getDocument', includeProperties: true, includeKeyframes: true }));
  const { revision: _r, dirty: _d, projectPath: _p, ...rest } = d;
  return rest;
}

/** The undo stack the session built: labels and position, measured from the end. */
async function history(): Promise<{ labels: string[]; fromEnd: number }> {
  const r = unwrap(await engine().query({ type: 'getHistory' }));
  return { labels: r.entries.map((e) => e.label), fromEnd: r.entries.length - r.position };
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
  it('reproduces a UI + AI + script session exactly: the document and the undo stack', async () => {
    const rec = await recordSession();
    await scriptedSession();
    const jsonl = await rec.stop();
    const live = await content();
    const historyLive = await history();
    expect(historyLive.labels).toEqual(expect.arrayContaining(['AI: add a spinner', 'Script: Tidy', 'Move']));
    expect(logFromJsonl(jsonl).records.length).toBeGreaterThan(20);

    const replay = await replaySession(jsonl);
    expect(replay.mismatches).toEqual([]);
    expect(await content()).toEqual(live);
    const replayed = await history();
    expect(replayed.labels.slice(-historyLive.labels.length)).toEqual(historyLive.labels);
    expect(replayed.fromEnd).toBe(historyLive.fromEnd);
  });

  it('keyboard undo/redo and the History panel jump are engine requests: the session replays exactly', async () => {
    const rec = await recordSession();
    const a = (await createLayerEdit('null', { name: 'A' }))!;
    await edit('Rename Layer', { type: 'renameLayer', layer: a, name: 'B' });
    await edit('Rename Layer', { type: 'renameLayer', layer: a, name: 'C' });
    // Ctrl+Z / Edit ▸ Undo / Ctrl+Shift+Z all call these.
    await performUndo();
    await performUndo();
    await performRedo();
    // History panel: click the first entry of the session.
    const first = unwrap(await engine().query({ type: 'getHistory' })).entries.length - 3;
    await performJumpTo(first);
    await createLayerEdit('null', { name: 'D' });
    await engineIdle();
    const jsonl = await rec.stop();
    const types = logFromJsonl(jsonl).records.map((r) => (r.request.body.kind === 'command' ? r.request.body.value.type : r.request.body.kind));
    expect(types.filter((t) => t === 'undo' || t === 'redo' || t === 'jumpToHistory')).toEqual(['undo', 'undo', 'redo', 'jumpToHistory']);
    const live = await content();
    const replay = await replaySession(jsonl);
    expect(replay.mismatches).toEqual([]);
    expect(await content()).toEqual(live);
  });

  it('refuses a file that is not a command log', async () => {
    await expect(replaySession(JSON.stringify({ header: {} }))).rejects.toThrow(CommandLogUnavailable);
    await expect(replaySession('')).rejects.toThrow(CommandLogUnavailable);
  });
});

/**
 * B5: the AI tools that used to write around the engine (update_layer's
 * material options and track matte, delete_layer on a parent) are engine
 * commands: the session replays to an equal document.
 */
describe('record → replay: the formerly-legacy AI tools', () => {

  async function solid(name: string): Promise<string> {
    const r = await edit('New Solid', { type: 'createLayer', comp: activeCompRootId(), kind: 'solid', name, init: [] });
    if (!r.ok) throw new Error(r.error.message);
    return (r.value[0] as { layer: string }).layer;
  }

  it('reproduces an AI session exactly', async () => {
    const rec = await recordSession();
    const d = await solid('D');
    const e = await solid('E');
    const f = await solid('F');
    await edit('Parent', { type: 'setParent', layers: [f], parent: e, keepWorldTransform: true });
    const turn = await runToolTurn('AI: light and matte', [
      { name: 'update_layer', args: { nodeId: d, threeD: true, acceptsLights: true, ambient: 40, specular: 70, shininess: 12 } },
      { name: 'update_layer', args: { nodeId: d, matte: { mode: 'luma', inverted: true } } },
      { name: 'delete_layer', args: { nodeIds: [e] } },
    ]);
    expect(turn.outcome.kind).toBe('engine');
    await engineIdle();
    expect(documentMirror().layer(f)).toBeUndefined();

    const jsonl = await rec.stop();
    const live = await content();
    const replay = await replaySession(jsonl);
    expect(replay.mismatches).toEqual([]);
    expect(await content()).toEqual(live);
  });
});
