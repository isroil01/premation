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
 * A third way is a `.pplugin` file (plan P2): "Install from file…" or a
 * double-click, handled by `registerPluginFileIpc` and electron/pluginFileInstall.ts.
 * A fourth is the machine-wide plug-ins folder vendors' installers write
 * (`machinePluginDir`): the engine scans it too, and main never writes it.
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
  bundlesIn,
  engineArgsFor,
  installPackage,
  machinePlatformKey,
  platformKeysFor,
  queueUninstall,
  readState,
  revokedInstalled,
  setEnabled,
  verifyRevocationList,
  readEntitlement,
  removeEntitlement,
  writeEntitlement,
  type EntitlementInfo,
  type DownloadRecord,
  type InstallOutcome,
  type PluginStoreState,
  type RevocationEntry,
  applyPendingAtStart,
} from '../nativePluginStore';
import {
  inspectPackageFile,
  installInspected,
  PendingPackages,
  type InspectResult,
  type StoreIdentity,
} from '../pluginFileInstall';

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
  arch?: string;
  /** The machine-wide plug-ins folder (`machinePluginDir`); scanned, never written. */
  machineDir?: () => string;
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
export async function pluginLaunchArgs(deps: Pick<StoreDeps, 'dir' | 'machineDir'>): Promise<string[]> {
  const dir = deps.dir();
  const machine = deps.machineDir?.();
  const state = await applyPendingAtStart(dir);
  const revoked = revokedInstalled(state, (await readRevocations(dir)).entries, machine ? await bundlesIn(machine) : []);
  // The machine folder is a second `--plugins` (repeatable); the engine skips it when it does not exist.
  return [...(machine ? ['--plugins', machine] : []), ...(await engineArgsFor(dir, state, revoked))];
}

/**
 * What an export job renders plugins with (engineExport.ts `plugins`): the
 * plugins folder, the disabled set, and the revoked installed plugins.
 * Pending installs are NOT applied here — the editor's engine is running.
 */
export async function exportPluginJob(
  deps: Pick<StoreDeps, 'dir' | 'machineDir'>,
): Promise<{ plugins: string[]; pluginDisabled: string[]; pluginRevoked?: string; pluginEntitlement?: string }> {
  const dir = deps.dir();
  const machine = deps.machineDir?.();
  const state = await readState(dir);
  const revoked = revokedInstalled(state, (await readRevocations(dir)).entries, machine ? await bundlesIn(machine) : []);
  const args = await engineArgsFor(dir, state, revoked);
  const disabled: string[] = [];
  let revokedFile: string | undefined;
  let entitlementFile: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--plugin-disabled' && args[i + 1]) disabled.push(args[i + 1]!);
    if (args[i] === '--revoked' && args[i + 1]) revokedFile = args[i + 1];
    if (args[i] === '--entitlement' && args[i + 1]) entitlementFile = args[i + 1];
  }
  return {
    plugins: machine ? [dir, machine] : [dir],
    pluginDisabled: disabled,
    ...(revokedFile ? { pluginRevoked: revokedFile } : {}),
    ...(entitlementFile ? { pluginEntitlement: entitlementFile } : {}),
  };
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
      // `platform` picks this machine's package: a version may hold one per platform.
      const machine = machinePlatformKey(deps.platform ?? process.platform, deps.arch ?? process.arch);
      const recordUrl = `${base}/plugins/${owner === true ? 'mine/' : ''}${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/download?platform=${machine}`;
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

// ── Premation Cloud entitlement (plan §3.2) ──────────────────────────────

export interface EntitlementStatus {
  /** The account's plan as the registry answered ('unknown' offline or signed out). */
  plan: 'pro' | 'free' | 'unknown';
  /** The kept token's end, epoch ms; null when there is none. */
  validUntil: number | null;
}

let lastEntitlementRefresh = 0;

/**
 * Fetch the account's entitlement token, verify it with the pinned operator
 * key and keep it for the engine (`--entitlement`). At sign-in, at start and
 * every 24 h (main.ts). A plan without Premation plugins keeps whatever token
 * is already here: it runs to its own `validUntil` (the paid period + 14
 * days), so lapsing is never sudden. Offline changes nothing. Never throws.
 */
export async function refreshEntitlement(deps: StoreDeps, opts: { force?: boolean; now?: () => number } = {}): Promise<EntitlementStatus> {
  const now = (opts.now ?? Date.now)();
  const dir = deps.dir();
  const kept = await readEntitlement(dir);
  // Token refreshes re-announce the sign-in every hour; the entitlement needs far less.
  if (!opts.force && now - lastEntitlementRefresh < 10 * 60_000) return statusOf('unknown', kept);
  lastEntitlementRefresh = now;
  try {
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(8000) : undefined;
    const res = await deps.authedFetch(`${deps.apiBase()}/plugins/entitlement`, { method: 'GET', ...(signal ? { signal } : {}) });
    if (!res.ok) return statusOf('unknown', kept);
    const body = (await res.json()) as { plan?: unknown; token?: unknown };
    if (body.plan === 'pro' && body.token) {
      const info = await writeEntitlement(dir, body.token as { payload: string; signature: string });
      return statusOf('pro', info ?? kept);
    }
    return statusOf(body.plan === 'free' ? 'free' : 'unknown', kept);
  } catch {
    return statusOf('unknown', kept);
  }
}

