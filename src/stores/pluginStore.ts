/**
 * Installed plugins, persisted.
 *
 * The previous plugin host kept its installed set in a plain in-memory `Map`,
 * so every reload uninstalled everything the user had added. That is not a
 * missing nicety — it is what made the whole feature a demo: nothing a user
 * installed could survive long enough to be part of their workflow.
 *
 * The record stores the package's SOURCE, not a running instance. Starting a
 * plugin is the host's job and happens fresh each session, which means a plugin
 * that wedges the app cannot wedge it permanently: disable it and reload.
 */

import { create } from 'zustand';
import { PluginDatabase } from '@core/services/PluginDatabase';
import { parseManifest, type PluginManifest, type PluginPermission } from '@core/plugins/manifest';

export interface InstalledPlugin {
  manifest: PluginManifest;
  /** Package-relative path → file text (entry module, panel HTML, …).
   *  Empty until `hydrate()` has run — the bytes live in IndexedDB. */
  files: Record<string, string>;
  /** Package-relative path → raw bytes (images shipped with the package). */
  binaries?: Record<string, Uint8Array>;
  /** Exactly what the user approved. Re-approval is required when a new
   *  version asks for more — see `PluginHost.install`. */
  granted: PluginPermission[];
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
  /**
   * How the package arrived.
   *
   * Only used to decide whether to offer **Reload** — re-reading a folder is
   * the plugin author's edit/run loop, and re-picking a `.zip` is not the same
   * gesture. The browser cannot re-read a directory without a fresh user
   * gesture (a stored FileSystemHandle still needs its permission re-granted
   * after a restart), so Reload opens the picker; what it saves is the second
   * consent screen, which is the part that made iterating tedious.
   */
  source?: 'folder' | 'file' | 'registry';
  /**
   * The publisher key this copy was verified against, when it came from the
   * registry. This is the PIN: an update is only accepted if it is signed by
   * this same key, checked on this machine. Absent for a plugin installed from
   * a local file — there was no signature to check and nothing to promise.
   */
  publisherKey?: string;
}

/** Unchanged on purpose — an existing install must still be found on upgrade. */
export const STORE_KEY = 'motion-editor.plugins';

/**
 * Ceiling on the METADATA index only.
 *
 * Package bytes no longer live here (see `PluginDatabase`), so this now bounds
 * a few hundred bytes per plugin rather than a whole package. It stays because
 * `localStorage` is shared with the account token, and an unbounded index is
 * still an unbounded index.
 */
const MAX_TOTAL_BYTES = 1 * 1024 * 1024;

/** What is written to `localStorage`: everything but the package payload. */
type StoredMeta = Omit<InstalledPlugin, 'files' | 'binaries'> & {
  /** Present only in records written before packages moved to IndexedDB. */
  files?: Record<string, string>;
};

/**
 * Read the index, dropping anything malformed.
 *
 * This survived a reload, an app upgrade, and possibly a hand-edited
 * `localStorage`. A malformed record is DROPPED, never repaired and never
 * migrated — a half-understood record handed to the sandbox loader is exactly
 * the input this check exists to refuse.
 */
