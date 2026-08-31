/**
 * A frame must not outlive the renderer that made it.
 *
 * The disk tier survives a restart: a manifest is reconciled at launch,
 * surviving generations are parked, and when the project reloads to the same
 * content hash they are served immediately. The content hash names the
 * DOCUMENT, so before this the answer to "did the code that renders change?"
 * was not asked at all — upgrade the app and last week's pixels came back
 * wearing this week's cache bar.
 *
 * These tests are about that one property, so they drive the identity directly
 * rather than trying to simulate an upgrade.
 */

import { FrameDiskCache, type DecodedFrame } from './frameDiskCache';
import type { FrameBlobStore, StoredFrame } from './frameBlobStore';
import {
  rendererIdentity,
  pluginEffectFingerprint,
  setDevRendererBuild,
} from './rendererIdentity';
import { registeredEffects } from '@core/plugins/pluginEffects';

class ManifestStore implements FrameBlobStore {
  map = new Map<string, StoredFrame>();
  manifest: string | null = null;
  async get(key: string): Promise<StoredFrame | undefined> { return this.map.get(key); }
  async put(key: string, frame: StoredFrame): Promise<void> { this.map.set(key, frame); }
  async delete(keys: ReadonlyArray<string>): Promise<void> { for (const k of keys) this.map.delete(k); }
  async keys(): Promise<string[]> { return [...this.map.keys()]; }
  async clear(): Promise<void> { this.map.clear(); this.manifest = null; }
  async readManifest(): Promise<string | null> { return this.manifest; }
  async writeManifest(json: string): Promise<void> { this.manifest = json; }
}

const canvas = (): HTMLCanvasElement => ({ width: 4, height: 4 }) as HTMLCanvasElement;
const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function cacheFor(store: ManifestStore, identity: string): FrameDiskCache {
  return new FrameDiskCache({
    store,
    identity: () => identity,
    encode: async () => ({ size: 100 }) as Blob,
    decode: async () => ({ width: 4, height: 4 }) as DecodedFrame,
  });
}

/** One app run: open, cache three frames under `key`, shut down cleanly. */
async function session(store: ManifestStore, identity: string, key: string): Promise<FrameDiskCache> {
  const cache = cacheFor(store, identity);
  await cache.open();
  cache.setGeneration(key);
  for (const f of [1, 2, 3]) {
    cache.write(f, canvas());
    await flush();
  }
  await flush();
  cache.flushManifest();
  await flush();
  return cache;
}

afterEach(() => setDevRendererBuild(false));

describe('a build only ever reads its own frames', () => {
  it('the SAME build reopens the project warm — the feature still works', async () => {
    const store = new ManifestStore();
    await session(store, 'v1', 'doc-hash');

    const next = cacheFor(store, 'v1');
    await next.open();
    next.setGeneration('doc-hash');
    // Same renderer, same document: this is the whole point of retention.
    expect(next.has(1)).toBe(true);
    expect(next.has(3)).toBe(true);
  });

  it('a DIFFERENT build does not adopt them, even at the same document hash', async () => {
    const store = new ManifestStore();
    await session(store, 'v1', 'doc-hash');
    expect(store.map.size).toBeGreaterThan(0);

    // The upgrade. Same project, same content hash, different renderer.
    const upgraded = cacheFor(store, 'v2');
    await upgraded.open();
    upgraded.setGeneration('doc-hash');

    // Before the namespace this returned true and blitted the old build's pixels.
    expect(upgraded.has(1)).toBe(false);
    expect(upgraded.has(2)).toBe(false);
    expect(upgraded.has(3)).toBe(false);
  });

  it('drops the other build’s generations at open rather than parking them', async () => {
    const store = new ManifestStore();
    await session(store, 'v1', 'doc-hash');

    const upgraded = cacheFor(store, 'v2');
    await upgraded.open();
    // Not merely unreachable — GONE. Parking a generation no key can ever name
    // would hold budget and show up in the size readout as cache the user does
    // not actually have.
    expect(upgraded.retainedGenerations).toBe(0);
    expect(upgraded.totalBytes).toBe(0);
  });

  it('keeps the old build’s frames out of the way of the new build’s', async () => {
    const store = new ManifestStore();
    await session(store, 'v1', 'doc-hash');
    const upgraded = await session(store, 'v2', 'doc-hash');
    // v2 wrote its own three frames under its own namespace and serves those.
    expect(upgraded.has(1)).toBe(true);
    expect([...store.map.keys()].every((k) => k.startsWith('v2~'))).toBe(true);
  });
});

describe('rendererIdentity', () => {
  it('is stable across calls when nothing changed', () => {
    expect(rendererIdentity()).toBe(rendererIdentity());
  });

  it('carries the app version', () => {
    // Not asserted against a literal — that would need updating every release,
    // which is the kind of test people delete. The claim is that the version
    // participates at all.
    const pkg = require('../../../package.json') as { version: string };
    expect(rendererIdentity().startsWith(`${pkg.version}.`)).toBe(true);
  });

  it('changes when told it is a development build', () => {
    const shipped = rendererIdentity();
    setDevRendererBuild(true);
    const dev = rendererIdentity();
    expect(dev).not.toBe(shipped);
    // Minted once: a second call must not invalidate what the first warmed.
    expect(rendererIdentity()).toBe(dev);
  });

  it('reports no plugin effects as a stable marker, not as an empty hash', () => {
    // Nothing registered in this environment. The value has to be SOMETHING
    // stable, or every session would look different from every other.
    expect(registeredEffects()).toHaveLength(0);
    expect(pluginEffectFingerprint()).toBe('-');
    expect(pluginEffectFingerprint()).toBe(pluginEffectFingerprint());
  });
});
