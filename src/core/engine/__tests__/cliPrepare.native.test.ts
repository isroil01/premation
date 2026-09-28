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
import { ProcessEngineClient, secondsToFlicks } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
// Test-only reach into the Electron main sources: the launcher is plain Node.
import { runEnginePrepare } from '../../../../electron/cliPrepare';

const exe = nativeEngineExe();
const maybe = exe ? describe : describe.skip;
if (!exe) console.log('[cliPrepare] premation-engine is not built — skipped');

jest.setTimeout(180_000);

maybe('premation-engine --prepare', () => {
  let dir = '';
  let projectPath = '';

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
    expect(out).toMatchObject({ ok: true, result: { reframed: { width: 360, height: 360 } } });
    if (!out.ok) return;
    expect(out.result.comp).toBe(out.result.reframed?.comp);
    expect(existsSync(saveTo)).toBe(true);
    const listed = await runEnginePrepare({ projectPath: saveTo, listComps: true }, { enginePath: exe, workDir: path.join(dir, 'w4') });
    expect(listed.ok && listed.result.comps?.some((c) => c.id === out.result.comp && c.width === 360 && c.height === 360)).toBe(true);
  });

  it('refuses a composition that is not there, by name', async () => {
    const out = await runEnginePrepare({ projectPath, comp: 'Nope', reframe: { ratio: 1 } }, { enginePath: exe, workDir: path.join(dir, 'w2') });
    if (!out.ok && /built without --prepare|exit code 3/.test(out.message)) return;
    expect(out).toEqual({ ok: false, message: 'Composition "Nope" not found.' });
  });
});
