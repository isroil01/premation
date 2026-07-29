/**
 * SyncEngine — one reconcile-and-exchange cycle against the encrypted vault.
 *
 * Everything crossing the transport is ciphertext: chunk contents and the
 * manifest are sealed by the `ProjectCipher` before upload and opened after
 * download, so the server stores opaque bytes it cannot read.
 * The engine itself is pure orchestration over the `SyncTransport` and
 * `ProjectCipher` ports — the real HTTP transport + backend are thin adapters.
 *
 * A cycle: fetch remote → decrypt its manifest → `reconcile(base, local, remote)`
 *   - conflicts?  → stop and report them (the caller keeps a conflict-copy)
 *   - otherwise   → download the chunks to pull, upload the chunks to push,
 *                   then compare-and-swap the merged manifest at the expected rev.
 */

import { reconcile, type ChunkMap } from './manifestDiff';
import type { ProjectCipher } from './ProjectCipher';

/** Server-held state — the manifest is an opaque ciphertext blob. */
export interface RemoteState {
  rev: number;
  manifest: Uint8Array;
}

export interface SyncTransport {
  getRemote(projectId: string): Promise<RemoteState | null>;
  hasChunk(projectId: string, hash: string): Promise<boolean>;
  getChunk(projectId: string, hash: string): Promise<Uint8Array | null>;
  putChunk(projectId: string, hash: string, sealed: Uint8Array): Promise<void>;
  /** Compare-and-swap the manifest at `expectedRev`; reports the real rev on conflict. */
  putRemote(
    projectId: string,
    expectedRev: number,
    manifest: Uint8Array,
  ): Promise<{ ok: true; rev: number } | { ok: false; rev: number }>;
}

/** Local bundle state fed to a sync: the manifest + each chunk's text. */
export interface LocalBundleState {
  manifest: ChunkMap;
  chunks: Record<string, string>;
}

/** A remote change to apply locally after a pull (`text` undefined ⇒ delete). */
export interface AppliedChange {
  name: string;
  hash?: string;
  text?: string;
}

export type SyncResult =
  | { status: 'conflict'; conflicts: string[] }
  | { status: 'retry'; rev: number }
  | { status: 'synced'; rev: number; merged: ChunkMap; applied: AppliedChange[] };

export class SyncEngine {
  constructor(
    private readonly transport: SyncTransport,
    private readonly cipher: ProjectCipher,
  ) {}

  async sync(projectId: string, local: LocalBundleState, base: ChunkMap): Promise<SyncResult> {
    const remote = await this.transport.getRemote(projectId);
    const rev = remote?.rev ?? 0;
    const remoteManifest: ChunkMap = remote
      ? this.decodeManifest(await this.cipher.decrypt(remote.manifest))
      : {};

    const rec = reconcile(base, local.manifest, remoteManifest);
    if (rec.conflicts.length > 0) return { status: 'conflict', conflicts: rec.conflicts };

    // Download the chunks the remote changed.
    const applied: AppliedChange[] = [];
    for (const c of rec.pull) {
      if (c.hash === undefined) {
        applied.push({ name: c.name });
        continue;
      }
      const sealed = await this.transport.getChunk(projectId, c.hash);
      const text = sealed ? new TextDecoder().decode(await this.cipher.decrypt(sealed)) : undefined;
      applied.push({ name: c.name, hash: c.hash, ...(text != null ? { text } : {}) });
    }

    // Upload the chunks this device changed (skip deletions and content already there).
    for (const c of rec.push) {
      if (c.hash === undefined) continue;
      if (await this.transport.hasChunk(projectId, c.hash)) continue;
      const sealed = await this.cipher.encrypt(new TextEncoder().encode(local.chunks[c.name] ?? ''));
      await this.transport.putChunk(projectId, c.hash, sealed);
    }

    // Merged truth = local with the remote pulls applied.
    const merged: ChunkMap = { ...local.manifest };
    for (const c of rec.pull) {
      if (c.hash === undefined) delete merged[c.name];
      else merged[c.name] = c.hash;
    }

    const sealedManifest = await this.cipher.encrypt(this.encodeManifest(merged));
    const put = await this.transport.putRemote(projectId, rev, sealedManifest);
    if (!put.ok) return { status: 'retry', rev: put.rev };

    return { status: 'synced', rev: put.rev, merged, applied };
  }

  private encodeManifest(m: ChunkMap): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(m));
  }

  private decodeManifest(bytes: Uint8Array): ChunkMap {
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as ChunkMap;
    } catch {
      return {};
    }
  }
}
