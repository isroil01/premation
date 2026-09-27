/**
 * File ▸ Collect Files through the C++ engine (`collectFiles`,
 * core/collect_files.cpp over FilePorts): a project whose footage was
 * imported BY PATH is copied with its files into `<folder>/<folder>.motion`
 * (the footage under `blobs/`), a missing file is listed and never fails the
 * collect, and the open document is unchanged (path, dirty, history).
 *
 * Skipped, saying so, when the full engine is not built.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessEngineClient, unwrap, type EngineClient } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';

jest.setTimeout(120_000);

const exe = nativeEngineExe();
const full = !!exe && !/headless/i.test(exe);
if (!full) console.log('[collect files native] the full premation-engine is not built — skipped');
const maybe = full ? describe : describe.skip;

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

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

maybe('Collect Files in the C++ engine', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let tmp: string;

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'premation-collect-'));
    native = await startNativeEngine();
    const c = new ProcessEngineClient(native.bridge);
    await c.whenReady();
    client = c;
  });
  afterAll(async () => {
    await native?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('copies the project and the footage it imported by path; the document is unchanged', async () => {
    const music = path.join(tmp, 'music.wav');
    writeFileSync(music, wav(1));
    const gone = path.join(tmp, 'gone.wav');
    writeFileSync(gone, wav(1));
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'Main' }, fromItems: [] })).item;
    const [a, b] = unwrap(await client.execute({
      type: 'importFiles',
      files: [{ path: music, asSequence: false, createComposition: false }, { path: gone, asSequence: false, createComposition: false }],
    })).items;
    unwrap(await client.execute({ type: 'createLayer', comp, kind: 'audio', source: a!, init: [] }));
    unwrap(await client.execute({ type: 'createLayer', comp, kind: 'audio', source: b!, init: [] }));
    rmSync(gone);
    const historyBefore = unwrap(await client.query({ type: 'getHistory' })).entries.length;

    const folder = path.join(tmp, 'Delivery');
    const res = unwrap(await client.execute({ type: 'collectFiles', folder, onlyUsed: true }));
    expect(res.path).toBe(path.join(folder, 'Delivery.motion'));
    expect(existsSync(res.path)).toBe(true);
    const blobs = filesUnder(res.path).filter((f) => f.includes(`${path.sep}blobs${path.sep}`));
    expect(blobs).toHaveLength(1);
    expect(statSync(blobs[0]!).size).toBe(wav(1).length);
    expect(res.missing).toContain('gone.wav');
    // The open document: same history, still untitled.
    expect(unwrap(await client.query({ type: 'getHistory' })).entries.length).toBe(historyBefore);
  });
});
