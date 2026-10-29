/**
 * AE's Post-Render Actions on the C++ engine: Import brings the rendered file
 * in; Import & Replace Usage also re-points every layer that used the rendered
 * composition at it — one undo entry, and undo puts the composition back.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { setupAppEngine, settleEdits, type Harness } from '@core/engine/__testHelpers__/appEngine';
import type { ExportJobRecord } from '@core/export/exportSupervisorClient';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { deliveredFiles, layersUsingComp, runPostRenderAction } from './postRender';

let h: Harness;
let dir = '';

/** A 2×2 opaque PNG: what a finished render stands in for here. */
function writePng(file: string): void {
  const crc = (b: Buffer): number => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.from([0, 255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 255]);
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

const job = (over: Partial<ExportJobRecord['spec']>, id = 'job-1'): ExportJobRecord => ({
  id,
  status: 'completed',
  spec: { projectPath: '/p', outPath: path.join(dir, 'render.png'), format: 'png', label: 'x', totalFrames: 1, ...over },
} as unknown as ExportJobRecord);

beforeEach(async () => {
  h = await setupAppEngine();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premation-postrender-'));
  writePng(path.join(dir, 'render.png'));
});
afterEach(async () => {
  await h.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function precompUsedTwice(): Promise<{ inner: string; uses: string[] }> {
  const a = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'A', init: [] })).layer;
  const r = await h.run({ type: 'precompose', comp: 'comp_root', layers: [a], name: 'Heavy', mode: 'moveAll', adjustDuration: false }) as { comp: string; layer: string };
  const second = (await h.run({ type: 'duplicateLayers', layers: [r.layer] }) as { layers: string[] }).layers[0]!;
  await settleEdits();
  return { inner: r.comp, uses: [r.layer, second] };
}

it('lists every delivered file, main first', () => {
  expect(deliveredFiles(job({ extraOutputs: [{ format: 'mp4', outPath: '/o/a.mp4' }] }))).toEqual([path.join(dir, 'render.png'), '/o/a.mp4']);
});

it('Import brings the render in and touches no layer', async () => {
  const { inner, uses } = await precompUsedTwice();
  const before = documentMirror().items.size;
  await runPostRenderAction(job({ postRender: 'import', comp: inner }));
  await engineIdle();
  await settleEdits();
  expect(documentMirror().items.size).toBe(before + 1);
  for (const l of uses) expect(documentMirror().layer(l)?.source).toBe(inner);
});

it('Import & Replace Usage re-points every use in one undo entry', async () => {
  const { inner, uses } = await precompUsedTwice();
  expect(layersUsingComp(inner).sort()).toEqual([...uses].sort());
  await runPostRenderAction(job({ postRender: 'importReplace', comp: inner }, 'job-2'));
  await engineIdle();
  await settleEdits();
  const imported = [...documentMirror().items.values()].find((i) => i.kind === 'footage' && /render\.png$/i.test(i.path));
  expect(imported).toBeTruthy();
  for (const l of uses) expect(documentMirror().layer(l)?.source).toBe(imported!.id);
  expect(layersUsingComp(inner)).toEqual([]);

  await h.run({ type: 'undo' });
  await settleEdits();
  for (const l of uses) expect(documentMirror().layer(l)?.source).toBe(inner);

  // The same job never runs twice.
  await runPostRenderAction(job({ postRender: 'importReplace', comp: inner }, 'job-2'));
  await settleEdits();
  for (const l of uses) expect(documentMirror().layer(l)?.source).toBe(inner);
});
