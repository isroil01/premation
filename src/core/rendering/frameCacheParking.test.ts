/**
 * Parking: a key change moves the live generation aside instead of deleting it.
 *
 * The invalidation key is a coordinate, not an arrow. Editing crosses it back
 * and forth constantly — undo, a slider released where it started, a layer
 * toggled off and on, a zoom in and out, a panel divider dragged and dragged
 * back — and every one of those used to throw away a whole work area of
 * rendered frames. Measured on a 20-layer comp with 90 frames cached, a
 * viewport zoom left exactly zero.
 *
 * Two claims to pin, and the second is the one that makes this free rather than
 * a trade: a returning key gets its frames back, and a parked generation never
 * costs the live one a single frame.
 */

import { FrameCache } from './frameCache';

/** jsdom canvases carry dimensions only, which is all the budget arithmetic
 *  reads — 4x4 RGBA = 64 bytes per frame. */
function src(w = 4, h = 4): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const FRAME_BYTES = 4 * 4 * 4;

describe('a returning key gets its frames back', () => {
  it('restores the whole generation, not a fragment of it', () => {
    const cache = new FrameCache();
    cache.setKey('edit-a', 4, 4);
    for (const f of [0, 1, 2, 3]) cache.put(f, src());
    expect(cache.size).toBe(4);

    cache.setKey('edit-b', 4, 4);   // an edit
    expect(cache.size).toBe(0);

    cache.setKey('edit-a', 4, 4);   // undo
    expect(cache.size).toBe(4);
    for (const f of [0, 1, 2, 3]) expect(cache.get(f)).not.toBeNull();
  });

  it('survives a round trip through several keys', () => {
    // Zoom in, look, zoom out: two crossings, not one.
    const cache = new FrameCache();
    cache.setKey('k0', 4, 4);
    cache.put(7, src());
    cache.setKey('k1', 4, 4);
    cache.setKey('k2', 4, 4);
    cache.setKey('k0', 4, 4);
    expect(cache.get(7)).not.toBeNull();
  });

  it('keeps the generations apart', () => {
    const cache = new FrameCache();
    cache.setKey('k0', 4, 4);
    cache.put(1, src());
    cache.setKey('k1', 4, 4);
    cache.put(2, src());
    cache.setKey('k0', 4, 4);
    // k0 held frame 1 and never held frame 2.
    expect(cache.has(1)).toBe(true);
    expect(cache.has(2)).toBe(false);
  });

  it('reports only the live generation to the cache bar', () => {
    const cache = new FrameCache();
    cache.setKey('k0', 4, 4);
    for (const f of [0, 1, 2]) cache.put(f, src());
    cache.setKey('k1', 4, 4);
    // A green bar drawn over parked frames would promise pixels this key
    // cannot serve.
    expect(cache.ranges(30)).toEqual([]);
    cache.setKey('k0', 4, 4);
    expect(cache.ranges(30)).toEqual([{ start: 0, end: 3 / 30 }]);
  });
});

describe('parking never costs the live generation', () => {
  it('evicts parked frames before live ones', () => {
    // Budget for four frames exactly.
    const cache = new FrameCache(4 * FRAME_BYTES);
    cache.setKey('old', 4, 4);
    for (const f of [0, 1, 2, 3]) cache.put(f, src());
    expect(cache.size).toBe(4);

    cache.setKey('new', 4, 4);
    for (const f of [10, 11, 12, 13]) cache.put(f, src());

    // The live generation is whole. Parking used headroom that existed, and
    // gave it back the moment the live generation wanted it.
    expect(cache.size).toBe(4);
    for (const f of [10, 11, 12, 13]) expect(cache.has(f)).toBe(true);
    expect(cache.parkedGenerations).toBe(0);
    expect(cache.totalBytesHeld).toBeLessThanOrEqual(4 * FRAME_BYTES);
  });

  it('behaves exactly as before parking when the budget is already full', () => {
    const cache = new FrameCache(4 * FRAME_BYTES);
    cache.setKey('old', 4, 4);
    for (const f of [0, 1, 2, 3]) cache.put(f, src());
    cache.setKey('new', 4, 4);
    for (const f of [10, 11, 12, 13]) cache.put(f, src());
    // Nothing to come back to — which is the same answer the old code gave,
    // reached without ever having taken capacity from the live generation.
    cache.setKey('old', 4, 4);
    expect(cache.size).toBe(0);
  });

  it('parks freely when there IS headroom', () => {
    const cache = new FrameCache(64 * FRAME_BYTES);
    cache.setKey('old', 4, 4);
    for (const f of [0, 1, 2, 3]) cache.put(f, src());
    cache.setKey('new', 4, 4);
    for (const f of [10, 11]) cache.put(f, src());
    expect(cache.parkedGenerations).toBe(1);
    cache.setKey('old', 4, 4);
    expect(cache.size).toBe(4);
  });

  it('holds a bounded number of parked generations', () => {
    const cache = new FrameCache(1024 * FRAME_BYTES);
    for (let i = 0; i < 10; i++) {
      cache.setKey(`k${i}`, 4, 4);
      cache.put(i, src());
    }
    // A deep history of parked states is headroom the live generation could
    // have used; the round trips worth catching are recent ones.
    expect(cache.parkedGenerations).toBeLessThanOrEqual(3);
    // And the oldest are the ones gone.
    cache.setKey('k0', 4, 4);
    expect(cache.size).toBe(0);
    cache.setKey('k8', 4, 4);
    expect(cache.size).toBe(1);
  });
});

describe('clear', () => {
  it('drops parked generations too — a purge that kept them would be a lie', () => {
    const cache = new FrameCache();
    cache.setKey('k0', 4, 4);
    cache.put(1, src());
    cache.setKey('k1', 4, 4);
    expect(cache.parkedGenerations).toBe(1);

    cache.clear();
    expect(cache.parkedGenerations).toBe(0);
    expect(cache.totalBytesHeld).toBe(0);
    cache.setKey('k0', 4, 4);
    expect(cache.size).toBe(0);
  });
});
