/**
 * The streaming desktop sink: ordering, back-pressure, the first-frame fallback
 * to staged files, and which exports are allowed to stream at all. The main
 * process is a fake bridge; the encoder side is covered by
 * electron/ffmpegStream.test.ts.
 */

import { FfmpegStreamSink, createVideoSink, streamEligible, type VideoSink, type VideoSinkParams } from './videoSink';

type Resolver = () => void;

function canvas(w = 4, h = 2): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const fakePixels = (c: HTMLCanvasElement): Uint8Array => new Uint8Array(c.width * c.height * 4);
const params: VideoSinkParams = { format: 'mp4', width: 4, height: 2, fps: 30 };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function installBridge(over: Record<string, unknown> = {}) {
  const streamed: number[] = [];
  const order: string[] = [];
  let outstanding = 0;
  let maxOutstanding = 0;
  const bridge = {
    beginJob: jest.fn(async () => { order.push('beginJob'); return 'job1'; }),
    stageAudio: jest.fn(async () => { order.push('stageAudio'); }),
    streamPreference: jest.fn(async () => 'stream' as const),
    openStream: jest.fn(async () => { order.push('openStream'); }),
    streamFrame: jest.fn(async (_job: string, index: number) => {
      outstanding += 1;
      maxOutstanding = Math.max(maxOutstanding, outstanding);
      await tick();
      streamed.push(index);
      outstanding -= 1;
    }),
    finishStream: jest.fn(async () => ({ path: '/job/out.mp4', frames: streamed.length })),
    stageFrame: jest.fn(async () => undefined),
    encode: jest.fn(async () => ({ path: '/job/out.mp4', frames: 1 })),
    cancel: jest.fn(async () => { order.push('cancel'); }),
    cleanJob: jest.fn(async () => { order.push('cleanJob'); }),
    saveTo: jest.fn(async (_job: string, dir: string, name: string) => ({ path: `${dir}/${name}` })),
    ...over,
  };
  (window as unknown as { motionEditor: unknown }).motionEditor = { render: bridge };
  return { bridge, streamed, order, maxOutstanding: () => maxOutstanding };
}

function fakeStaged() {
  const added: number[] = [];
  const sink: VideoSink = {
    addFrame: jest.fn(async (_c: HTMLCanvasElement, i: number) => { added.push(i); }),
    finish: jest.fn(async () => ({ kind: 'blob', ext: 'mp4', frames: added.length, blob: new Blob([]) }) as never),
    dispose: jest.fn(async () => undefined),
  };
  return { sink, added };
}

afterEach(() => {
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
  jest.restoreAllMocks();
});

