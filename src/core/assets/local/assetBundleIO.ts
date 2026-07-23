/**
 * assetBundleIO — load/save a bundle's asset registry.
 *
 * The registry rows live in `assets/registry.json` (text, via `BundleFs`); the
 * bytes live in the content-addressed blob store (`createBlobStore(root)` →
 * binary IPC on desktop, localStorage in the browser). This joins the two so the
 * asset layer persists with its project.
 */

import type { BundleFs } from '@core/project/bundle/BundleFs';
import { AssetRegistry, type AssetImportMeta } from './AssetRegistry';
import { createBlobStore } from './blobStoreEnv';
import { sha256Hex, type BytesHashFn } from './contentHash';
import type { AssetRecord, AssetRegistryFile } from './blobTypes';

const REGISTRY_PATH = 'assets/registry.json';

/** Load the asset registry for the bundle at `root` (empty if none yet). */
export async function loadAssetRegistry(fs: BundleFs, root: string, hasher: BytesHashFn = sha256Hex): Promise<AssetRegistry> {
  const blobs = createBlobStore(root);
  const text = await fs.read(root, REGISTRY_PATH);
  let file: AssetRegistryFile | null = null;
  if (text != null) {
    try {
      file = JSON.parse(text) as AssetRegistryFile;
    } catch {
      file = null;
    }
  }
  return AssetRegistry.fromJSON(file, blobs, hasher);
}

/** Persist the registry rows to `assets/registry.json` (blobs are already written). */
export async function saveAssetRegistry(fs: BundleFs, root: string, registry: AssetRegistry): Promise<void> {
  await fs.writeAtomic(root, REGISTRY_PATH, JSON.stringify(registry.toJSON()));
}

/**
 * Import one asset into the bundle at `root`: content-address the bytes, store
 * the blob (dedup), append the record, and persist the registry — the single
 * call the import UI (drop handler / file picker) makes. Returns the record.
 */
export async function importAssetToBundle(
  fs: BundleFs,
  root: string,
  bytes: Uint8Array,
  meta: AssetImportMeta,
  hasher: BytesHashFn = sha256Hex,
): Promise<AssetRecord> {
  const registry = await loadAssetRegistry(fs, root, hasher);
  const record = await registry.importBytes(bytes, meta);
  await saveAssetRegistry(fs, root, registry);
  return record;
}
