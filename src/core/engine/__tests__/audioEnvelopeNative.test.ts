/**
 * The audio driver's envelope as the engine's `audioEnvelope` job (B4 round 8)
 * on the REAL `premation-engine`, against the TypeScript reference
 * (audioDriver.ts analyseAudioEnvelope) on the same samples: a 440 Hz tone
 * that stops halfway, band / attack / release / gate / normalise applied.
 *
 * Skipped, saying so, when the full engine is not built.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessEngineClient, secondsToFlicks, unwrap, type EngineClient, type EventBatch, type JobInfo } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '../__testHelpers__/nativeEngine';
import { analyseAudioEnvelope } from '@core/audio/audioDriver';

jest.setTimeout(120_000);

const exe = nativeEngineExe();
const full = !!exe && !/headless/i.test(exe);
if (!full) console.log('[audio envelope native] the full premation-engine is not built — skipped');
const maybe = full ? describe : describe.skip;

const RATE = 48000;

/** Mono 16-bit samples: a tone for the first half, silence after. */
function toneThenSilence(seconds: number): Int16Array {
  const n = Math.round(seconds * RATE);
  const out = new Int16Array(n);
  for (let i = 0; i < n / 2; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * 12000);
  return out;
}

function wav(samples: Int16Array): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i]!, 44 + i * 2);
  return b;
}

maybe('the audio envelope job on the real engine', () => {
  let native: NativeEngine;
  let client: EngineClient;
  let tmp: string;

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'premation-envelope-'));
    native = await startNativeEngine();
    const c = new ProcessEngineClient(native.bridge);
    await c.whenReady();
    client = c;
  });
  afterAll(async () => {
    await native?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  const waitJob = (id: string) => new Promise<{ job: JobInfo; error?: { message: string } }>((resolve) => {
    const off = client.subscribe((b: EventBatch) => {
      for (const e of b.events) {
        if (e.type === 'jobFinished' && e.job.id === id) {
          off();
          resolve({ job: e.job, ...(e.error ? { error: e.error } : {}) });
        }
      }
    });
  });

  it('follows a layer\'s sound through its bar, as the TypeScript detector does, and writes nothing', async () => {
    const samples = toneThenSilence(2);
    const file = path.join(tmp, 'tone.wav');
    writeFileSync(file, wav(samples));
    const comp = unwrap(await client.execute({ type: 'createComposition', settings: { name: 'Env', width: 320, height: 180, frameRate: { num: 30, den: 1 } }, fromItems: [] })).item;
    const item = unwrap(await client.execute({ type: 'importFiles', files: [{ path: file, asSequence: false, createComposition: false }] })).items[0]!;
    const layer = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'audio', name: 'Tone', source: item, init: [] })).layer;
    const before = unwrap(await client.query({ type: 'getHistory' })).entries.length;
    const opts = { bandLo: 250, bandHi: 2000, attackMs: 20, releaseMs: 120, gate: 0.1, normalize: true };
    const started = unwrap(await client.execute({
      type: 'startJob',
      job: { kind: 'audioEnvelope', value: { comp, source: layer, range: { start: 0, duration: secondsToFlicks(2) }, ...opts } },
      apply: true,
    }));
    const done = await waitJob(started.job);
    expect(done.error).toBeUndefined();
    const summary = JSON.parse(done.job.result) as { raw: number[]; fps: number; start: number; end: number };
    expect(summary).toMatchObject({ fps: 30, start: 0, end: 2 });
    const ref = analyseAudioEnvelope(Float32Array.from(samples, (v) => v / 32768), RATE, 30, {
      band: { lo: opts.bandLo, hi: opts.bandHi }, attackMs: opts.attackMs, releaseMs: opts.releaseMs, gate: opts.gate, normalize: true,
    });
    expect(summary.raw).toHaveLength(ref.length);
    summary.raw.forEach((v, i) => expect(v).toBeCloseTo(ref[i]!, 3));
    // Loud while the tone plays, decaying after it stops.
    expect(summary.raw[15]!).toBeGreaterThan(0.9);
    expect(summary.raw[59]!).toBeLessThan(0.2);
    expect(unwrap(await client.query({ type: 'getHistory' })).entries.length).toBe(before);
  });
});