describe('FfmpegStreamSink', () => {
  it('opens once (audio first), streams every frame in order one at a time, and finishes into a file', async () => {
    const { bridge, streamed, order, maxOutstanding } = installBridge();
    const sink = new FfmpegStreamSink({ ...params, audioWav: new Uint8Array(44), transparent: true }, { readPixels: fakePixels });
    for (let i = 0; i < 6; i++) await sink.addFrame(canvas(), i);
    const result = await sink.finish();

    expect(order.slice(0, 3)).toEqual(['beginJob', 'stageAudio', 'openStream']);
    expect(bridge.openStream).toHaveBeenCalledWith('job1', expect.objectContaining({
      format: 'mp4', width: 4, height: 2, fps: 30, hasAudio: true, alpha: true, quality: 'high',
    }));
    expect(streamed).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxOutstanding()).toBe(1);
    expect(bridge.stageFrame).not.toHaveBeenCalled();
    expect(sink.pipeline).toBe('stream');
    expect(result.kind).toBe('file');
    expect(result.frames).toBe(6);
    if (result.kind === 'file') {
      await expect(result.saveTo('/out', 'x.mp4', true)).resolves.toBe('/out/x.mp4');
      expect(bridge.cleanJob).toHaveBeenCalledWith('job1');
    }
  });

  it('lets the render run ahead of the write, but only by the queue bound', async () => {
    const pending: Resolver[] = [];
    const { bridge } = installBridge({
      streamFrame: jest.fn((_job: string, index: number) =>
        index === 0 ? Promise.resolve() : new Promise<void>((r) => pending.push(r))),
    });
    const sink = new FfmpegStreamSink(params, { readPixels: fakePixels });
    await sink.addFrame(canvas(), 0);
    await sink.addFrame(canvas(), 1); // writing
    await sink.addFrame(canvas(), 2); // queued
    let third = false;
    const blocked = sink.addFrame(canvas(), 3).then(() => { third = true; });
    await tick();
    expect(third).toBe(false);
    pending.shift()!();
    await blocked;
    expect(third).toBe(true);
    // Drain the rest so finish can complete.
    const finishing = sink.finish();
    for (let i = 0; i < 5 && pending.length === 0; i++) await tick();
    while (pending.length) { pending.shift()!(); await tick(); }
    await finishing;
    expect(bridge.streamFrame.mock.calls.map((c: unknown[]) => c[1])).toEqual([0, 1, 2, 3]);
  });

  it('falls back to staged files, with this same frame, when the stream cannot open', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { bridge, order } = installBridge({
      openStream: jest.fn(async () => { throw new Error('No handler registered for render:openStream'); }),
    });
    const staged = fakeStaged();
    const sink = new FfmpegStreamSink(params, { readPixels: fakePixels, staged: () => staged.sink });
    for (let i = 0; i < 3; i++) await sink.addFrame(canvas(), i);
    await sink.finish();
    expect(staged.added).toEqual([0, 1, 2]);
    expect(staged.sink.finish).toHaveBeenCalled();
    expect(sink.pipeline).toBe('staged');
    // The half-opened job is reclaimed, not leaked.
    expect(order).toEqual(expect.arrayContaining(['cancel', 'cleanJob']));
    expect(bridge.finishStream).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('honours the staged preference silently', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { bridge } = installBridge({ streamPreference: jest.fn(async () => 'staged') });
    const staged = fakeStaged();
    const sink = new FfmpegStreamSink(params, { readPixels: fakePixels, staged: () => staged.sink });
    await sink.addFrame(canvas(), 0);
    expect(staged.added).toEqual([0]);
    expect(bridge.openStream).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not fall back when ffmpeg is missing — staging would fail the same way, later', async () => {
    installBridge({
      openStream: jest.fn(async () => { throw new Error('ffmpeg was not found. Install it…'); }),
    });
    const staged = jest.fn(() => fakeStaged().sink);
    const sink = new FfmpegStreamSink(params, { readPixels: fakePixels, staged });
    await expect(sink.addFrame(canvas(), 0)).rejects.toThrow('ffmpeg was not found');
    expect(staged).not.toHaveBeenCalled();
  });

  it('a frame that fails mid-stream fails the export and nothing after it is sent', async () => {
    const sent: number[] = [];
    installBridge({
      streamFrame: jest.fn(async (_job: string, index: number) => {
        if (index === 2) throw new Error('Encoding stopped at frame 2: ffmpeg exited 1');
        sent.push(index);
      }),
    });
    const sink = new FfmpegStreamSink(params, { readPixels: fakePixels });
    let failure: unknown = null;
    try {
      for (let i = 0; i < 6; i++) await sink.addFrame(canvas(), i);
      await sink.finish();
    } catch (e) {
      failure = e;
    }
    expect(String(failure)).toContain('Encoding stopped at frame 2');
    expect(sent).toEqual([0, 1]);
  });

  it('refuses a frame of a different size than the stream was opened at', async () => {
    installBridge();
    const sink = new FfmpegStreamSink(params, { readPixels: fakePixels });
    await sink.addFrame(canvas(4, 2), 0);
    await expect(sink.addFrame(canvas(8, 2), 1)).rejects.toThrow('opened at 4×2');
  });

  it('dispose kills the child before closing the queue, then removes the job dir', async () => {
    const { order } = installBridge();
    const sink = new FfmpegStreamSink(params, { readPixels: fakePixels });
    await sink.addFrame(canvas(), 0);
    await sink.dispose();
    expect(order.slice(-2)).toEqual(['cancel', 'cleanJob']);
  });

  it('streams the real unpremultiplied bytes read back from the frame canvas', async () => {
    const received: Uint8Array[] = [];
    installBridge({
      streamFrame: jest.fn(async (_job: string, _i: number, bytes: Uint8Array) => { received.push(bytes.slice()); }),
    });
    const c = canvas(3, 3);
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(255, 0, 0, 0.5)';
    g.fillRect(0, 0, 3, 3);
    const expected = g.getImageData(0, 0, 3, 3).data;
    const sink = new FfmpegStreamSink({ ...params, width: 3, height: 3 });
    await sink.addFrame(c, 0);
    expect(received[0]!.length).toBe(36);
    expect(Array.from(received[0]!)).toEqual(Array.from(expected));
  });
});

