import { bracketFrames, VideoFrameCache } from './videoFrameCache';

describe('bracketFrames', () => {
  it('brackets a time that falls between two source frames', () => {
    // 30fps: frame 3 is at 0.1s, frame 4 at 0.1333s. 0.1167s sits halfway.
    const { a, b, weight } = bracketFrames(3.5 / 30, 30);
    expect(a).toBeCloseTo(3 / 30);
    expect(b).toBeCloseTo(4 / 30);
    expect(weight).toBeCloseTo(0.5);
  });

  it('reports zero weight exactly on a frame boundary', () => {
    // Nothing to blend toward here — the caller must draw frame A alone.
    expect(bracketFrames(2 / 30, 30).weight).toBeCloseTo(0);
  });

  it('uses the SOURCE frame rate, not the composition\'s', () => {
    // The whole point of measuring fps: 24fps footage has frames at 1/24,
    // and blending on the comp's 30fps grid would target times where the
    // source has no frame at all.
    const { a, b } = bracketFrames(0.5, 24);
    expect(a).toBeCloseTo(12 / 24);
    expect(b).toBeCloseTo(13 / 24);
  });

  it('handles t=0', () => {
    const { a, b, weight } = bracketFrames(0, 30);
    expect(a).toBe(0);
    expect(b).toBeCloseTo(1 / 30);
    expect(weight).toBe(0);
  });

  it('degenerates safely on a zero or negative frame rate', () => {
    // Never produce NaN pen positions or an Infinity seek.
    expect(bracketFrames(1.5, 0)).toEqual({ a: 1.5, b: 1.5, weight: 0 });
    expect(bracketFrames(1.5, -30)).toEqual({ a: 1.5, b: 1.5, weight: 0 });
  });

  it('degenerates safely on a non-finite time', () => {
    const r = bracketFrames(Number.NaN, 30);
    expect(r.weight).toBe(0);
  });
});

/** A fake element standing in for the decoder: jsdom has neither. */
function fakeVideo(): HTMLVideoElement {
  const listeners = new Map<string, Array<() => void>>();
  let currentTime = 0;
  const v = {
    videoWidth: 4,
    videoHeight: 4,
    readyState: 2,
    src: '',
    get currentTime() {
      return currentTime;
    },
    set currentTime(t: number) {
      currentTime = t;
      // A real element seeks asynchronously; fire on the next tick.
      queueMicrotask(() => (listeners.get('seeked') ?? []).forEach((fn) => fn()));
    },
    addEventListener(type: string, fn: () => void) {
      const arr = listeners.get(type) ?? [];
      arr.push(fn);
      listeners.set(type, arr);
    },
    dispatch(type: string) {
      (listeners.get(type) ?? []).forEach((fn) => fn());
    },
  };
  return v as unknown as HTMLVideoElement;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('VideoFrameCache', () => {
  it('returns null on a miss rather than blocking', () => {
    const cache = new VideoFrameCache(1024 * 1024, () => fakeVideo());
    expect(cache.get('a.mp4', 0.5)).toBeNull();
  });

  it('caches a frame once the decode lands, and serves it synchronously after', async () => {
    const vid = fakeVideo();
    const cache = new VideoFrameCache(1024 * 1024, () => vid);
    expect(cache.get('a.mp4', 0.5)).toBeNull();
    (vid as unknown as { dispatch: (t: string) => void }).dispatch('loadeddata');
    await flush();
    await flush();
    expect(cache.stats('a.mp4')!.frames).toBeGreaterThan(0);
  });

  it('keeps two distinct frames at once — the thing one element cannot do', async () => {
    const vid = fakeVideo();
    const cache = new VideoFrameCache(1024 * 1024, () => vid);
    (vid as unknown as { dispatch: (t: string) => void }).dispatch('loadeddata');
    cache.get('a.mp4', 0.1);
    cache.get('a.mp4', 0.2);
    await flush();
    await flush();
    await flush();
    expect(cache.stats('a.mp4')!.frames).toBe(2);
  });

  it('evicts under budget instead of pinning every frame it ever touched', async () => {
    // 4x4x4 = 64 bytes per frame; a 100-byte budget holds one.
    const vid = fakeVideo();
    const cache = new VideoFrameCache(100, () => vid);
    (vid as unknown as { dispatch: (t: string) => void }).dispatch('loadeddata');
    for (let i = 1; i <= 4; i++) {
      cache.get('a.mp4', i / 10);
      await flush();
      await flush();
    }
    expect(cache.stats('a.mp4')!.bytes).toBeLessThanOrEqual(100);
  });

  it('decodes from an element that was ALREADY loaded before the cache saw it', async () => {
    // The app has usually been playing this source already, so `loadeddata`
    // fired long before the cache subscribed and will never fire again.
    // Waiting for the event left the cache permanently un-ready and frame
    // blending silently dead — readyState has to be checked up front.
    const vid = fakeVideo(); // readyState: 2 from birth, no event dispatched
    const cache = new VideoFrameCache(1024 * 1024, () => vid);
    cache.get('a.mp4', 0.5);
    await flush();
    await flush();
    expect(cache.stats('a.mp4')!.frames).toBe(1);
  });

  it('drops sources that are no longer retained', () => {
    const cache = new VideoFrameCache(1024, () => fakeVideo());
    cache.get('a.mp4', 0);
    cache.get('b.mp4', 0);
    cache.retain(new Set(['a.mp4']));
    expect(cache.stats('a.mp4')).not.toBeNull();
    expect(cache.stats('b.mp4')).toBeNull();
  });

  it('does not queue the same time twice', async () => {
    const vid = fakeVideo();
    const cache = new VideoFrameCache(1024 * 1024, () => vid);
    (vid as unknown as { dispatch: (t: string) => void }).dispatch('loadeddata');
    cache.get('a.mp4', 0.5);
    cache.get('a.mp4', 0.5);
    cache.get('a.mp4', 0.5);
    await flush();
    await flush();
    expect(cache.stats('a.mp4')!.frames).toBe(1);
  });
});
