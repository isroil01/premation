/**
 * Installing native plugins from the store (docs/PLUGIN_STORE.md §4).
 *
 * Main does all of it — the page asks for "install com.example.glow 1.2.0"
 * and gets back an outcome. The bytes never pass through the renderer, and
 * nothing is written to the plugins folder until every check has passed:
 *
 *   download record ── size / SHA-256 ── publisher signature ── pinned key
 *     ── unzip (safe paths only) ── manifest id / version ── every file
 *     against `integrity` ── stage ── atomic swap (or queue for the next
 *     start on Windows, where a loaded DLL is locked) ── quarantine cleared.
 *
 * `<dir>/state.json` is the installed set: version, the publisher key pinned
 * at first install, enabled, and the uninstall queue. It is written with
 * temp-file + rename (CLAUDE.md: never write over the user's file).
 *
 * Pure apart from the filesystem: the network fetch and the engine are the
 * caller's (ipc/nativePlugins.ts), so this file is testable against a temp dir.
 */

import { createHash, createPublicKey, randomBytes, verify as nodeVerify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { unzipSync } from 'fflate';

export const MANIFEST = 'premation-plugin.json';
export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 2000;

/**
 * The registry operator's public key for the signed revocation list (the same
 * key the 0.8 editor pinned; motion-back `MOTION_REVOCATION_KEY` is its private
 * half). Pinned in the app, never fetched: a key the server could choose is a
 * key whoever controls the server could choose.
 */
export const OPERATOR_PUBLIC_KEY =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2Zrt+EZ6T/vYPa0w4AFFdiQf7UGyVBi5S6TPQiSQjTDqFgVyFcEsseMG+rBk/AE/NhWxWYTRE/WInb2Xx4lgqA==';

/** The registry's download answer for a native version (§3). */
export interface DownloadRecord {
  id: string;
  version: string;
  kind?: string;
  packageUrl?: string;
  signature: string;
  publisherKey: string;
  sha256: string;
  size: number;
}

export interface InstalledPlugin {
  version: string;
  /** SPKI base64 — pinned at first install; a later package must be signed by it. */
  publisherKey: string;
  enabled: boolean;
  installedAt: number;
  /** Installed but waiting for the next engine start (a Windows update over a loaded DLL). */
  pending?: boolean;
}

export interface PluginStoreState {
  plugins: Record<string, InstalledPlugin>;
  /** Ids whose folder is deleted at the next start (before the engine loads anything). */
  uninstall: string[];
}

export type InstallOutcome =
  | { ok: true; id: string; version: string; restartNeeded: boolean }
  | { ok: false; reason: string; code: 'size' | 'hash' | 'signature' | 'key-changed' | 'package' | 'io' | 'revoked' };

const STATE_FILE = 'state.json';
const ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,99}$/;

export const emptyState = (): PluginStoreState => ({ plugins: {}, uninstall: [] });

export async function readState(dir: string): Promise<PluginStoreState> {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, STATE_FILE), 'utf8')) as Partial<PluginStoreState>;
    const plugins: Record<string, InstalledPlugin> = {};
    for (const [id, p] of Object.entries(raw.plugins ?? {})) {
      if (!ID_RE.test(id) || !p || typeof p.version !== 'string') continue;
      plugins[id] = {
        version: p.version,
        publisherKey: typeof p.publisherKey === 'string' ? p.publisherKey : '',
        enabled: p.enabled !== false,
        installedAt: typeof p.installedAt === 'number' ? p.installedAt : 0,
        ...(p.pending ? { pending: true } : {}),
      };
    }
    const uninstall = Array.isArray(raw.uninstall) ? raw.uninstall.filter((i): i is string => typeof i === 'string' && ID_RE.test(i)) : [];
    return { plugins, uninstall };
  } catch {
    return emptyState();
  }
}

