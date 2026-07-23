/**
 * Architecture guard: the local-first save / version / asset-import paths make
 * ZERO network calls (principles 3 & 7 — no automatic uploads, offline by
 * default). If a future change routes any of these through the network, this
 * test fails loudly instead of the app silently phoning home on every keystroke.
 *
 * It replaces global `fetch` with a tripwire that throws AND counts, then
 * exercises save + autosave-version + asset import and asserts it was never
 * touched.
 */

import { ProjectBundleService } from './bundle/ProjectBundleService';
import { MemoryBundleFs } from './bundle/BundleFs';
import { importAssetToBundle } from '@core/assets/local/assetBundleIO';
import type { EditorDocument } from '@core/api/cloudDocument';
import type { BytesHashFn } from '@core/assets/local/contentHash';

const fakeHash: BytesHashFn = async (b) => `h${b.length}_${Array.from(b).join('-')}`;

const doc: EditorDocument = {
  version: '1.1.0',
  scene: { version: '1.0.0', nodes: [{ id: 'box' }] } as never,
  animation: { tracks: { 'box:x': [{ t: 0, value: 1 }] }, expressions: {} } as never,
  comps: { main: { id: 'main', name: 'M', width: 1280, height: 720, fps: 48, durationSeconds: 7, background: '#000', transparent: false, startFrame: 0 } } as never,
};

describe('local-first paths are network-free', () => {
  const original = globalThis.fetch;
  let calls = 0;

  beforeEach(() => {
    calls = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = (...args: unknown[]) => {
      calls++;
      throw new Error(`network call in a local-first path: ${String(args[0])}`);
    };
  });
  afterEach(() => {
    (globalThis as unknown as { fetch: unknown }).fetch = original;
  });

  it('save + autosave version snapshot make no network calls', async () => {
    const svc = new ProjectBundleService(new MemoryBundleFs(), undefined, () => 1);
    await svc.save('/p/X.motion', doc, { version: { kind: 'autosave' } });
    expect(calls).toBe(0);
  });

  it('asset import makes no network calls', async () => {
    const fs = new MemoryBundleFs();
    await importAssetToBundle(fs, '/p/X.motion', new Uint8Array([1, 2, 3]), { name: 'logo.png', mime: 'image/png' }, fakeHash);
    expect(calls).toBe(0);
  });
});
