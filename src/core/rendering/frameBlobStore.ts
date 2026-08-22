/**
 * Where cached frames go when they will not fit in RAM.
 *
 * An interface rather than a direct IndexedDB call so the tier above it — the
 * budget, the LRU, the look-ahead — is testable without a database. That is not
 * hypothetical convenience: this repo has no `fake-indexeddb`, and jsdom has no
 * `indexedDB` at all, so a store wired straight to IDB would have made the whole
 * eviction policy untestable and it would have shipped unverified.
 *
 * It also leaves room for the desktop build to swap in a real filesystem store
 * later (frames on disk under userData, no quota negotiation) without touching
 * the policy above.
 */

export interface StoredFrame {
  /** Encoded image bytes — PNG, so a cached frame is the frame. */
  blob: Blob;
  bytes: number;
}

export interface FrameBlobStore {
  get(key: string): Promise<StoredFrame | undefined>;
  put(key: string, frame: StoredFrame): Promise<void>;
  delete(keys: ReadonlyArray<string>): Promise<void>;
  /** Every key currently held. Used to reconcile the index at boot. */
  keys(): Promise<string[]>;
  clear(): Promise<void>;
  /**
   * The persisted index of what the store holds, as opaque JSON — which
   * generations, which frames, how many bytes. OPTIONAL: a store without a
   * manifest still works, but the cache then cannot trust anything a previous
   * session left (it cannot know the byte sizes without reading every blob),
   * so it falls back to purging at open. Present on the IndexedDB store.
   */
  readManifest?(): Promise<string | null>;
  writeManifest?(json: string): Promise<void>;
}

/** Reserved key the manifest lives under — never a frame. */
export const MANIFEST_KEY = '__manifest__';

const DB_NAME = 'motion-frame-cache-db';
const STORE_NAME = 'frames';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** The production store. Every method resolves rather than throwing on a
 *  missing/blocked database: a preview cache that cannot write is slower, not
 *  broken, and must never take the viewport down with it. */
export class IndexedDbFrameStore implements FrameBlobStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.db) this.db = openDb();
    return this.db;
  }

  private async tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => Promise<T>): Promise<T | undefined> {
    try {
      const db = await this.open();
      return await run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
    } catch {
      // A blocked or quota-exhausted cache degrades to "no disk tier".
      return undefined;
    }
  }

  async get(key: string): Promise<StoredFrame | undefined> {
    return this.tx('readonly', (s) => promisify<StoredFrame | undefined>(s.get(key)));
  }

  async put(key: string, frame: StoredFrame): Promise<void> {
    await this.tx('readwrite', (s) => promisify(s.put(frame, key)));
  }

  async delete(keys: ReadonlyArray<string>): Promise<void> {
    await this.tx('readwrite', async (s) => {
      for (const k of keys) void s.delete(k);
    });
  }

  async keys(): Promise<string[]> {
    const all = (await this.tx('readonly', (s) => promisify(s.getAllKeys()))) as string[] ?? [];
    return all.filter((k) => k !== MANIFEST_KEY);
  }

  async clear(): Promise<void> {
    await this.tx('readwrite', (s) => promisify(s.clear()));
  }

  async readManifest(): Promise<string | null> {
    const v = await this.tx('readonly', (s) => promisify(s.get(MANIFEST_KEY)));
    return typeof v === 'string' ? v : null;
  }

  async writeManifest(json: string): Promise<void> {
    await this.tx('readwrite', (s) => promisify(s.put(json, MANIFEST_KEY)));
  }
}

/** True when this runtime can back a disk tier at all. */
export function frameStoreAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}
