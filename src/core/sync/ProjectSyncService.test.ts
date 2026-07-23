/**
 * ProjectSyncService — two bundles converge through a shared vault.
 *
 * End-to-end over the real bundle codec + a mock transport + identity cipher:
 * device A saves a bundle and syncs it up; device B (empty) syncs and its
 * on-disk bundle becomes byte-equal to A's document. Also covers the conflict
 * surface.
 */

import { ProjectSyncService, conflictCopyLabel } from './ProjectSyncService';
import type { SyncTransport, RemoteState } from './SyncEngine';
import type { ProjectCipher } from './ProjectCipher';
import { BundleRepository } from '@core/project/bundle/BundleRepository';
import { MemoryBundleFs } from '@core/project/bundle/BundleFs';
import type { EditorDocument } from '@core/api/cloudDocument';

const identityCipher: ProjectCipher = {
  async encrypt(b) { return b.slice(); },
  async decrypt(b) { return b.slice(); },
};

/** Shared in-memory vault (models the server). */
class SharedVault implements SyncTransport {
  private rev = 0;
  private manifest: Uint8Array | null = null;
  private chunks = new Map<string, Uint8Array>();
  async getRemote(): Promise<RemoteState | null> {
    return this.manifest ? { rev: this.rev, manifest: this.manifest } : null;
  }
  async hasChunk(_p: string, h: string) { return this.chunks.has(h); }
  async getChunk(_p: string, h: string) { return this.chunks.get(h) ?? null; }
  async putChunk(_p: string, h: string, s: Uint8Array) { this.chunks.set(h, s); }
  async putRemote(_p: string, expectedRev: number, manifest: Uint8Array) {
    if (expectedRev !== this.rev) return { ok: false as const, rev: this.rev };
    this.rev += 1;
    this.manifest = manifest;
    return { ok: true as const, rev: this.rev };
  }
}

function doc(anim: unknown): EditorDocument {
  return {
    version: '1.1.0',
    scene: { version: '1.0.0', nodes: [{ id: 'box' }] } as never,
    animation: { tracks: anim, expressions: {} } as never,
    comps: { main: { id: 'main', name: 'M', width: 1280, height: 720, fps: 48, durationSeconds: 7, background: '#000', transparent: false, startFrame: 0 } } as never,
  };
}

describe('two devices converge', () => {
  it('device B pulls device A\'s bundle and becomes byte-equal', async () => {
    const vault = new SharedVault();
    const fsA = new MemoryBundleFs();
    const fsB = new MemoryBundleFs();
    const rootA = '/A/P.motion';
    const rootB = '/B/P.motion';

    // Device A: save a bundle, then sync up.
    const d = doc({ 'box:x': [{ t: 0, value: 1 }, { t: 2, value: 9 }] });
    await new BundleRepository(fsA).save(rootA, d);
    const up = await new ProjectSyncService(fsA, vault, identityCipher).sync(rootA, 'P');
    expect(up.status).toBe('synced');
    expect(up.rev).toBe(1);

    // Device B: empty, sync down.
    const down = await new ProjectSyncService(fsB, vault, identityCipher).sync(rootB, 'P');
    expect(down.status).toBe('synced');
    expect(down.pulled?.sort()).toEqual(['animation.json', 'meta.json', 'scene.json']);

    // B's on-disk bundle now decodes to A's document.
    expect(await new BundleRepository(fsB).load(rootB)).toEqual(d);
  });

  it('a re-sync with no changes is a no-op fast-forward', async () => {
    const vault = new SharedVault();
    const fs = new MemoryBundleFs();
    const root = '/A/P.motion';
    await new BundleRepository(fs).save(root, doc({ a: 1 }));
    const svc = new ProjectSyncService(fs, vault, identityCipher);
    await svc.sync(root, 'P');
    const again = await svc.sync(root, 'P');
    expect(again.status).toBe('synced');
    expect(again.pulled).toEqual([]);
  });
});

describe('conflict', () => {
  it('surfaces a same-chunk conflict without clobbering', async () => {
    const vault = new SharedVault();
    const fsA = new MemoryBundleFs();
    const fsB = new MemoryBundleFs();
    const rootA = '/A/P.motion';
    const rootB = '/B/P.motion';

    // A and B start from the same synced base.
    await new BundleRepository(fsA).save(rootA, doc({ v: 'base' }));
    await new ProjectSyncService(fsA, vault, identityCipher).sync(rootA, 'P');
    await new BundleRepository(fsB).save(rootB, doc({ v: 'base' }));
    await new ProjectSyncService(fsB, vault, identityCipher).sync(rootB, 'P');

    // Both edit animation differently.
    await new BundleRepository(fsA).save(rootA, doc({ v: 'A-edit' }));
    await new ProjectSyncService(fsA, vault, identityCipher).sync(rootA, 'P'); // A wins the race
    await new BundleRepository(fsB).save(rootB, doc({ v: 'B-edit' }));
    const bRes = await new ProjectSyncService(fsB, vault, identityCipher).sync(rootB, 'P');

    expect(bRes.status).toBe('conflict');
    expect(bRes.conflicts).toContain('animation.json');
  });

  it('conflictCopyLabel is descriptive', () => {
    expect(conflictCopyLabel('macbook', 0)).toContain('macbook');
  });
});
