/**
 * The raw pixel pipe's renderer half: how a frame is cut into chunks, that
 * every chunk waits for its ack, that nothing follows a refused chunk — and
 * that the chunk size agrees with the ceiling the main process enforces.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RAW_PIPE_CHUNK_BYTES,
  frameChunks,
  isVideoEncoderId,
  streamFrameChunked,
  type RawPipeBridge,
} from './rawPipe';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function fakeBridge(opts: { failAt?: number; hold?: boolean } = {}) {
  const calls: Array<{ index: number; offset: number; len: number; last: boolean }> = [];
  const pending: Array<() => void> = [];
  let outstanding = 0;
  let maxOutstanding = 0;
  const bridge: RawPipeBridge = {
    streamChunk: jest.fn(async (_job: string, index: number, offset: number, bytes: Uint8Array, last: boolean) => {
      outstanding += 1;
      maxOutstanding = Math.max(maxOutstanding, outstanding);
      calls.push({ index, offset, len: bytes.byteLength, last });
      if (opts.hold) await new Promise<void>((r) => pending.push(r));
      else await tick();
      outstanding -= 1;
      if (opts.failAt !== undefined && calls.length - 1 === opts.failAt) throw new Error('ffmpeg exited 1');
    }),
  };
  return { bridge, calls, pending, maxOutstanding: () => maxOutstanding };
}

describe('frameChunks', () => {
  it('cuts a frame into consecutive views of at most the chunk size, last one marked', () => {
    const frame = new Uint8Array(10).map((_, i) => i);
    const chunks = [...frameChunks(frame, 4)];
    expect(chunks.map((c) => [c.offset, c.bytes.byteLength, c.last])).toEqual([[0, 4, false], [4, 4, false], [8, 2, true]]);
    expect([...chunks[2]!.bytes]).toEqual([8, 9]);
    // Views, not copies: the one copy is IPC's.
    expect(chunks[1]!.bytes.buffer).toBe(frame.buffer);
  });

  it('a frame that fits is exactly one chunk; an empty frame is refused', () => {
    expect([...frameChunks(new Uint8Array(4), 4)]).toHaveLength(1);
    expect(() => [...frameChunks(new Uint8Array(0), 4)]).toThrow('empty frame');
    expect(() => [...frameChunks(new Uint8Array(4), 0)]).toThrow('positive');
  });

  it('a 1080p frame is two 4 MiB chunks and 4K UHD is eight, at the default size', () => {
    const count = (w: number, h: number) => [...frameChunks(new Uint8Array(w * h * 4))].length;
    expect(count(1920, 1080)).toBe(2);
    expect(count(3840, 2160)).toBe(8);
  });
});

describe('streamFrameChunked', () => {
  it('sends every chunk in order, one at a time, awaiting the ack for each', async () => {
    const { bridge, calls, maxOutstanding } = fakeBridge();
    const frame = new Uint8Array(10);
    expect(await streamFrameChunked(bridge, 'job', 7, frame, 4)).toBe(3);
    expect(calls).toEqual([
      { index: 7, offset: 0, len: 4, last: false },
      { index: 7, offset: 4, len: 4, last: false },
      { index: 7, offset: 8, len: 2, last: true },
    ]);
    expect(maxOutstanding()).toBe(1);
  });

  it('does not resolve before the last chunk is acked', async () => {
    const { bridge, calls, pending } = fakeBridge({ hold: true });
    let done = false;
    const sending = streamFrameChunked(bridge, 'job', 0, new Uint8Array(8), 4).then(() => { done = true; });
    await tick();
    expect(calls).toHaveLength(1);
    expect(done).toBe(false);
    pending.shift()!();
    await tick();
    expect(calls).toHaveLength(2);
    expect(done).toBe(false);
    pending.shift()!();
    await sending;
    expect(done).toBe(true);
  });

  it('a refused chunk rejects the frame and nothing after it is sent', async () => {
    const { bridge, calls } = fakeBridge({ failAt: 1 });
    await expect(streamFrameChunked(bridge, 'job', 0, new Uint8Array(12), 4)).rejects.toThrow('ffmpeg exited 1');
    expect(calls).toHaveLength(2);
  });
});

describe('the chunk size and the main process agree', () => {
  it('RAW_PIPE_CHUNK_BYTES is within the ceiling electron/ffmpegStream.ts enforces', () => {
    const src = readFileSync(join(process.cwd(), 'electron', 'ffmpegStream.ts'), 'utf8');
    const m = /export const RAW_PIPE_MAX_CHUNK_BYTES = (\d+) \* 1024 \* 1024;/.exec(src);
    expect(m).not.toBeNull();
    const max = Number(m![1]) * 1024 * 1024;
    expect(RAW_PIPE_CHUNK_BYTES).toBe(4 * 1024 * 1024);
    expect(RAW_PIPE_CHUNK_BYTES).toBeLessThanOrEqual(max);
  });

  it('knows the encoder ids the main process accepts', () => {
    for (const id of ['libx264', 'h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'h264_videotoolbox']) expect(isVideoEncoderId(id)).toBe(true);
    expect(isVideoEncoderId('h264_amf')).toBe(false);
    expect(isVideoEncoderId(undefined)).toBe(false);
  });
});
