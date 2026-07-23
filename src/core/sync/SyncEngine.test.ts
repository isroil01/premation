/**
 * SyncEngine — a reconcile-and-exchange cycle over a mock vault.
 *
 * Uses an identity cipher (flow test, not crypto) + an in-memory transport that
 * models the server's compare-and-swap manifest + content-addressed chunk store.
 * Covers first push, pull on a second device, fast-forward of disjoint edits,
 * conflict reporting, and CAS-rev retry.
 */

import { SyncEngine, type SyncTransport, type RemoteState, type LocalBundleState } from './SyncEngine';
import type { ProjectCipher } from './ProjectCipher';
import type { ChunkMap } from './manifestDiff';

/** Passthrough cipher — copies bytes so tests exercise the flow, not AES. */
const identityCipher: ProjectCipher = {
  async encrypt(b) { return b.slice(); },
  async decrypt(b) { return b.slice(); },
};

class MockTransport implements SyncTransport {
  private rev = 0;
  private manifest: Uint8Array | null = null;
  private chunks = new Map<string, Uint8Array>();

  async getRemote(): Promise<RemoteState | null> {
    return this.manifest ? { rev: this.rev, manifest: this.manifest } : null;
  }
  async hasChunk(_p: string, hash: string) { return this.chunks.has(hash); }
  async getChunk(_p: string, hash: string) { return this.chunks.get(hash) ?? null; }
  async putChunk(_p: string, hash: string, sealed: Uint8Array) { this.chunks.set(hash, sealed); }
  async putRemote(_p: string, expectedRev: number, manifest: Uint8Array) {
    if (expectedRev !== this.rev) return { ok: false as const, rev: this.rev };
    this.rev += 1;
    this.manifest = manifest;
    return { ok: true as const, rev: this.rev };
  }
  /** Force a divergent server state (another device pushed). */
  forceManifest(map: ChunkMap, rev: number) {
    this.manifest = new TextEncoder().encode(JSON.stringify(map));
    this.rev = rev;
  }
}

const local = (manifest: ChunkMap, chunks: Record<string, string>): LocalBundleState => ({ manifest, chunks });

describe('first push (empty remote)', () => {
  it('uploads chunks and sets the manifest at rev 1', async () => {
    const t = new MockTransport();
    const eng = new SyncEngine(t, identityCipher);
    const res = await eng.sync('p', local({ scene: 'a', animation: 'b' }, { scene: 'S', animation: 'B' }), {});
    expect(res).toMatchObject({ status: 'synced', rev: 1, merged: { scene: 'a', animation: 'b' } });
    expect(await t.hasChunk('p', 'a')).toBe(true);
    expect(await t.hasChunk('p', 'b')).toBe(true);
  });
});

describe('pull on a second device', () => {
  it('downloads and decrypts the chunks the remote has', async () => {
    const t = new MockTransport();
    const eng = new SyncEngine(t, identityCipher);
    // device A pushes
    await eng.sync('p', local({ scene: 'a', animation: 'b' }, { scene: 'S', animation: 'B' }), {});
    // device B starts empty
    const res = await eng.sync('p', local({}, {}), {});
    expect(res.status).toBe('synced');
    if (res.status === 'synced') {
      const applied = Object.fromEntries(res.applied.map((c) => [c.name, c.text]));
      expect(applied).toEqual({ scene: 'S', animation: 'B' });
    }
  });
});

describe('fast-forward of disjoint edits', () => {
  it('pulls the remote-changed chunk and pushes the local-changed one, no conflict', async () => {
    const t = new MockTransport();
    const eng = new SyncEngine(t, identityCipher);
    // server changed scene to a3 at rev 5; base agreed on scene:a, animation:b
    t.forceManifest({ scene: 'a3', animation: 'b' }, 5);
    // ensure the remote scene chunk exists to pull
    await t.putChunk('p', 'a3', new TextEncoder().encode('S3'));

    const res = await eng.sync(
      'p',
      local({ scene: 'a', animation: 'b2' }, { scene: 'S', animation: 'B2' }),
      { scene: 'a', animation: 'b' },
    );

    expect(res.status).toBe('synced');
    if (res.status === 'synced') {
      expect(res.merged).toEqual({ scene: 'a3', animation: 'b2' });
      expect(res.applied).toEqual([{ name: 'scene', hash: 'a3', text: 'S3' }]);
      expect(await t.hasChunk('p', 'b2')).toBe(true); // pushed
    }
  });
});

describe('conflict', () => {
  it('reports a same-chunk divergence without touching the server', async () => {
    const t = new MockTransport();
    const eng = new SyncEngine(t, identityCipher);
    t.forceManifest({ animation: 'bR' }, 3);
    const res = await eng.sync('p', local({ animation: 'bL' }, { animation: 'X' }), { animation: 'b' });
    expect(res).toEqual({ status: 'conflict', conflicts: ['animation'] });
  });
});

describe('CAS retry', () => {
  it('reports retry when the manifest was expected at a stale rev', async () => {
    const t = new MockTransport();
    const eng = new SyncEngine(t, identityCipher);
    // Remote exists at rev 2, but our base matches it so no conflict — yet we
    // simulate a racing writer by bumping rev between get and put is hard here;
    // instead verify putRemote CAS: force rev 2 with a manifest equal to local
    // so reconcile is empty, then a stale expectedRev triggers retry.
    t.forceManifest({ scene: 'a' }, 2);
    // monkeypatch getRemote to report an older rev than the store holds
    const orig = t.getRemote.bind(t);
    t.getRemote = async () => {
      const r = await orig();
      return r ? { ...r, rev: 1 } : null; // stale rev → CAS mismatch on put
    };
    const res = await eng.sync('p', local({ scene: 'a', meta: 'm' }, { scene: 'S', meta: 'M' }), { scene: 'a' });
    expect(res.status).toBe('retry');
  });
});
