/**
 * Local (content-addressed) asset types.
 *
 * Distinct from `AssetService` (the cloud/URL asset registry): under local-first,
 * every imported asset has canonical BYTES on disk in the project's bundle,
 * addressed by the SHA-256 of its content. A node references an asset by `id`;
 * the bytes live once per unique content (`hash`), so importing the same file
 * twice stores one blob.
 */

export type LocalAssetType = 'image' | 'video' | 'audio' | 'json' | 'font' | 'other';

/** A row in `assets/registry.json`. Points at a blob by content hash. */
export interface AssetRecord {
  /** Stable id nodes reference. Derived from the hash → dedup-friendly. */
  id: string;
  /** SHA-256 hex of the bytes — the content address / blob name. */
  hash: string;
  name: string;
  type: LocalAssetType;
  mime: string;
  /** Byte length. */
  size: number;
  width?: number;
  height?: number;
  duration?: number;
}

/** Serialized `assets/registry.json`. */
export interface AssetRegistryFile {
  version: string;
  assets: AssetRecord[];
}

/** Map a MIME type to a coarse asset kind. */
export function inferAssetType(mime: string): LocalAssetType {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/json') return 'json';
  if (mime.startsWith('font/') || mime.includes('font')) return 'font';
  return 'other';
}
