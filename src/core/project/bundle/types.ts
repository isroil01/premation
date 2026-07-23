/**
 * `.motion` bundle types.
 *
 * A `.motion` is a directory bundle (like `.sketch`/`.fcpbundle`), not a single
 * file. The authored document is split along the engines' existing authority
 * lines — scene, animation, timeline — so that a save rewrites only the chunk
 * that changed, versions can share identical chunks, and (paid) sync can ship
 * deltas. Deriveable data (thumbnails/proxies/waveforms) is deliberately NOT in
 * the bundle; it lives in the app cache dir so bundles stay small and portable.
 *
 * This module defines the on-disk shape only. Reading/writing the actual
 * directory is the file-adapter's job; turning a live `EditorDocument` into
 * chunks and back is `bundleCodec.ts`.
 */

/** Container format version. Distinct from the inner `EditorDocument.version`. */
export const BUNDLE_FORMAT_VERSION = '2.0.0';

/**
 * Canonical chunk file names (relative to the bundle root). The mapping from
 * `EditorDocument` fields to chunks is a strict partition — every field lands in
 * exactly one chunk, no overlap — so decode is unambiguous. See `bundleCodec`.
 */
export const CHUNK = {
  manifest: 'manifest.json',
  scene: 'scene.json',
  animation: 'animation.json',
  timeline: 'timeline.json',
  meta: 'meta.json',
} as const;

/** Chunk names that carry document content (everything except the manifest). */
export const CONTENT_CHUNKS = [CHUNK.scene, CHUNK.animation, CHUNK.timeline, CHUNK.meta] as const;

export type ChunkName = (typeof CONTENT_CHUNKS)[number];

/**
 * `manifest.json` — the index of the bundle. Records the container version and
 * the hash of every content chunk present. A chunk absent from `chunks` is
 * absent from the bundle (optional chunks like an empty timeline are omitted).
 */
export interface BundleManifest {
  bundleFormat: string;
  /** The inner document version (e.g. '1.1.0'), preserved for migration. */
  documentVersion: string;
  /** chunk file name → content hash. Only present chunks appear. */
  chunks: Partial<Record<ChunkName, string>>;
}

/**
 * In-memory representation of a bundle: the manifest plus the raw JSON text of
 * each present chunk, keyed by file name. This is the currency between the codec
 * and the file adapter — the adapter writes each entry to `<bundle>/<name>`.
 */
export interface MotionBundle {
  manifest: BundleManifest;
  /** file name (including 'manifest.json') → serialized contents. */
  files: Record<string, string>;
}
