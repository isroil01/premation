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
import type { NativeTrust } from '@core/plugins/runtimeTier';
import { installedSyncSink } from '@core/plugins/installedSyncSink';
import type { SyncReport } from '@core/plugins/installedSync';

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
  /**
   * The user's decision to let this plugin run UNSANDBOXED.
   *
   * Absent for every sandboxed plugin, and absent for a native one that has
   * not been agreed to yet — which is the state that keeps it from running.
   * `granted` is the wrong home for this: that list is a set of bounded
   * capabilities the host enforces one call at a time, and this is a single
   * unbounded yes that removes the thing doing the enforcing. Storing it as
   * another permission string would let any code path that widens a grant
   * widen this too.
   *
   * Carries the tier and version it was given for. See `runtimeTier.ts` —
   * a plugin that was sandboxed and turns native on update has to ask again,
   * and that check reads these fields rather than the record's existence.
   */
  nativeTrust?: NativeTrust;
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
  /**
   * The key the registry said was authorised to take over, recorded at install
   * and refreshed on every update — BEFORE any rotation uses it.
   *
   * That ordering is the whole point. Without it, the first time this machine
   * hears of a replacement key is the response asking it to trust that key,
   * which is no evidence at all — so every rotation looked identical, including
   * the one an attacker with a stolen publisher account most wants shown. With
   * it, "this key was authorised months ago" becomes something this machine
   * checked for itself rather than something the server asserts.
   */
  nextPublisherKey?: string;
  /**
   * How that successor was authorised: `backup` at first publish, before there
   * was an install base to endanger, or `dashboard` later, behind the account
   * password.
   *
   * Not the same claim. A `backup` key was chosen when nobody could be harmed
   * by the choice; a `dashboard` key was chosen by whoever held the account at
   * the time, which is exactly what a thief holds.
   */
  nextPublisherKeyMethod?: 'backup' | 'dashboard';
  /**
   * Security-relevant things that happened to this plugin on this machine.
   *
   * Small and append-only. It exists because the safest rotation path is
   * SILENT — a key matching one authorised at first publish is accepted with no
   * prompt — and something has to be able to say afterwards that it happened. A
   * change nobody was asked about and nobody can find later is indistinguishable
   * from no change at all.
   */
  securityEvents?: Array<{ at: number; text: string }>;
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
    return validateMeta(JSON.parse(raw) as unknown) ?? [];
  } catch {
    return [];
  }
}

/**
 * Validate a stored index, whatever it was read from.
 *
 * Returns `null` for "there is nothing here", which is a different answer from
 * `[]` — "there IS an index and it lists no plugins". `hydrate()` needs the
 * distinction to decide whether to migrate from `localStorage`: migrating over
 * a legitimately empty IndexedDB record would resurrect plugins the user
 * uninstalled after the move.
 */
