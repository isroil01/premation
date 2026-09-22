/**
 * The streaming encoder's contract, against a FAKE ffmpeg: a node script that
 * consumes stdin slowly (so the pipe really fills), counts the bytes, and can be
 * told to crash partway. No real encoder is involved — what is under test is
 * back-pressure, ordering and failure reporting, none of which need one.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FfmpegStdinStream } from './ffmpegStream';

const FAKE = `
const fs = require('fs');
const [out, delayMs, dieAfter] = process.argv.slice(2);
let total = 0;
process.stdin.on('data', (chunk) => {
  total += chunk.length;
  if (+dieAfter && total >= +dieAfter) { process.stderr.write('fake encoder crashed'); process.exit(3); }
  if (+delayMs) { process.stdin.pause(); setTimeout(() => process.stdin.resume(), +delayMs); }
});
process.stdin.on('end', () => { fs.writeFileSync(out, String(total)); process.exit(0); });
`;

let dir: string;
let script: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ffmpeg-stream-test-'));
  script = path.join(dir, 'fake-ffmpeg.cjs');
  writeFileSync(script, FAKE);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FRAME = 1024 * 1024;

function open(opts: { delayMs?: number; dieAfter?: number; out?: string; onSpawn?: (p: ReturnType<typeof spawn>) => void } = {}) {
  const out = opts.out ?? path.join(dir, `out-${Math.random()}.txt`);
  return {
    out,
    stream: FfmpegStdinStream.open({
      bin: process.execPath,
      args: [script, out, String(opts.delayMs ?? 0), String(opts.dieAfter ?? 0)],
      frameBytes: FRAME,
      spawnImpl: ((bin: string, args: string[], o: never) => {
        const p = spawn(bin, args, o);
        opts.onSpawn?.(p);
        return p;
      }) as typeof spawn,
    }),
  };
}

const frame = (fill: number): Uint8Array => new Uint8Array(FRAME).fill(fill);

describe('FfmpegStdinStream', () => {
  it('delivers every frame, in order, and waits on drain instead of buffering', async () => {
    let proc: ReturnType<typeof spawn> | null = null;
    // A 1 ms pause per ~64 KB chunk is enough to keep the pipe full for every
    // write; slower made this take ~5 s and time out under a parallel run.
    const { out, stream: opening } = open({ delayMs: 1, onSpawn: (p) => { proc = p; } });
    const stream = await opening;
    let maxBuffered = 0;
    for (let i = 0; i < 12; i++) {
      await stream.write(i, frame(i));
      maxBuffered = Math.max(maxBuffered, proc!.stdin!.writableLength);
    }
    expect(await stream.finish()).toBe(12);
    expect(Number(readFileSync(out, 'utf8'))).toBe(12 * FRAME);
    // Back-pressure engaged, and nothing beyond one frame was ever parked in
    // main's heap when a write resolved.
    expect(stream.drainWaits).toBeGreaterThan(0);
    expect(maxBuffered).toBeLessThan(FRAME);
  }, 20_000);

  it('refuses a frame out of order or of the wrong size', async () => {
    const { stream: opening } = open();
    const stream = await opening;
    await expect(stream.write(1, frame(0))).rejects.toThrow('out of order');
    await expect(stream.write(0, new Uint8Array(10))).rejects.toThrow('bytes');
    stream.kill();
  });

  it('a child that dies mid-stream rejects the waiting write with its stderr — never hangs', async () => {
    const { stream: opening } = open({ delayMs: 5, dieAfter: 3 * FRAME });
    const stream = await opening;
    let failure: unknown = null;
    try {
      for (let i = 0; i < 50; i++) await stream.write(i, frame(1));
    } catch (e) {
      failure = e;
    }
    expect(String(failure)).toMatch(/exited 3.*fake encoder crashed/);
    await expect(stream.finish()).rejects.toThrow();
  });

  it('kill during a drain wait rejects the write', async () => {
    const { stream: opening } = open({ delayMs: 200 });
    const stream = await opening;
    const writes = (async () => {
      for (let i = 0; i < 10; i++) await stream.write(i, frame(2));
    })();
    setTimeout(() => stream.kill(), 50);
    await expect(writes).rejects.toThrow();
  });

  it('a missing binary fails at open, before any frame', async () => {
    await expect(FfmpegStdinStream.open({
      bin: path.join(dir, 'definitely-not-ffmpeg.exe'),
      args: [],
      frameBytes: FRAME,
    })).rejects.toThrow('ffmpeg was not found');
  });

  it('refuses to finish with zero frames', async () => {
    const { stream: opening } = open();
    const stream = await opening;
    await expect(stream.finish()).rejects.toThrow('No frames');
  });
});

describe('FfmpegStdinStream — chunked frames (the raw pixel pipe)', () => {
  const CHUNK = 256 * 1024;

  /** Send `frame` as `CHUNK`-sized pieces, awaiting each ack. */
  async function writeChunked(stream: FfmpegStdinStream, index: number, bytes: Uint8Array, chunk = CHUNK): Promise<number> {
    let n = 0;
    for (let off = 0; off < bytes.byteLength; off += chunk) {
      const end = Math.min(bytes.byteLength, off + chunk);
      await stream.writeChunk(index, off, bytes.subarray(off, end), end === bytes.byteLength);
      n += 1;
    }
    return n;
  }

  it('reassembles chunks into whole frames, in order, with back-pressure per chunk', async () => {
    let proc: ReturnType<typeof spawn> | null = null;
    const { out, stream: opening } = open({ delayMs: 1, onSpawn: (p) => { proc = p; } });
    const stream = await opening;
    let maxBuffered = 0;
    for (let i = 0; i < 8; i++) {
      expect(await writeChunked(stream, i, frame(i))).toBe(FRAME / CHUNK);
      maxBuffered = Math.max(maxBuffered, proc!.stdin!.writableLength);
    }
    expect(stream.framesWritten).toBe(8);
    expect(await stream.finish()).toBe(8);
    expect(Number(readFileSync(out, 'utf8'))).toBe(8 * FRAME);
    expect(stream.drainWaits).toBeGreaterThan(0);
    // Never more than one chunk parked beyond the pipe: the bound the
    // renderer's per-chunk ack buys.
    expect(maxBuffered).toBeLessThanOrEqual(CHUNK);
  }, 20_000);

  it('refuses a gap, an overlap, an overrun, a wrong-sized last chunk and an oversized chunk', async () => {
    const { stream: opening } = open();
    const stream = await opening;
    const f = frame(9);
    await stream.writeChunk(0, 0, f.subarray(0, CHUNK), false);
    await expect(stream.writeChunk(0, 2 * CHUNK, f.subarray(2 * CHUNK, 3 * CHUNK), false)).rejects.toThrow('not contiguous');
    await expect(stream.writeChunk(0, 0, f.subarray(0, CHUNK), false)).rejects.toThrow('not contiguous');
    await expect(stream.writeChunk(1, CHUNK, f.subarray(CHUNK, 2 * CHUNK), false)).rejects.toThrow('out of order');
    await expect(stream.writeChunk(0, CHUNK, new Uint8Array(FRAME), false)).rejects.toThrow('exceeds');
    await expect(stream.writeChunk(0, CHUNK, f.subarray(CHUNK, 2 * CHUNK), true)).rejects.toThrow(`is ${2 * CHUNK} bytes`);
    await expect(stream.writeChunk(0, CHUNK, new Uint8Array(9 * 1024 * 1024), false)).rejects.toThrow('the limit is');
    // A half-sent frame cannot be finished into a file.
    await expect(stream.finish()).rejects.toThrow('only partly streamed');
  });

  it('a whole-frame write and a chunked write are interchangeable frame to frame', async () => {
    const { out, stream: opening } = open();
    const stream = await opening;
    await stream.write(0, frame(1));
    await writeChunked(stream, 1, frame(2));
    await stream.write(2, frame(3));
    expect(await stream.finish()).toBe(3);
    expect(Number(readFileSync(out, 'utf8'))).toBe(3 * FRAME);
  });

  it('a child that dies mid-frame rejects the chunk that was waiting', async () => {
    const { stream: opening } = open({ delayMs: 5, dieAfter: 2 * FRAME + CHUNK });
    const stream = await opening;
    let failure: unknown = null;
    try {
      for (let i = 0; i < 20; i++) await writeChunked(stream, i, frame(1));
    } catch (e) {
      failure = e;
    }
    expect(String(failure)).toMatch(/exited 3.*fake encoder crashed/);
  });
});
