/**
 * ProjectSyncService — one full sync of a local `.motion` bundle against the
 * encrypted vault.
 *
 * Bridges the local bundle (BundleFs) and the `SyncEngine`: it reads the local
 * manifest + chunk texts, runs a reconcile-and-exchange cycle, and APPLIES the
 * pulled remote chunks back to disk (updating `manifest.json`), so after a sync
 * the on-disk bundle reflects the merged truth. The sync base (last agreed
 * manifest + rev) is kept in `sync/state.json` inside the bundle.
 *
 * Conflicts are surfaced, not silently resolved — the caller snapshots a
 * conflict-copy version (see `conflictCopyLabel`) and lets the user choose.
 *
 * Pure orchestration over the injected ports (BundleFs / SyncTransport /
 * ProjectCipher), so the whole "two devices converge" path is unit-testable.
 */

import { readManifest } from '@core/project/bundle/bundleCodec';
import { BUNDLE_FORMAT_VERSION, CONTENT_CHUNKS, CHUNK, type BundleManifest } from '@core/project/bundle/types';
import type { ChunkMap } from './manifestDiff';
import { SyncEngine, type SyncTransport } from './SyncEngine';
import type { ProjectCipher } from './ProjectCipher';
import type { BundleFs } from '@core/project/bundle/BundleFs';

const SYNC_STATE_PATH = 'sync/state.json';

interface SyncStateFile {
  baseManifest: ChunkMap;
  rev: number;
}

export interface SyncOutcome {
  status: 'synced' | 'conflict' | 'failed';
  rev?: number;
  /** Chunk names pulled from the remote and applied locally. */
  pulled?: string[];
  /** Chunk names in conflict (caller should snapshot a conflict-copy). */
  conflicts?: string[];
}

/** Suggested label for the version a caller snapshots on conflict. */
export function conflictCopyLabel(deviceId: string, at: number): string {
  return `Conflicted copy (${deviceId}) @ ${new Date(at).toISOString()}`;
}

export class ProjectSyncService {
  private readonly engine: SyncEngine;

  constructor(
    private readonly fs: BundleFs,
    transport: SyncTransport,
    cipher: ProjectCipher,
  ) {
    this.engine = new SyncEngine(transport, cipher);
  }

  async sync(root: string, projectId: string, maxRetries = 3): Promise<SyncOutcome> {
    const localManifest = await this.readLocalManifest(root);
    const chunks: Record<string, string> = {};
    for (const name of CONTENT_CHUNKS) {
      if (!localManifest[name]) continue;
      const text = await this.fs.read(root, name);
      if (text != null) chunks[name] = text;
    }

    const { baseManifest } = await this.readBase(root);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await this.engine.sync(projectId, { manifest: localManifest, chunks }, baseManifest);

      if (res.status === 'conflict') return { status: 'conflict', conflicts: res.conflicts };
      if (res.status === 'retry') continue;

      // Apply pulled remote chunks to disk.
      for (const change of res.applied) {
        if (change.text != null) await this.fs.writeAtomic(root, change.name, change.text);
        else await this.fs.remove(root, change.name);
      }
      await this.writeMergedManifest(root, res.merged);
      await this.writeBase(root, res.merged, res.rev);
      return { status: 'synced', rev: res.rev, pulled: res.applied.map((c) => c.name) };
    }
    return { status: 'failed' };
  }

  private async readLocalManifest(root: string): Promise<ChunkMap> {
    const text = await this.fs.read(root, CHUNK.manifest);
    if (text == null) return {};
    const manifest = readManifest({ [CHUNK.manifest]: text });
    return (manifest?.chunks ?? {}) as ChunkMap;
  }

  private async writeMergedManifest(root: string, merged: ChunkMap): Promise<void> {
    const existing = await this.fs.read(root, CHUNK.manifest);
    const documentVersion = existing ? (readManifest({ [CHUNK.manifest]: existing })?.documentVersion ?? '1.1.0') : '1.1.0';
    const manifest: BundleManifest = { bundleFormat: BUNDLE_FORMAT_VERSION, documentVersion, chunks: merged };
    await this.fs.writeAtomic(root, CHUNK.manifest, JSON.stringify(manifest));
  }

  private async readBase(root: string): Promise<SyncStateFile> {
    const text = await this.fs.read(root, SYNC_STATE_PATH);
    if (text == null) return { baseManifest: {}, rev: 0 };
    try {
      const parsed = JSON.parse(text) as SyncStateFile;
      return { baseManifest: parsed.baseManifest ?? {}, rev: parsed.rev ?? 0 };
    } catch {
      return { baseManifest: {}, rev: 0 };
    }
  }

  private async writeBase(root: string, baseManifest: ChunkMap, rev: number): Promise<void> {
    await this.fs.writeAtomic(root, SYNC_STATE_PATH, JSON.stringify({ baseManifest, rev }));
  }
}
