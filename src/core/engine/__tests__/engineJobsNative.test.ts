/**
 * Engine jobs end to end on the REAL `premation-engine` (full build, with job
 * kinds): the transcribe job (2026-09-28) and auto-trace's solo render.
 *
 *   transcribe  the composition's sound mixed by a child `--export` (audio
 *               only), 16 kHz mono, POSTed with the key Electron main put in
 *               the request — here to a LOCAL server standing in for the
 *               provider (PREMATION_TRANSCRIBE_URL, honoured for 127.0.0.1
 *               only). The server sees the key and a WAV; the job answers the
 *               cues in composition seconds; nothing is written; getJobs and
 *               the engine's log never carry the key.
 *   autoTrace   `rendered`: the layer drawn alone by a child engine (GPU) and
 *               traced in comp space, pulled back to layer space.
 *   autoReframe the composition rendered small by a child engine, read back
 *               (PNG through the OS still codec), a new comp made from it.
 *
 * Skipped, saying so, when the full engine is not built (the headless build
 * runs no jobs).
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessEngineClient, secondsToFlicks, unwrap, type EngineClient, type EventBatch, type JobInfo } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '../__testHelpers__/nativeEngine';

jest.setTimeout(180_000);

const exe = nativeEngineExe();
const full = !!exe && !/headless/i.test(exe);
if (!full) console.log('[engine jobs native] the full premation-engine is not built — skipped');
const maybe = full ? describe : describe.skip;

/** A mono 16-bit WAV: a 440 Hz tone. */
function toneWav(seconds: number, rate = 48000): Buffer {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
  return b;
}

async function waitJob(client: EngineClient, id: string): Promise<{ job: JobInfo; error?: { code: string; message: string; detail?: string } }> {
  return new Promise((resolve) => {
    const off = client.subscribe((b: EventBatch) => {
      for (const e of b.events) {
        if (e.type === 'jobFinished' && e.job.id === id) {
          off();
          resolve({ job: e.job, ...(e.error ? { error: e.error } : {}) });
        }
      }
    });
  });
}

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => parts.push(d));
    req.on('end', () => resolve(Buffer.concat(parts)));
  });
}

