import { ExactVideoFrameCache, type ExactSourceLike, type LoadedExactSource } from './exactVideoFrames';
import type { DecodedFrameLike } from '@core/video/exactVideoSource';

const FPS = 30;
const FRAMES = 24;

/** A stub source on a fixed 30fps grid. jsdom has no WebCodecs, so `frameAt`
 *  hands back plain objects with the display-size fields the cache reads. */
function stubSource(opts: { failFor?: Set<number>; w?: number; h?: number } = {}) {
  const decoded: number[] = [];
  const source: ExactSourceLike = {
    frameIndexAt(timeUs: number): number {
      // Mimics frameAtTime: last frame whose FRACTIONAL-µs start is at or
      // before timeUs (frame i starts at i/FPS × 1e6 = 33333.33µs, ...).
      let idx = 0;
      while (idx + 1 < FRAMES && ((idx + 1) / FPS) * 1e6 <= timeUs) idx += 1;
      return idx;
    },
    frameAt(presIdx: number): Promise<DecodedFrameLike> {
      if (opts.failFor?.has(presIdx)) {
        return Promise.reject(new Error(`decode failed for #${presIdx}`));
      }
      decoded.push(presIdx);
      const frame = {
        timestamp: Math.round((presIdx / FPS) * 1e6),
        displayWidth: opts.w ?? 4,
        displayHeight: opts.h ?? 4,
        close: () => undefined,
      };
      return Promise.resolve(frame as unknown as DecodedFrameLike);
    },
    close: jest.fn(),
  };
  return { source, decoded };
}

