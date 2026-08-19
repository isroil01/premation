/**
 * Renderer side of the project-thumbnail cache: hash a rendered blob, hand
 * the bytes to the main process, and turn a stored hash back into an object
 * URL for a card's <img>.
 *
 * Content addressing does the invalidation: a new render of the same pixels
 * hashes the same and writes nothing; a changed project gets a new hash on
 * its index row and the old file just stops being referenced.
 *
 * Per-capability probe, no isDesktop(): in a browser tab `window.motionEditor`
 * has no `thumbs`, `storeThumb` returns null, and cards render their facts
 * without an image — the same graceful shape as every other bridge consumer.
 */

const urlByHash = new Map<string, string>();

export function thumbCacheAvailable(): boolean {
  const bridge = typeof window !== 'undefined' ? window.motionEditor : undefined;
  return typeof bridge?.thumbs?.write === 'function';
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Persist a rendered thumbnail; returns its content hash, or null when
 *  there is no disk here (browser tab) or the write failed. */
export async function storeThumb(blob: Blob): Promise<string | null> {
  const bridge = typeof window !== 'undefined' ? window.motionEditor : undefined;
  if (!bridge?.thumbs?.write) return null;
  try {
    const bytes = await blob.arrayBuffer();
    const hash = (await sha256Hex(bytes)).slice(0, 32);
    const ok = await bridge.thumbs.write(hash, new Uint8Array(bytes));
    return ok ? hash : null;
  } catch {
    return null;
  }
}

/** Object URL for a stored thumbnail, memoized per hash for the session —
 *  cards re-render often and the bytes never change under a given hash. */
export async function thumbUrl(hash: string): Promise<string | null> {
  const hit = urlByHash.get(hash);
  if (hit) return hit;
  const bridge = typeof window !== 'undefined' ? window.motionEditor : undefined;
  if (!bridge?.thumbs?.read) return null;
  try {
    const bytes = await bridge.thumbs.read(hash);
    if (!bytes || bytes.byteLength === 0) return null;
    // Copy into a fresh ArrayBuffer-backed view: the IPC value types as
    // ArrayBufferLike and BlobPart refuses the SharedArrayBuffer half of it.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const url = URL.createObjectURL(new Blob([copy], { type: 'image/png' }));
    urlByHash.set(hash, url);
    return url;
  } catch {
    return null;
  }
}
