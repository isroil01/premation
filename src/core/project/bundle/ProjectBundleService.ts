/**
 * ProjectBundleService — the one façade the app uses for a local-first project.
 *
 * Ties together the pieces that all operate on a single `.motion` bundle: the
 * document (BundleRepository), version history (VersionStore), the asset registry
 * (assetBundleIO), and the AI chunks (aiBundleIO). Callers get a small, coherent
 * API — save, load, list/restore versions — instead of wiring four modules by
 * hand at every call site.
 *
 * Pure orchestration over an injected `BundleFs` + clock, so the compose logic
 * (save → snapshot → prune) is unit-testable.
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import { BundleRepository } from './BundleRepository';
import { VersionStore, type VersionEntry, type VersionKind } from './VersionStore';
import { hashString, type HashFn } from './hash';
import type { BundleFs } from './BundleFs';

export interface SaveOptions {
  /** Also record a version snapshot for this save. */
  version?: { kind: VersionKind; label?: string; time?: number };
  /** How many autosave versions to keep (older ones pruned). Default 20. */
  keepAutosaves?: number;
}

export class ProjectBundleService {
  private readonly repo: BundleRepository;

  constructor(
    private readonly fs: BundleFs,
    private readonly hash: HashFn = hashString,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.repo = new BundleRepository(fs, hash);
  }

  /** Save the document (incremental) and optionally snapshot a version. */
  async save(root: string, doc: EditorDocument, opts?: SaveOptions): Promise<void> {
    await this.repo.save(root, doc);
    if (opts?.version) {
      const vs = this.versions(root);
      await vs.snapshot(doc, {
        kind: opts.version.kind,
        ...(opts.version.label != null ? { label: opts.version.label } : {}),
        ...(opts.version.time != null ? { time: opts.version.time } : {}),
        createdAt: this.clock(),
      });
      if (opts.version.kind === 'autosave') {
        await vs.prune('autosave', opts.keepAutosaves ?? 20);
      }
    }
  }

  load(root: string): Promise<EditorDocument | null> {
    return this.repo.load(root);
  }

  has(root: string): Promise<boolean> {
    return this.repo.has(root);
  }

  listVersions(root: string): Promise<VersionEntry[]> {
    return this.versions(root).list();
  }

  restoreVersion(root: string, rev: number): Promise<EditorDocument | null> {
    return this.versions(root).restore(rev);
  }

  private versions(root: string): VersionStore {
    return new VersionStore(this.fs, root, this.hash);
  }
}