export async function writeState(dir: string, state: PluginStoreState): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, STATE_FILE);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmp, file);
}

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** ECDSA P-256 / SHA-256, IEEE P1363, SPKI — motion-back plugin-signature.ts's scheme. */
export function verifySignature(bytes: Uint8Array, signatureB64: string, publicKeyB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec') return false;
    const sig = Buffer.from(signatureB64, 'base64');
    return sig.length === 64 && nodeVerify('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

/** A zip entry name that is a safe relative path, or null. */
export function safeEntryPath(name: string): string | null {
  if (name === '' || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  const parts = name.split('/');
  if (parts.some((p) => p === '..' || p === '.' )) return null;
  if (parts.some((p, i) => p === '' && i !== parts.length - 1)) return null;
  return name;
}

interface UnpackedPlugin {
  manifest: { id: string; version: string; binary: Record<string, string>; integrity?: { files?: Record<string, string> } };
  files: Map<string, Uint8Array>;
}

/** Unzip and check a `.pplugin` against its own manifest (§2). Throws a sentence. */
export function unpackPlugin(bytes: Uint8Array, expect: { id: string; version: string }): UnpackedPlugin {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error('The package is not a valid zip.');
  }
  const files = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue; // a directory entry
    const safe = safeEntryPath(name);
    if (!safe) throw new Error(`The package holds an unsafe path: ${name}`);
    files.set(safe, data);
  }
  if (files.size > MAX_FILES) throw new Error('The package holds too many files.');
  const mbytes = files.get(MANIFEST);
  if (!mbytes) throw new Error(`The package has no ${MANIFEST} at its root.`);
  let manifest: UnpackedPlugin['manifest'];
  try {
    manifest = JSON.parse(new TextDecoder().decode(mbytes)) as UnpackedPlugin['manifest'];
  } catch {
    throw new Error(`${MANIFEST} is not valid JSON.`);
  }
  if (manifest.id !== expect.id) throw new Error(`The package is "${manifest.id}", not "${expect.id}".`);
  if (manifest.version !== expect.version) throw new Error(`The package is version ${manifest.version}, not ${expect.version}.`);
  const integrity = manifest.integrity?.files;
  if (!integrity || typeof integrity !== 'object') throw new Error('The package has no integrity list.');
  const listed = new Set(Object.keys(integrity));
  for (const [p, data] of files) {
    if (p === MANIFEST) continue;
    const want = integrity[p];
    if (!want) throw new Error(`The package holds a file its manifest does not list: ${p}`);
    if (sha256Hex(data) !== want) throw new Error(`A file does not match its manifest hash: ${p}`);
    listed.delete(p);
  }
  if (listed.size > 0) throw new Error(`The package is missing files its manifest lists: ${[...listed].join(', ')}`);
  return { manifest, files };
}

export interface InstallInput {
  /** `<userData>/native-plugins`. */
  dir: string;
  bytes: Uint8Array;
  record: DownloadRecord;
  /** Windows locks a loaded DLL: an update over an installed copy waits for the next start. */
  platform: NodeJS.Platform;
  /** Plugin ids on the current revocation list (verified). */
  revoked?: ReadonlySet<string>;
  /** Clear macOS quarantine (injected for tests). */
  clearQuarantine?: (folder: string) => Promise<void>;
  now?: () => number;
}

/** Verify, stage and put a downloaded package in place. Never throws. */
export async function installPackage(input: InstallInput): Promise<InstallOutcome> {
  const { dir, bytes, record } = input;
  const id = record.id;
  if (!ID_RE.test(id)) return { ok: false, code: 'package', reason: `"${id}" is not a plugin id.` };
  if (input.revoked?.has(id)) return { ok: false, code: 'revoked', reason: 'This plugin was revoked by the plugin store.' };
  if (bytes.byteLength > MAX_PACKAGE_BYTES || bytes.byteLength !== record.size) {
    return { ok: false, code: 'size', reason: 'The download is not the size the store listed.' };
  }
  if (sha256Hex(bytes) !== record.sha256.toLowerCase()) {
    return { ok: false, code: 'hash', reason: 'The download does not match the hash the store listed.' };
  }
  if (!verifySignature(bytes, record.signature, record.publisherKey)) {
    return { ok: false, code: 'signature', reason: 'The publisher signature does not verify.' };
  }
  const state = await readState(dir);
  const prior = state.plugins[id];
  if (prior?.publisherKey && prior.publisherKey !== record.publisherKey) {
    return {
      ok: false,
      code: 'key-changed',
      reason: 'This plugin is now signed by a different publisher key than the one you installed. Uninstall it first if you trust the new key.',
    };
  }
  let unpacked: UnpackedPlugin;
  try {
    unpacked = unpackPlugin(bytes, { id, version: record.version });
  } catch (e) {
    return { ok: false, code: 'package', reason: (e as Error).message };
  }

  const staging = path.join(dir, '.staging', `${id}-${randomBytes(6).toString('hex')}`);
  try {
    for (const [p, data] of unpacked.files) {
      const target = path.join(staging, ...p.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data, { mode: 0o755 });
    }
    if (input.platform === 'darwin') await (input.clearQuarantine ?? clearQuarantine)(staging);

    const live = path.join(dir, id);
    const restartNeeded = input.platform === 'win32' && existsSync(live);
    if (restartNeeded) {
      // A loaded DLL cannot be replaced on Windows: queue the swap for the next start.
      const pending = path.join(dir, '.pending', id);
      await rm(pending, { recursive: true, force: true });
      await mkdir(path.dirname(pending), { recursive: true });
      await rename(staging, pending);
    } else {
      await swapInto(live, staging);
    }
    state.plugins[id] = {
      version: record.version,
      publisherKey: record.publisherKey,
      enabled: prior?.enabled ?? true,
      installedAt: (input.now ?? Date.now)(),
      ...(restartNeeded ? { pending: true } : {}),
    };
    state.uninstall = state.uninstall.filter((u) => u !== id);
    await writeState(dir, state);
    // A copy already loaded keeps running until the engine restarts (a rescan
    // does not swap a loaded module); a first install loads on rescan.
    return { ok: true, id, version: record.version, restartNeeded: restartNeeded || !!prior };
  } catch (e) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, code: 'io', reason: `Could not install: ${(e as Error).message}` };
  }
}

