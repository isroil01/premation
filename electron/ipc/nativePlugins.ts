/**
 * Native plugins: the folder, and installing from the plugin store.
 *
 * Native SDK plugins (docs/PLUGIN_SDK.md) live in `<userData>/native-plugins`,
 * which the engine scans (`EngineHost`'s `nativePluginDir`). They get there two
 * ways: by hand (the page can only ask main to open THIS folder), or from the
 * store (docs/PLUGIN_STORE.md §4): the page asks to install `{id, version}`,
 * and MAIN fetches the registry's download record with the user's session (so
 * a private plugin installs for its owner), downloads the bytes, and hands them
 * to nativePluginStore.ts, which verifies and installs. The renderer never
 * names a path or a URL, and never holds the package.
 *
 * Every channel goes through `ipcGuard`'s `handle`, so the sender-frame check
 * applies.
 */

import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { shell } from 'electron';
import { handle } from '../ipcGuard';
import {
  engineArgsFor,
  installPackage,
  queueUninstall,
  readState,
  revokedInstalled,
  setEnabled,
  verifyRevocationList,
  type DownloadRecord,
  type InstallOutcome,
  type PluginStoreState,
  type RevocationEntry,
  applyPendingAtStart,
} from '../nativePluginStore';

export interface OpenNativePluginFolderResult {
  ok: boolean;
  /** The folder that was (or would have been) opened. */
  path: string;
  /** The OS's reason when it could not be opened. */
  error?: string;
}

export interface NativePluginIpcDeps {
  /** The folder the engine loads native plugins from (main.ts's `nativePluginDir`). */
  dir: () => string;
  /** `shell.openPath` — injected for the test. Resolves '' on success, else an error string. */
  openPath?: (p: string) => Promise<string>;
  /** Create the folder if it is missing — a fresh install has not made it yet. */
  ensureDir?: (p: string) => void;
}

/** The handler bodies, exported for the test. */
export function nativePluginHandlers(deps: NativePluginIpcDeps): {
  openFolder: () => Promise<OpenNativePluginFolderResult>;
  folderPath: () => string;
} {
  const openPath = deps.openPath ?? ((p: string) => shell.openPath(p));
  const ensure = deps.ensureDir ?? ((p: string) => { mkdirSync(p, { recursive: true }); });
  return {
    openFolder: async () => {
      const dir = deps.dir();
      try {
        ensure(dir);
        const error = await openPath(dir);
        return error ? { ok: false, path: dir, error } : { ok: true, path: dir };
      } catch (err) {
        return { ok: false, path: dir, error: err instanceof Error ? err.message : String(err) };
      }
    },
    folderPath: () => deps.dir(),
  };
}

export function registerNativePluginIpc(deps: NativePluginIpcDeps): void {
  const h = nativePluginHandlers(deps);
  /** Open the native plugins folder in the OS file manager. */
  handle('plugins:openNativeFolder', () => h.openFolder());
  /** The native plugins folder's path, for the install instructions. */
  handle('plugins:nativeFolderPath', () => h.folderPath());
}

// ── The store (AE parity step 2) ─────────────────────────────────────────

const ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,99}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;

export interface StoreDeps {
  dir: () => string;
  /** The registry API base (`<backendOrigin>/api`). */
  apiBase: () => string;
  /** fetch with the user's session (apiProxy `sendWithAuth`); a plain fetch for public reads. */
  authedFetch: (url: string, init: RequestInit) => Promise<Response>;
  publicFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  platform?: NodeJS.Platform;
}

const REVOCATIONS_FILE = '.revocations.json';

/** The last verified revocation list (seq high-water mark kept: an older list is never accepted). */
async function readRevocations(dir: string): Promise<{ seq: number; entries: RevocationEntry[] }> {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, REVOCATIONS_FILE), 'utf8')) as { seq?: unknown; entries?: unknown };
    return { seq: typeof raw.seq === 'number' ? raw.seq : 0, entries: Array.isArray(raw.entries) ? (raw.entries as RevocationEntry[]) : [] };
  } catch {
    return { seq: 0, entries: [] };
  }
}

/**
 * Fetch and verify the registry's signed revocation list (public, no auth:
 * asking must not identify the user). A list that does not verify, or is older
 * than the one kept, changes nothing. Never throws.
 */
export async function refreshRevocations(deps: StoreDeps): Promise<RevocationEntry[]> {
  const dir = deps.dir();
  const kept = await readRevocations(dir);
  try {
    const res = await (deps.publicFetch ?? fetch)(`${deps.apiBase()}/plugins/revocations`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const list = verifyRevocationList(await res.json());
      if (list && list.seq >= kept.seq) {
        mkdirSync(dir, { recursive: true });
        await writeFile(path.join(dir, REVOCATIONS_FILE), JSON.stringify(list));
        return list.entries;
      }
    }
  } catch {
    // Offline: the kept list stays in force.
  }
  return kept.entries;
}

/**
 * What the engine is started with (every launch, restarts included): pending
 * installs and uninstalls applied first, then `--plugin-disabled` for each
 * disabled plugin and `--revoked` for installed plugins on the kept list.
 */
