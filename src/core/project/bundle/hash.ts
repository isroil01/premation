/**
 * Content hashing for the `.motion` bundle.
 *
 * The bundle manifest records a hash per chunk so that (1) a save can skip
 * rewriting chunks that did not change, (2) versions can structurally share
 * identical chunks, and (3) sync can ship only changed chunks. All three need
 * the hash to be stable and deterministic for identical input — nothing here
 * depends on wall clock, iteration order, or platform.
 *
 * The default is a synchronous 64-bit FNV-1a rendered as hex. It is NOT a
 * cryptographic hash: it is a change-detection fingerprint, and a handful of
 * chunks per project is astronomically far from its birthday bound. Asset BLOB
 * content-addressing (dedup across projects) is a separate concern and will use
 * SHA-256 via Web Crypto — do not reuse this function for that.
 *
 * Callers that want a stronger algorithm can inject their own `HashFn`; the
 * codec never hard-codes this one.
 */

export type HashFn = (input: string) => string;

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

/**
 * Deterministic 64-bit FNV-1a over the UTF-8 code units of `input`, hex-encoded
 * and zero-padded to 16 chars. Pure and synchronous.
 */
export function hashString(input: string): string {
  let hash = FNV64_OFFSET;
  for (let i = 0; i < input.length; i++) {
    // Fold each UTF-16 code unit as two bytes (low, high) so the hash reflects
    // the full character range without a TextEncoder allocation.
    const code = input.charCodeAt(i);
    hash = ((hash ^ BigInt(code & 0xff)) * FNV64_PRIME) & MASK64;
    hash = ((hash ^ BigInt((code >> 8) & 0xff)) * FNV64_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, '0');
}
