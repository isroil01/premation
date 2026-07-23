/**
 * Content-addressed asset registry: import, dedup, serialize, GC.
 *
 * Uses a deterministic injected hasher so the dedup/GC logic is tested without
 * depending on WebCrypto availability; a separate guarded case exercises the
 * real `sha256Hex` when the environment provides `crypto.subtle`.
 */

import { AssetRegistry } from './AssetRegistry';
import { MemoryBlobStore, blobPathFor } from './BlobStore';
import { inferAssetType } from './blobTypes';
import { sha256Hex } from './contentHash';
import type { BytesHashFn } from './contentHash';

/** Deterministic content hash for tests: same bytes → same hash. */
const fakeHash: BytesHashFn = async (bytes) => `h${bytes.length}_${Array.from(bytes).join('-')}`;

const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);

describe('importBytes + dedup', () => {
  it('stores the blob and returns a stable, hash-derived record', async () => {
    const blobs = new MemoryBlobStore();
    const reg = new AssetRegistry(blobs, fakeHash);
    const rec = await reg.importBytes(bytes(1, 2, 3), { name: 'logo.png', mime: 'image/png', width: 64, height: 64 });

    expect(rec.id).toMatch(/^asset_/);
    expect(rec.type).toBe('image');
    expect(rec.size).toBe(3);
    expect(rec.width).toBe(64);
    expect(await blobs.has(rec.hash)).toBe(true);
    expect(blobPathFor(rec.hash)).toContain('blobs/');
  });

  it('re-importing identical bytes writes no new blob and reuses the record', async () => {
    const blobs = new MemoryBlobStore();
    const reg = new AssetRegistry(blobs, fakeHash);
    const a = await reg.importBytes(bytes(9, 9), { name: 'a.png', mime: 'image/png' });
    const b = await reg.importBytes(bytes(9, 9), { name: 'again.png', mime: 'image/png' });

    expect(b.id).toBe(a.id);
    expect(blobs.putCount).toBe(1); // stored once
    expect(reg.all()).toHaveLength(1);
  });

  it('distinct content yields distinct assets and blobs', async () => {
    const blobs = new MemoryBlobStore();
    const reg = new AssetRegistry(blobs, fakeHash);
    const a = await reg.importBytes(bytes(1), { name: 'a', mime: 'image/png' });
    const b = await reg.importBytes(bytes(2), { name: 'b', mime: 'video/mp4' });

    expect(a.id).not.toBe(b.id);
    expect(b.type).toBe('video');
    expect((await blobs.list()).length).toBe(2);
  });
});

describe('serialize round-trip', () => {
  it('fromJSON(toJSON) preserves records', async () => {
    const blobs = new MemoryBlobStore();
    const reg = new AssetRegistry(blobs, fakeHash);
    await reg.importBytes(bytes(1, 2), { name: 'x', mime: 'audio/mp3', duration: 3 });
    const restored = AssetRegistry.fromJSON(reg.toJSON(), blobs, fakeHash);
    expect(restored.all()).toEqual(reg.all());
    expect(restored.all()[0]!.type).toBe('audio');
  });
});

describe('gc', () => {
  it('drops unreferenced records and deletes their orphaned blobs', async () => {
    const blobs = new MemoryBlobStore();
    const reg = new AssetRegistry(blobs, fakeHash);
    const keep = await reg.importBytes(bytes(1), { name: 'keep', mime: 'image/png' });
    const drop = await reg.importBytes(bytes(2), { name: 'drop', mime: 'image/png' });

    const deleted = await reg.gc(new Set([keep.id]));

    expect(deleted).toEqual([drop.hash]);
    expect(reg.get(drop.id)).toBeNull();
    expect(reg.get(keep.id)).not.toBeNull();
    expect(await blobs.has(keep.hash)).toBe(true);
    expect(await blobs.has(drop.hash)).toBe(false);
  });
});

describe('inferAssetType', () => {
  it('maps common MIME families', () => {
    expect(inferAssetType('image/png')).toBe('image');
    expect(inferAssetType('video/mp4')).toBe('video');
    expect(inferAssetType('audio/wav')).toBe('audio');
    expect(inferAssetType('application/json')).toBe('json');
    expect(inferAssetType('font/woff2')).toBe('font');
    expect(inferAssetType('application/octet-stream')).toBe('other');
  });
});

describe('sha256Hex (when WebCrypto is available)', () => {
  const maybe = globalThis.crypto?.subtle ? it : it.skip;
  maybe('hashes deterministically and dedups real bytes', async () => {
    const blobs = new MemoryBlobStore();
    const reg = new AssetRegistry(blobs, sha256Hex);
    const a = await reg.importBytes(bytes(1, 2, 3, 4), { name: 'a', mime: 'image/png' });
    const b = await reg.importBytes(bytes(1, 2, 3, 4), { name: 'b', mime: 'image/png' });
    expect(a.hash).toHaveLength(64);
    expect(b.id).toBe(a.id);
    expect(blobs.putCount).toBe(1);
  });
});
