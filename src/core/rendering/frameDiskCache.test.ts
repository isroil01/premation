/**
 * The disk tier: its budget, its generation turnover, and the two races.
 *
 * The store is injected (see `frameBlobStore.ts` for why), so everything here
 * runs without IndexedDB and the eviction policy is actually exercised rather
 * than assumed.
 *
 * The assertions that matter most are not the happy path — they are the ones
 * about a generation turning over WHILE an encode or a read is in flight. A
 * cache that serves one edit's pixels under the next edit's key is worse than
 * no cache: it is a wrong frame that looks like a correct one, on a surface
 * whose whole job is showing you what you just changed.
 */

import { FrameDiskCache, type DecodedFrame } from './frameDiskCache';
import type { FrameBlobStore, StoredFrame } from './frameBlobStore';

/** Generation ids are namespaced by the renderer that wrote them (see
 *  `rendererIdentity`). Pinned here so these tests assert on generation
 *  bookkeeping rather than on the app's current version string. */
const RID = 'r';

class MemoryFrameStore implements FrameBlobStore {
  map = new Map<string, StoredFrame>();
  clears = 0;

  async get(key: string): Promise<StoredFrame | undefined> {
    return this.map.get(key);
  }
  async put(key: string, frame: StoredFrame): Promise<void> {
    this.map.set(key, frame);
  }
  async delete(keys: ReadonlyArray<string>): Promise<void> {
    for (const k of keys) this.map.delete(k);
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
  async clear(): Promise<void> {
    this.clears++;
    this.map.clear();
  }
}

/** A canvas stand-in — the tier only ever reads width/height and hands the
 *  object to the injected encoder. */
const canvas = (w = 4, h = 4): HTMLCanvasElement => ({ width: w, height: h }) as HTMLCanvasElement;

const blobOf = (bytes: number): Blob => ({ size: bytes }) as Blob;

/** Settle the fire-and-forget write/read chains. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function makeCache(opts: { maxBytes?: number; blobBytes?: number } = {}) {
  const store = new MemoryFrameStore();
  const cache = new FrameDiskCache({
    store,
    identity: () => RID,
    maxBytes: opts.maxBytes ?? 1000,
    encode: async () => blobOf(opts.blobBytes ?? 100),
    decode: async () => ({ width: 4, height: 4 }) as DecodedFrame,
  });
  cache.setGeneration('g1');
  return { store, cache };
}

describe('a previous session is never trusted', () => {
  it('open() clears whatever was left on disk', async () => {
    // The invalidation key is built from revision COUNTERS that reset to 0 each
    // launch, so last session's frame 12 and this session's frame 12 can carry
    // the same key and be completely different projects. Purging at open is the
    // whole reason this tier is safe to have at all.
    const store = new MemoryFrameStore();
    await store.put('stale#12', { blob: blobOf(10), bytes: 10 });
    const cache = new FrameDiskCache({ store, identity: () => RID });
    await cache.open();
    expect(store.map.size).toBe(0);
  });

  it('open() is idempotent, so a second call cannot wipe live frames', async () => {
    const { store, cache } = makeCache();
    await cache.open();
    cache.write(1, canvas());
    await flush();
    expect(cache.storedFrames).toBe(1);
    await cache.open();
    expect(store.map.size).toBe(1);
  });
});

describe('storing frames', () => {
  it('writes a frame and reports it held', async () => {
    const { store, cache } = makeCache();
    cache.write(3, canvas());
    await flush();
    expect(cache.has(3)).toBe(true);
    expect(cache.storedFrames).toBe(1);
    expect([...store.map.keys()]).toEqual([`${RID}~g1#3`]);
  });

  it('does not re-encode a frame it already holds', async () => {
    const store = new MemoryFrameStore();
    let encodes = 0;
    const cache = new FrameDiskCache({
      store,
      identity: () => RID,
      encode: async () => { encodes++; return blobOf(10); },
    });
    cache.setGeneration('g1');
    cache.write(1, canvas());
    await flush();
    cache.write(1, canvas());
    await flush();
    expect(encodes).toBe(1);
  });

  it('refuses a degenerate canvas', async () => {
    const { cache } = makeCache();
    cache.write(1, canvas(0, 0));
    await flush();
    expect(cache.storedFrames).toBe(0);
  });

  it('does nothing at all before a generation is set', async () => {
    const store = new MemoryFrameStore();
    const cache = new FrameDiskCache({ store, identity: () => RID, encode: async () => blobOf(10) });
    cache.write(1, canvas());
    await flush();
    expect(store.map.size).toBe(0);
  });
});

describe('the byte budget', () => {
  it('evicts the least recently used frame past the budget', async () => {
    const { cache } = makeCache({ maxBytes: 250, blobBytes: 100 });
    for (const f of [1, 2, 3]) {
      cache.write(f, canvas());
      await flush();
    }
    // 3 × 100 = 300 > 250, so the oldest goes.
    expect(cache.storedBytes).toBe(200);
    expect(cache.has(1)).toBe(false);
    expect(cache.has(2)).toBe(true);
    expect(cache.has(3)).toBe(true);
  });

  it('deletes evicted frames from the store, not just the index', async () => {
    // An index that forgets a frame the store still holds is a leak that grows
    // until the quota kills the cache entirely.
    const { store, cache } = makeCache({ maxBytes: 150, blobBytes: 100 });
    cache.write(1, canvas());
    await flush();
    cache.write(2, canvas());
    await flush();
    expect([...store.map.keys()]).toEqual([`${RID}~g1#2`]);
  });

  it('a read moves a frame to the back of the eviction queue', async () => {
    const { cache } = makeCache({ maxBytes: 250, blobBytes: 100 });
    for (const f of [1, 2] as const) {
      cache.write(f, canvas());
      await flush();
    }
    // Reach frame 1 through the look-ahead, so it is no longer the oldest…
    cache.prefetch(0, () => false, () => {}, 1);
    await flush();
    cache.write(3, canvas());
    await flush();
    expect(cache.has(1)).toBe(true);
    expect(cache.has(2)).toBe(false);
  });
});

describe('generation turnover', () => {
  it('PARKS the old generation instead of deleting it', async () => {
    // The exchange the content-derived key makes possible: an outgoing
    // generation keeps its blobs, and returns whole if its key comes back.
    const { store, cache } = makeCache();
    cache.write(1, canvas());
    await flush();
    cache.setGeneration('g2');
    expect(cache.has(1)).toBe(false);       // not servable under g2…
    expect(cache.storedBytes).toBe(0);
    expect(cache.retainedGenerations).toBe(1);
    await flush();
    expect(store.map.size).toBe(1);         // …but still on disk.
  });

  it('an undo whose key RETURNS gets its frames back without a render', async () => {
    const { cache } = makeCache();
    cache.write(1, canvas());
    cache.write(2, canvas());
    await flush();
    cache.setGeneration('g2');              // the edit
    expect(cache.has(1)).toBe(false);
    cache.setGeneration('g1');              // the undo — same content hash
    expect(cache.has(1)).toBe(true);
    expect(cache.has(2)).toBe(true);
    // g2 held no frames, and an EMPTY generation is not parked — parking it
    // would be bookkeeping for nothing and would count against the cap.
    expect(cache.retainedGenerations).toBe(0);
  });

  it('setting the SAME generation keeps the frames', async () => {
    // `setKey` runs every frame during playback; turning the cache over on each
    // one would make the tier permanently empty.
    const { cache } = makeCache();
    cache.write(1, canvas());
    await flush();
    cache.setGeneration('g1');
    expect(cache.has(1)).toBe(true);
  });

  it('a frame encoded before an edit is never stored under the new key', async () => {
    // THE race. The encode is async; if the user edits while it is running, the
    // finished blob belongs to the previous scene state. Writing it now would
    // put pre-edit pixels under the post-edit key and the viewport would show
    // the change as not having happened.
    const store = new MemoryFrameStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const cache = new FrameDiskCache({
      store,
      identity: () => RID,
      encode: async () => { await gate; return blobOf(10); },
    });
    cache.setGeneration('g1');
    cache.write(1, canvas());
    cache.setGeneration('g2'); // the edit lands mid-encode
    release();
    await flush();
    expect(store.map.size).toBe(0);
    expect(cache.has(1)).toBe(false);
  });

  it('a frame decoded after an edit is never promoted', async () => {
    // Same race on the read side: promoting here would blit a stale frame into
    // the RAM cache, where nothing downstream could tell it was stale.
    const store = new MemoryFrameStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const cache = new FrameDiskCache({
      store,
      identity: () => RID,
      encode: async () => blobOf(10),
      decode: async () => { await gate; return ({ width: 4, height: 4 }) as DecodedFrame; },
    });
    cache.setGeneration('g1');
    cache.write(1, canvas());
    await flush();

    const promoted: number[] = [];
    cache.prefetch(0, () => false, (f) => promoted.push(f), 1);
    cache.setGeneration('g2');
    release();
    await flush();
    expect(promoted).toEqual([]);
  });
});

describe('look-ahead', () => {
  const seed = async (frames: number[]) => {
    const made = makeCache({ maxBytes: 1e9, blobBytes: 10 });
    for (const f of frames) {
      made.cache.write(f, canvas());
      await flush();
    }
    return made;
  };

  it('promotes the frames just ahead of the playhead', async () => {
    const { cache } = await seed([1, 2, 3]);
    const promoted: number[] = [];
    cache.prefetch(0, () => false, (f) => promoted.push(f), 3);
    await flush();
    expect(promoted.sort()).toEqual([1, 2, 3]);
  });

  it('never promotes the CURRENT frame — only what is ahead', async () => {
    // Reading the frame being drawn is pure waste: the render loop has already
    // decided what to do with it by the time the read lands.
    const { cache } = await seed([5]);
    const promoted: number[] = [];
    cache.prefetch(5, () => false, (f) => promoted.push(f), 3);
    await flush();
    expect(promoted).toEqual([]);
  });

  it('skips frames RAM already holds', async () => {
    const { cache } = await seed([1, 2]);
    const promoted: number[] = [];
    cache.prefetch(0, (f) => f === 1, (f) => promoted.push(f), 2);
    await flush();
    expect(promoted).toEqual([2]);
  });

  it('skips frames it does not hold, without touching the store', async () => {
    const { store, cache } = await seed([1]);
    let gets = 0;
    const realGet = store.get.bind(store);
    store.get = async (k) => { gets++; return realGet(k); };
    cache.prefetch(0, () => false, () => {}, 10);
    await flush();
    expect(gets).toBe(1);
  });

  it('dedupes in-flight reads across repeated calls', async () => {
    // `prefetch` runs on EVERY rendered frame, so the same window is requested
    // dozens of times a second. Without the guard each one queues another read
    // and another decode of the identical frame.
    const store = new MemoryFrameStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let decodes = 0;
    const cache = new FrameDiskCache({
      store,
      identity: () => RID,
      encode: async () => blobOf(10),
      decode: async () => { decodes++; await gate; return ({ width: 4, height: 4 }) as DecodedFrame; },
    });
    cache.setGeneration('g1');
    cache.write(1, canvas());
    await flush();

    for (let i = 0; i < 5; i++) cache.prefetch(0, () => false, () => {}, 1);
    release();
    await flush();
    expect(decodes).toBe(1);
  });

  it('caps concurrent reads so decoding cannot starve the renderer', async () => {
    const store = new MemoryFrameStore();
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const cache = new FrameDiskCache({
      store,
      identity: () => RID,
      encode: async () => blobOf(10),
      decode: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await gate;
        inFlight--;
        return ({ width: 4, height: 4 }) as DecodedFrame;
      },
    });
    cache.setGeneration('g1');
    for (let f = 1; f <= 12; f++) {
      cache.write(f, canvas());
      await flush();
    }
    cache.prefetch(0, () => false, () => {}, 12);
    await Promise.resolve();
    release();
    await flush();
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe('ranges', () => {
  it('merges contiguous frames into spans in seconds', async () => {
    const { cache } = makeCache({ maxBytes: 1e9, blobBytes: 10 });
    for (const f of [0, 1, 2, 7, 8]) {
      cache.write(f, canvas());
      await flush();
    }
    expect(cache.ranges(10)).toEqual([
      { start: 0, end: 0.3 },
      { start: 0.7, end: 0.9 },
    ]);
  });

  it('is empty for a nonsense fps rather than dividing by zero', async () => {
    const { cache } = await (async () => {
      const m = makeCache();
      m.cache.write(1, canvas());
      await flush();
      return m;
    })();
    expect(cache.ranges(0)).toEqual([]);
  });
});

describe('purge', () => {
  it('drops the index and the store together', async () => {
    const { store, cache } = makeCache();
    cache.write(1, canvas());
    await flush();
    await cache.purge();
    expect(cache.storedFrames).toBe(0);
    expect(cache.storedBytes).toBe(0);
    expect(store.map.size).toBe(0);
  });
});
