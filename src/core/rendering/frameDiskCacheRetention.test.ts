/**
 * Cross-session retention: the manifest, the reconcile, and the caps.
 *
 * The store here IMPLEMENTS the manifest API, unlike the one in
 * `frameDiskCache.test.ts` — that split is deliberate, because the cache
 * promises different things in each case: with a manifest it may adopt what a
 * previous session left; without one it must purge, since it cannot know what
 * the blobs weigh without reading them all.
 *
 * The dangerous failures here are quiet growth (a cap that never fires, and
 * the cache swells until the browser quota kills it wholesale) and false
 * adoption (trusting a manifest row whose blob is gone, which turns into a
 * prefetch that never lands).
 */

import { FrameDiskCache, type DecodedFrame } from './frameDiskCache';
import type { FrameBlobStore, StoredFrame } from './frameBlobStore';

class ManifestFrameStore implements FrameBlobStore {
  map = new Map<string, StoredFrame>();
  manifest: string | null = null;
  manifestWrites = 0;

  async get(key: string): Promise<StoredFrame | undefined> { return this.map.get(key); }
  async put(key: string, frame: StoredFrame): Promise<void> { this.map.set(key, frame); }
  async delete(keys: ReadonlyArray<string>): Promise<void> { for (const k of keys) this.map.delete(k); }
  async keys(): Promise<string[]> { return [...this.map.keys()]; }
  async clear(): Promise<void> { this.map.clear(); this.manifest = null; }
  async readManifest(): Promise<string | null> { return this.manifest; }
  async writeManifest(json: string): Promise<void> { this.manifest = json; this.manifestWrites++; }
}

const canvas = (w = 4, h = 4): HTMLCanvasElement => ({ width: w, height: h }) as HTMLCanvasElement;
const blobOf = (bytes: number): Blob => ({ size: bytes }) as Blob;
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function makeCache(store: ManifestFrameStore, opts: { maxBytes?: number; maxGenerations?: number; blobBytes?: number } = {}) {
  return new FrameDiskCache({
    store,
    maxBytes: opts.maxBytes ?? 10_000,
    maxGenerations: opts.maxGenerations ?? 4,
    encode: async () => blobOf(opts.blobBytes ?? 100),
    decode: async () => ({ width: 4, height: 4 }) as DecodedFrame,
  });
}

/** One session: open, write frames under `gen`, flush so the manifest lands. */
async function session(store: ManifestFrameStore, gen: string, frames: number[]): Promise<void> {
  const cache = makeCache(store);
  await cache.open();
  cache.setGeneration(gen);
  for (const f of frames) {
    cache.write(f, canvas());
    await flush();
  }
  await flush();
}

describe('surviving a restart', () => {
  it('a new cache instance adopts the previous session and serves it warm', async () => {
    const store = new ManifestFrameStore();
    await session(store, 'projectA', [1, 2, 3]);

    // "Restart": a fresh instance over the same store — as createViewportDiskCache
    // would produce on the next launch.
    const next = makeCache(store);
    await next.open();
    expect(next.retainedGenerations).toBe(1);

    // The reloaded project hashes to the same key → warm from the first frame.
    next.setGeneration('projectA');
    expect(next.has(1)).toBe(true);
    expect(next.has(3)).toBe(true);
    expect(next.storedFrames).toBe(3);
  });

  it('a DIFFERENT project cannot see the parked frames', async () => {
    const store = new ManifestFrameStore();
    await session(store, 'projectA', [1, 2]);
    const next = makeCache(store);
    await next.open();
    next.setGeneration('projectB');
    expect(next.has(1)).toBe(false);
    expect(next.storedFrames).toBe(0);
    // …but projectA's frames are still parked, not destroyed.
    expect(next.retainedGenerations).toBe(1);
  });

  it('adopted bytes COUNT against the budget', async () => {
    // The growth failure: a session inherits 9 generations "for free", writes
    // its own, and the quota kills everything. Adopted frames must be paid for.
    const store = new ManifestFrameStore();
    await session(store, 'old', [1, 2, 3]); // 300 bytes
    const next = makeCache(store, { maxBytes: 350, blobBytes: 100 });
    await next.open();
    next.setGeneration('new');
    next.write(1, canvas());
    await flush();
    next.write(2, canvas());
    await flush();
    // 300 parked + 200 live > 350 → the parked generation went, wholesale.
    expect(next.retainedGenerations).toBe(0);
    expect(next.totalBytes).toBeLessThanOrEqual(350);
    expect(store.map.size).toBe(2);
  });
});