function validateMeta(parsed: unknown): StoredMeta[] | null {
  if (!Array.isArray(parsed)) return null;
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

/** The index as it is stored: everything except the package bytes. */
function toMeta(list: readonly InstalledPlugin[]): StoredMeta[] {
  // `files` and `binaries` are stripped here. This is the whole point: a
  // package with a 2 MB texture in it must not be able to make the write that
  // persists the user's session fail.
  return list.map(({ files: _files, binaries: _binaries, ...rest }) => rest);
}

/**
 * Persist the index.
 *
 * ── Why this is no longer `localStorage`, and why it still returns sync ─────
 *
 * The index moved into IndexedDB so it can be written in the SAME transaction
 * as the payload (see `PluginDatabase.putPackageAndIndex`). While the two lived
 * in different storage systems there was no way to commit them together, and a
 * crash between the writes left an index entry with no package or a package no
 * index pointed at — the entire reason `hydrate()` reconciles both directions.
 *
 * This function keeps its synchronous signature and its boolean, because every
 * caller is a store action that must decide immediately whether the change
 * happened. The IndexedDB write is issued and not awaited; what it returns is
 * whether the index is within its size bound, which is the only failure a
 * caller can act on. A rejected write surfaces at the next boot through
 * `hydrate()`, exactly as it always did.
 *
 * The one caller that must NOT use this is `put`, which has a payload to write
 * atomically alongside the index.
 */
function saveMeta(list: readonly InstalledPlugin[]): boolean {
  try {
    const meta = toMeta(list);
    if (JSON.stringify(meta).length > MAX_TOTAL_BYTES) return false;
    void PluginDatabase.putIndex(meta);
    return true;
  } catch {
    return false;
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
  /**
   * Set when a package could not be written to this machine.
   *
   * The whole reason this field exists: that failure used to be discarded, and
   * a discarded storage failure looks exactly like a plugin that uninstalls
   * itself overnight. Cleared by the next successful write.
   */
  persistError: string | null;
  /**
   * The last reconcile against the account, or null before one has run.
   *
   * Held so the plugin manager can offer to restore what this machine is
   * missing. Kept OUT of `plugins`: a restorable entry is a name and a
   * version, not an installed package, and putting it in the same list would
   * make something the user has not agreed to install indistinguishable from
   * something they have.
   */
  lastSync: SyncReport | null;
  /** Record a reconcile result. */
  noteSync: (report: SyncReport) => void;
  /** Insert or replace by manifest id. Returns false when it could not persist. */
  put(entry: InstalledPlugin): boolean;
  remove(id: string): void;
  setEnabled(id: string, enabled: boolean): void;
  /** Narrow (or restore) what the user allows. Always a subset of the manifest
   *  — `PluginHost.setGranted` intersects before calling this. */
  setGranted(id: string, granted: PluginPermission[]): void;
  /**
   * Record — or withdraw — the decision to let a plugin run unsandboxed.
   *
   * Deliberately its own action rather than a field on `setGranted`. That one
   * narrows a bounded list and is called from several places; this grants the
   * unbounded thing and should be greppable to exactly the surfaces that ask
   * the question.
   *
   * `null` withdraws, which is what "Sandbox this plugin again" does. The
   * plugin keeps working — as a sandboxed plugin, refused at whatever it was
   * doing that needed more.
   */
  setNativeTrust(id: string, trust: NativeTrust | null): void;
  /**
   * Append to a plugin's security log. See `InstalledPlugin.securityEvents`.
   *
   * A store action rather than a field the caller mutates, because the one
   * write that matters is the SILENT one — a backup-key rotation the user was
   * never asked about — and it must not be possible to accept that rotation
   * without the record being made in the same place.
   */
  noteSecurityEvent(id: string, text: string): void;
  get(id: string): InstalledPlugin | undefined;
  /** Load package payloads from IndexedDB, migrating any legacy record found
   *  in `localStorage`. Must complete before `pluginHost.configure()`. */
  hydrate(): Promise<void>;
  /** Re-read the index from `localStorage`, re-running normalisation. Exists
   *  for tests, which need to set up a stored record and then load it. */
  rehydrateFromStorage(): Promise<void>;
}

/**
 * The index at module load, from `localStorage` only.
 *
 * ── Why this still reads localStorage after the move ────────────────────────
 *
 * The index now LIVES in IndexedDB, which cannot be read synchronously — so
 * the first frame can no longer be given the real list. That was a genuine
 * property and it is bought back by `hydrate()`, which every surface already
 * waits on (`configure()` refuses to run before it) and which now loads the
 * index as well as the payloads.
 *
 * What remains here is the MIGRATION source: a machine upgrading from a build
 * that wrote `localStorage` still has its list there, and reading it at module
 * load means the palette is correct on the first frame of the upgrade run too.
 * `hydrate()` moves it and clears it, after which this returns nothing forever.
 */
function legacyPlugins(): InstalledPlugin[] {
  return loadMeta().map((m) => ({ ...m, files: m.files ?? {}, binaries: {} }));
}

export const usePluginStore = create<PluginStore>((set, get) => ({
  plugins: legacyPlugins(),
  hydrated: false,
  lastHydration: null,
  persistError: null,
  lastSync: null,

  put: (entry) => {
    const next = [...get().plugins.filter((p) => p.manifest.id !== entry.manifest.id), entry];
    const meta = toMeta(next);
    if (JSON.stringify(meta).length > MAX_TOTAL_BYTES) return false;
    set({ plugins: next });
    /*
      Payload and index in ONE transaction.

      This is what 4.2 bought. Before, they were two writes to two storage
      systems, and a crash or a quota failure between them left the pair
      disagreeing in one of two directions — an index entry whose package is
      missing (a plugin that lists but cannot start, forever) or a package no
      index points at (megabytes of software the user believes they removed).
      IndexedDB commits across both stores or neither.

      Still not awaited, and the returned boolean is still about the SIZE bound
      rather than the write: `install` has to answer now. What changed is that a
      failure can no longer be partial.

      What is no longer DISCARDED is whether it worked. `putPackageAndIndex`
      has always returned false on failure and this call threw it away, so a
      write that failed for any reason produced a plugin that worked all
      session and was gone at the next boot — `hydrate()` finds an index entry
      with no payload and drops it, reporting only to a console nobody has open
      in a packaged build. That is exactly the "I have to reinstall my plugins
      every time" report. It now lands in `persistError`, which the plugin
      manager shows.
    */
    void PluginDatabase.putPackageAndIndex(
      entry.manifest.id,
      { files: entry.files, binaries: entry.binaries ?? {} },
      meta,
    ).then(
      (ok) => {
        set({
          persistError: ok
            ? null
            : `“${entry.manifest.name}” could not be saved to this machine — it will be gone when you restart.`,
        });
      },
      () => {
        set({
          persistError: `“${entry.manifest.name}” could not be saved to this machine — it will be gone when you restart.`,
        });
      },
    );
    // The account's durable copy. Failing here is NOT an install failure — the
    // plugin is on the machine and works — so it is deliberately silent: the
    // next `reconcileInstalledSet` pushes it up, and a signed-out or
    // local-edition user has nothing to push to.
    installedSyncSink().record(entry.manifest.id, {
      version: entry.manifest.version,
      enabled: entry.enabled,
      granted: entry.granted,
    });
    return true;
  },

  remove: (id) => {
    const next = get().plugins.filter((p) => p.manifest.id !== id);
    // One transaction, for the same reason `put` uses one: a delete that took
    // the package but not the index entry leaves a plugin listed forever with
    // nothing behind it, which reads as "broken" rather than "removed".
    void PluginDatabase.removePackageAndIndex(id, toMeta(next));
    // Uninstalling is the one direction that must reach the account, or the
    // next reconcile offers to restore what the user just removed.
    installedSyncSink().forget(id);
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

  setNativeTrust: (id, trust) => {
    const next = get().plugins.map((p) => {
      if (p.manifest.id !== id) return p;
      // Removed, not set to undefined-in-place: a key present with an
      // undefined value survives `JSON.stringify` as an absent key anyway, but
      // the in-memory record would still carry it and `'nativeTrust' in p`
      // would answer wrong for anything that checks that way.
      const { nativeTrust: _drop, ...rest } = p;
      return trust ? { ...rest, nativeTrust: trust, updatedAt: Date.now() }
        : { ...rest, updatedAt: Date.now() };
    });
    saveMeta(next);
    set({ plugins: next });
  },

  noteSecurityEvent: (id, text) => {
    const next = get().plugins.map((p) => {
      if (p.manifest.id !== id) return p;
      // Bounded. This is append-only and lives in the metadata index, which is
      // shared with the account token — an unbounded log on a plugin that
      // rotates keys in a loop is a way to fill that quota.
      const events = [...(p.securityEvents ?? []), { at: Date.now(), text }].slice(-20);
      return { ...p, securityEvents: events };
    });
    saveMeta(next);
    set({ plugins: next });
  },

  noteSync: (report) => set({ lastSync: report }),

  get: (id) => get().plugins.find((p) => p.manifest.id === id),

  rehydrateFromStorage: async () => {
    // Re-reads the LEGACY location, which is what this seam is for: tests set
    // up a `localStorage` record and then load it. `hydrate()` is what reads
    // the real store, and it runs next.
    set({ plugins: legacyPlugins(), hydrated: false, lastHydration: null });
  },

  hydrate: async () => {
    /*
      The index comes from IndexedDB now, and from `localStorage` exactly once.

      A machine upgrading from a build that wrote the index to `localStorage`
      has its list there and nowhere else. It is read at module load (see
      `legacyPlugins`), moved here, and the old key is cleared only AFTER the
      new record is verified back — a clear-then-write would lose every
      installed plugin if the write failed, which is the one outcome worse than
      not migrating.

      The stored records go through `loadMeta`'s validation either way. A record
      that survived a reload, an app upgrade and possibly a hand-edited store is
      not more trustworthy for having moved.
    */
    const stored = await PluginDatabase.getIndex();
    const fromDb = validateMeta(stored);
    const legacy = get().plugins;

    let current: InstalledPlugin[];
    if (fromDb !== null) {
      current = fromDb.map((m) => ({ ...m, files: m.files ?? {}, binaries: {} }));
    } else {
      current = legacy;
      if (legacy.length > 0) {
        const moved = await PluginDatabase.putIndex(toMeta(legacy));
        // Verified back, not assumed. `putIndex` reports its own failure, and
        // reading it again is what makes "the new home has it" a fact rather
        // than an inference from a promise that resolved.
        if (moved && validateMeta(await PluginDatabase.getIndex()) !== null) {
          try { localStorage.removeItem(STORE_KEY); } catch { /* private mode */ }
        }
      }
    }

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
