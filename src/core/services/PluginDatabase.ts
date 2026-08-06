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
const DB_VERSION = 1;
const STORE_NAME = 'packages';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available.')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the plugin database.'));
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const req = fn(tx.objectStore(STORE_NAME));
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
};