function loadMeta(): StoredMeta[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: StoredMeta[] = [];
    for (const p of parsed) {
      if (!p || typeof p !== 'object') continue;
      const record = p as StoredMeta;
      if (typeof record.manifest?.id !== 'string' || !Array.isArray(record.granted)) continue;
      const manifest = normaliseManifest(record.manifest);
      if (!manifest) continue;
      out.push({ ...record, manifest });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Bring a stored manifest up to the current format, or drop it.
 *
 * A record written by an API-1 build has a `panel: "panel.html"` string and no
 * `contributes` / `activationEvents` at all. Everything added in API 2 reads
 * `manifest.contributes.commands` directly — on purpose, because a key that is
 * sometimes absent and sometimes empty is two representations of one state — so
 * an unnormalised record does not degrade gracefully. It throws, inside
 * `pluginHost.configure()`, before the editor has rendered anything. The user's
 * plugins would not stop working; the app would.
 *
 * Normalising through `parseManifest` rather than a hand-written migration is
 * the point: a bespoke one would be a second definition of the manifest format,
 * free to drift from the real one and guaranteed to eventually. Anything the
 * validator would refuse today is dropped, exactly as a malformed record is —
 * repairing a record nobody fully understands is how one reaches the sandbox
 * loader.
 */
function normaliseManifest(stored: PluginManifest): PluginManifest | null {
  return parseManifest(stored).manifest;
}

function saveMeta(list: readonly InstalledPlugin[]): boolean {
  try {
    // `files` and `binaries` are stripped here. This is the whole point: a
    // package with a 2 MB texture in it must not be able to make the write
    // that persists the user's session fail.
    const meta = list.map(({ files: _files, binaries: _binaries, ...rest }) => rest);
    const json = JSON.stringify(meta);
    if (json.length > MAX_TOTAL_BYTES) return false;
    localStorage.setItem(STORE_KEY, json);
    return true;
  } catch {
    return false; // quota or private mode — the caller reports it
  }
}

/**
 * What `hydrate()` had to reconcile between the index and the payload store.
 *
 * Returned as data rather than only logged, so a UI can say "2 plugins were
 * removed because their package was missing" instead of the user finding out by
 * noticing something gone.
 */
export interface HydrationReport {
  restored: string[];
  /** Index entries with no payload. Listed, unstartable — so, removed. */
  droppedNoPayload: string[];
  /** Payloads with no index entry. Invisible, so nothing else could free them. */
  orphansRemoved: string[];
}

interface PluginStore {
  plugins: InstalledPlugin[];
  /** False until `hydrate()` has completed. `PluginHost.configure` refuses to
   *  run before it — see the note there. */
  hydrated: boolean;
  /** The last reconciliation, for a UI that wants to explain itself. */
  lastHydration: HydrationReport | null;
  /** Insert or replace by manifest id. Returns false when it could not persist. */
  put(entry: InstalledPlugin): boolean;
  remove(id: string): void;
  setEnabled(id: string, enabled: boolean): void;
  /** Narrow (or restore) what the user allows. Always a subset of the manifest
   *  — `PluginHost.setGranted` intersects before calling this. */
  setGranted(id: string, granted: PluginPermission[]): void;
  get(id: string): InstalledPlugin | undefined;
  /** Load package payloads from IndexedDB, migrating any legacy record found
   *  in `localStorage`. Must complete before `pluginHost.configure()`. */
  hydrate(): Promise<void>;
  /** Re-read the index from `localStorage`, re-running normalisation. Exists
   *  for tests, which need to set up a stored record and then load it. */
  rehydrateFromStorage(): Promise<void>;
}

/**
 * The index, read synchronously at module load.
 *
 * Payloads are absent until `hydrate()` resolves, so `files` starts empty. That
 * is deliberate rather than unfortunate: the manifest is what the palette, the
 * menu and the manager need, and all three can be right on the first frame
 * while the bytes are still coming off disk. Only STARTING a plugin needs the
 * bytes, and starting is already asynchronous.
 */
function initialPlugins(): InstalledPlugin[] {
  return loadMeta().map((m) => ({ ...m, files: m.files ?? {}, binaries: {} }));
}

export const usePluginStore = create<PluginStore>((set, get) => ({
  plugins: initialPlugins(),
  hydrated: false,
  lastHydration: null,

  put: (entry) => {
    const next = [...get().plugins.filter((p) => p.manifest.id !== entry.manifest.id), entry];
    const ok = saveMeta(next);
    if (!ok) return false;
    set({ plugins: next });
    // The payload goes to IndexedDB in the background. The metadata write above
    // is what `install` reports on, because it is the one that decides whether
    // the plugin exists at all; a payload that fails to persist surfaces on the
    // next launch as a plugin that cannot start, with its own error.
    void PluginDatabase.put(entry.manifest.id, {
      files: entry.files,
      binaries: entry.binaries ?? {},
    });
    return true;
  },

  remove: (id) => {
    const next = get().plugins.filter((p) => p.manifest.id !== id);
    saveMeta(next);
    void PluginDatabase.remove(id);
    set({ plugins: next });
  },

  setEnabled: (id, enabled) => {
    const next = get().plugins.map((p) => (p.manifest.id === id ? { ...p, enabled } : p));
    saveMeta(next);
    set({ plugins: next });
  },

  setGranted: (id, granted) => {
    const next = get().plugins.map((p) =>
      p.manifest.id === id ? { ...p, granted: [...granted], updatedAt: Date.now() } : p,
    );
    saveMeta(next);
    set({ plugins: next });
  },

  get: (id) => get().plugins.find((p) => p.manifest.id === id),

  rehydrateFromStorage: async () => {
    set({ plugins: initialPlugins(), hydrated: false, lastHydration: null });
  },

  hydrate: async () => {
    const current = get().plugins;

    /**
     * Reconciling two stores that can disagree.
     *
     * An index entry and its payload are written separately, so any crash,
     * quota failure or manual `localStorage` edit between the two leaves them
     * out of step — in both directions:
     *
     *   • **Index without payload.** A plugin the manager lists, that cannot
     *     start, forever. Left alone it presents as "this plugin is broken"
     *     with no cause and no cure but a manual uninstall.
     *   • **Payload without index.** Megabytes of a plugin the user believes
     *     they removed, invisible from every surface, kept until the origin is
     *     cleared.
     *
     * Both are resolved here, and both are REPORTED rather than swallowed —
     * silently dropping something a user installed is exactly the behaviour
     * that makes people distrust a plugin manager.
     */
    const report: HydrationReport = { restored: [], droppedNoPayload: [], orphansRemoved: [] };

    const settled = await Promise.all(
      current.map(async (p) => {
        // A record still carrying its files came from before payloads moved.
        // Move it, then let the `saveMeta` below drop it from localStorage.
        if (Object.keys(p.files).length > 0) {
          await PluginDatabase.put(p.manifest.id, { files: p.files, binaries: p.binaries ?? {} });
          report.restored.push(p.manifest.id);
          return p;
        }
        const payload = await PluginDatabase.get(p.manifest.id);
        if (!payload) return null;
        report.restored.push(p.manifest.id);
        return { ...p, files: payload.files, binaries: payload.binaries };
      }),
    );

    const hydrated: InstalledPlugin[] = [];
    settled.forEach((entry, i) => {
      if (entry) hydrated.push(entry);
      else report.droppedNoPayload.push(current[i]!.manifest.id);
    });

    // Orphan payloads: bytes with no index entry pointing at them.
    const known = new Set(hydrated.map((p) => p.manifest.id));
    for (const id of await PluginDatabase.keys()) {
      if (known.has(id)) continue;
      await PluginDatabase.remove(id);
      report.orphansRemoved.push(id);
    }

    set({ plugins: hydrated, hydrated: true, lastHydration: report });
    // Rewrite the index without the payloads. Done AFTER the moves above, so a
    // failure anywhere in between leaves the legacy record intact rather than
    // stranding a plugin with its bytes nowhere.
    saveMeta(hydrated);

    if (report.droppedNoPayload.length > 0 || report.orphansRemoved.length > 0) {
      // The store must not import the UI. `lastHydration` is the structured
      // channel a surface should read; this is the breadcrumb for a developer.
      console.warn(
        '[plugins] storage reconciled:',
        `dropped ${report.droppedNoPayload.length} without a package`,
        `(${report.droppedNoPayload.join(', ') || 'none'});`,
        `removed ${report.orphansRemoved.length} orphaned package(s)`,
        `(${report.orphansRemoved.join(', ') || 'none'})`,
      );
    }
  },
}));
