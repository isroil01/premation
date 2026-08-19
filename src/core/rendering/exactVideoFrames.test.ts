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
});
