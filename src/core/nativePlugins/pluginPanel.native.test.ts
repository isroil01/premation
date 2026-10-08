/**
 * Plugin panels on premation-engine-headless (plugin SDK 1.1, plan P5 gate):
 * the `rings` bundle ships `ui/index.html`; the engine lists it with a panel and
 * answers getEffectUi with the plugin, the panel flag and the sequence data the
 * panel reads. A panel's palette edit (the hidden Set Palette button with a
 * payload) and a handle drag are each one undo entry; undo and redo restore
 * both the handle position and the palette.
 *
 * Needs the SDK sample bundles the engine build lays out next to it; skipped
 * when they are absent.
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unwrap, type EngineClient } from '@motion/engine-api';
import { bootEngine, engine, engineIdle, shutdownEngine } from '@core/engine/engineInstance';
import { resetEngineOwnership } from '@core/engine/engineOwnership';
import { resetProcessEngine } from '@core/engine/process/processEngine';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { readPanelFile } from '../../../electron/pluginPanelProtocol';
import { dragCommand, DRAG_BEGIN, DRAG_END } from './pluginOverlay';
import { panelCommand, parsePanelMessage } from './pluginPanel';

jest.setTimeout(120_000);

const exe = nativeEngineExe();
const samples = exe ? path.join(path.dirname(exe), '..', 'plugins') : '';
const run = !!exe && existsSync(path.join(samples, 'rings', 'ui', 'index.html'));
if (!run) console.log('[plugin panel native] engine or sample bundles not built — skipped');
const maybe = run ? describe : describe.skip;

const RINGS = 'com.premation.samples.rings';
const MAGIC = 0x52494e47;

/** rings.cpp's Palette: magic, format, seed, count, 8 × rgb float32 (little-endian). */
function palette(bytes: Uint8Array | undefined): string[] {
  if (!bytes) return [];
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, true) !== MAGIC) return [];
  const out: string[] = [];
  for (let i = 0; i < v.getUint32(12, true); i++) {
    const c = [0, 1, 2].map((k) => Math.round(v.getFloat32(16 + i * 12 + k * 4, true) * 255));
    out.push(`#${c.map((n) => n.toString(16).padStart(2, '0')).join('')}`);
  }
  return out;
}

maybe('plugin panels, engine side', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let dir = '';

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'plugin-panel-'));
    cpSync(path.join(samples, 'rings'), path.join(dir, 'rings'), { recursive: true });
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

  it('lists the panel, and main serves it from the bundle the engine loaded', async () => {
    const list = unwrap(await client.query({ type: 'listPlugins' }));
    expect(list.plugins.find((p) => p.id === RINGS)).toMatchObject({ status: 'loaded', panel: true });
    const html = await readPanelFile([dir], `plugin-ui://${RINGS}/index.html`);
    expect(html?.body.toString()).toContain('panel.js');
    expect(html?.csp).toContain("connect-src 'none'");
  });

  it('edits the palette from the panel; undo and redo restore palette and handle', async () => {
    const layer = (unwrap(await client.execute({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'R', init: [] } as never)) as unknown as { layer: string }).layer;
    const fx = unwrap(await client.execute({ type: 'addEffect', layers: [layer], effect: RINGS, params: [] })).groups[0]!;
    const effectId = fx.split('/')[1]!;
    const state = async () => {
      const ui = unwrap(await client.query({ type: 'getEffectUi', layer, effect: fx }));
      const center = unwrap(await client.query({
        type: 'getPropertyValues',
        props: [{ layer, path: `${fx}/p1X` }, { layer, path: `${fx}/p1Y` }],
        time: 0,
        evaluated: false,
      })).values.map((v) => (v.value.kind === 'scalar' ? v.value.value : NaN));
      return { ui, palette: palette(ui.data.find((d) => d.key === 'sequence')?.data), center };
    };

    const s0 = await state();
    expect(s0.ui).toMatchObject({ plugin: RINGS, panel: true });
    expect(s0.ui.params.find((p) => p.key === 'p9')).toMatchObject({ name: 'Set Palette', hidden: true });
    expect(s0.palette).toHaveLength(6);

    // The panel's message, as the editor turns it into a command.
    const msg = parsePanelMessage({ premation: 1, id: 1, type: 'invokeButton', key: 'p9', payload: '#ff0000 #00ff00 #0000ff' });
    expect(msg?.type).toBe('invokeButton');
    unwrap(await client.execute(panelCommand(msg as never, { layer, effectId, time: 0 })));
    const s1 = await state();
    expect(s1.palette).toEqual(['#ff0000', '#00ff00', '#0000ff']);

    // A bad payload is refused and changes nothing.
    const bad = await client.execute(panelCommand({ id: 2, type: 'invokeButton', key: 'p9', payload: 'red' }, { layer, effectId, time: 0 }));
    expect(bad.ok).toBe(false);
    expect((await state()).palette).toEqual(s1.palette);

    // Drag the centre handle (one gesture = one entry).
    const g = unwrap(await client.execute({ type: 'beginGesture', label: 'Drag Effect Handle' })).gesture;
    const start = { x: s1.center[0]!, y: s1.center[1]! };
    unwrap(await client.execute(dragCommand(layer, fx, 1, start, start, DRAG_BEGIN)));
    unwrap(await client.execute(dragCommand(layer, fx, 1, { x: start.x + 40, y: start.y - 15 }, start, DRAG_END)));
    unwrap(await client.execute({ type: 'endGesture', gesture: g, commit: true }));
    const s2 = await state();
    expect(s2.center[0]).toBeCloseTo(start.x + 40, 6);
    expect(s2.center[1]).toBeCloseTo(start.y - 15, 6);
    expect(s2.palette).toEqual(s1.palette);

    unwrap(await client.execute({ type: 'undo' })); // the drag
    const u1 = await state();
    expect(u1.center).toEqual(s1.center);
    expect(u1.palette).toEqual(s1.palette);
    unwrap(await client.execute({ type: 'undo' })); // the palette
    expect((await state()).palette).toEqual(s0.palette);

    unwrap(await client.execute({ type: 'redo' }));
    expect((await state()).palette).toEqual(s1.palette);
    unwrap(await client.execute({ type: 'redo' }));
    const r2 = await state();
    expect(r2.center).toEqual(s2.center);
    expect(r2.palette).toEqual(s1.palette);
  });
});
