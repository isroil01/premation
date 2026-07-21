/**
 * SettingsManager — general-purpose persisted key/value configuration service.
 *
 * This is the low-level settings substrate any subsystem can use to persist a
 * bit of config (theme mode, recent projects, panel prefs, engine options).
 * It is distinct from the reactive `preferenceStore`, which is the React-facing
 * slice of user-visible UI preferences; that store can layer on top of this.
 *
 * Storage is abstracted behind `SettingsBackend` so localStorage / a config
 * file / IndexedDB can be swapped without touching callers.
 */

export interface SettingsBackend {
  read(): Record<string, unknown> | null;
  write(all: Record<string, unknown>): void;
}

/** Default synchronous localStorage backend. */
export function createLocalStorageBackend(key = 'motion-editor.settings'): SettingsBackend {
  return {
    read() {
      try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    },
    write(all) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(all));
      } catch {
        /* ignore quota / serialization errors */
      }
    },
  };
}

/** In-memory backend (tests / SSR / headless). */
export function createMemoryBackend(): SettingsBackend {
  let store: Record<string, unknown> | null = null;
  return {
    read: () => store,
    write: (all) => { store = { ...all }; },
  };
}

export type SettingsListener<T> = (value: T) => void;

export class SettingsManager {
  private cache: Record<string, unknown>;
  private readonly listeners = new Map<string, Set<SettingsListener<unknown>>>();

  constructor(private readonly backend: SettingsBackend = createLocalStorageBackend()) {
    this.cache = backend.read() ?? {};
    if ('rendering.backend' in this.cache) {
      delete this.cache['rendering.backend'];
      try {
        this.backend.write(this.cache);
      } catch {
        /* ignore write failures during boot */
      }
    }
  }

  get<T>(key: string, fallback: T): T {
    return key in this.cache ? (this.cache[key] as T) : fallback;
  }

  has(key: string): boolean {
    return key in this.cache;
  }

  set<T>(key: string, value: T): void {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    this.backend.write(this.cache);
    this.fire(key, value);
  }

  delete(key: string): void {
    if (!(key in this.cache)) return;
    delete this.cache[key];
    this.backend.write(this.cache);
    this.fire(key, undefined);
  }

  /** Subscribe to changes for a single key. Returns an unsubscribe fn. */
  observe<T>(key: string, listener: SettingsListener<T>): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener as SettingsListener<unknown>);
    return () => { set?.delete(listener as SettingsListener<unknown>); };
  }

  /** All keys currently stored. */
  keys(): ReadonlyArray<string> {
    return Object.keys(this.cache);
  }

  private fire(key: string, value: unknown): void {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const l of set) {
      try { l(value); } catch { /* isolate */ }
    }
  }
}