describe('the reconcile', () => {
  it('deletes orphan blobs the manifest does not account for', async () => {
    const store = new ManifestFrameStore();
    await session(store, 'g', [1]);
    // A write that landed after the last manifest flush — unaccounted bytes.
    await store.put('g#99', { blob: blobOf(100), bytes: 100 });
    const next = makeCache(store);
    await next.open();
    expect(store.map.has('g#99')).toBe(false);
    expect(store.map.has('g#1')).toBe(true);
  });

  it('drops manifest rows whose blob is gone, rather than promising them', async () => {
    // Trusting the row would turn into a prefetch that never lands — `has()`
    // says yes, the read finds nothing, forever.
    const store = new ManifestFrameStore();
    await session(store, 'g', [1, 2]);
    store.map.delete('g#2');
    const next = makeCache(store);
    await next.open();
    next.setGeneration('g');
    expect(next.has(1)).toBe(true);
    expect(next.has(2)).toBe(false);
  });

  it('treats a corrupt manifest as no manifest: cold cache, not a wrong one', async () => {
    const store = new ManifestFrameStore();
    await session(store, 'g', [1]);
    store.manifest = '{not json';
    const next = makeCache(store);
    await next.open();
    expect(store.map.size).toBe(0);
    next.setGeneration('g');
    expect(next.has(1)).toBe(false);
  });

  it('treats a FUTURE manifest version the same way', async () => {
    const store = new ManifestFrameStore();
    await session(store, 'g', [1]);
    store.manifest = JSON.stringify({ v: 2, whatever: [] });
    const next = makeCache(store);
    await next.open();
    expect(store.map.size).toBe(0);
  });
});

describe('the caps', () => {
  it('keeps at most maxGenerations − 1 parked, oldest dropped first', async () => {
    const store = new ManifestFrameStore();
    const cache = makeCache(store, { maxGenerations: 3 });
    await cache.open();
    for (const g of ['g1', 'g2', 'g3', 'g4']) {
      cache.setGeneration(g);
      cache.write(1, canvas());
      await flush();
    }
    // Live g4 + two parked; g1 (the oldest) is gone from disk too.
    expect(cache.retainedGenerations).toBe(2);
    expect(store.map.has('g1#1')).toBe(false);
    expect(store.map.has('g3#1')).toBe(true);
  });

  it('parked generations are evicted before the LIVE one sheds a frame', async () => {
    const store = new ManifestFrameStore();
    const cache = makeCache(store, { maxBytes: 250, blobBytes: 100 });
    await cache.open();
    cache.setGeneration('g1');
    cache.write(1, canvas());
    await flush();
    cache.setGeneration('g2');
    for (const f of [1, 2]) {
      cache.write(f, canvas());
      await flush();
    }
    // 100 parked + 200 live ≤ 250 would be false (300) → park went first; the
    // live generation keeps both frames.
    expect(cache.retainedGenerations).toBe(0);
    expect(cache.storedFrames).toBe(2);
  });

  it('the manifest reflects evictions, so the next session cannot resurrect them', async () => {
    const store = new ManifestFrameStore();
    const cache = makeCache(store, { maxGenerations: 2 });
    await cache.open();
    for (const g of ['g1', 'g2', 'g3']) {
      cache.setGeneration(g);
      cache.write(1, canvas());
      await flush();
    }
    await flush();
    const manifest = JSON.parse(store.manifest!) as { gens: Array<{ id: string }> };
    expect(manifest.gens.map((g) => g.id)).not.toContain('g1');
  });
});

describe('manifest hygiene', () => {
  it('coalesces writes — a burst of frames is one manifest write, not one each', async () => {
    const store = new ManifestFrameStore();
    const cache = makeCache(store);
    await cache.open();
    cache.setGeneration('g');
    const before = store.manifestWrites;
    for (const f of [1, 2, 3, 4, 5]) cache.write(f, canvas());
    await flush();
    // 5 encodes land in the same turn; the persist is scheduled once per turn.
    expect(store.manifestWrites - before).toBeLessThanOrEqual(2);
  });

  it('purge removes the manifest with the blobs', async () => {
    const store = new ManifestFrameStore();
    const cache = makeCache(store);
    await cache.open();
    cache.setGeneration('g');
    cache.write(1, canvas());
    await flush();
    await cache.purge();
    expect(store.manifest).toBeNull();
    expect(store.map.size).toBe(0);
    expect(cache.totalBytes).toBe(0);
  });
});
