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
import { performUndo, performRedo, performJumpTo } from '@stores/historyStore';
import { activeCompRootId } from '@core/scene/activeComp';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getNodeEffects } from '@core/effects/effects';
import { useProjectStore } from '@stores/projectStore';
import { createHostApi } from '@core/plugins/hostApi';
import type { PluginManifest } from '@core/plugins/manifest';

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
    // A caller-chosen effect id is a named legacy gap (the engine mints ids).
    const turn = await runToolTurn('AI: legacy', [
      { name: 'create_layer', args: { id: 'b', kind: 'shape', name: 'Box' } },
      { name: 'add_effect', args: { nodeId: 'b', type: 'glow', id: 'my_glow' } },
    ]);
    expect(turn.outcome.kind).toBe('snapshot');
    await createLayerEdit('null', { name: 'After' });
    rec.stop();
    expect(rec.writesAroundEngine).toBeGreaterThan(0);
  });

  it('gesture ids ride in the header id counters: gestures before the recording, none burned on replay', async () => {
    // Three drags BEFORE recording: the recorded drags are gestures 4 and 5.
    const a = (await createLayerEdit('null', { name: 'A' }))!;
    for (let i = 0; i < 3; i++) {
      const g = new GestureSession('Pre');
      g.send({ type: 'setProperty', prop: { layer: a, path: 'transform/rotation' }, value: { kind: 'scalar', value: i } });
      await g.end();
    }
    const before = historyLabels();
    const rec = await recordSession();
    // Recording starts no gesture of its own (B5 burned one to learn the counter).
    expect(historyLabels()).toEqual(before);
    for (let i = 0; i < 2; i++) {
      const g = new GestureSession('Drag');
      g.send({ type: 'setProperty', prop: { layer: a, path: 'transform/position' }, value: { kind: 'vec2', value: { x: i * 10, y: 5 } } });
      await g.end();
    }
    const log = logFromJsonl(rec.stop());
    expect(log.header.ids.gesture).toBe(3);
    const ends = log.records.map((r) => r.request.body).filter((b) => b.kind === 'command' && b.value.type === 'endGesture');
    expect(ends.map((b) => (b.value as { gesture: number }).gesture)).toEqual([4, 5]);
    const saved = await save('C:/p/g-live.motion');
    const replay = await replaySession(log);
    expect(replay.mismatches).toEqual([]);
    expect(await save('C:/p/g-replay.motion')).toBe(saved);
  });

  it('a log in the B5 format (header.gestureSeq) still replays', async () => {
    const a = (await createLayerEdit('null', { name: 'A' }))!;
    const pre = new GestureSession('Pre');
    pre.send({ type: 'setProperty', prop: { layer: a, path: 'transform/rotation' }, value: { kind: 'scalar', value: 9 } });
    await pre.end();
    const rec = await recordSession();
    const g = new GestureSession('Drag');
    g.send({ type: 'setProperty', prop: { layer: a, path: 'transform/rotation' }, value: { kind: 'scalar', value: 3 } });
    await g.end();
    const log = logFromJsonl(rec.stop());
    const { gesture, ...ids } = log.header.ids;
    const b5 = { ...log, header: { ...log.header, ids, gestureSeq: gesture } };
    expect((await replaySession(b5)).mismatches).toEqual([]);
  });

  it('keyboard undo/redo and the History panel jump are engine requests: the session replays revision-exact', async () => {
    const rec = await recordSession();
    const a = (await createLayerEdit('null', { name: 'A' }))!;
    await edit('Rename Layer', { type: 'renameLayer', layer: a, name: 'B' });
    await edit('Rename Layer', { type: 'renameLayer', layer: a, name: 'C' });
    // Ctrl+Z / Edit ▸ Undo / Ctrl+Shift+Z all call these.
    await performUndo();
    await performUndo();
    await performRedo();
    // History panel: click the first entry.
    await performJumpTo(0);
    await createLayerEdit('null', { name: 'D' });
    await engineIdle();
    const jsonl = rec.stop();
    const types = logFromJsonl(jsonl).records.map((r) => (r.request.body.kind === 'command' ? r.request.body.value.type : r.request.body.kind));
    expect(types.filter((t) => t === 'undo' || t === 'redo' || t === 'jumpToHistory')).toEqual(['undo', 'undo', 'redo', 'jumpToHistory']);
    const savedLive = await save('C:/p/k-live.motion');
    const historyLive = await history();
    const replay = await replaySession(jsonl);
    expect(replay.mismatches).toEqual([]);
    expect(await save('C:/p/k-replay.motion')).toBe(savedLive);
    expect(await history()).toEqual(historyLive);
  });

  it('refuses a file that is not a command log', async () => {
    await expect(replaySession(JSON.stringify({ header: {} }))).rejects.toThrow(CommandLogUnavailable);
  });
});

