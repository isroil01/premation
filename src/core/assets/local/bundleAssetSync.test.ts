/**
 * A bundle carrying its own footage, both ways.
 *
 * The failure this prevents is invisible at the moment it happens: a project
 * saved with footage imported before the bundle existed writes a document that
 * references object URLs and no bytes. It reopens perfectly on the machine that
 * made it — IndexedDB still has everything — and renders black on any other.
 * Nobody finds out until the project has already travelled.
 *
 * So the assertions here are about the two things that make a move survivable:
 * the bytes are IN the bundle, and the ids still line up. Either alone is
 * useless — bytes bound to nothing, or bindings pointing at nothing.
 */

import {
  assetsFromRecords,
  collectAssetsIntoBundle,
  isCollected,
  mimeFor,
  needsCollecting,
  rewriteDocumentSrcs,
  type SyncableAsset,
} from './bundleAssetSync';
import type { AssetRecord } from './blobTypes';
import type { EditorDocument } from '@core/api/cloudDocument';

/** An in-memory bundle FS, so the sync can be exercised without a disk. */
const files = new Map<string, string>();
const blobs = new Map<string, Uint8Array>();

jest.mock('@core/project/bundle/bundleFsEnv', () => ({
  detectBundleFs: () => ({
    read: async (_root: string, name: string) => files.get(name) ?? null,
    writeAtomic: async (_root: string, name: string, contents: string) => { files.set(name, contents); },
    remove: async (_root: string, name: string) => { files.delete(name); },
    list: async () => [...files.keys()],
  }),
}));

jest.mock('./blobStoreEnv', () => ({
  createBlobStore: () => ({
    has: async (hash: string) => blobs.has(hash),
    put: async (hash: string, bytes: Uint8Array) => { blobs.set(hash, bytes); },
    read: async (hash: string) => blobs.get(hash) ?? null,
    delete: async (hash: string) => { blobs.delete(hash); },
    list: async () => [...blobs.keys()],
  }),
}));

const ROOT = '/projects/Promo.motion';

/*
  jsdom has `crypto` but not `crypto.subtle`, and the asset registry
  content-addresses with a real SHA-256 (`contentHash.ts`) — so without this
  every import would throw, be caught as "unreadable", and the suite would pass
  by collecting nothing. Node's WebCrypto is the same algorithm the renderer
  uses, so this tests the real hashing rather than a stand-in.
*/
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', {
      value: (require('node:crypto') as typeof import('node:crypto')).webcrypto,
      configurable: true,
    });
  }
});

const asset = (over: Partial<SyncableAsset> = {}): SyncableAsset => ({
  id: 'asset_local_1',
  name: 'clip.mp4',
  type: 'video',
  src: 'blob:http://localhost/abc',
  size: 4,
  ...over,
});

/** A reader that answers with fixed bytes for any src. */
const bytesReader = (bytes: Uint8Array) => async () => bytes;

beforeEach(() => {
  files.clear();
  blobs.clear();
});

describe('needsCollecting', () => {
  it('collects a session object URL — the one kind that dies', () => {
    expect(needsCollecting('blob:http://localhost/abc')).toBe(true);
  });

  it('leaves an already-collected ref alone', () => {
    expect(needsCollecting('motion-blob:deadbeef')).toBe(false);
    expect(isCollected('motion-blob:deadbeef')).toBe(true);
  });

  it('leaves a durable http src alone', () => {
    // Copying someone else's hosted file into the bundle turns a reference into
    // a copy, which is a licensing decision and not a storage one.
    expect(needsCollecting('https://cdn.example/clip.mp4')).toBe(false);
  });

  it('leaves a data: URL alone, since it already travels in the document', () => {
    expect(needsCollecting('data:image/png;base64,AAA')).toBe(false);
  });

  it('ignores an empty src', () => {
    expect(needsCollecting('  ')).toBe(false);
  });
});

describe('mimeFor', () => {
  it('reads the extension', () => {
    expect(mimeFor(asset({ name: 'shot.mov' }))).toBe('video/quicktime');
    expect(mimeFor(asset({ name: 'logo.PNG', type: 'image' }))).toBe('image/png');
  });

  it('falls back to the coarse kind rather than octet-stream', () => {
    // `application/octet-stream` would classify the record as 'other' and hide
    // it from every media picker.
    expect(mimeFor(asset({ name: 'no-extension', type: 'audio' }))).toBe('audio/*');
  });
});

