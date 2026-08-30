/**
 * AssetRegistry — the content-addressed asset registry for a project bundle.
 *
 * Owns `assets/registry.json` (the `AssetRecord[]`) and coordinates with a
 * `BlobStore` for the bytes. Importing bytes hashes them, stores the blob once
 * (dedup), and returns a stable record; GC drops records no node references and
 * then deletes any blob left orphaned.
 *
 * Pure orchestration over the `BlobStore` + injectable hasher — no filesystem,
 * no engines, so the whole import/dedup/GC contract is unit-testable.
 */

import { sha256Hex, type BytesHashFn } from './contentHash';
import type { BlobStore } from './BlobStore';
import {
  inferAssetType,
  type AssetRecord,
  type AssetRegistryFile,
  type LocalAssetType,
} from './blobTypes';

const REGISTRY_VERSION = '1.0.0';

export interface AssetImportMeta {
  name: string;
  mime: string;
  /**
   * Keep this id instead of deriving one from the hash.
   *
   * For COLLECTING an asset the document already references. Layers bind to a
   * library entry by `assetId`, so minting a fresh hash-derived id while
   * copying the bytes into the bundle would orphan every layer using it — the
   * asset would be safely stored and no longer reachable, which is worse than
   * not storing it. Fresh imports pass nothing and get the content-addressed id.
   */
  id?: string;
  /** Override the MIME-inferred kind. */
  type?: LocalAssetType;
  width?: number;
  height?: number;
  duration?: number;
}

export class AssetRegistry {
  private readonly records = new Map<string, AssetRecord>();

  constructor(
    private readonly blobs: BlobStore,
    private readonly hasher: BytesHashFn = sha256Hex,
  ) {}

  /**
   * Import bytes: hash, store the blob if new, and register a record. Re-importing
   * identical content returns the existing record and writes no new blob (dedup).
   */
  async importBytes(bytes: Uint8Array, meta: AssetImportMeta): Promise<AssetRecord> {
    const hash = await this.hasher(bytes);
    const id = meta.id ?? `asset_${hash.slice(0, 12)}`;

    const existing = this.records.get(id);
    if (existing) return existing;

    if (!(await this.blobs.has(hash))) {
      await this.blobs.put(hash, bytes);
    }

    const record: AssetRecord = {
      id,
      hash,
      name: meta.name,
      type: meta.type ?? inferAssetType(meta.mime),
      mime: meta.mime,
      size: bytes.length,
      ...(meta.width != null ? { width: meta.width } : {}),
      ...(meta.height != null ? { height: meta.height } : {}),
      ...(meta.duration != null ? { duration: meta.duration } : {}),
    };
    this.records.set(id, record);
    return record;
  }

  get(id: string): AssetRecord | null {
    return this.records.get(id) ?? null;
  }

  all(): AssetRecord[] {
    return [...this.records.values()];
  }

  /** The set of blob hashes any current record points at. */
  referencedHashes(): Set<string> {
    return new Set([...this.records.values()].map((r) => r.hash));
  }

  toJSON(): AssetRegistryFile {
    return { version: REGISTRY_VERSION, assets: this.all() };
  }

  /** Rebuild a registry from its serialized form. */
  static fromJSON(file: AssetRegistryFile | null, blobs: BlobStore, hasher: BytesHashFn = sha256Hex): AssetRegistry {
    const reg = new AssetRegistry(blobs, hasher);
    for (const record of file?.assets ?? []) reg.records.set(record.id, record);
    return reg;
  }

  /**
   * Drop every record whose id is NOT in `usedAssetIds`, then delete any blob no
   * surviving record references. Returns the hashes of the blobs deleted.
   */
  async gc(usedAssetIds: Set<string>): Promise<string[]> {
    for (const id of [...this.records.keys()]) {
      if (!usedAssetIds.has(id)) this.records.delete(id);
    }
    const live = this.referencedHashes();
    const deleted: string[] = [];
    for (const hash of await this.blobs.list()) {
      if (!live.has(hash)) {
        await this.blobs.delete(hash);
        deleted.push(hash);
      }
    }
    return deleted;
  }
}