/**
 * B5: plugins call the same API. A plugin's document verbs — compositions,
 * properties, effect parameters, keyframes in layer time, a subtree delete —
 * and the AI tools that used to write around the engine (update_layer's
 * material options and track matte, delete_layer on a parent) are engine
 * commands now: the session is exact (`writesAroundEngine` 0) and replays to
 * a byte-identical saved project.
 */
describe('record → replay: plugins and the formerly-legacy AI tools', () => {
  const manifest = {
    id: 'studio.acme.tool', name: 'Tool', version: '1.0.0', description: 'A tool.', apiVersion: 5,
    main: 'main.js', permissions: [], activationEvents: ['onStartup'],
    contributes: { commands: [], panels: [], layerKinds: [], effects: [], net: null },
  } as unknown as PluginManifest;
  const api = createHostApi(manifest, {
    registerCommand: () => {}, openPanel: () => {}, closePanel: () => {}, warn: () => {},
    granted: () => new Set<never>(),
  });
  const call = async (verb: string, ...args: unknown[]): Promise<unknown> => api[verb]!(...args);

  async function solid(name: string): Promise<string> {
    const r = await edit('New Solid', { type: 'createLayer', comp: activeCompRootId(), kind: 'solid', name, init: [] });
    if (!r.ok) throw new Error(r.error.message);
    return (r.value[0] as { layer: string }).layer;
  }

  it('reproduces a plugin + AI session exactly, with no write around the engine', async () => {
    const rec = await recordSession();
    const a = await solid('A');
    const b = await solid('B');
    const c = await solid('C');

    // ── The plugin ──
    const comp = String(await call('composition.create', { name: 'Plugged', width: 640, height: 360, fps: 25, durationSeconds: 3 }));
    expect(useProjectStore.getState().comps[comp]).toMatchObject({ name: 'Plugged', width: 640, height: 360, fps: 25 });
    await call('composition.rename', comp, 'Plugged (renamed)');
    await call('composition.delete', comp);
    expect(useProjectStore.getState().comps[comp]).toBeUndefined();
    await call('scene.setProperty', a, 'opacity', 40);
    const fx = String(await call('effects.add', a, 'blur'));
    await call('effects.setParam', a, fx, 'amount', 12);
    await call('animation.setKeyframes', a, 'rotation', [{ t: 0, value: 0 }, { t: 1, value: 90, easing: 'easeInOut' }, { t: 2, value: 45 }]);
    await call('animation.setKeyframe', a, 'y', 0.5, 300);
    await call('animation.removeKeyframe', a, 'rotation', 2);
    // Layer time, stored units, exactly where the legacy writers put them.
    expect(defaultAnimation.getTrackKeyframes(a, 'rotation')?.map((k) => [k.t, k.value, k.easing])).toEqual([[0, 0, 'linear'], [1, 90, 'easeInOut']]);
    expect(defaultAnimation.getTrackKeyframes(a, 'y')?.map((k) => [k.t, k.value])).toEqual([[0.5, 300]]);
    expect(getNodeEffects(a).find((x) => x.id === fx)?.params?.amount).toBe(12);
    await call('scene.setParent', c, b);
    await call('scene.deleteLayer', b);
    expect(defaultSceneGraph.getNode(b)).toBeUndefined();
    expect(defaultSceneGraph.getNode(c)).toBeUndefined();

    // ── An AI turn through the tools that used to go around the engine ──
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
    expect(defaultSceneGraph.getNode(f)).toBeUndefined();
    await engineIdle();

    const jsonl = rec.stop();
    expect(rec.writesAroundEngine).toBe(0);
    // Eleven plugin calls, eleven engine entries named after the plugin.
    const entries = h.engine.historyState().entries;
    expect(entries.filter((x) => x.origin === 'plugin').map((x) => x.label.split(':')[0])).toEqual(Array(11).fill('Tool'));
    const savedLive = await save('C:/p/plugin-live.motion');

    const replay = await replaySession(jsonl);
    expect(replay.mismatches).toEqual([]);
    expect(await save('C:/p/plugin-replay.motion')).toBe(savedLive);
  });
});
