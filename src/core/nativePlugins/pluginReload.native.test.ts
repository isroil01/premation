/**
 * reloadPlugin on the real engine (W2, docs/PLUGIN_SDK.md "Hot reload"): started with
 * `--plugin-shadow`, the engine loads a dev bundle from a copy, so the bundle's binary can be
 * rebuilt (overwritten) while it runs; `reloadPlugin` swaps the new build in; a broken build is
 * refused with the reason and the old one stays loaded.
 *
 * Needs the test probe the engine build lays out (<build>/test-plugins/reload/v1, v2:
 * native/engine/tests/plugins/reload_probe.cpp); skipped when it is absent.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unwrap, type EngineClient } from '@motion/engine-api';
import { bootEngine, engine, engineIdle, shutdownEngine } from '@core/engine/engineInstance';
import { resetEngineOwnership } from '@core/engine/engineOwnership';
import { resetProcessEngine } from '@core/engine/process/processEngine';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { reloadPlugin } from './pluginStore';

jest.setTimeout(120_000);

const exe = nativeEngineExe();
const binary = process.platform === 'win32' ? 'reload_probe.dll' : process.platform === 'darwin' ? 'libreload_probe.dylib' : 'libreload_probe.so';
const probes = exe ? path.join(path.dirname(exe), '..', 'test-plugins', 'reload') : '';
const run = !!exe && existsSync(path.join(probes, 'v1', binary)) && existsSync(path.join(probes, 'v2', binary));
if (!run) console.log('[plugin reload native] engine or reload probe not built — skipped');
const maybe = run ? describe : describe.skip;

const PROBE = 'com.premation.test.reload';
const manifest = JSON.stringify({
  manifestVersion: 1,
  id: PROBE,
  name: 'Reload probe',
  version: '1.0.0',
  sdk: { major: 1, minor: 2 },
  binary: { windows: 'reload_probe.dll', macos: 'libreload_probe.dylib', linux: 'libreload_probe.so' },
  effects: [{ matchName: `${PROBE}.probe`, name: 'Reload Probe', category: 'Test' }],
});

maybe('reloadPlugin (Developer Mode)', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let dir = '';
  let bundle = '';

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'plugin-reload-'));
    bundle = path.join(dir, 'plugins', 'reload');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(path.join(bundle, 'premation-plugin.json'), manifest);
    copyFileSync(path.join(probes, 'v1', binary), path.join(bundle, binary));
    native = await startNativeEngine({
      extraArgs: ['--no-gpu', '--test-ports', '--plugins', path.join(dir, 'plugins'), '--plugin-shadow', path.join(dir, 'shadow')],
    });
    (window as unknown as { motionEditor?: unknown }).motionEditor = { engine: native.bridge };
    resetProcessEngine();
    resetEngineOwnership();
    bootEngine({ ownsDocument: true });
    client = engine();
    await engineIdle();
  });

  afterAll(async () => {
    shutdownEngine();
    await native?.stop();
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
    rmSync(dir, { recursive: true, force: true });
  });

  const status = async () => unwrap(await client.query({ type: 'listPlugins' })).plugins.find((p) => p.id === PROBE)?.status;

  it('loads the dev bundle from a shadow copy, so its binary can be rebuilt while the engine runs', async () => {
    expect(await status()).toBe('loaded');
    expect(() => copyFileSync(path.join(probes, 'v2', binary), path.join(bundle, binary))).not.toThrow();
    expect(existsSync(path.join(dir, 'shadow', PROBE))).toBe(true);
  });

  it('swaps the rebuilt module in', async () => {
    const res = await reloadPlugin(client, PROBE);
    expect(res).toEqual(expect.objectContaining({ ok: true }));
    if (res.ok) expect(res.plugins.find((p) => p.id === PROBE)?.status).toBe('loaded');
  });

  it('refuses a broken build with the reason and keeps the old one loaded', async () => {
    writeFileSync(path.join(bundle, binary), 'not a shared library');
    const res = await reloadPlugin(client, PROBE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/was not reloaded/);
    expect(await status()).toBe('loaded');
  });

  it('names an unknown plugin', async () => {
    const res = await reloadPlugin(client, 'com.nobody.nothing');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/no installed plugin/);
  });
});
