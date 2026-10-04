/**
 * `premation-engine --prepare` (native/engine/src/cli_prepare.cpp) through the
 * CLI's launcher (electron/cliPrepare.ts), against the real engine: a project
 * made and saved by the engine, then listed, reframed (the autoReframe job,
 * applied) and saved as the copy `--export` renders. Skipped, saying so, when
 * the engine is not built or predates `--prepare`.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessEngineClient, secondsToFlicks, unwrap } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
// Test-only reach into the Electron main sources: the launcher is plain Node.
import { runEnginePrepare } from '../../../../electron/cliPrepare';
import { commandLogRequests } from '../../../../electron/commandLog';

const exe = nativeEngineExe();
const maybe = exe ? describe : describe.skip;
if (!exe) console.log('[cliPrepare] premation-engine is not built — skipped');

jest.setTimeout(180_000);

maybe('premation-engine --prepare', () => {
  let dir = '';
  let projectPath = '';
  let textLayer = '';
  let startDocument = '';

  /** Open a saved copy in a fresh engine and read from it. */
  async function readBack<T>(file: string, read: (c: ProcessEngineClient) => Promise<T>): Promise<T> {
    const native = await startNativeEngine();
    try {
      const c = new ProcessEngineClient(native.bridge);
      await c.whenReady();
      unwrap(await c.execute({ type: 'openProject', path: file } as never));
      return await read(c);
    } finally {
      await native.stop();
    }
  }
  const sourceText = (c: ProcessEngineClient, layer: string): Promise<unknown> =>
    c.query({ type: 'getPropertyValues', props: [{ layer, path: 'text/sourceText' }], time: 0, evaluated: false } as never)
      .then((r) => (r.ok ? (r.value as { values: Array<{ value: unknown }> }).values[0]?.value : null));

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'premation-prepare-'));
    projectPath = path.join(dir, 'p.motion');
    const native = await startNativeEngine();
    try {
      const client = new ProcessEngineClient(native.bridge);
      await client.whenReady();
      const made = await client.execute({
        type: 'createComposition',
        settings: { name: 'Main', width: 640, height: 360, frameRate: { num: 30, den: 1 }, duration: secondsToFlicks(1) },
        fromItems: [],
      } as never);
      expect(made.ok).toBe(true);
      const comp = (made as { value: { item: string } }).value.item;
      textLayer = (unwrap(await client.execute({ type: 'createLayer', comp, kind: 'text', name: 'Name here', init: [] } as never)) as unknown as { layer: string }).layer;
      const fields = [{ id: 'name', label: 'Name', kind: 'text', default: '', target: { nodeId: textLayer, componentType: 'Text', prop: 'content' } }];
      unwrap(await client.execute({ type: 'setCompositionSettings', comp, patch: { templateFields: JSON.stringify(fields) } } as never));
      startDocument = new TextDecoder().decode((unwrap(await client.query({ type: 'exportDocument' } as never)) as unknown as { document: Uint8Array }).document);
      const saved = await client.execute({ type: 'saveProject', path: projectPath, copy: false } as never);
      expect(saved.ok).toBe(true);
    } finally {
      await native.stop();
    }
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('lists the compositions and saves a copy', async () => {
    const saveTo = path.join(dir, 'copy.motion');
    const out = await runEnginePrepare({ projectPath, listComps: true, saveTo }, { enginePath: exe, workDir: path.join(dir, 'w1') });
    if (!out.ok && /built without --prepare|exit code 3/.test(out.message)) return; // an engine older than --prepare
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) return;
    const main = out.result.comps?.find((c) => c.name === 'Main');
    expect(main).toMatchObject({ width: 640, height: 360, fps: 30 });
    expect(out.result.comp).toBe(main?.id);
    expect(existsSync(saveTo)).toBe(true);
  });

  it('reframes into a new composition and saves the copy that targets it', async () => {
    const saveTo = path.join(dir, 'square.motion');
    const out = await runEnginePrepare({ projectPath, comp: 'Main', reframe: { ratio: 1 }, saveTo }, { enginePath: exe, workDir: path.join(dir, 'w3') });
    if (!out.ok && /built without --prepare|exit code 3/.test(out.message)) return;
    if (!out.ok && /runs no jobs/.test(out.message)) return;  // the headless engine: auto-reframe is a job
    expect(out).toMatchObject({ ok: true, result: { reframed: { width: 360, height: 360 } } });
    if (!out.ok) return;
    expect(out.result.comp).toBe(out.result.reframed?.comp);
    expect(existsSync(saveTo)).toBe(true);
    const listed = await runEnginePrepare({ projectPath: saveTo, listComps: true }, { enginePath: exe, workDir: path.join(dir, 'w4') });
    expect(listed.ok && listed.result.comps?.some((c) => c.id === out.result.comp && c.width === 360 && c.height === 360)).toBe(true);
  });

  it('adds captions to the copy it saves (setCaptions)', async () => {
    const saveTo = path.join(dir, 'captioned.motion');
    const out = await runEnginePrepare({
      projectPath, comp: 'Main', saveTo,
      captions: { cues: [{ start: 0.1, end: 0.5, text: 'Hello' }, { start: 0.5, end: 0.9, text: 'World' }] },
    }, { enginePath: exe, workDir: path.join(dir, 'w5') });
    if (!out.ok && /built without --prepare|exit code 3/.test(out.message)) return;
    expect(out).toMatchObject({ ok: true, result: { captionLayers: 2 } });
    expect(existsSync(saveTo)).toBe(true);
  });

  it('fills a data row into the template fields (Source Text), in the saved copy', async () => {
    const saveTo = path.join(dir, 'row.motion');
    const out = await runEnginePrepare({ projectPath, comp: 'Main', fill: { name: 'Ada Lovelace', unused: 'x' }, saveTo }, { enginePath: exe, workDir: path.join(dir, 'w6') });
    if (!out.ok && /built without --prepare|exit code 3/.test(out.message)) return;
    expect(out).toMatchObject({ ok: true, result: { fill: { filled: ['name'], skipped: [], failed: [] } } });
    const text = await readBack(saveTo, (c) => sourceText(c, textLayer));
    expect(JSON.stringify(text)).toContain('Ada Lovelace');
  });

  it('replays a command log onto its start document', async () => {
    const log = [
      JSON.stringify({ header: { document: JSON.parse(startDocument), ids: {}, revision: 0 } }),
      JSON.stringify({ request: { seq: 1, body: { kind: 'command', value: { type: 'renameLayer', layer: textLayer, name: 'Replayed' } }, origin: 'ui' }, revisionAfter: 1, documentHash: 0 }),
    ].join('\n');
    const saveTo = path.join(dir, 'replayed.motion');
    const out = await runEnginePrepare({ projectPath, requests: commandLogRequests(log).requests, saveTo }, { enginePath: exe, workDir: path.join(dir, 'w7') });
    if (!out.ok && /built without --prepare|exit code 3/.test(out.message)) return;
    expect(out).toMatchObject({ ok: true, result: { replayed: { applied: 2, refused: 0 } } });
    const name = await readBack(saveTo, async (c) => {
      const r = await c.query({ type: 'getLayers', layers: [textLayer] } as never);
      return r.ok ? (r.value as { layers: Array<{ name: string }> }).layers[0]?.name : null;
    });
    expect(name).toBe('Replayed');
  });

  it('replays a log recorded mid-session: its gesture ids are the recording engine\'s', async () => {
    // Recorded after three earlier gestures: the log closes gestures 4 and 5,
    // while a fresh engine opens its own first gesture. Each recorded
    // endGesture must close the gesture the replayed beginGesture opened.
    const rec = (seq: number, value: unknown): string =>
      JSON.stringify({ request: { seq, body: { kind: 'command', value }, origin: 'ui' }, revisionAfter: seq, documentHash: 0 });
    const log = [
      JSON.stringify({ header: { document: JSON.parse(startDocument), ids: {}, revision: 0 } }),
      rec(1, { type: 'beginGesture', label: 'Rename' }),
      rec(2, { type: 'renameLayer', layer: textLayer, name: 'First' }),
      rec(3, { type: 'endGesture', gesture: 4, commit: true }),
      rec(4, { type: 'beginGesture', label: 'Rename again' }),
      rec(5, { type: 'renameLayer', layer: textLayer, name: 'Second' }),
      rec(6, { type: 'endGesture', gesture: 5, commit: true }),
    ].join('\n');
    const saveTo = path.join(dir, 'replayed-gestures.motion');
    const out = await runEnginePrepare({ projectPath, requests: commandLogRequests(log).requests, saveTo }, { enginePath: exe, workDir: path.join(dir, 'w8') });
    if (!out.ok && /built without --prepare|exit code 3/.test(out.message)) return;
    expect(out).toMatchObject({ ok: true, result: { replayed: { applied: 7, refused: 0 } } });
    const name = await readBack(saveTo, async (c) => {
      const r = await c.query({ type: 'getLayers', layers: [textLayer] } as never);
      return r.ok ? (r.value as { layers: Array<{ name: string }> }).layers[0]?.name : null;
    });
    expect(name).toBe('Second');
  });

  it('refuses a composition that is not there, by name', async () => {
    const out = await runEnginePrepare({ projectPath, comp: 'Nope', reframe: { ratio: 1 } }, { enginePath: exe, workDir: path.join(dir, 'w2') });
    if (!out.ok && /built without --prepare|exit code 3/.test(out.message)) return;
    expect(out).toEqual({ ok: false, message: 'Composition "Nope" not found.' });
  });
});
