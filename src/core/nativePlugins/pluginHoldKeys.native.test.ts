/**
 * Plugin popups and checkboxes keyframe as After Effects does: hold keys. The
 * `ripple` sample's Sampling popup (p5) and Tint ▸ Enable checkbox (p7) take
 * keys on their effect's data track (`effect.<id>.<key>`, kind "hold"); between
 * two keys the first one's value holds (never a blend of two modes), the
 * frame's params follow the keys, and the stopwatch off returns to one static
 * value. A built-in effect's popup stays static.
 *
 * Needs the SDK sample bundles the engine build lays out next to it; skipped
 * when they are absent.
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unwrap, type EngineClient, type Value } from '@motion/engine-api';
import { bootEngine, engine, engineIdle, shutdownEngine } from '@core/engine/engineInstance';
import { resetEngineOwnership } from '@core/engine/engineOwnership';
import { resetProcessEngine } from '@core/engine/process/processEngine';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';

jest.setTimeout(120_000);

const exe = nativeEngineExe();
const samples = exe ? path.join(path.dirname(exe), '..', 'plugins') : '';
const run = !!exe && existsSync(path.join(samples, 'ripple', 'premation-plugin.json'));
if (!run) console.log('[plugin hold keys native] engine or sample bundles not built — skipped');
const maybe = run ? describe : describe.skip;

const RIPPLE = 'com.premation.samples.ripple';
const S = 705_600_000;

maybe('plugin popups and checkboxes take hold keys', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let dir = '';

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'plugin-hold-keys-'));
    cpSync(path.join(samples, 'ripple'), path.join(dir, 'ripple'), { recursive: true });
    native = await startNativeEngine({ extraArgs: ['--no-gpu', '--test-ports', '--plugins', dir] });
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

  const layerWith = async (effect: string): Promise<{ layer: string; fx: string }> => {
    const layer = (unwrap(await client.execute({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'H', init: [] } as never)) as unknown as { layer: string }).layer;
    const fx = unwrap(await client.execute({ type: 'addEffect', layers: [layer], effect, params: [] })).groups[0]!;
    return { layer, fx };
  };
  const at = async (layer: string, paths: string[], seconds: number): Promise<Value[]> =>
    unwrap(await client.query({ type: 'getPropertyValues', props: paths.map((p) => ({ layer, path: p })), time: Math.round(seconds * S), evaluated: true })).values.map((v) => v.value);
  const key = (layer: string, p: string, seconds: number, value: Value) =>
    client.execute({ type: 'addKeyframes', keys: [{ prop: { layer, path: p }, time: Math.round(seconds * S), value, spatialIn: [], spatialOut: [] }] });

  it('holds each key until the next, and the stopwatch off leaves one static value', async () => {
    const { layer, fx } = await layerWith(RIPPLE);
    const sampling = `${fx}/p5`;
    const tint = `${fx}/p7`;
    for (const r of [
      await key(layer, sampling, 0, { kind: 'choice', value: 'Nearest' }),
      await key(layer, sampling, 1, { kind: 'choice', value: 'Bilinear' }),
      await key(layer, tint, 0, { kind: 'bool', value: true }),
      await key(layer, tint, 1, { kind: 'bool', value: false }),
    ]) unwrap(r);

    expect(await at(layer, [sampling, tint], 0)).toEqual([{ kind: 'choice', value: 'Nearest' }, { kind: 'bool', value: true }]);
    // Hold: the first key's value until the second, never a blend of two modes.
    expect(await at(layer, [sampling, tint], 0.9)).toEqual([{ kind: 'choice', value: 'Nearest' }, { kind: 'bool', value: true }]);
    expect(await at(layer, [sampling, tint], 1.5)).toEqual([{ kind: 'choice', value: 'Bilinear' }, { kind: 'bool', value: false }]);
    const keys = unwrap(await client.query({ type: 'getKeyframes', props: [{ layer, path: sampling }] })).sets[0]!.keyframes;
    expect(keys.map((k) => k.value)).toEqual([{ kind: 'choice', value: 'Nearest' }, { kind: 'choice', value: 'Bilinear' }]);

    // A choice that names no option is refused, not stored.
    const bad = await key(layer, sampling, 2, { kind: 'choice', value: 'Bicubic' });
    expect(bad.ok).toBe(false);

    // Undo takes the last key back.
    unwrap(await client.execute({ type: 'undo' }));
    expect(await at(layer, [tint], 1.5)).toEqual([{ kind: 'bool', value: true }]);

    // Stopwatch off: the value at the playhead becomes the static value.
    unwrap(await client.execute({ type: 'setAnimated', prop: { layer, path: sampling }, animated: false, time: Math.round(1.2 * S) }));
    expect(unwrap(await client.query({ type: 'getKeyframes', props: [{ layer, path: sampling }] })).sets[0]!.keyframes).toHaveLength(0);
    expect(await at(layer, [sampling], 0)).toEqual([{ kind: 'choice', value: 'Bilinear' }]);
  });

  it('keeps a built-in effect popup static', async () => {
    const { layer, fx } = await layerWith('fast-box-blur');
    const def = unwrap(await client.query({ type: 'listEffects', category: '' })).effects.find((e) => e.matchName === 'fast-box-blur');
    const popup = def?.params.find((p) => p.type === 'enum');
    if (!popup) return;  // the built-in has no popup on this build
    const r = await key(layer, `${fx}/${popup.matchName}`, 0, { kind: 'choice', value: popup.options[0]!.label });
    expect(r.ok).toBe(false);
  });
});