export async function pluginLaunchArgs(deps: Pick<StoreDeps, 'dir'>): Promise<string[]> {
  const dir = deps.dir();
  const state = await applyPendingAtStart(dir);
  const revoked = revokedInstalled(state, (await readRevocations(dir)).entries);
  return engineArgsFor(dir, state, revoked);
}

/**
 * What an export job renders plugins with (engineExport.ts `plugins`): the
 * plugins folder, the disabled set, and the revoked installed plugins.
 * Pending installs are NOT applied here — the editor's engine is running.
 */
export async function exportPluginJob(deps: Pick<StoreDeps, 'dir'>): Promise<{ plugins: string[]; pluginDisabled: string[]; pluginRevoked?: string }> {
  const dir = deps.dir();
  const state = await readState(dir);
  const revoked = revokedInstalled(state, (await readRevocations(dir)).entries);
  const args = await engineArgsFor(dir, state, revoked);
  const disabled: string[] = [];
  let revokedFile: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--plugin-disabled' && args[i + 1]) disabled.push(args[i + 1]!);
    if (args[i] === '--revoked' && args[i + 1]) revokedFile = args[i + 1];
  }
  return { plugins: [dir], pluginDisabled: disabled, ...(revokedFile ? { pluginRevoked: revokedFile } : {}) };
}

/** The handler bodies, exported for the test. */
export function storeHandlers(deps: StoreDeps): {
  install: (req: unknown) => Promise<InstallOutcome>;
  uninstall: (id: unknown) => Promise<PluginStoreState | null>;
  setEnabled: (req: unknown) => Promise<PluginStoreState | null>;
  state: () => Promise<PluginStoreState>;
} {
  return {
    install: async (req) => {
      const { id, version, owner } = (req ?? {}) as { id?: unknown; version?: unknown; owner?: unknown };
      if (typeof id !== 'string' || !ID_RE.test(id) || typeof version !== 'string' || !VERSION_RE.test(version)) {
        return { ok: false, code: 'package', reason: 'Bad install request.' };
      }
      const dir = deps.dir();
      const base = deps.apiBase();
      const recordUrl = `${base}/plugins/${owner === true ? 'mine/' : ''}${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/download`;
      let record: DownloadRecord;
      try {
        const res = await deps.authedFetch(recordUrl, { method: 'GET' });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          let message = `The store answered ${res.status}.`;
          try {
            const body = JSON.parse(text) as { message?: unknown };
            if (typeof body.message === 'string') message = body.message;
          } catch { /* not JSON */ }
          return { ok: false, code: 'package', reason: message };
        }
        record = (await res.json()) as DownloadRecord;
      } catch (e) {
        return { ok: false, code: 'io', reason: `Could not reach the plugin store: ${(e as Error).message}` };
      }
      if (record.kind !== 'native' || typeof record.packageUrl !== 'string') {
        return { ok: false, code: 'package', reason: 'That is not a native plugin, which is all this version of Premation runs.' };
      }
      if (record.id !== id || record.version !== version) return { ok: false, code: 'package', reason: 'The store answered for a different plugin.' };
      let bytes: Uint8Array;
      try {
        // The bytes URL is the registry's own short-lived link; no session is sent with it.
        const url = new URL(record.packageUrl, base);
        // https, or the registry's own origin (a dev backend on http://localhost).
        if (url.protocol !== 'https:' && url.origin !== new URL(base).origin) {
          return { ok: false, code: 'package', reason: 'The store gave a download link this app will not follow.' };
        }
        const res = await (deps.publicFetch ?? fetch)(url.toString(), { redirect: 'follow' });
        if (!res.ok) return { ok: false, code: 'io', reason: `The download failed (${res.status}).` };
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        return { ok: false, code: 'io', reason: `The download failed: ${(e as Error).message}` };
      }
      const revoked = new Set((await readRevocations(dir)).entries.filter((e) => !e.versions?.length || e.versions.includes(version)).map((e) => e.id));
      return installPackage({ dir, bytes, record, platform: deps.platform ?? process.platform, revoked });
    },
    uninstall: async (id) => (typeof id === 'string' && ID_RE.test(id) ? queueUninstall(deps.dir(), id) : null),
    setEnabled: async (req) => {
      const { id, enabled } = (req ?? {}) as { id?: unknown; enabled?: unknown };
      if (typeof id !== 'string' || !ID_RE.test(id) || typeof enabled !== 'boolean') return null;
      return setEnabled(deps.dir(), id, enabled);
    },
    state: () => readState(deps.dir()),
  };
}

export function registerPluginStoreIpc(deps: StoreDeps): void {
  const h = storeHandlers(deps);
  /** Download, verify and install `{ id, version, owner? }` from the store. */
  handle('plugins:install', (_e, req: unknown) => h.install(req));
  /** Queue an uninstall (the folder goes at the next start; the plugin is disabled now). */
  handle('plugins:uninstall', (_e, id: unknown) => h.uninstall(id));
  /** Persist enabled / disabled (the page also tells the running engine). */
  handle('plugins:setEnabled', (_e, req: unknown) => h.setEnabled(req));
  /** The installed set (versions, pinned keys, enabled, pending). */
  handle('plugins:installed', () => h.state());
}
