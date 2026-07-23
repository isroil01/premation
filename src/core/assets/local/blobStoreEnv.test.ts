/**
 * VirtualBlobStore binary round-trip + asset registry persistence.
 * (The desktop ElectronBlobStore / disk IPC is verified on-device.)
 */

import { VirtualBlobStore } from './blobStoreEnv';
import { loadAssetRegistry, saveAssetRegistry, importAssetToBundle } from './assetBundleIO';
import { AssetRegistry } from './AssetRegistry';
import { MemoryBundleFs } from '@core/project/bundle/BundleFs';
import type { BytesHashFn } from './contentHash';

const ROOT = '/p/My.motion';
const fakeHash: BytesHashFn = async (b) => `h${b.length}_${Array.from(b).join('-')}`;

beforeEach(() => localStorage.clear());

describe('VirtualBlobStore', () => {
  it('stores and reads back exact bytes (base64 round-trip)', async () => {
    const store = new VirtualBlobStore(ROOT);
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await store.put('abc', bytes);
    expect(await store.has('abc')).toBe(true);
    expect(Array.from((await store.read('abc'))!)).toEqual([0, 1, 2, 250, 255]);
    expect(await store.list()).toEqual(['abc']);
    await store.delete('abc');
    expect(await store.has('abc')).toBe(false);
  });

  it('scopes blobs to the bundle root', async () => {
    await new VirtualBlobStore(ROOT).put('x', new Uint8Array([1]));
    expect(await new VirtualBlobStore('/other.motion').list()).toEqual([]);
  });
});

describe('asset registry persistence', () => {
  it('save then load preserves records', async () => {
    const fs = new MemoryBundleFs();
    const reg = new AssetRegistry(new VirtualBlobStore(ROOT), fakeHash);
    await reg.importBytes(new Uint8Array([1, 2, 3]), { name: 'logo.png', mime: 'image/png', width: 32, height: 32 });
    await saveAssetRegistry(fs, ROOT, reg);

    const loaded = await loadAssetRegistry(fs, ROOT, fakeHash);
    expect(loaded.all()).toEqual(reg.all());
    expect(loaded.all()[0]!.name).toBe('logo.png');
  });

  it('importAssetToBundle stores blob + record + registry in one call, deduping', async () => {
    const fs = new MemoryBundleFs();
    const a = await importAssetToBundle(fs, ROOT, new Uint8Array([7, 7]), { name: 'a.png', mime: 'image/png' }, fakeHash);
    const b = await importAssetToBundle(fs, ROOT, new Uint8Array([7, 7]), { name: 'b.png', mime: 'image/png' }, fakeHash);
    expect(b.id).toBe(a.id); // dedup across separate calls (registry reloaded from disk)
    const reg = await loadAssetRegistry(fs, ROOT, fakeHash);
    expect(reg.all()).toHaveLength(1);
    expect(await new VirtualBlobStore(ROOT).has(a.hash)).toBe(true);
  });
});