/** Rename `staged` to `live`, moving any previous copy aside first and removing it after. */
async function swapInto(live: string, staged: string): Promise<void> {
  const old = `${live}.old-${randomBytes(4).toString('hex')}`;
  const hadOld = existsSync(live);
  if (hadOld) await rename(live, old);
  try {
    await rename(staged, live);
  } catch (e) {
    if (hadOld) await rename(old, live).catch(() => undefined);
    throw e;
  }
  if (hadOld) await rm(old, { recursive: true, force: true }).catch(() => undefined);
}

function clearQuarantine(folder: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('xattr', ['-dr', 'com.apple.quarantine', folder], () => resolve());
  });
}

/** Mark for removal at the next start and disable now. */
export async function queueUninstall(dir: string, id: string): Promise<PluginStoreState> {
  const state = await readState(dir);
  if (!state.uninstall.includes(id)) state.uninstall.push(id);
  if (state.plugins[id]) state.plugins[id] = { ...state.plugins[id]!, enabled: false };
  await writeState(dir, state);
  return state;
}

export async function setEnabled(dir: string, id: string, enabled: boolean): Promise<PluginStoreState> {
  const state = await readState(dir);
  const p = state.plugins[id];
  if (p) state.plugins[id] = { ...p, enabled };
  await writeState(dir, state);
  return state;
}

/**
 * Before the engine starts (nothing is loaded yet): delete queued uninstalls,
 * swap in pending updates, clear stale staging. Never throws.
 */
export async function applyPendingAtStart(dir: string): Promise<PluginStoreState> {
  const state = await readState(dir);
  try {
    for (const id of state.uninstall) {
      await rm(path.join(dir, id), { recursive: true, force: true });
      await rm(path.join(dir, '.pending', id), { recursive: true, force: true });
      delete state.plugins[id];
    }
    state.uninstall = [];
    const pendingRoot = path.join(dir, '.pending');
    if (existsSync(pendingRoot)) {
      for (const id of await readdir(pendingRoot)) {
        if (!ID_RE.test(id)) continue;
        await swapInto(path.join(dir, id), path.join(pendingRoot, id));
        if (state.plugins[id]) state.plugins[id] = { ...state.plugins[id]!, pending: false };
      }
    }
    await rm(path.join(dir, '.staging'), { recursive: true, force: true });
    for (const p of Object.values(state.plugins)) delete p.pending;
    await writeState(dir, state);
  } catch {
    // A locked file or a permissions problem must not stop the engine starting.
  }
  return state;
}

/** One revocation entry (the registry's signed list). */
export interface RevocationEntry {
  id: string;
  versions?: string[];
  reason: string;
}

/** Verify the registry's signed list with the pinned operator key; null when it does not verify. */
export function verifyRevocationList(signed: unknown, operatorKey = OPERATOR_PUBLIC_KEY): { seq: number; entries: RevocationEntry[] } | null {
  const s = signed as { payload?: unknown; signature?: unknown } | null;
  if (!s || typeof s.payload !== 'string' || typeof s.signature !== 'string' || !operatorKey) return null;
  if (!verifySignature(new TextEncoder().encode(s.payload), s.signature, operatorKey)) return null;
  try {
    const list = JSON.parse(s.payload) as { seq?: unknown; entries?: unknown };
    if (typeof list.seq !== 'number' || !Array.isArray(list.entries)) return null;
    const entries = list.entries.filter((e): e is RevocationEntry => !!e && typeof (e as RevocationEntry).id === 'string')
      .map((e) => ({ id: e.id, reason: typeof e.reason === 'string' ? e.reason : '', ...(Array.isArray(e.versions) ? { versions: e.versions.filter((v) => typeof v === 'string') } : {}) }));
    return { seq: list.seq, entries };
  } catch {
    return null;
  }
}

/** The entries that hit what is installed (a versioned entry only hits that version). */
export function revokedInstalled(state: PluginStoreState, entries: readonly RevocationEntry[]): RevocationEntry[] {
  return entries.filter((e) => {
    const p = state.plugins[e.id];
    if (!p) return false;
    return !e.versions || e.versions.length === 0 || e.versions.includes(p.version);
  });
}

/** The engine's arguments for the installed set: `--plugin-disabled` per disabled plugin, `--revoked <file>`. */
export async function engineArgsFor(dir: string, state: PluginStoreState, revoked: readonly RevocationEntry[]): Promise<string[]> {
  const args: string[] = [];
  for (const [id, p] of Object.entries(state.plugins)) if (!p.enabled) args.push('--plugin-disabled', id);
  if (revoked.length > 0) {
    const file = path.join(dir, '.revoked.json');
    await writeFile(file, JSON.stringify({ revoked: revoked.map((e) => ({ id: e.id, reason: e.reason })) }));
    args.push('--revoked', file);
  }
  return args;
}
