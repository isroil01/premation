/**
 * assetReveal — "Reveal in Explorer / Finder" for a library asset.
 *
 * An asset has a file on disk in two cases: the import remembered where it
 * came from (`asset.path` — the media browser, an older Electron's
 * `File.path`), or the bytes were collected into the open bundle as a
 * content-addressed blob (`motion-blob:<hash>` → `<bundle>/blobs/<hh>/<hash>`,
 * the layout `electron/main.ts`'s blob IPC writes). An IndexedDB-only asset
 * has neither, and the menu item says so by staying disabled rather than
 * opening an empty folder.
 *
 * The IPC itself lives in `electron/ipc/reveal.ts`; absent in the browser
 * build, and every caller checks `canRevealAssets()` before offering it.
 */

import type { ImportedAsset } from '@stores/assetStore';
import { useUIStore } from '@stores/uiStore';
import { getProjectManager } from '@core/services/coreServices';
import { isBundlePath } from '@core/project/bundle/bundleProjectIO';
import { isLocalBlobRef, LOCAL_BLOB_SCHEME } from '@core/assets/local/localBlobSource';

/** Whether this build can show a file in the OS file manager at all. */
export function canRevealAssets(): boolean {
  return typeof window !== 'undefined' && typeof window.motionEditor?.shell?.revealInFolder === 'function';
}

/** Pure: the on-disk path of a collected blob, given the bundle root. */
export function blobPathInBundle(root: string, src: string): string | null {
  if (!isLocalBlobRef(src)) return null;
  const hash = src.slice(LOCAL_BLOB_SCHEME.length);
  if (!/^[0-9a-f]{8,}$/i.test(hash)) return null;
  const sep = root.includes('\\') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  return [base, 'blobs', hash.slice(0, 2), hash].join(sep);
}

/** The path Reveal would open, or null when the asset has no file on disk. */
export function assetDiskPath(asset: Pick<ImportedAsset, 'path' | 'src'>): string | null {
  if (asset.path) return asset.path;
  const root = getProjectManager().getState().current?.path ?? null;
  if (!root || !isBundlePath(root)) return null;
  return blobPathInBundle(root, asset.src);
}

/** Show the asset's file in Explorer / Finder. Reports when it cannot. */
export async function revealAsset(asset: Pick<ImportedAsset, 'name' | 'path' | 'src'>): Promise<boolean> {
  const reveal = window.motionEditor?.shell?.revealInFolder;
  const path = assetDiskPath(asset);
  if (!reveal || !path) {
    useUIStore.getState().notify({
      level: 'info',
      message: `“${asset.name}” has no file on disk to reveal — it lives in the project's local store.`,
      durationMs: 4000,
    });
    return false;
  }
  let ok = false;
  try {
    ok = await reveal(path);
  } catch {
    ok = false;
  }
  if (!ok) {
    useUIStore.getState().notify({
      level: 'warning',
      message: `The file for “${asset.name}” is no longer at ${path}.`,
      durationMs: 5000,
    });
  }
  return ok;
}
