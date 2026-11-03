/**
 * Plugin layer types on the real engine (SDK 1.4, L1–L3; docs/PLUGIN_SDK.md "Layer types"):
 * a plugin's manifest `layerTypes` are listed; createLayer kind=generator with the type makes a
 * layer drawn by that type's generator effect, whose params are the layer's own properties
 * (timeline group `contents`, settable through `init` and keyframes); the layer's own effect cannot
 * be removed, duplicated or moved, and other effects stack after it; an unknown type is notFound.
 *
 * Needs the chartlayer sample bundle the engine build lays out; skipped when it is absent.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { unwrap, type EngineClient } from '@motion/engine-api';
import { bootEngine, engine, engineIdle, shutdownEngine } from '@core/engine/engineInstance';
import { resetEngineOwnership } from '@core/engine/engineOwnership';
import { resetProcessEngine } from '@core/engine/process/processEngine';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';

jest.setTimeout(120_000);

const exe = nativeEngineExe();
const samples = exe ? path.join(path.dirname(exe), '..', 'plugins') : '';
const run = !!exe && existsSync(path.join(samples, 'chartlayer', 'premation-plugin.json'));
if (!run) console.log('[plugin layer types native] engine or chartlayer sample not built — skipped');
const maybe = run ? describe : describe.skip;

const PLUGIN = 'com.premation.samples.chartlayer';
const TYPE = `${PLUGIN}:bars`;
const EFFECT = `${PLUGIN}.bars`;
const SECOND = 705_600_000;

maybe('plugin layer types', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let comp = '';

  beforeAll(async () => {
    native = await startNativeEngine({ extraArgs: ['--no-gpu', '--test-ports', '--plugins', path.join(samples, 'chartlayer')] });
    (window as unknown as { motionEditor?: unknown }).motionEditor = { engine: native.bridge };
    resetProcessEngine();
    resetEngineOwnership();
    bootEngine({ ownsDocument: true });
    client = engine();
    await engineIdle();
    comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'C', width: 320, height: 180, duration: 2 * SECOND }, fromItems: [] })).item;
  });

  afterAll(async () => {
    shutdownEngine();
    await native?.stop();
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
  });

  const create = async (init: { path: string; value: unknown }[] = []) =>
    unwrap(await client.execute({ type: 'createLayer', comp, kind: 'generator', generator: TYPE, init } as never)) as unknown as { layer: string };

  it('lists the manifest layer types of a loaded plugin', async () => {
    const plugins = unwrap(await client.query({ type: 'listPlugins' })).plugins;
    expect(plugins.find((p) => p.id === PLUGIN)?.layerTypes).toEqual([{ type: TYPE, name: 'Bar Chart', effect: EFFECT, category: 'Premation Samples' }]);
  });

  it('creates a layer drawn by the type; its params are the layer\'s own properties', async () => {
    const { layer } = await create([{ path: 'effects/layer/p1', value: { kind: 'scalar', value: 12 } }]);
    const info = unwrap(await client.query({ type: 'getLayers', layers: [layer] })).layers[0]!;
    expect(info.kind).toBe('generator');
    expect(info.pluginLayerType).toBe(TYPE);
    expect(info.generator).toBe('');  // not a retired JavaScript plugin layer
    expect(info.name).toBe('Bar Chart');

    const values = unwrap(await client.query({ type: 'getPropertyValues', props: [{ layer, path: 'effects/layer/p1' }, { layer, path: 'effects/layer/p2' }], time: 0, evaluated: false })).values;
    expect(values.map((v) => (v.value as { value?: unknown }).value)).toEqual([12, 70]);

    const rows = unwrap(await client.query({ type: 'getTimelineRows', layers: [layer] })).sets[0]!.rows;
    const own = rows.filter((r) => r.prop.startsWith('effect.layer.'));
    expect(own.length).toBeGreaterThanOrEqual(6);
    expect(new Set(own.map((r) => r.group))).toEqual(new Set(['contents']));

    // Keyframed like any property.
    const p3 = { layer, path: 'effects/layer/p3' };
    unwrap(await client.execute({ type: 'addKeyframes', keys: [0, SECOND].map((time, i) => ({ prop: p3, time, value: { kind: 'scalar', value: i * 100 }, spatialIn: [], spatialOut: [] })) } as never));
    const mid = unwrap(await client.query({ type: 'getPropertyValues', props: [{ layer, path: 'effects/layer/p3' }], time: SECOND / 2, evaluated: true })).values[0]!;
    expect((mid.value as { value: number }).value).toBeGreaterThan(0);
    expect((mid.value as { value: number }).value).toBeLessThan(100);
  });

  it('keeps the layer\'s own effect first and in place; other effects go after it', async () => {
    const { layer } = await create();
    const own = { layer, path: 'effects/layer' };
    const remove = await client.execute({ type: 'removePropertyGroups', groups: [own] });
    expect(remove.ok).toBe(false);
    const dup = await client.execute({ type: 'duplicatePropertyGroups', groups: [own] } as never);
    expect(dup.ok).toBe(false);
    const atZero = await client.execute({ type: 'addEffect', layers: [layer], effect: EFFECT, params: [], index: 0 });
    expect(atZero.ok).toBe(false);
    const after = unwrap(await client.execute({ type: 'addEffect', layers: [layer], effect: EFFECT, params: [] })).groups;
    expect(after).toHaveLength(1);
    // The added effect is an ordinary effect: its rows are under `effects`, and it can go again.
    const rows = unwrap(await client.query({ type: 'getTimelineRows', layers: [layer] })).sets[0]!.rows;
    expect(rows.some((r) => r.group === 'effects')).toBe(true);
    expect((await client.execute({ type: 'removePropertyGroups', groups: [{ layer, path: after[0]! }] })).ok).toBe(true);
  });

  it('refuses an unknown layer type, and a generator layer without one', async () => {
    const unknown = await client.execute({ type: 'createLayer', comp, kind: 'generator', generator: 'com.nobody.x:y', init: [] } as never);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('notFound');
    const none = await client.execute({ type: 'createLayer', comp, kind: 'generator', init: [] } as never);
    expect(none.ok).toBe(false);
  });
});
