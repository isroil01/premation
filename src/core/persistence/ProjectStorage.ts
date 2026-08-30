/**
 * ProjectStorage — how a captured project document reaches durable storage.
 *
 * `ProjectManager` stays document-agnostic: it captures/restores an opaque
 * `VersionedDocument` via its `ProjectDocumentIO` and hands that document to a
 * `ProjectStorage` to persist or load by path. Two strategies exist:
 *
 *   - `FileProjectStorage` — the legacy single-file blob (serialize → write).
 *   - `BundleProjectStorage` — a chunked `.motion` directory bundle.
 *
 * `RoutedProjectStorage` picks between them per path + the `LOCAL_FIRST` flag,
 * so flag-off behaviour is byte-identical to today and a bundle already on disk
 * still opens even if the flag is later turned off.
 *
 * The bundle layer is intentionally coupled to `EditorDocument` (it knows the
 * scene/animation/timeline chunks); the cast is safe because the app registers
 * `projectDocumentIO`, whose document IS an `EditorDocument`.
 */

import type { VersionedDocument } from '@core/types';
import type { ProjectService } from '@core/persistence/ProjectService';
import type { FileManager } from '@core/files/FileManager';
import type { EditorDocument } from '@core/api/cloudDocument';
import { BundleRepository } from '@core/project/bundle/BundleRepository';
import { getBundleRepository, isBundlePath } from '@core/project/bundle/bundleProjectIO';
import { isLocalFirst } from '@core/config/flags';
import { collectBundleAssetsForSave } from '@core/assets/local/bundleAssetCollect';

export interface ProjectStorage<T extends VersionedDocument = VersionedDocument> {
  save(path: string, doc: T): Promise<void>;
  load(path: string): Promise<T | null>;
}

/** Legacy single-file storage: serialize to one blob, write/read as a string. */
export class FileProjectStorage<T extends VersionedDocument = VersionedDocument> implements ProjectStorage<T> {
  constructor(
    private readonly service: ProjectService,
    private readonly files: FileManager,
  ) {}

  async save(path: string, doc: T): Promise<void> {
    await this.files.write(path, this.service.serialize(doc));
  }

  async load(path: string): Promise<T | null> {
    const contents = await this.files.read(path);
    return contents == null ? null : (this.service.parse(contents) as T);
  }
}

/** Chunked `.motion` directory-bundle storage. */
export class BundleProjectStorage<T extends VersionedDocument = VersionedDocument> implements ProjectStorage<T> {
  constructor(private readonly repo: BundleRepository = getBundleRepository()) {}

  async save(path: string, doc: T): Promise<void> {
    /*
      COLLECT before writing.

      Footage imported before this bundle existed lives only in this session's
      object URLs, so the document references bytes the bundle does not have.
      Saved as-is the bundle looks complete, weighs nothing, and renders black
      on any other machine — the failure is invisible until the project has
      already travelled. Copying the bytes in and repointing the document is
      what makes a `.motion` self-contained.

      Best-effort by construction: a save must not fail because one object URL
      died. See `bundleAssetCollect`.
    */
    await collectBundleAssetsForSave(path, doc as unknown as EditorDocument);
    await this.repo.save(path, doc as unknown as EditorDocument);
  }

  async load(path: string): Promise<T | null> {
    return (await this.repo.load(path)) as unknown as T | null;
  }

  has(path: string): Promise<boolean> {
    return this.repo.has(path);
  }
}

/** Route each save/load to the file or bundle strategy. */
export class RoutedProjectStorage<T extends VersionedDocument = VersionedDocument> implements ProjectStorage<T> {
  constructor(
    private readonly file: ProjectStorage<T>,
    private readonly bundle: BundleProjectStorage<T>,
    private readonly localFirst: () => boolean = isLocalFirst,
  ) {}

  async save(path: string, doc: T): Promise<void> {
    // New bundles are only created under the flag; otherwise stay single-file.
    if (this.localFirst() && isBundlePath(path)) return this.bundle.save(path, doc);
    return this.file.save(path, doc);
  }

  async load(path: string): Promise<T | null> {
    // A path that already holds a bundle opens as a bundle regardless of the
    // flag, so bundles remain readable if LOCAL_FIRST is later turned off.
    if (isBundlePath(path) && (await this.bundle.has(path))) return this.bundle.load(path);
    return this.file.load(path);
  }
}