describe('collectAssetsIntoBundle', () => {
  it('writes the bytes into the bundle', async () => {
    const result = await collectAssetsIntoBundle(ROOT, [asset()], bytesReader(new Uint8Array([1, 2, 3, 4])));

    expect(result.collected).toEqual(['asset_local_1']);
    expect(blobs.size).toBe(1);
  });

  it('KEEPS the asset id, so the document still binds to it', async () => {
    // A fresh hash-derived id would leave the bytes safely stored and every
    // layer using them orphaned — worse than not storing them.
    await collectAssetsIntoBundle(ROOT, [asset()], bytesReader(new Uint8Array([1, 2, 3, 4])));

    const registry = JSON.parse(files.get('assets/registry.json') as string) as { assets: AssetRecord[] };
    expect(registry.assets[0]?.id).toBe('asset_local_1');
  });

  it('hands back a motion-blob src per collected id', async () => {
    const result = await collectAssetsIntoBundle(ROOT, [asset()], bytesReader(new Uint8Array([1, 2, 3, 4])));
    expect(result.srcById.get('asset_local_1')).toMatch(/^motion-blob:[0-9a-f]+$/);
  });

  it('skips assets already in the bundle', async () => {
    const result = await collectAssetsIntoBundle(
      ROOT,
      [asset({ src: 'motion-blob:abc' })],
      bytesReader(new Uint8Array([1])),
    );
    expect(result.collected).toEqual([]);
    expect(result.alreadyLocal).toBe(1);
    expect(blobs.size).toBe(0);
  });

  it('records an unreadable asset without failing the rest', async () => {
    // One dead object URL from a previous session must not fail a save that
    // would otherwise store everything else.
    const reader = async (src: string) => (src.endsWith('dead') ? null : new Uint8Array([9]));
    const result = await collectAssetsIntoBundle(
      ROOT,
      [asset({ id: 'good', src: 'blob:live' }), asset({ id: 'bad', src: 'blob:dead' })],
      reader,
    );

    expect(result.collected).toEqual(['good']);
    expect(result.unreadable).toEqual(['bad']);
  });

  it('writes the registry ONCE for a whole pass', async () => {
    let writes = 0;
    const original = files.set.bind(files);
    files.set = ((k: string, v: string) => { if (k === 'assets/registry.json') writes += 1; return original(k, v); }) as never;

    await collectAssetsIntoBundle(
      ROOT,
      [asset({ id: 'a', src: 'blob:a' }), asset({ id: 'b', src: 'blob:b' }), asset({ id: 'c', src: 'blob:c' })],
      async (src) => new Uint8Array([src.charCodeAt(src.length - 1)]),
    );

    expect(writes).toBe(1);
    files.set = original as never;
  });

  it('does nothing at all when there is nothing to collect', async () => {
    const result = await collectAssetsIntoBundle(ROOT, [], bytesReader(new Uint8Array([1])));
    expect(result.collected).toEqual([]);
    expect(files.size).toBe(0);
  });

  it('dedups identical bytes to one blob', async () => {
    await collectAssetsIntoBundle(
      ROOT,
      [asset({ id: 'a', src: 'blob:a' }), asset({ id: 'b', src: 'blob:b' })],
      bytesReader(new Uint8Array([7, 7, 7])),
    );
    expect(blobs.size).toBe(1);
  });
});

describe('rewriteDocumentSrcs', () => {
  const doc = (): EditorDocument => ({
    version: '1.1.0',
    scene: {
      version: '1.0.0',
      nodes: [
        {
          id: 'n1',
          children: [],
          transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
          components: [
            { id: 'c1', type: 'Transform', props: { assetId: 'a1', src: 'blob:dead' } },
            { id: 'c2', type: 'Audio', props: { __assetId: 'a2', __src: 'blob:dead' } },
          ],
        },
      ],
    },
    animation: { tracks: {}, expressions: {} },
  } as unknown as EditorDocument);

  it('repoints a picture layer', () => {
    const d = doc();
    rewriteDocumentSrcs(d, new Map([['a1', 'motion-blob:aaa']]));
    expect((d.scene.nodes[0]!.components[0]!.props as Record<string, unknown>).src).toBe('motion-blob:aaa');
  });

  it('repoints an audio layer through its __-prefixed pair', () => {
    const d = doc();
    rewriteDocumentSrcs(d, new Map([['a2', 'motion-blob:bbb']]));
    expect((d.scene.nodes[0]!.components[1]!.props as Record<string, unknown>).__src).toBe('motion-blob:bbb');
  });

  it('leaves a component whose asset was not collected', () => {
    const d = doc();
    expect(rewriteDocumentSrcs(d, new Map([['other', 'motion-blob:ccc']]))).toBe(0);
    expect((d.scene.nodes[0]!.components[0]!.props as Record<string, unknown>).src).toBe('blob:dead');
  });

  it('reports how many it fixed', () => {
    const d = doc();
    expect(rewriteDocumentSrcs(d, new Map([['a1', 'motion-blob:aaa'], ['a2', 'motion-blob:bbb']]))).toBe(2);
  });
});

describe('assetsFromRecords', () => {
  const record = (over: Partial<AssetRecord> = {}): AssetRecord => ({
    id: 'asset_abc',
    hash: 'abc123',
    name: 'clip.mp4',
    type: 'video',
    mime: 'video/mp4',
    size: 100,
    ...over,
  });

  it('turns a record into a library entry pointing at the bundle', () => {
    expect(assetsFromRecords([record()])).toEqual([
      { id: 'asset_abc', name: 'clip.mp4', type: 'video', src: 'motion-blob:abc123', size: 100 },
    ]);
  });

  it('carries intrinsic size and duration', () => {
    const [entry] = assetsFromRecords([record({ width: 1920, height: 1080, duration: 12 })]);
    expect(entry?.metadata).toEqual({ width: 1920, height: 1080, duration: 12 });
  });

  it('skips kinds the library cannot show', () => {
    // A font or JSON record is a real bundle asset but not a media entry, and a
    // card for it in the Assets panel would open nothing.
    expect(assetsFromRecords([record({ type: 'font' }), record({ type: 'json' })])).toEqual([]);
  });

  it('keeps the record id, which is what layers bind to', () => {
    expect(assetsFromRecords([record({ id: 'asset_from_doc' })])[0]?.id).toBe('asset_from_doc');
  });
});
