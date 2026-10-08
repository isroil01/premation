/**
 * Plugin SDK 1.1 parameter types on premation-engine-headless (plan P6): the
 * `grademap` sample's STRING / CURVE / GRADIENT / FILE params are listed with
 * the control kind the editor needs, are ordinary (static) effect properties,
 * and a FILE param holds a project item — imported as a `data` item, kept by
 * Remove Unused, relinked like footage, saved with the project.
 *
 * Needs the SDK sample bundles the engine build lays out next to it; skipped
 * when they are absent.
 */

import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unwrap, type EngineClient } from '@motion/engine-api';
import { bootEngine, engine, engineIdle, shutdownEngine } from '@core/engine/engineInstance';
import { resetEngineOwnership } from '@core/engine/engineOwnership';
import { resetProcessEngine } from '@core/engine/process/processEngine';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';

jest.setTimeout(120_000);

const exe = nativeEngineExe();
const samples = exe ? path.join(path.dirname(exe), '..', 'plugins') : '';
const run = !!exe && existsSync(path.join(samples, 'grademap', 'premation-plugin.json'));
if (!run) console.log('[plugin params native] engine or sample bundles not built — skipped');
const maybe = run ? describe : describe.skip;

const GRADEMAP = 'com.premation.samples.grademap';

maybe('plugin SDK 1.1 params, engine side', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let dir = '';

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'plugin-params-'));
    cpSync(path.join(samples, 'grademap'), path.join(dir, 'plugins', 'grademap'), { recursive: true });
    writeFileSync(path.join(dir, 'warm.cube'), 'LUT_1D_SIZE 2\n0 0 0\n1 0.9 0.8\n');
    writeFileSync(path.join(dir, 'cool.cube'), 'LUT_1D_SIZE 2\n0 0 0\n0.8 0.9 1\n');
    native = await startNativeEngine({ extraArgs: ['--no-gpu', '--test-ports', '--plugins', path.join(dir, 'plugins')] });
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

  it('lists the params with the control each needs', async () => {
    const catalog = unwrap(await client.query({ type: 'listEffects', category: '' }));
    const fx = catalog.effects.find((e) => e.matchName === GRADEMAP);
    expect(fx).toBeDefined();
    const by = new Map(fx!.params.map((p) => [p.matchName, p]));
    expect(by.get('p1')).toMatchObject({ kind: 'text', valueType: 'string', animatable: false, defaultValue: { kind: 'string', value: 'rgb' } });
    expect(by.get('p2')).toMatchObject({ kind: 'curve', valueType: 'json', animatable: false });
    expect(by.get('p3')).toMatchObject({ kind: 'gradient', valueType: 'json', animatable: false });
    expect(by.get('p4')).toMatchObject({ kind: 'file', valueType: 'string', fileTypes: 'cube' });
    expect(by.get('p5')?.kind).toBe('');
  });

  it('stores the values, and a FILE param holds a project item', async () => {
    const layer = (unwrap(await client.execute({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'G', init: [] } as never)) as unknown as { layer: string }).layer;
    const fx = unwrap(await client.execute({ type: 'addEffect', layers: [layer], effect: GRADEMAP, params: [] })).groups[0]!;
    const read = async (key: string) => unwrap(await client.query({
      type: 'getPropertyValues', props: [{ layer, path: `${fx}/${key}` }], time: 0, evaluated: false,
    })).values[0]!.value;

    expect(await read('p1')).toEqual({ kind: 'string', value: 'rgb' });
    unwrap(await client.execute({ type: 'setProperty', prop: { layer, path: `${fx}/p1` }, value: { kind: 'string', value: 'rg' } }));
    expect(await read('p1')).toEqual({ kind: 'string', value: 'rg' });
    const stops = [[0, 0, 0, 0.2, 1], [1, 1, 0.5, 0, 1]];
    unwrap(await client.execute({ type: 'setProperty', prop: { layer, path: `${fx}/p3` }, value: { kind: 'json', value: JSON.stringify(stops) } }));
    const g = await read('p3');
    expect(g.kind === 'json' ? JSON.parse(g.value) : null).toEqual(stops);

    // The LUT: imported as a data item (no footage probe), referenced by id.
    const warm = unwrap(await client.execute({ type: 'importFiles', files: [{ path: path.join(dir, 'warm.cube'), asSequence: false, createComposition: false, asData: true }] })).items[0]!;
    const info = unwrap(await client.query({ type: 'getItems', items: [warm] }));
    expect(JSON.stringify(info)).toContain('warm.cube');
    unwrap(await client.execute({ type: 'setProperty', prop: { layer, path: `${fx}/p4` }, value: { kind: 'string', value: warm } }));
    expect(await read('p4')).toEqual({ kind: 'string', value: warm });

    // Used by the effect: Remove Unused keeps it.
    const removed = unwrap(await client.execute({ type: 'removeUnusedItems' })).items;
    expect(removed).not.toContain(warm);

    // Relink to another file: the item (and so the param) follows; no footage probe.
    unwrap(await client.execute({ type: 'relinkItem', item: warm, path: path.join(dir, 'cool.cube'), keepInterpretation: true }));
    const relinked = JSON.stringify(unwrap(await client.query({ type: 'getItems', items: [warm] })));
    expect(relinked).toContain('cool.cube');

    // The document carries both the value and the item.
    const exported = unwrap(await client.query({ type: 'exportDocument' }));
    const saved = new TextDecoder().decode(exported.document);
    expect(saved).toContain(`"p4":"${warm}"`);
    expect(saved).toContain('cool.cube');

    // No longer referenced: Remove Unused takes it.
    unwrap(await client.execute({ type: 'setProperty', prop: { layer, path: `${fx}/p4` }, value: { kind: 'string', value: '' } }));
    expect(unwrap(await client.execute({ type: 'removeUnusedItems' })).items).toContain(warm);
  });
});
