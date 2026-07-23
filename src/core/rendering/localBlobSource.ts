/**
 * localBlobSource — resolve a local-first asset reference to bytes for the GPU
 * texture loader (RFC §6 / render integration).
 *
 * Locally-imported assets are content-addressed in the bundle blob store; a node
 * references one as `motion-blob:<sha256>`. `buildSnapshot` passes that string
 * through untouched (it's not a `/files` or `blob:`/`data:` URL, so `assetUrl`
 * leaves it alone), and the async `ImageLoader` in `AppTextureProvider` calls
 * `loadLocalBlobObjectUrl` to turn it into a decodable object URL.
 *
 * The actual byte source (the bundle's `BlobStore`, which needs the current
 * project root + environment) is INJECTED via `setLocalBlobResolver` at boot, so
 * this render-layer module stays free of app-service imports.
 */

export const LOCAL_BLOB_SCHEME = 'motion-blob:';

/** Resolve a content hash to its bytes (or null if unavailable). */
export type LocalBlobResolver = (hash: string) => Promise<Uint8Array | null>;

let resolver: LocalBlobResolver | null = null;

/** Wire the byte source at boot (app layer). Pass null to clear (tests). */
export function setLocalBlobResolver(fn: LocalBlobResolver | null): void {
  resolver = fn;
}

/** True when `src` is a local-first asset reference. */
export function isLocalBlobRef(src: string): boolean {
  return src.startsWith(LOCAL_BLOB_SCHEME);
}

/** Build a `motion-blob:` reference for a content hash. */
export function localBlobRef(hash: string): string {
  return `${LOCAL_BLOB_SCHEME}${hash}`;
}

/**
 * Resolve a `motion-blob:<hash>` ref to a fresh object URL the image/video
 * loader can decode, or null if there is no resolver or no such blob. Callers
 * are responsible for `URL.revokeObjectURL` once decoded.
 */
export async function loadLocalBlobObjectUrl(src: string): Promise<string | null> {
  if (!resolver || !isLocalBlobRef(src)) return null;
  const hash = src.slice(LOCAL_BLOB_SCHEME.length);
  const bytes = await resolver(hash);
  if (!bytes) return null;
  return URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
}