maybe('engine jobs on the real engine', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let server: Server;
  let tmp: string;
  const seen: Array<{ auth: string | undefined; type: string | undefined; bytes: Buffer }> = [];

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'premation-jobs-'));
    server = createServer((req, res) => {
      void body(req).then((bytes) => {
        seen.push({ auth: req.headers.authorization, type: req.headers['content-type'], bytes });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          language: 'english',
          segments: [{ start: 0.2, end: 1.1, text: ' A tone. ' }, { start: 1.0, end: 1.8, text: 'Still a tone.' }],
          words: [{ start: 0.2, end: 0.5, word: 'A' }],
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    // The provider is this local server: never the real one from a test.
    native = await startNativeEngine({}, { PREMATION_TRANSCRIBE_URL: `http://127.0.0.1:${port}/v1/audio/transcriptions` });
    const c = new ProcessEngineClient(native.bridge);
    await c.whenReady();
    client = c;
  });
  afterAll(async () => {
    await native?.stop();
    server?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('transcribes a composition through the provider with the key it was handed', async () => {
    const wav = path.join(tmp, 'tone.wav');
    writeFileSync(wav, toneWav(2));
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'Talk', width: 320, height: 180 }, fromItems: [] })).item;
    const item = unwrap(await client.execute({ type: 'importFiles', files: [{ path: wav, asSequence: false, createComposition: false }] })).items[0]!;
    unwrap(await client.execute({ type: 'createLayer', comp, kind: 'audio', source: item, init: [] }));
    const before = unwrap(await client.query({ type: 'getHistory' })).entries.length;

    const started = unwrap(await client.execute({
      type: 'startJob',
      job: {
        kind: 'transcribe',
        value: {
          layer: '', language: 'en', createCaptions: false, comp,
          range: { start: secondsToFlicks(0.5), duration: secondsToFlicks(1.5) },
          provider: 'openai', credential: 'sk-test-key',
        },
      },
      apply: true,
    }));
    const done = await waitJob(client, started.job);
    expect(done.error).toBeUndefined();
    expect(done.job.status).toBe('done');
    const result = JSON.parse(done.job.result) as { cues: Array<{ start: number; end: number; text: string }>; words: unknown[]; language: string };
    // Rebased by the range start (0.5 s), trimmed, de-overlapped.
    expect(result.cues).toEqual([{ start: 0.7, end: 1.5, text: 'A tone.' }, { start: 1.5, end: 2.3, text: 'Still a tone.' }]);
    expect(result.language).toBe('english');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe('Bearer sk-test-key');
    expect(seen[0]!.type).toMatch(/^multipart\/form-data; boundary=/);
    const text = seen[0]!.bytes.toString('latin1');
    expect(text).toContain('name="model"\r\n\r\nwhisper-1');
    expect(text).toContain('Content-Type: audio/wav\r\n\r\nRIFF');
    // 1.5 s of 16 kHz mono 16-bit ≈ 48 kB.
    expect(seen[0]!.bytes.length).toBeGreaterThan(40_000);
    expect(seen[0]!.bytes.length).toBeLessThan(60_000);

    // Nothing written; the key is nowhere the client can read it back.
    expect(unwrap(await client.query({ type: 'getHistory' })).entries.length).toBe(before);
    const jobs = JSON.stringify(unwrap(await client.query({ type: 'getJobs' })));
    expect(jobs).not.toContain('sk-test-key');
  });

  it('refuses a transcribe job without a key, naming the reason', async () => {
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'NoKey' }, fromItems: [] })).item;
    const res = await client.execute({
      type: 'startJob',
      job: { kind: 'transcribe', value: { layer: '', language: '', createCaptions: false, comp, provider: 'openai' } },
      apply: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.detail).toContain('no_key');
  });

  it('traces what a layer draws, rendered alone, as layer-space masks', async () => {
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'Trace', width: 320, height: 180 }, fromItems: [] })).item;
    // A solid moved and scaled to half: its drawn box pulls back to the layer's own box.
    const layer = unwrap(await client.execute({
      type: 'createLayer', comp, kind: 'solid', name: 'Box',
      init: [
        { path: 'transform/position', value: { kind: 'vec2', value: { x: 120, y: 80 } } },
        { path: 'transform/scale', value: { kind: 'vec2', value: { x: 50, y: 50 } } },
      ],
    })).layer;
    unwrap(await client.execute({ type: 'createLayer', comp, kind: 'solid', name: 'Other', init: [] }));
    const before = unwrap(await client.query({ type: 'getHistory' })).entries.length;
    const started = unwrap(await client.execute({
      type: 'startJob',
      job: {
        kind: 'autoTrace',
        value: {
          layer, range: { start: 0, duration: secondsToFlicks(1 / 30) }, channel: 'alpha', threshold: 0.5,
          everyFrame: false, invert: false, rendered: true,
        },
      },
      apply: true,
    }));
    const done = await waitJob(client, started.job);
    if (done.error?.code === 'unsupported') {
      console.log(`[engine jobs native] rendered trace skipped: ${done.error.message}`);
      return;
    }
    expect(done.error).toBeUndefined();
    const result = JSON.parse(done.job.result) as { pathsAdded: number; frames: number };
    // One ring: the solid only ("Other" is not drawn in the solo render), one frame.
    expect(result).toMatchObject({ pathsAdded: 1, frames: 1 });
    expect(done.job.applied).toBe(true);
    const history = unwrap(await client.query({ type: 'getHistory' })).entries;
    expect(history.length).toBe(before + 1);
    expect(history[history.length - 1]!.label).toBe('Auto-trace');
  });

  it('auto-reframes a composition into a new one, the source untouched', async () => {
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'Wide', width: 640, height: 360, duration: secondsToFlicks(1) }, fromItems: [] })).item;
    unwrap(await client.execute({
      type: 'createLayer', comp, kind: 'solid', name: 'Subject',
      init: [{ path: 'transform/scale', value: { kind: 'vec2', value: { x: 20, y: 20 } } }],
    }));
    const started = unwrap(await client.execute({
      type: 'startJob', job: { kind: 'autoReframe', value: { comp, width: 180, height: 320 } }, apply: true,
    }));
    const done = await waitJob(client, started.job);
    if (done.error?.code === 'unsupported') {
      console.log(`[engine jobs native] auto-reframe skipped: ${done.error.message}`);
      return;
    }
    expect(done.error).toBeUndefined();
    const result = JSON.parse(done.job.result) as { samples: number; comp?: string };
    expect(result.samples).toBeGreaterThan(0);
    expect(result.comp).toBeTruthy();
    const history = unwrap(await client.query({ type: 'getHistory' })).entries;
    expect(history[history.length - 1]!.label).toBe('Auto-reframe');
  });
});