function loaderFor(stub: { source: ExactSourceLike }): (src: string) => Promise<LoadedExactSource> {
  return () => Promise.resolve({ source: stub.source, width: 4, height: 4 });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ExactVideoFrameCache', () => {
  it('is pending while the source loads, then serves the exact frame', async () => {
    const stub = stubSource();
    const cache = new ExactVideoFrameCache(1024 * 1024, loaderFor(stub), () => true);

    expect(cache.get('a.mp4', 0.5).state).toBe('pending');
    await flush(); // loader resolves
    expect(cache.get('a.mp4', 0.5).state).toBe('pending'); // decode queued
    await flush(); // decode lands

    const r = cache.get('a.mp4', 0.5);
    expect(r).toMatchObject({ state: 'frame', presIndex: 15, exact: true });
  });

  it('resolves the same presentation index for sub-frame times (no seek drift)', async () => {
    const stub = stubSource();
    const cache = new ExactVideoFrameCache(1024 * 1024, loaderFor(stub), () => true);
    cache.get('a.mp4', 0.5);
    await flush();
    cache.get('a.mp4', 0.5);
    await flush();

    // 0.5s and 0.5s + a third of a frame land on the SAME frame — the exact
    // path has a real grid, unlike the element's seek deadband.
    const a = cache.get('a.mp4', 0.5);
    const b = cache.get('a.mp4', 0.5 + 1 / (3 * FPS));
    expect(a).toMatchObject({ state: 'frame', presIndex: 15, exact: true });
    expect(b).toMatchObject({ state: 'frame', presIndex: 15, exact: true });
    expect(stub.decoded).toEqual([15]);
  });

  it('serves the nearest decoded neighbour, inexactly, while the target decodes', async () => {
    const stub = stubSource();
    const cache = new ExactVideoFrameCache(1024 * 1024, loaderFor(stub), () => true);
    cache.get('a.mp4', 0);
    await flush();
    cache.get('a.mp4', 0);
    await flush();

    // Frame 0 is cached; asking for 0.5s returns it as a stand-in and queues 15.
    const near = cache.get('a.mp4', 0.5);
    expect(near).toMatchObject({ state: 'frame', presIndex: 0, exact: false });
    await flush();
    expect(cache.get('a.mp4', 0.5)).toMatchObject({ state: 'frame', presIndex: 15, exact: true });
  });

  it('does not queue the same frame twice', async () => {
    const stub = stubSource();
    const cache = new ExactVideoFrameCache(1024 * 1024, loaderFor(stub), () => true);
    cache.get('a.mp4', 0.5);
    await flush();
    cache.get('a.mp4', 0.5);
    cache.get('a.mp4', 0.5);
    cache.get('a.mp4', 0.5);
    await flush();
    expect(stub.decoded).toEqual([15]);
  });

  it('goes sticky-unavailable without WebCodecs, and never calls the loader', () => {
    const loader = jest.fn();
    const cache = new ExactVideoFrameCache(1024 * 1024, loader, () => false);
    expect(cache.get('a.mp4', 0).state).toBe('unavailable');
    expect(cache.get('a.mp4', 1).state).toBe('unavailable');
    expect(loader).not.toHaveBeenCalled();
  });

  it('goes sticky-unavailable when the demux/load fails', async () => {
    const cache = new ExactVideoFrameCache(
      1024 * 1024,
      () => Promise.reject(new Error('not an mp4')),
      () => true,
    );
    expect(cache.get('a.webm', 0).state).toBe('pending');
    await flush();
    expect(cache.get('a.webm', 0).state).toBe('unavailable');
    expect(cache.stats('a.webm')!.state).toBe('unavailable');
  });

  it('goes unavailable and closes the decoder after repeated decode failures', async () => {
    const stub = stubSource({ failFor: new Set([0, 1, 2, 3, 4, 5]) });
    const cache = new ExactVideoFrameCache(1024 * 1024, loaderFor(stub), () => true);
    cache.get('a.mp4', 0);
    await flush();
    // Three distinct failing decodes trip the breaker.
    for (const t of [0, 1 / FPS, 2 / FPS]) {
      cache.get('a.mp4', t);
      await flush();
    }
    expect(cache.get('a.mp4', 0).state).toBe('unavailable');
    expect(stub.source.close).toHaveBeenCalled();
  });

  it('a successful decode resets the failure count', async () => {
    const stub = stubSource({ failFor: new Set([0, 2]) });
    const cache = new ExactVideoFrameCache(1024 * 1024, loaderFor(stub), () => true);
    cache.get('a.mp4', 0);
    await flush();
    for (const t of [0, 1 / FPS, 2 / FPS, 3 / FPS]) {
      cache.get('a.mp4', t);
      await flush();
    }
    // Two failures interleaved with successes never reach the threshold.
    expect(cache.get('a.mp4', 1 / FPS).state).toBe('frame');
  });

  it('evicts under the byte budget instead of pinning every frame', async () => {
    // 4x4x4 = 64 bytes per canvas; a 100-byte budget holds one.
    const stub = stubSource();
    const cache = new ExactVideoFrameCache(100, loaderFor(stub), () => true);
    cache.get('a.mp4', 0);
    await flush();
    for (let i = 0; i < 4; i++) {
      cache.get('a.mp4', i / FPS);
      await flush();
    }
    expect(cache.stats('a.mp4')!.bytes).toBeLessThanOrEqual(100);
  });

  it('exposes inflight work as waits that clear themselves on settle', async () => {
    const stub = stubSource();
    const cache = new ExactVideoFrameCache(1024 * 1024, loaderFor(stub), () => true);
    cache.get('a.mp4', 0.5); // load inflight
    expect(cache.waits().length).toBe(1);
    await flush();
    cache.get('a.mp4', 0.5); // decode inflight
    expect(cache.waits().length).toBe(1);
    await flush();
    await flush();
    expect(cache.waits().length).toBe(0);
  });

  it('notifies onChange when a decode lands', async () => {
    const stub = stubSource();
    const cache = new ExactVideoFrameCache(1024 * 1024, loaderFor(stub), () => true);
    const changed = jest.fn();
    cache.onChange(changed);
    cache.get('a.mp4', 0.5);
    await flush(); // load
    cache.get('a.mp4', 0.5);
    await flush(); // decode
    expect(changed).toHaveBeenCalled();
  });

  it('clear() closes sources and forgets state', async () => {
    const stub = stubSource();
    const cache = new ExactVideoFrameCache(1024 * 1024, loaderFor(stub), () => true);
    cache.get('a.mp4', 0);
    await flush();
    cache.clear();
    expect(stub.source.close).toHaveBeenCalled();
    expect(cache.stats('a.mp4')).toBeNull();
  });

  describe('pulldown removal (Interpret Footage ▸ Remove Pulldown)', () => {
    it('serves the duplicate whole frame for the first split slot', async () => {
      const stub = stubSource();
      const cache = new ExactVideoFrameCache(1024 * 1024, loaderFor(stub), () => true);
      cache.get('a.mp4', 2 / FPS, 0);
      await flush(); // load
      cache.get('a.mp4', 2 / FPS, 0);
      await flush(); // decode
      // Frame 2 is B/C — its whole film frame is frame 1, which is what the
      // mapping decodes and serves.
      const r = cache.get('a.mp4', 2 / FPS, 0);
      expect(r).toMatchObject({ state: 'frame', presIndex: 1, exact: true });
      expect(stub.decoded).toEqual([1]);
    });

    it('weaves the fields-only film frame from both carriers and caches it', async () => {
      const stub = stubSource();
      const cache = new ExactVideoFrameCache(1024 * 1024, loaderFor(stub), () => true);
      cache.get('a.mp4', 3 / FPS, 0);
      await flush(); // load
      // Frame 3 is C/D: film frame C only exists as fields across frames 2
      // and 3 — BOTH are requested.
      expect(cache.get('a.mp4', 3 / FPS, 0).state).toBe('pending');
      await flush(); // decodes land
      const r = cache.get('a.mp4', 3 / FPS, 0);
      expect(r).toMatchObject({ state: 'frame', presIndex: 2.5, exact: true });
      expect(new Set(stub.decoded)).toEqual(new Set([2, 3]));
      // The weave is cached under its synthetic index: re-asking neither
      // decodes nor rebuilds.
      const again = cache.get('a.mp4', 3 / FPS, 0);
      expect(again).toMatchObject({ state: 'frame', presIndex: 2.5, exact: true });
      expect((again as { canvas: HTMLCanvasElement }).canvas).toBe((r as { canvas: HTMLCanvasElement }).canvas);
      expect(cache.stats('a.mp4')!.frames).toBe(3); // frames 2, 3, and the weave
    });

    it('whole-frame slots pass through untouched', async () => {
      const stub = stubSource();
      const cache = new ExactVideoFrameCache(1024 * 1024, loaderFor(stub), () => true);
      cache.get('a.mp4', 5 / FPS, 0);
      await flush();
      cache.get('a.mp4', 5 / FPS, 0);
      await flush();
      // Frame 5 opens the second cycle (A/A) — served as itself.
      expect(cache.get('a.mp4', 5 / FPS, 0)).toMatchObject({ state: 'frame', presIndex: 5, exact: true });
    });

    it('without a phase the mapping is not applied', async () => {
      const stub = stubSource();
      const cache = new ExactVideoFrameCache(1024 * 1024, loaderFor(stub), () => true);
      cache.get('a.mp4', 3 / FPS);
      await flush();
      cache.get('a.mp4', 3 / FPS);
      await flush();
      expect(cache.get('a.mp4', 3 / FPS)).toMatchObject({ state: 'frame', presIndex: 3, exact: true });
    });
  });

  it('a load that resolves after clear() closes the late source instead of resurrecting it', async () => {
    let resolveLoad: ((v: LoadedExactSource) => void) | null = null;
    const stub = stubSource();
    const cache = new ExactVideoFrameCache(
      1024 * 1024,
      () => new Promise((r) => (resolveLoad = r)),
      () => true,
    );
    cache.get('a.mp4', 0);
    cache.clear();
    resolveLoad!({ source: stub.source, width: 4, height: 4 });
    await flush();
    expect(stub.source.close).toHaveBeenCalled();
    expect(cache.stats('a.mp4')).toBeNull();
  });

  describe('streaming playback', () => {
    const STREAM_FRAMES = 90;

    /** A 90-frame stub grid + a fake demux (only samples.length is read) +
     *  a recording fake reader — streaming without WebCodecs. */
    function streamHarness(): {
      cache: ExactVideoFrameCache;
      decoded: number[];
      readers: Array<{ from: number; delivered: number[]; closed: boolean }>;
    } {
      const decoded: number[] = [];
      const source: ExactSourceLike = {
        frameIndexAt(timeUs: number): number {
          let idx = 0;
          while (idx + 1 < STREAM_FRAMES && ((idx + 1) / FPS) * 1e6 <= timeUs) idx += 1;
          return idx;
        },
        frameAt(presIdx: number): Promise<DecodedFrameLike> {
          decoded.push(presIdx);
          return Promise.resolve({
            timestamp: Math.round((presIdx / FPS) * 1e6),
            displayWidth: 4,
            displayHeight: 4,
            close: () => undefined,
          } as unknown as DecodedFrameLike);
        },
        close: jest.fn(),
      };
      const demuxed = { samples: new Array(STREAM_FRAMES) } as unknown as import('@core/video/mp4Demuxer').DemuxedVideo;
      const readers: Array<{ from: number; delivered: number[]; closed: boolean }> = [];
      const cache = new ExactVideoFrameCache(
        1024 * 1024,
        () => Promise.resolve({ source, width: 4, height: 4, demuxed }),
        () => true,
        (_d, from) => {
          const rec = { from, delivered: [] as number[], closed: false };
          readers.push(rec);
          return {
            frameAt(presIdx: number): Promise<DecodedFrameLike> {
              rec.delivered.push(presIdx);
              return Promise.resolve({
                timestamp: Math.round((presIdx / FPS) * 1e6),
                displayWidth: 4,
                displayHeight: 4,
                close: () => undefined,
              } as unknown as DecodedFrameLike);
            },
            close(): void {
              rec.closed = true;
            },
          };
        },
      );
      return { cache, decoded, readers };
    }

    /** Drain the pump loop (one await per frame). */
    const drain = async (n = 20): Promise<void> => {
      for (let i = 0; i < n; i++) await flush();
    };

    it('an ascending miss run flips the source into a decode-ahead stream', async () => {
      const { cache, decoded, readers } = streamHarness();
      cache.get('a.mp4', 0);
      await flush(); // load
      // Playback: frames 0, 1, 2, … — the first misses go to random access.
      for (const idx of [0, 1, 2]) {
        cache.get('a.mp4', idx / FPS);
        await flush();
      }
      expect(readers.length).toBe(1);
      expect(readers[0]!.from).toBe(0);
      await drain();
      // The stream decoded ahead of the newest request…
      expect(Math.max(...readers[0]!.delivered)).toBeGreaterThanOrEqual(10);
      // …so the frames playback needs next are already exact cache hits.
      for (const idx of [3, 4, 5, 6]) {
        expect(cache.get('a.mp4', idx / FPS)).toMatchObject({ state: 'frame', presIndex: idx, exact: true });
      }
      // Random access served only the pre-stream miss (stream arms on frame 1).
      expect(decoded).toEqual([]);
    });

    it('cache hits keep the stream ahead of the playhead', async () => {
      const { cache, readers } = streamHarness();
      cache.get('a.mp4', 0);
      await flush();
      for (const idx of [0, 1, 2]) {
        cache.get('a.mp4', idx / FPS);
        await flush();
      }
      await drain();
      const before = Math.max(...readers[0]!.delivered);
      // Ride the cache: every hit advances the target, the pump follows.
      for (const idx of [3, 4, 5, 6, 7, 8]) {
        cache.get('a.mp4', idx / FPS);
        await drain(4);
      }
      expect(Math.max(...readers[0]!.delivered)).toBeGreaterThan(before);
    });

    it('a far seek kills the stream and random access resumes', async () => {
      const { cache, decoded, readers } = streamHarness();
      cache.get('a.mp4', 0);
      await flush();
      for (const idx of [0, 1, 2]) {
        cache.get('a.mp4', idx / FPS);
        await flush();
      }
      await drain();
      // Jump far past the stream window — a scrub, not playback.
      cache.get('a.mp4', 80 / FPS);
      await flush();
      expect(readers[0]!.closed).toBe(true);
      expect(decoded).toContain(80);
    });

    it('a loop wrap restarts streaming instead of random-access per frame', async () => {
      const { cache, decoded, readers } = streamHarness();
      cache.get('a.mp4', 0);
      await flush(); // load
      // Warm streaming through the middle of the clip.
      for (const idx of [0, 1, 2, 3, 4, 5]) {
        cache.get('a.mp4', idx / FPS);
        await flush();
      }
      await drain();
      const decodedBeforeWrap = decoded.length;
      // Simulate comp/footage loop: jump from near the end back to frame 0.
      cache.get('a.mp4', (STREAM_FRAMES - 2) / FPS);
      await flush();
      await drain(8);
      cache.get('a.mp4', 0);
      await flush();
      await drain(12);
      // A fresh reader should have been opened at the wrap target…
      expect(readers.length).toBeGreaterThanOrEqual(2);
      const wrapReader = readers[readers.length - 1]!;
      expect(wrapReader.from).toBe(0);
      expect(wrapReader.closed).toBe(false);
      // …and playback after the wrap should not fall back to one random-access
      // decode per frame (the failure mode that made loops unwatchable).
      expect(decoded.length - decodedBeforeWrap).toBeLessThan(8);
      for (const idx of [1, 2, 3, 4]) {
        expect(cache.get('a.mp4', idx / FPS)).toMatchObject({ state: 'frame', presIndex: idx, exact: true });
      }
    });

    it('a mid-clip comp loop wrap restarts streaming for compositions shorter than source', async () => {
      const { cache, readers } = streamHarness();
      cache.get('a.mp4', 0);
      await flush();
      // Comp is only 20 frames long (out of 120 source frames).
      for (let idx = 0; idx <= 20; idx++) {
        cache.get('a.mp4', idx / FPS);
        await flush();
      }
      await drain(10);
      const initialReaders = readers.length;
      // Loop back to frame 0 from frame 20.
      cache.get('a.mp4', 0);
      await flush();
      await drain(10);
      expect(readers.length).toBeGreaterThan(initialReaders);
      const loopReader = readers[readers.length - 1]!;
      expect(loopReader.from).toBe(0);
      expect(loopReader.closed).toBe(false);
    });

    it('test-stub sources without a demux never stream', async () => {
      const stub = stubSource();
      const readers: number[] = [];
      const cache = new ExactVideoFrameCache(
        1024 * 1024,
        loaderFor(stub),
        () => true,
        () => {
          readers.push(1);
          throw new Error('should not be constructed');
        },
      );
      cache.get('a.mp4', 0);
      await flush();
      for (const idx of [0, 1, 2, 3, 4, 5]) {
        cache.get('a.mp4', idx / FPS);
        await flush();
      }
      expect(readers.length).toBe(0);
      expect(stub.decoded).toEqual([0, 1, 2, 3, 4, 5]);
    });
  });
});
