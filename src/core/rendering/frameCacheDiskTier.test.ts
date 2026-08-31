/**
 * The seam between the RAM cache and the disk tier.
 *
 * `frameDiskCache.test.ts` covers the tier's own policy. What is asserted here
 * is the contract BETWEEN them, which is where the design can quietly fail:
 *
 *  • `get` stays synchronous. The render loop blits or re-renders in the same
 *    tick, so if attaching a disk tier ever made a hit await anything, playback
 *    would stutter on exactly the comps this is meant to help.
 *  • A promoted frame must not be written back. It came FROM the store; the
 *    round trip would re-encode it forever.
 *  • The tier turns over with the RAM key, or it serves pre-edit pixels.
 */

import { FrameCache } from './frameCache';
import { FrameDiskCache, type DecodedFrame } from './frameDiskCache';
import type { FrameBlobStore, StoredFrame } from './frameBlobStore';

/** Generation ids are namespaced by the renderer that wrote them (see
 *  `rendererIdentity`). Pinned here so these tests assert on generation
 *  bookkeeping rather than on the app's current version string. */
const RID = 'r';

class MemoryFrameStore implements FrameBlobStore {
  map = new Map<string, StoredFrame>();
  async get(key: string): Promise<StoredFrame | undefined> { return this.map.get(key); }
  async put(key: string, frame: StoredFrame): Promise<void> { this.map.set(key, frame); }
  async delete(keys: ReadonlyArray<string>): Promise<void> { for (const k of keys) this.map.delete(k); }
  async keys(): Promise<string[]> { return [...this.map.keys()]; }
  async clear(): Promise<void> { this.map.clear(); }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function sourceCanvas(w = 4, h = 4): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function setup(opts: { encodes?: () => void } = {}) {
  const store = new MemoryFrameStore();
  const disk = new FrameDiskCache({
    store,
    identity: () => RID,
    maxBytes: 1e9,
    encode: async () => { opts.encodes?.(); return ({ size: 10 }) as Blob; },
    decode: async () => sourceCanvas() as DecodedFrame,
  });
  const ram = new FrameCache(1024 * 1024);
  ram.attachDisk(disk);
  ram.setKey('k1', 4, 4);
  return { store, disk, ram };
}

describe('write-through', () => {
  it('a put reaches the disk tier', async () => {
    const { store, ram } = setup();
    ram.put(1, sourceCanvas());
    await flush();
    expect([...store.map.keys()]).toEqual([`${RID}~k1#1`]);
  });

  it('the RAM cache still works with no disk attached', () => {
    // The web edition and every existing test get exactly the old object.
    const ram = new FrameCache(1024 * 1024);
    ram.setKey('k', 4, 4);
    ram.put(1, sourceCanvas());
    expect(ram.get(1)).not.toBeNull();
    expect(ram.diskRanges(30)).toEqual([]);
  });
});

describe('get stays synchronous', () => {
  it('returns the cached canvas in the same tick', () => {
    const { ram } = setup();
    ram.put(1, sourceCanvas());
    // No await between the put and the get: a hit must not depend on any
    // promise the disk tier started.
    expect(ram.get(1)).not.toBeNull();
  });

  it('returns null on a miss rather than waiting for the store', async () => {
    const { disk, ram } = setup();
    disk.write(9, sourceCanvas());
    await flush();
    // Frame 9 is on disk but not in RAM. `get` must not stall or resolve it.
    expect(ram.get(9)).toBeNull();
  });
});

describe('promotion', () => {
  it('a look-ahead read lands in RAM, so the next pass is a hit', async () => {
    const { disk, ram } = setup();
    disk.write(5, sourceCanvas());
    await flush();
    expect(ram.get(5)).toBeNull();

    // Frame 4 is on screen; the look-ahead pulls 5 in behind it.
    ram.get(4);
    await flush();
    expect(ram.get(5)).not.toBeNull();
  });

  it('a promoted frame is NOT re-encoded back to disk', async () => {
    let encodes = 0;
    const { disk, ram } = setup({ encodes: () => { encodes++; } });
    disk.write(5, sourceCanvas());
    await flush();
    expect(encodes).toBe(1);

    ram.get(4); // promotes 5
    await flush();
    expect(ram.get(5)).not.toBeNull();
    await flush();
    expect(encodes).toBe(1);
  });
});

describe('invalidation', () => {
  it('a new key turns the disk tier over: nothing served, blobs PARKED', async () => {
    const { store, ram } = setup();
    ram.put(1, sourceCanvas());
    await flush();
    expect(store.map.size).toBe(1);

    ram.setKey('k2', 4, 4);
    await flush();
    // The bar and the servable set are empty under the new key — that is the
    // correctness half. The blob stays parked on disk, waiting for k1's
    // content hash to return (an undo), which is the retention half.
    expect(ram.diskRanges(30)).toEqual([]);
    expect(store.map.size).toBe(1);
  });

  it('the OLD key returning serves its frames again — the undo path', async () => {
    const { ram } = setup();
    ram.put(1, sourceCanvas());
    await flush();
    ram.setKey('k2', 4, 4);
    expect(ram.diskRanges(30)).toEqual([]);
    ram.setKey('k1', 4, 4);
    expect(ram.diskRanges(30)).toEqual([{ start: 1 / 30, end: 2 / 30 }]);
  });

  it('a density-only resize keeps the disk generation; a key change turns it over', async () => {
    // Size no longer joins the invalidation (adaptive-resolution flips must
    // not wipe the preview — see frameCache.setKey); the KEY still does.
    const { ram } = setup();
    ram.put(1, sourceCanvas());
    await flush();
    ram.setKey('k1', 8, 8);
    await flush();
    expect(ram.diskRanges(30)).not.toEqual([]);
    ram.setKey('k2', 8, 8);
    await flush();
    expect(ram.diskRanges(30)).toEqual([]);
  });

  it('attaching a disk tier adopts the key already in force', async () => {
    // Attach happens at boot, `setKey` every frame — if attach did not adopt
    // the current key the tier would sit generation-less until the next edit
    // and silently store nothing.
    const store = new MemoryFrameStore();
    const disk = new FrameDiskCache({ store, identity: () => RID, encode: async () => ({ size: 10 }) as Blob });
    const ram = new FrameCache(1024 * 1024);
    ram.setKey('k1', 4, 4);
    ram.attachDisk(disk);
    ram.put(1, sourceCanvas());
    await flush();
    expect([...store.map.keys()]).toEqual([`${RID}~k1#1`]);
  });
});

describe('the cache bar', () => {
  it('reports disk spans separately from RAM spans', async () => {
    const { ram } = setup();
    ram.put(0, sourceCanvas());
    ram.put(1, sourceCanvas());
    await flush();
    expect(ram.ranges(10)).toEqual([{ start: 0, end: 0.2 }]);
    expect(ram.diskRanges(10)).toEqual([{ start: 0, end: 0.2 }]);
  });
});