function statusOf(plan: EntitlementStatus['plan'], info: EntitlementInfo | null): EntitlementStatus {
  return { plan, validUntil: info?.validUntil ?? null };
}

/** Signed out: drop the token (another account may use this machine next). */
export async function forgetEntitlement(deps: Pick<StoreDeps, 'dir'>): Promise<void> {
  lastEntitlementRefresh = 0;
  await removeEntitlement(deps.dir()).catch(() => undefined);
}

export function registerEntitlementIpc(deps: StoreDeps): void {
  /** Refresh now (the page asks after an upgrade); answers the status. */
  handle('plugins:refreshEntitlement', () => refreshEntitlement(deps, { force: true }));
  /** The kept token's status, without asking the registry. */
  handle('plugins:entitlement', async () => statusOf('unknown', await readEntitlement(deps.dir())));
}

// ── Install from a file (plan P2) ────────────────────────────────────────

export interface FileIpcDeps extends StoreDeps {
  /** The OS open dialog for one `.pplugin`; null when cancelled. */
  pickFile: () => Promise<string | null>;
  /** Tell the page a package was opened (it then calls `plugins:takeOpenedPackages`). */
  notify: () => void;
  readFile?: (p: string) => Promise<Uint8Array>;
}

/** The store's public listing for an id, for the trust line. null: not listed; 'unreachable': could not ask. */
async function storeIdentity(deps: StoreDeps, id: string): Promise<StoreIdentity | null | 'unreachable'> {
  try {
    const res = await (deps.publicFetch ?? fetch)(`${deps.apiBase()}/plugins/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return null;
    if (!res.ok) return 'unreachable';
    const j = (await res.json()) as Partial<StoreIdentity> & { publisher?: { displayName?: unknown; verified?: unknown } };
    if (typeof j.publisherKey !== 'string') return null;
    return {
      publisherKey: j.publisherKey,
      nextPublisherKey: typeof j.nextPublisherKey === 'string' ? j.nextPublisherKey : null,
      publisher: { displayName: typeof j.publisher?.displayName === 'string' ? j.publisher.displayName : '', verified: j.publisher?.verified === true },
    };
  } catch {
    return 'unreachable';
  }
}

/** The handler bodies, exported for the test. `open(path)` is what a double-click calls. */
export function fileHandlers(deps: FileIpcDeps): {
  open: (filePath: string) => Promise<InspectResult>;
  pick: () => Promise<InspectResult | null>;
  install: (req: unknown) => Promise<InstallOutcome>;
  takeOpened: () => InspectResult[];
} {
  const pending = new PendingPackages();
  const opened: InspectResult[] = [];
  const read = deps.readFile ?? (async (p: string) => new Uint8Array(await readFile(p)));
  const platform = deps.platform ?? process.platform;

  const inspect = async (filePath: string): Promise<InspectResult> => {
    const fileName = path.basename(filePath);
    let bytes: Uint8Array;
    try {
      bytes = await read(filePath);
    } catch (e) {
      return { ok: false, fileName, reason: `Could not read the file: ${(e as Error).message}` };
    }
    const sidecar = await read(`${filePath}.sig`).then((b) => new TextDecoder().decode(b)).catch(() => null);
    const dir = deps.dir();
    const revocations = (await readRevocations(dir)).entries;
    const { result, unpacked, key } = await inspectPackageFile({
      fileName,
      bytes,
      sidecar,
      state: await readState(dir),
      hereKeys: platformKeysFor(platform, deps.arch ?? process.arch),
      isRevoked: (id, version) => revocations.some((e) => e.id === id && (!e.versions?.length || e.versions.includes(version))),
      lookupStore: (id) => storeIdentity(deps, id),
    });
    if (!result.ok || !unpacked) return result;
    return { ok: true, preview: pending.put(result.preview, unpacked, key ?? '') };
  };

  return {
    open: async (filePath) => {
      const r = await inspect(filePath);
      opened.push(r);
      deps.notify();
      return r;
    },
    pick: async () => {
      const p = await deps.pickFile();
      return p ? inspect(p) : null;
    },
    install: (req) => installInspected(pending, req, { dir: deps.dir(), platform }),
    takeOpened: () => opened.splice(0, opened.length),
  };
}

/** Registers the file channels; returns `open` for main's double-click routing. */
export function registerPluginFileIpc(deps: FileIpcDeps): (filePath: string) => Promise<InspectResult> {
  const h = fileHandlers(deps);
  /** Show the open dialog and inspect the chosen `.pplugin` (null when cancelled). */
  handle('plugins:pickPackageFile', () => h.pick());
  /** Install an inspected package by its token (`{ token, allowUnknown? }`). */
  handle('plugins:installPackageFile', (_e, req: unknown) => h.install(req));
  /** Packages opened by double-click since the page last asked. */
  handle('plugins:takeOpenedPackages', () => h.takeOpened());
  return h.open;
}
