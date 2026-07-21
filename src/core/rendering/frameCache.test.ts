/**
 * Frame cache — LRU eviction, key invalidation, and range reporting. Canvas
 * pixel copies are exercised through jsdom's canvas stub (dimensions only).
 */

import { FrameCache } from './frameCache';

function src(w = 4, h = 4): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

describe('FrameCache', () => {
  it('stores and returns frames under the same key', () => {
    const cache = new FrameCache();
    cache.setKey('k1', 4, 4);
    expect(cache.get(3)).toBeNull();
    cache.put(3, src());
    expect(cache.get(3)).not.toBeNull();
    expect(cache.size).toBe(1);
  });

  it('a key change clears everything (honest invalidation)', () => {
    const cache = new FrameCache();
    cache.setKey('k1', 4, 4);
    cache.put(0, src());
    cache.put(1, src());
    cache.setKey('k2', 4, 4);
    expect(cache.size).toBe(0);
    expect(cache.get(0)).toBeNull();
  });

  it('a size change also invalidates (same logical key)', () => {
    const cache = new FrameCache();
    cache.setKey('k1', 4, 4);
    cache.put(0, src());
    cache.setKey('k1', 8, 8);
    expect(cache.size).toBe(0);
  });

  it('evicts least-recently-used frames past the byte budget', () => {
    // Budget of 3 frames: 4×4×4 = 64 bytes/frame → 192-byte budget.
    const cache = new FrameCache(192);
    cache.setKey('k', 4, 4);
    cache.put(0, src());
    cache.put(1, src());
    cache.put(2, src());
    cache.get(0); // touch 0 → 1 is now LRU
    cache.put(3, src());
    expect(cache.size).toBe(3);
    expect(cache.get(1)).toBeNull(); // evicted
    expect(cache.get(0)).not.toBeNull();
    expect(cache.get(3)).not.toBeNull();
  });

  it('reports merged cached ranges in seconds', () => {
    const cache = new FrameCache();
    cache.setKey('k', 4, 4);
    for (const f of [0, 1, 2, 10, 11]) cache.put(f, src());
    expect(cache.ranges(10)).toEqual([
      { start: 0, end: 0.3 },
      { start: 1, end: 1.2 },
    ]);
    expect(cache.ranges(0)).toEqual([]);
  });

  it('notifies listeners on put and clear', () => {
    const cache = new FrameCache();
    cache.setKey('k', 4, 4);
    let calls = 0;
    const off = cache.onChange(() => calls++);
    cache.put(0, src());
    cache.clear();
    off();
    cache.put(1, src());
    expect(calls).toBe(2);
  });
});
