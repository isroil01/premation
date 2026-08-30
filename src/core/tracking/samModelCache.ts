/**
 * Where the Object Matte model lives between launches.
 *
 * A SAM-class ONNX file is tens of megabytes. Downloading it once per session
 * would be absurd, and shipping it in the app would multiply the installer's
 * size for a feature most projects never touch — so it is fetched on demand,
 * once, and kept here.
 *
 * IndexedDB rather than a file on disk, deliberately. It works identically in
 * the desktop shell and a browser tab, it needs no new privileged IPC channel
 * (the local edition's whole claim is that its privileged surface is small),
 * and the browser evicts it under storage pressure — which for a re-downloadable
 * cache is the correct behaviour rather than a bug.
 *
 * The record keeps the source URL alongside the bytes. Not for re-fetching: for
 * ANSWERING. "Which model is this, and where did it come from" is a question a
 * user is entitled to ask of a neural net that runs on their footage, and a
 * cache that cannot answer it is a black box.
 */

const DB_NAME = 'motion-models-db';
const STORE_NAME = 'models';
const DB_VERSION = 1;

/** The one key this cache uses. One model, replaced rather than accumulated. */
export const SAM_MODEL_KEY = 'sam-object-matte';

export interface CachedModel {
  id: string;
  /** The ONNX bytes. */
  data: Blob;
  /** Where it came from, verbatim. */
  sourceUrl: string;
  /** Epoch millis. Shown so "when did I install this" is answerable. */
  installedAt: number;
  bytes: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const ModelCache = {
  /**
   * The cached model, or null.
   *
   * Never throws. A browser with IndexedDB disabled, a private window, or a
   * quota failure all mean the same thing to every caller — "no cached model" —
   * and turning that into an exception would make a missing optional feature
   * able to break a boot path.
   */
  async get(id: string = SAM_MODEL_KEY): Promise<CachedModel | null> {
    try {
      const db = await openDb();
      return await new Promise<CachedModel | null>((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
        request.onsuccess = () => resolve((request.result as CachedModel | undefined) ?? null);
        request.onerror = () => reject(request.error);
      });
    } catch {
      return null;
    }
  },

  async put(model: CachedModel): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(model);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },

  async remove(id: string = SAM_MODEL_KEY): Promise<void> {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } catch {
      /* nothing cached, or no storage — either way there is nothing to remove */
    }
  },
};
