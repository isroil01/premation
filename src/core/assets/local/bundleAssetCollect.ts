/**
 * The store-facing half of bundle asset sync.
 *
 * `bundleAssetSync.ts` is pure — records and bytes in, records and bytes out —
 * so it can be tested without a document, a store or a browser. This is the
 * thin layer that knows about the asset store and the live scene, kept separate
 * so the persistence layer can call one function and the logic stays testable.
 *
 * Both entry points are BEST-EFFORT and say so in their return types rather
 * than by throwing. A save must not fail because one object URL died in a
 * previous session, and an open must not fail because a bundle has no registry
 * — a project that will not open is a far worse outcome than a project whose
 * Assets panel is short a row.
 */

import { isBundlePath } from '@core/project/bundle/bundleProjectIO';
import { isLocalFirst } from '@core/config/flags';
import {
  useAssetStore,
  withDocumentItems,
  isItemPlaceholder,
  fillPlaceholder,
  type ImportedAsset,
} from '@stores/assetStore';
import { rebindAssetSrcs } from '@core/scene/assetRebind';
import type { EditorDocument } from '@core/api/cloudDocument';
import {
  collectAssetsIntoBundle,
  readBundleAssets,
  rewriteDocumentSrcs,
  type SyncableAsset,
} from './bundleAssetSync';

/** The library, in the shape the sync layer reads. */
function libraryAssets(): SyncableAsset[] {
  return useAssetStore.getState().assets.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type === 'video' ? 'video' : a.type === 'audio' ? 'audio' : 'image',
    src: a.src,
    size: a.size,
    ...(a.metadata ? { metadata: a.metadata } : {}),
    ...(a.tags && a.tags.length > 0 ? { tags: a.tags } : {}),
    ...(a.label ? { label: a.label } : {}),
  }));
}

/**
 * Copy the session's footage into the bundle and repoint `doc` at it.
 *
 * Called from the bundle save path, BEFORE the chunks are written, so the file
 * that lands on disk already references the bytes beside it.
 *
 * A no-op off local-first and for a non-bundle path — the single-file and cloud
 * paths have their own storage and would only be slowed by a walk that can
 * never collect anything.
 */
export async function collectBundleAssetsForSave(path: string, doc: EditorDocument): Promise<number> {
  if (!isLocalFirst() || !isBundlePath(path)) return 0;

  const assets = libraryAssets();
  if (assets.length === 0) return 0;

  try {
    const result = await collectAssetsIntoBundle(path, assets);
    if (result.collected.length === 0) return 0;

    // The DOCUMENT first: it is what is about to be written, and a bundle whose
    // blobs are present but whose scene still names dead object URLs is exactly
    // the state this exists to prevent.
    rewriteDocumentSrcs(doc, result.srcById);

    // Then the live library and the live scene, so the session the user is
    // still in stops holding object URLs it no longer needs — and so a second
    // save has nothing left to collect.
    useAssetStore.setState((s) => {
      for (const asset of s.assets) {
        const next = result.srcById.get(asset.id);
        if (next) asset.src = next;
      }
    });
    rebindAssetSrcs(useAssetStore.getState().assets);

    return result.collected.length;
  } catch {
    // Storage refused, or the bundle FS is unavailable. The save itself can
    // still succeed and is strictly better than no save at all.
    return 0;
  }
}

/**
 * Bring a bundle's own assets back into the library.
 *
 * Layers already survive a move without this — a `motion-blob:<hash>` src
 * resolves straight out of the bundle — so what this restores is the ASSETS
 * PANEL: without it a project reopens showing footage on screen that cannot be
 * dragged into a second layer, because as far as the library is concerned it
 * was never imported.
 *
 * Additive and id-keyed: an asset already in the library (hydrated from this
 * device's IndexedDB) is left exactly as it is, so this can never replace a
 * live object URL with one that has to be re-read from disk.
 */
export async function restoreBundleAssets(path: string | null): Promise<number> {
  if (!isLocalFirst() || !path || !isBundlePath(path)) return 0;

  try {
    const fromBundle = await readBundleAssets(path);
    if (fromBundle.length === 0) return 0;

    // A placeholder (an item the document lists with no bytes in the session)
    // is exactly what the bundle's registry fills in, so it does not count as
    // present.
    const presentIds = (list: ImportedAsset[]): Set<string> =>
      new Set(list.filter((a) => !isItemPlaceholder(a)).map((a) => a.id));
    const present = presentIds(useAssetStore.getState().assets);
    const missing = fromBundle.filter((a) => !present.has(a.id));
    if (missing.length === 0) return 0;

    // The registry carries the file (and tags/label as a fallback); the
    // DOCUMENT carries the item's organisation — folder, interpretation,
    // label, tags, comment. This runs after the document was restored, so
    // without the overlay an asset that arrives here comes back unfiled and
    // un-conformed while the document on disk still says otherwise.
    const arriving = withDocumentItems(
      missing.map((asset): ImportedAsset => ({
        id: asset.id,
        name: asset.name,
        type: asset.type,
        src: asset.src,
        size: asset.size ?? 0,
        ...(asset.metadata ? { metadata: asset.metadata } : {}),
        ...(asset.tags ? { tags: asset.tags } : {}),
        ...(asset.label ? { label: asset.label } : {}),
      })),
    );

    useAssetStore.setState((s) => {
      // Re-checked inside the transaction: IndexedDB hydration runs
      // concurrently at boot and may have landed between the read above and
      // this commit.
      const now = presentIds(s.assets);
      for (const asset of arriving) {
        if (now.has(asset.id)) continue;
        const at = s.assets.findIndex((a) => a.id === asset.id);
        if (at >= 0) s.assets[at] = fillPlaceholder(s.assets[at]!, asset);
        else s.assets.push(asset);
      }
    });

    // Any layer still holding a dead `blob:` now has a live entry to bind to.
    rebindAssetSrcs(useAssetStore.getState().assets);
    return missing.length;
  } catch {
    return 0;
  }
}
