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
import type { PluginManifest, PluginPermission } from '@core/plugins/manifest';

export interface InstalledPlugin {
  manifest: PluginManifest;
  /** Package-relative path → file text (entry module, panel HTML, …). */
  files: Record<string, string>;
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

const STORE_KEY = 'motion-editor.plugins';

/** localStorage is shared with the rest of the app; a runaway package must not
 *  be able to spend the whole quota. */
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

function load(): InstalledPlugin[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Shape-check on read: this survived a reload, an app upgrade, and possibly
    // a hand-edited localStorage. A malformed record must be dropped, not
    // handed to the sandbox loader.
    return parsed.filter((p): p is InstalledPlugin =>
      !!p && typeof p === 'object'
      && typeof (p as InstalledPlugin).manifest?.id === 'string'
      && typeof (p as InstalledPlugin).files === 'object'
      && Array.isArray((p as InstalledPlugin).granted),
    );
  } catch {
    return [];
  }
}

function save(list: readonly InstalledPlugin[]): boolean {
  try {
    const json = JSON.stringify(list);
    if (json.length > MAX_TOTAL_BYTES) return false;
    localStorage.setItem(STORE_KEY, json);
    return true;
  } catch {
    return false; // quota or private mode — the caller reports it
  }
}

interface PluginStore {
  plugins: InstalledPlugin[];
  /** Insert or replace by manifest id. Returns false when it could not persist. */
  put(entry: InstalledPlugin): boolean;
  remove(id: string): void;
  setEnabled(id: string, enabled: boolean): void;
  /** Narrow (or restore) what the user allows. Always a subset of the manifest
   *  — `PluginHost.setGranted` intersects before calling this. */
  setGranted(id: string, granted: PluginPermission[]): void;
  get(id: string): InstalledPlugin | undefined;
}

export const usePluginStore = create<PluginStore>((set, get) => ({
  plugins: load(),

  put: (entry) => {
    const next = [...get().plugins.filter((p) => p.manifest.id !== entry.manifest.id), entry];
    const ok = save(next);
    if (ok) set({ plugins: next });
    return ok;
  },

  remove: (id) => {
    const next = get().plugins.filter((p) => p.manifest.id !== id);
    save(next);
    set({ plugins: next });
  },

  setEnabled: (id, enabled) => {
    const next = get().plugins.map((p) => (p.manifest.id === id ? { ...p, enabled } : p));
    save(next);
    set({ plugins: next });
  },

  setGranted: (id, granted) => {
    const next = get().plugins.map((p) =>
      p.manifest.id === id ? { ...p, granted: [...granted], updatedAt: Date.now() } : p,
    );
    save(next);
    set({ plugins: next });
  },

  get: (id) => get().plugins.find((p) => p.manifest.id === id),
}));
