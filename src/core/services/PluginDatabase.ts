/**
 * Where installed plugin PACKAGES live.
 *
 * They used to live in `localStorage`, as JSON, alongside the account bearer
 * JWT and the user's plaintext AI provider keys — all three sharing one origin
 * quota of a few megabytes. That was already tight for source-only packages.
 * With binary media allowed in a package it stops being a size question and
 * becomes a safety one: a plugin big enough to fill the quota can make the
 * write that persists the user's session fail.
 *
 * So the bytes move here. What stays in `localStorage` is the METADATA index —
 * manifest, grants, enabled flag — which is small, bounded, and needs to be
 * readable synchronously at boot so the palette is complete on the first frame.
 * See `pluginStore.ts` for that half.
 */

export interface PluginPayload {
  /** Package-relative path → file text. */
  files: Record<string, string>;
  /** Package-relative path → raw bytes. */
  binaries: Record<string, Uint8Array>;
}

const DB_NAME = 'motion-plugins-db';
/**
 * 2 adds the `storage` object store — see `pluginStorage.ts`.
 *
 * A second store rather than a key inside `packages`, because the two have
 * opposite lifetimes: a package is replaced wholesale on update and deleted on
 * uninstall, while a plugin's settings are exactly what should survive both.
 * Sharing a record would make "update this plugin" and "forget what it
 * remembered" the same write.
 *
 * 3 adds the `index` store — the metadata index, moved out of `localStorage`.
 *
 * Moved so it can be written in the SAME transaction as the payload. While the
 * two lived in different storage systems there was no way to make them commit
 * together, and `hydrate()` existed to clean up after the crashes that left
 * them disagreeing. IndexedDB commits atomically across the stores a
 * transaction names, so that class of inconsistency stops being producible.
 */
const DB_VERSION = 3;
const STORE_NAME = 'packages';
const STORAGE_STORE = 'storage';
/** One record holds every plugin's global bag. See `putStorage`. */
const STORAGE_KEY = 'all';
const INDEX_STORE = 'index';
/** One record holds the whole index — it is read and written as a unit. */
const INDEX_KEY = 'all';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available.')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Both guarded, not just the new one: an upgrade runs from whatever
      // version the user is on, including a fresh install at 0.
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      if (!db.objectStoreNames.contains(STORAGE_STORE)) db.createObjectStore(STORAGE_STORE);
      if (!db.objectStoreNames.contains(INDEX_STORE)) db.createObjectStore(INDEX_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the plugin database.'));
  });
}

function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
  storeName: string = STORE_NAME,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const req = fn(tx.objectStore(storeName));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('Plugin database request failed.'));
        tx.oncomplete = () => db.close();
      }),
  );
}

export const PluginDatabase = {
  async get(id: string): Promise<PluginPayload | null> {
    try {
      const v = await run<PluginPayload | undefined>('readonly', (s) => s.get(id));
      return v ?? null;
    } catch {
      // A missing or blocked database is not a reason to lose the editor. The
      // plugin simply will not start, and the manager says so.
      return null;
    }
  },

  async put(id: string, payload: PluginPayload): Promise<boolean> {
    try {
      await run('readwrite', (s) => s.put(payload, id));
      return true;
    } catch {
      return false;
    }
  },

  async remove(id: string): Promise<void> {
    try { await run('readwrite', (s) => s.delete(id)); } catch { /* already gone */ }
  },

  /**
   * Every plugin id with a payload stored.
   *
   * Needed to find ORPHANS — payloads whose index entry is gone. Nothing else
   * can: the index is the only list of what should exist, so a payload missing
   * from it is invisible from every other direction and would sit on the user's
   * disk forever.
   */
  async keys(): Promise<string[]> {
    try {
      const ks = await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
      return ks.filter((k): k is string => typeof k === 'string');
    } catch {
      return [];
    }
  },

  /**
   * Every plugin's `global` storage bag, as one record.
   *
   * One record rather than a row per plugin, and the reason is the read: the
   * host loads all of it once at boot so `storage.get` can answer
   * synchronously, and a per-plugin layout would turn that into N requests
   * against a database that has to be opened anyway. The whole thing is small
   * by construction — 1 MB per plugin, and a machine with twenty plugins that
   * each filled their quota is not the shape this is for.
   */
  async getStorage(): Promise<unknown> {
    try {
      return await run<unknown>('readonly', (s) => s.get(STORAGE_KEY), STORAGE_STORE);
    } catch {
      // No database, blocked, or a schema this build does not understand. A
      // plugin loses its remembered settings, which is a bad day and not a
      // reason to fail the editor's boot.
      return null;
    }
  },

  async putStorage(value: unknown): Promise<boolean> {
    try {
      await run('readwrite', (s) => s.put(value, STORAGE_KEY), STORAGE_STORE);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * The metadata index — manifests, grants, pins — as one record.
   *
   * It used to live in `localStorage`, written separately from the payload, and
   * that separation is the entire reason `hydrate()` reconciles in both
   * directions at boot: a crash or a quota failure between the two writes left
   * an index entry with no package, or a package no index points at.
   */
  async getIndex(): Promise<unknown> {
    try {
      return await run<unknown>('readonly', (s) => s.get(INDEX_KEY), INDEX_STORE);
    } catch {
      return null;
    }
  },

  /**
   * Write one plugin's payload AND the whole index in a single transaction.
   *
   * This is the point of 4.2. IndexedDB commits a transaction atomically across
   * every store it names, so the torn state — index without payload, payload
   * without index — cannot be produced by a crash between two writes, because
   * there are no longer two writes.
   *
   * `hydrate()` stays anyway. It still catches the states this cannot: a quota
   * failure that aborts the whole transaction (leaving the previous consistent
   * state, which may still be missing something the caller believes it wrote),
   * a database cleared by the browser, and every record written by a build that
   * predates this. What disappears is the class where OUR code produced the
   * inconsistency.
   */
  async putPackageAndIndex(id: string, payload: PluginPayload, index: unknown): Promise<boolean> {
    try {
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE_NAME, INDEX_STORE], 'readwrite');
        // Resolved on `oncomplete`, not on the last request's `onsuccess`: a
        // request can succeed and the transaction still abort, and reporting
        // success there is precisely the torn write this method removes.
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error ?? new Error('aborted')); };
        tx.onerror = () => { db.close(); reject(tx.error ?? new Error('failed')); };
        tx.objectStore(STORE_NAME).put(payload, id);
        tx.objectStore(INDEX_STORE).put(index, INDEX_KEY);
      });
      return true;
    } catch {
      return false;
    }
  },

  /** Remove one plugin's payload and rewrite the index, in one transaction. */
  async removePackageAndIndex(id: string, index: unknown): Promise<boolean> {
    try {
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE_NAME, INDEX_STORE], 'readwrite');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error ?? new Error('aborted')); };
        tx.onerror = () => { db.close(); reject(tx.error ?? new Error('failed')); };
        tx.objectStore(STORE_NAME).delete(id);
        tx.objectStore(INDEX_STORE).put(index, INDEX_KEY);
      });
      return true;
    } catch {
      return false;
    }
  },

  /** Rewrite the index alone — for edits that touch no package bytes. */
  async putIndex(index: unknown): Promise<boolean> {
    try {
      await run('readwrite', (s) => s.put(index, INDEX_KEY), INDEX_STORE);
      return true;
    } catch {
      return false;
    }
  },
};
