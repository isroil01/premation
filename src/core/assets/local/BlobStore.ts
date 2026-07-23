/**
 * BlobStore — content-addressed binary storage for asset bytes.
 *
 * Keyed by SHA-256 hash: a blob is immutable and stored once. The bundle lays
 * blobs out as `blobs/<hash[0:2]>/<hash>` (fan-out to keep any one directory
 * small). Two backends will implement this:
 *   - `MemoryBlobStore` (below) — pure, for tests / the browser virtual FS.
 *   - a disk-backed store in Electron main (binary IPC) — the desktop backend,
 *     device-bound (binary write needs new IPC beyond the string `bundle:*`).
 */

export interface BlobStore {
  has(hash: string): Promise<boolean>;
  put(hash: string, bytes: Uint8Array): Promise<void>;
  read(hash: string): Promise<Uint8Array | null>;
  delete(hash: string): Promise<void>;
  /** Every stored hash — used by GC to find blobs no record references. */
  list(): Promise<string[]>;
}

/** Relative path of a blob within a bundle. */
export function blobPathFor(hash: string): string {
  return `blobs/${hash.slice(0, 2)}/${hash}`;
}

/** In-memory content store for tests / browser. */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  /** Count of physical writes — lets tests assert dedup (a re-import writes 0). */
  putCount = 0;

  async has(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }
  async put(hash: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(hash, bytes);
    this.putCount++;
  }
  async read(hash: string): Promise<Uint8Array | null> {
    return this.blobs.get(hash) ?? null;
  }
  async delete(hash: string): Promise<void> {
    this.blobs.delete(hash);
  }
  async list(): Promise<string[]> {
    return [...this.blobs.keys()];
  }
}
