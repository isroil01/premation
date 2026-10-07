/**
 * The plugin store's engine side on premation-engine-headless (AE parity 2.7–2.9):
 * a bundle copied into the plugins folder after start loads on `rescanPlugins`
 * with no restart; its effects become editor effect definitions
 * (pluginEffectDefs.ts) and an ordinary `addEffect`; a plugin disabled at start
 * (`--plugin-disabled`) is listed and not loaded; a revoked one never loads.
 *
 * Needs the SDK sample bundles the engine build lays out next to it
 * (<build>/plugins/{ripple,rings}); skipped when they are absent.
 */

import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unwrap, type EngineClient } from '@motion/engine-api';
import { bootEngine, engine, engineIdle, shutdownEngine } from '@core/engine/engineInstance';
import { resetEngineOwnership } from '@core/engine/engineOwnership';
import { resetProcessEngine } from '@core/engine/process/processEngine';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { pluginEffectDefFor, refreshPluginEffectDefs } from '@core/inspector/pluginEffectDefs';
import { effectDefFor } from '@core/inspector/effectCatalog';
import { rescanPlugins } from './pluginStore';

jest.setTimeout(120_000);

const exe = nativeEngineExe();
const samples = exe ? path.join(path.dirname(exe), '..', 'plugins') : '';
const run = !!exe && existsSync(path.join(samples, 'ripple', 'premation-plugin.json'));
if (!run) console.log('[plugin store native] engine or sample bundles not built — skipped');
const maybe = run ? describe : describe.skip;

const RIPPLE = 'com.premation.samples.ripple';
const RINGS = 'com.premation.samples.rings';
const CHECKOUT = 'com.premation.samples.checkout';

maybe('the plugin store, engine side', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let dir = '';

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'plugin-store-'));
    // rings is installed before start; checkout is disabled at start; ripple arrives later.
    cpSync(path.join(samples, 'rings'), path.join(dir, 'rings'), { recursive: true });
    cpSync(path.join(samples, 'checkout'), path.join(dir, 'checkout'), { recursive: true });
    const revoked = path.join(dir, '.revoked.json');
    writeFileSync(revoked, JSON.stringify({ revoked: [{ id: 'com.nobody.unrelated', reason: 'x' }] }));
    native = await startNativeEngine({ extraArgs: ['--no-gpu', '--test-ports', '--plugins', dir, '--plugin-disabled', CHECKOUT, '--revoked', revoked] });
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

  it('lists what was there at start, the disabled one not loaded', async () => {
    const list = unwrap(await client.query({ type: 'listPlugins' })).plugins;
    expect(list.find((p) => p.id === RINGS)?.status).toBe('loaded');
    expect(list.find((p) => p.id === CHECKOUT)?.status).toBe('disabled');
    expect(list.find((p) => p.id === RIPPLE)).toBeUndefined();
  });

  it('loads a bundle installed after start on rescan, and its effects become editor definitions', async () => {
    cpSync(path.join(samples, 'ripple'), path.join(dir, 'ripple'), { recursive: true });
    const after = await rescanPlugins(client);
    expect(after?.find((p) => p.id === RIPPLE)?.status).toBe('loaded');
    await refreshPluginEffectDefs(client);
    const def = pluginEffectDefFor(RIPPLE);
    expect(def).toBeDefined();
    expect(effectDefFor(RIPPLE)).toBe(def);
    expect(def!.provider).toBe(RIPPLE);
    // A point param is two numbers; a popup is an enum with 1-based choices.
    const keys = def!.params.map((p) => `${p.key}:${p.type}`);
    expect(keys).toEqual(expect.arrayContaining(['p1X:number', 'p1Y:number', 'p2:number', 'p5:enum']));
    expect(def!.params.find((p) => p.key === 'p5')?.options).toEqual([{ value: 1, label: 'Nearest' }, { value: 2, label: 'Bilinear' }]);
    // rings has a button.
    expect(pluginEffectDefFor(RINGS)?.actions.some((a) => a.key === 'p8')).toBe(true);
  });

  it('adds a plugin effect like any other, and enabling a start-disabled plugin loads it', async () => {
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'P', width: 64, height: 64, duration: 705_600_000 }, fromItems: [] })).item;
    const layer = (unwrap(await client.execute({ type: 'createLayer', comp, kind: 'solid', init: [] } as never)) as unknown as { layer: string }).layer;
    const added = unwrap(await client.execute({ type: 'addEffect', layers: [layer], effect: RIPPLE, params: [] })).groups;
    expect(added).toHaveLength(1);
    unwrap(await client.execute({ type: 'setPluginEnabled', plugin: CHECKOUT, enabled: true }));
    const list = unwrap(await client.query({ type: 'listPlugins' })).plugins;
    expect(list.find((p) => p.id === CHECKOUT)?.status).toBe('loaded');
  });
});
