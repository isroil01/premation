/**
 * The frame cache's memory accounting and its non-disturbing probe.
 *
 * Both exist because of the IDLE PRE-RENDER PUMP, which fills this cache while
 * the editor sits paused. It scans forward for the first uncached frame and it
 * caches frames at whatever resolution adaptive quality last chose — two access
 * patterns the cache was not written for, and each one broke a different
 * invariant:
 *
 *   • Scanning with `get` promoted every already-cached frame to
 *     most-recently-used, so the LRU then evicted the frames NEAREST the
 *     playhead — the ones about to be needed.
 *   • Sizing every entry from the CURRENT canvas meant a cache holding a mix of
 *     Full and Quarter frames was measured as if all of them matched the newest
 *     one, overshooting the budget by up to 16× (or evicting valid frames
 *     early, depending on which way the last flip went).
 */

import { FrameCache } from './frameCache';

function src(w = 4, h = 4): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

describe('has() — the non-disturbing probe', () => {
  it('reports residency without touching LRU recency', () => {
    // Budget of exactly 3 frames at 4×4 (64 bytes each).
    const cache = new FrameCache(192);
    cache.setKey('k', 4, 4);
    cache.put(0, src());
    cache.put(1, src());
    cache.put(2, src());

    // Probe the oldest frame. If `has` touched recency, 0 would become the
    // most-recently-used and frame 1 would be evicted next instead.
    expect(cache.has(0)).toBe(true);
    expect(cache.has(99)).toBe(false);

    cache.put(3, src());
    // 0 was still the least-recently-used, so 0 is what went.
    expect(cache.has(0)).toBe(false);
    expect(cache.has(1)).toBe(true);
    expect(cache.has(2)).toBe(true);
    expect(cache.has(3)).toBe(true);
  });

  it('get() DOES touch recency — the contrast that makes has() worth having', () => {
    const cache = new FrameCache(192);
    cache.setKey('k', 4, 4);
    cache.put(0, src());
    cache.put(1, src());
    cache.put(2, src());
    cache.get(0);
    cache.put(3, src());
    expect(cache.has(0)).toBe(true);
    expect(cache.has(1)).toBe(false);
  });
});

describe('the byte budget', () => {
  it('charges each frame its own size, not the newest frame\'s', () => {
    // 1000-byte budget. Four 8×8 frames = 256 bytes each = 1024 > 1000.
    const cache = new FrameCache(1000);
    cache.setKey('k', 8, 8);
    cache.put(0, src(8, 8));
    cache.put(1, src(8, 8));
    cache.put(2, src(8, 8));
    expect(cache.size).toBe(3);
    expect(cache.bytes).toBe(768);

    // Adaptive resolution degrades: the next frames are 4×4 (64 bytes). A
    // budget computed from the CURRENT size would now believe it could hold
    // 1000/64 ≈ 15 frames and keep everything; real accounting knows the three
    // big ones still weigh 768.
    cache.setKey('k', 4, 4);
    for (let f = 3; f < 10; f++) cache.put(f, src(4, 4));
    expect(cache.bytes).toBeLessThanOrEqual(1000);
  });

  it('never evicts down to nothing, even if one frame exceeds the whole budget', () => {
    const cache = new FrameCache(10); // smaller than a single 4×4 frame (64B)
    cache.setKey('k', 4, 4);
    cache.put(0, src());
    cache.put(1, src());
    // Holding one frame beats holding none and re-rendering forever.
    expect(cache.size).toBe(1);
    expect(cache.has(1)).toBe(true);
  });

  it('re-putting a frame does not double-count its bytes', () => {
    const cache = new FrameCache();
    cache.setKey('k', 4, 4);
    cache.put(5, src());
    const once = cache.bytes;
    cache.put(5, src());
    expect(cache.bytes).toBe(once);
    expect(cache.size).toBe(1);
  });

  it('clear() resets the accounting, not just the map', () => {
    const cache = new FrameCache();
    cache.setKey('k', 4, 4);
    cache.put(0, src());
    cache.clear();
    expect(cache.bytes).toBe(0);
    expect(cache.size).toBe(0);
  });
});

describe('disk write-through', () => {
  it('hands the disk tier the cache\'s own copy, not the caller\'s canvas', () => {
    // The caller's canvas is the live WebGL content canvas; encoding from it
    // forces a second GPU readback inside the render tick, on top of the one
    // the RAM copy just did.
    const written: HTMLCanvasElement[] = [];
    const cache = new FrameCache();
    cache.attachDisk({
      setGeneration: () => {},
      write: (_f: number, c: HTMLCanvasElement) => { written.push(c); },
      prefetch: () => {},
      ranges: () => [],
    } as unknown as Parameters<FrameCache['attachDisk']>[0]);
    cache.setKey('k', 4, 4);

    const source = src();
    cache.put(0, source);

    expect(written).toHaveLength(1);
    expect(written[0]).not.toBe(source);
  });
});