describe('FfmpegStreamSink — the chunked raw pipe', () => {
  /** A bridge from a main that offers `streamChunk`; frames reassembled per index. */
  function installChunkBridge(over: Record<string, unknown> = {}) {
    const frames = new Map<number, Uint8Array>();
    const chunks: Array<{ index: number; offset: number; len: number; last: boolean }> = [];
    let outstanding = 0;
    let maxOutstanding = 0;
    const base = installBridge({
      streamChunk: jest.fn(async (_job: string, index: number, offset: number, bytes: Uint8Array, last: boolean) => {
        outstanding += 1;
        maxOutstanding = Math.max(maxOutstanding, outstanding);
        chunks.push({ index, offset, len: bytes.byteLength, last });
        const f = frames.get(index) ?? new Uint8Array(0);
        const merged = new Uint8Array(f.byteLength + bytes.byteLength);
        merged.set(f, 0);
        merged.set(bytes, f.byteLength);
        frames.set(index, merged);
        await tick();
        outstanding -= 1;
      }),
      finishStream: jest.fn(async () => ({ path: '/job/out.mp4', frames: frames.size })),
      ...over,
    });
    return { ...base, frames, chunks, maxOutstanding: () => maxOutstanding };
  }

  it('prefers streamChunk over streamFrame, one chunk in flight, every frame whole', async () => {
    const { bridge, chunks, frames, maxOutstanding } = installChunkBridge();
    const sink = new FfmpegStreamSink({ ...params, width: 8, height: 8 }, { readPixels: (c) => new Uint8Array(c.width * c.height * 4).fill(7) });
    for (let i = 0; i < 4; i++) await sink.addFrame(canvas(8, 8), i);
    const result = await sink.finish();
    expect(bridge.streamFrame).not.toHaveBeenCalled();
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(chunks.every((c) => c.offset === 0 && c.len === 256 && c.last)).toBe(true);
    expect(maxOutstanding()).toBe(1);
    expect([...frames.values()].every((f) => f.byteLength === 256 && f.every((b) => b === 7))).toBe(true);
    expect(result.frames).toBe(4);
  });

  it('reports the encoder main opened the child with, and its fallback warning', async () => {
    installChunkBridge({
      openStream: jest.fn(async () => ({ videoEncoder: 'libx264', warning: 'h264_nvenc is compiled in but failed to initialise on this machine; encoded with libx264 instead.' })),
    });
    const sink = new FfmpegStreamSink({ ...params, videoEncoder: 'h264_nvenc' }, { readPixels: fakePixels });
    await sink.addFrame(canvas(), 0);
    const result = await sink.finish();
    expect(result.kind).toBe('file');
    if (result.kind === 'file') {
      expect(result.videoCodec).toBe('libx264');
      expect(result.warning).toMatch(/h264_nvenc/);
    }
  });

  it('passes the requested encoder to openStream for mp4 only', async () => {
    const { bridge } = installChunkBridge();
    const mp4 = new FfmpegStreamSink({ ...params, videoEncoder: 'h264_qsv' }, { readPixels: fakePixels });
    await mp4.addFrame(canvas(), 0);
    expect(bridge.openStream).toHaveBeenLastCalledWith('job1', expect.objectContaining({ videoEncoder: 'h264_qsv' }));
    const webm = new FfmpegStreamSink({ ...params, format: 'webm', videoEncoder: 'h264_qsv' }, { readPixels: fakePixels });
    await webm.addFrame(canvas(), 0);
    expect(bridge.openStream).toHaveBeenLastCalledWith('job1', expect.not.objectContaining({ videoEncoder: expect.anything() }));
  });
});

describe('which exports stream', () => {
  it('everything the ffmpeg sink encodes, except HDR, resumable renders and an explicit staged pipeline', () => {
    for (const format of ['mp4', 'webm', 'gif', 'mov'] as const) {
      expect(streamEligible({ ...params, format })).toBe(true);
    }
    expect(streamEligible({ ...params, format: 'hdr10' })).toBe(false);
    expect(streamEligible({ ...params, format: 'hlg' })).toBe(false);
    expect(streamEligible({ ...params, resume: { spec: {}, totalFrames: 10 } })).toBe(false);
    expect(streamEligible({ ...params, pipeline: 'staged' })).toBe(false);
    expect(streamEligible({ ...params, format: 'plugin:x.y' })).toBe(false);
  });

  it('createVideoSink hands the desktop a streaming sink by default', () => {
    installBridge();
    expect(createVideoSink(params)).toBeInstanceOf(FfmpegStreamSink);
    expect(createVideoSink({ ...params, format: 'hdr10' })).not.toBeInstanceOf(FfmpegStreamSink);
    expect(createVideoSink({ ...params, resume: { spec: {}, totalFrames: 3 } })).not.toBeInstanceOf(FfmpegStreamSink);
  });
});
