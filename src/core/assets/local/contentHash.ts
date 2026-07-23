/**
 * Content hashing for asset blobs — SHA-256, the dedup / content-address key.
 *
 * This is the cryptographic hash the RFC reserves for asset blobs (NOT the fast
 * FNV-1a chunk fingerprint in `project/bundle/hash.ts`): collisions here would
 * silently alias distinct media, so it must be a real digest.
 *
 * `sha256Hex` uses Web Crypto (`crypto.subtle`), which is async. The registry
 * takes the hasher as a parameter so callers can inject a deterministic one in
 * tests / environments without subtle crypto.
 */

export type BytesHashFn = (bytes: Uint8Array) => Promise<string>;

/** SHA-256 of `bytes` as lowercase hex, via Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('sha256Hex: WebCrypto subtle is unavailable in this environment');
  const digest = await subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
