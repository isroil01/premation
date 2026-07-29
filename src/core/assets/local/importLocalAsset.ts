/**
 * importLocalAsset — bring a dropped/picked File into the current project bundle
 * as a content-addressed local asset (the local-first design, principles 2 & 3: local ownership,
 * zero automatic upload).
 *
 * Writes the bytes to the bundle blob store (dedup by hash), returns the record
 * plus intrinsic media metadata, and yields a `motion-blob:<hash>` src that the
 * GPU loader resolves locally (see `localBlobSource`). No network.
 *
 * Returns null when there is no local-first bundle open, so the caller can fall
 * back to its existing in-memory object-URL path (still upload-free).
 */

import { getProjectManager } from '@core/services/coreServices';
import { detectBundleFs } from '@core/project/bundle/bundleFsEnv';
import { isBundlePath } from '@core/project/bundle/bundleProjectIO';
import { importAssetToBundle } from './assetBundleIO';
import { localBlobRef } from '@core/rendering/localBlobSource';
import type { AssetRecord } from './blobTypes';

export interface LocalImportResult {
  record: AssetRecord;
  /** `motion-blob:<hash>` — the src to store on the node/asset. */
  src: string;
  metadata?: { width?: number; height?: number; duration?: number };
}

export async function importLocalAsset(file: File): Promise<LocalImportResult | null> {
  const path = getProjectManager().getState().current?.path ?? null;
  if (!path || !isBundlePath(path)) return null;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const record = await importAssetToBundle(detectBundleFs(), path, bytes, {
    name: file.name,
    mime: file.type || 'application/octet-stream',
  });
  const metadata = await readMediaMeta(file);
  return { record, src: localBlobRef(record.hash), ...(metadata ? { metadata } : {}) };
}

/** Read intrinsic size (image) or duration (audio/video) via a temp object URL. */
async function readMediaMeta(file: File): Promise<LocalImportResult['metadata'] | null> {
  const url = URL.createObjectURL(file);
  try {
    if (file.type.startsWith('image/')) {
      return await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => resolve(null);
        img.src = url;
      });
    }
    if (file.type.startsWith('video/')) {
      return await new Promise((resolve) => {
        const v = document.createElement('video');
        v.onloadedmetadata = () => resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration });
        v.onerror = () => resolve(null);
        v.src = url;
      });
    }
    if (file.type.startsWith('audio/')) {
      return await new Promise((resolve) => {
        const a = new Audio();
        a.onloadedmetadata = () => resolve({ duration: a.duration });
        a.onerror = () => resolve(null);
        a.src = url;
      });
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
