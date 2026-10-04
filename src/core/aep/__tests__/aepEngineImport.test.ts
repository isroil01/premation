/**
 * After Effects import by the C++ ENGINE (`importProject{path}` of an `.aep`,
 * core/aep): a real RIFX file on disk (buildAep, the reader's inverse) opened
 * by the real `premation-engine` — comps, layers, the footage it references
 * imported by path through the engine's media probe (an unreadable one listed
 * as missing), one undo entry.
 *
 * The native half is skipped, saying so, when the full engine is not built.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessEngineClient, unwrap, type EngineClient } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { zipBytes } from '@core/export/zip';
import { aepFile, compItem, folderItem, footageItem, layer } from '../__testHelpers__/buildAep';
import { importAepThroughEngine, summarizeEngineAepImport } from '../aepImport';

jest.setTimeout(120_000);

/** A mono 16-bit WAV of silence (a readable footage file). */
function wav(seconds: number): Buffer {
  const n = Math.round(seconds * 8000);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  return b;
}

function promo(dir: string): string {
  const music = path.join(dir, 'music.wav');
  writeFileSync(music, wav(2));
  const file = aepFile([
    folderItem(20, 'Footage', [
      footageItem({ id: 9, name: 'Red Solid', width: 320, height: 180, solid: { color: [1, 0, 0], name: 'Red Solid' } }),
      footageItem({ id: 10, name: 'music.wav', width: 0, height: 0, path: music }),
      footageItem({ id: 11, name: 'gone.mov', width: 320, height: 180, path: path.join(dir, 'gone.mov') }),
    ]),
    compItem({
      id: 1, name: 'Main', width: 320, height: 180, fps: 24, durationSeconds: 4,
      layers: [
        layer({ id: 1, sourceId: 9, displayName: 'Background', outPoint: 4 }),
        layer({ id: 2, sourceId: 10, displayName: 'Music', outPoint: 4 }),
        layer({ id: 3, sourceId: 11, displayName: 'Plate', outPoint: 4, parentId: 1 }),
      ],
    }),
  ]);
  const out = path.join(dir, 'Promo.aep');
  writeFileSync(out, file);
  return out;
}

const exe = nativeEngineExe();
const full = !!exe && !/headless/i.test(exe);
if (!full) console.log('[aep engine import] the full premation-engine is not built — skipped');
const maybe = full ? describe : describe.skip;

maybe('After Effects import in the C++ engine', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let tmp: string;

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'premation-aep-'));
    native = await startNativeEngine();
    const c = new ProcessEngineClient(native.bridge);
    await c.whenReady();
    client = c;
  });
  afterAll(async () => {
    await native?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('opens the comps, layers and footage as one undoable entry', async () => {
    const file = promo(tmp);
    const before = unwrap(await client.query({ type: 'getHistory' })).entries.length;
    const result = await importAepThroughEngine(client, file);
    expect(result).not.toBeNull();
    if (!result || !result.ok) throw new Error(result ? result.message : 'null');
    expect(result.summary).toMatchObject({ comps: 1, layers: 3 });
    expect(summarizeEngineAepImport(result)).toBe('1 composition, 3 layers');
    // The missing plate is reported; the music imported by path.
    expect(result.missingFootage).toEqual([path.join(tmp, 'gone.mov')]);
    expect(result.openComp).toBeTruthy();
    const history = unwrap(await client.query({ type: 'getHistory' })).entries;
    expect(history.length).toBe(before + 1);
    expect(history[history.length - 1]!.label).toBe('Import After Effects Project');
    const comp = unwrap(await client.query({ type: 'getItems', items: [result.openComp!] })).items[0]!;
    expect(comp.name).toBe('Main');
    unwrap(await client.execute({ type: 'undo' }));
    expect((await client.query({ type: 'getItems', items: [result.openComp!] })).ok).toBe(false);
  });

  it('imports a template package (.mogrt.zip, exportMogrt.ts) as a folder, one undoable entry', async () => {
    // A document from the engine itself: one comp with two layers.
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'Lower Third' }, fromItems: [] })).item;
    unwrap(await client.execute({ type: 'createLayer', comp, kind: 'solid', name: 'Bar', init: [] }));
    unwrap(await client.execute({ type: 'createLayer', comp, kind: 'text', name: 'Name', init: [] }));
    const exported = unwrap(await client.query({ type: 'exportDocument' })).document;
    const document = JSON.parse(new TextDecoder().decode(exported)) as unknown;
    const enc = new TextEncoder();
    const file = path.join(tmp, 'Lower Third.mogrt.zip');
    writeFileSync(file, zipBytes([
      { name: 'manifest.json', data: enc.encode(JSON.stringify({ version: 1, type: 'premation-mogrt', name: 'Lower Third', fieldCount: 0 })) },
      { name: 'package.json', data: enc.encode(JSON.stringify({ format: 'premation-mogrt-v1', name: 'Lower Third', createdAt: '', fields: [], document })) },
    ]));
    const before = unwrap(await client.query({ type: 'getHistory' })).entries.length;
    const res = unwrap(await client.execute({ type: 'importProject', path: file }));
    expect(res.items.length).toBeGreaterThanOrEqual(2);
    const folder = unwrap(await client.query({ type: 'getItems', items: [res.items[0]!] })).items[0]!;
    expect(folder.name).toBe('Lower Third');
    expect(unwrap(await client.query({ type: 'getHistory' })).entries.length).toBe(before + 1);
    // Not a package: refused, nothing written.
    const junk = path.join(tmp, 'Other.mogrt');
    writeFileSync(junk, zipBytes([{ name: 'package.json', data: enc.encode('{"format":"something-else"}') }]));
    const bad = await client.execute({ type: 'importProject', path: junk });
    expect(bad.ok).toBe(false);
  });

  it('reports a file that is not a project', async () => {
    const junk = path.join(tmp, 'Junk.aep');
    writeFileSync(junk, 'not a riff file');
    const result = await importAepThroughEngine(client, junk);
    expect(result).toMatchObject({ ok: false });
  });
});
