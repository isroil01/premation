/**
 * Install a `.pplugin` from a file (plan P2): Plugins ▸ Installed ▸ "Install
 * from file…", or a double-click on the file (electron-builder
 * `fileAssociations`; main.ts routes `open-file` / `second-instance` here).
 *
 * Two steps, so the user decides with the facts in front of them:
 *
 *   1. `inspectPackageFile` reads and checks the package — integrity, its
 *      signature, which publisher that signature belongs to, whether this
 *      machine can run it — and answers a preview the page shows in the
 *      install dialog. The bytes stay in main behind a token: the page never
 *      names a path to install.
 *   2. `installInspected(token, { allowUnknown })` installs through the same
 *      stage → swap path as a store install (`stageAndSwap`).
 *
 * Signatures. A package signs itself (`premation-plugin.sig`, over the
 * manifest, whose integrity list hashes every other file) or comes with the
 * packer's `<file>.sig` (over the whole file). A package whose key is not the
 * store's key for that id, and is not the key already pinned here, is from an
 * unknown publisher: it installs only after an explicit "Install anyway", and
 * its key is pinned then, as a store install pins it.
 */

import { randomBytes } from 'node:crypto';
import {
  MAX_PACKAGE_BYTES,
  readState,
  stageAndSwap,
  unpackPlugin,
  verifySignature,
  type InstallOutcome,
  type PluginStoreState,
  type UnpackedPlugin,
} from './nativePluginStore';

/** What the store says about an id (public `GET /plugins/:id`). */
export interface StoreIdentity {
  publisherKey: string;
  nextPublisherKey?: string | null;
  publisher: { displayName: string; verified: boolean };
  name?: string;
}

export type FileTrust =
  /** Signed with the store's key for this id, by a verified publisher. */
  | 'store-verified'
  /** Signed with the store's key for this id. */
  | 'store'
  /** Not in the store (or offline), but signed with the key already pinned here. */
  | 'pinned'
  /** Signed, by a key the store does not know for this id. */
  | 'unknown'
  /** No signature at all. */
  | 'unsigned';

/** The install dialog's facts (the page renders them; src/types/motionEditor.d.ts mirrors it). */
export interface PackagePreview {
  token: string;
  fileName: string;
  id: string;
  name: string;
  version: string;
  vendor: string;
  sdk: string;
  effects: Array<{ matchName: string; name: string; category: string }>;
  platforms: string[];
  runsHere: boolean;
  trust: FileTrust;
  /** The store's publisher name when the store knows the key; else the manifest's vendor. */
  publisher: string;
  /** Requires a Premation Cloud entitlement to load (plan §3.2). */
  entitlement: string | null;
  /** The version installed now, if any. */
  installedVersion: string | null;
  /** Why it cannot be installed at all (shown instead of an Install button). */
  problem: string | null;
  /** The store could not be asked (offline): trust is judged from this machine alone. */
  storeUnreachable: boolean;
}

export type InspectResult = { ok: true; preview: PackagePreview } | { ok: false; fileName: string; reason: string };

export interface InspectInput {
  fileName: string;
  bytes: Uint8Array;
  /** `<file>.sig`'s text when it exists beside the file. */
  sidecar: string | null;
  /** The installed set. */
  state: PluginStoreState;
  /** Binary keys this machine loads, most specific first. */
  hereKeys: readonly string[];
  /** Ids on the verified revocation list that hit this id + version. */
  isRevoked: (id: string, version: string) => boolean;
  /** The store's view of the id: null when it does not list it, 'unreachable' when it could not be asked. */
  lookupStore: (id: string) => Promise<StoreIdentity | null | 'unreachable'>;
}

/** `{ signature, publicKey }` JSON (both the embedded member and the sidecar). */
function parseSignatureJson(text: string): { signature: string; publicKey: string } | null {
  try {
    const j = JSON.parse(text) as { signature?: unknown; publicKey?: unknown };
    return typeof j.signature === 'string' && typeof j.publicKey === 'string' ? { signature: j.signature, publicKey: j.publicKey } : null;
  } catch {
    return null;
  }
}

/** Check a package file and say what installing it would mean. Never throws. */
export async function inspectPackageFile(input: InspectInput): Promise<{ result: InspectResult; unpacked?: UnpackedPlugin; key?: string }> {
  const { fileName, bytes } = input;
  const fail = (reason: string) => ({ result: { ok: false as const, fileName, reason } });
  if (bytes.byteLength === 0) return fail('The file is empty.');
  if (bytes.byteLength > MAX_PACKAGE_BYTES) return fail(`The file is larger than ${MAX_PACKAGE_BYTES / 1024 / 1024} MB.`);

  let unpacked: UnpackedPlugin;
  try {
    unpacked = unpackPlugin(bytes);
  } catch (e) {
    return fail(`This is not a Premation plugin package: ${(e as Error).message}`);
  }
  const m = unpacked.manifest;

  // ── Who signed it ──
  let key = '';
  if (unpacked.embeddedSignature) {
    const sig = parseSignatureJson(new TextDecoder().decode(unpacked.embeddedSignature));
    if (!sig || !verifySignature(unpacked.manifestBytes, sig.signature, sig.publicKey)) {
      return fail('The package\'s signature does not verify: it was changed after it was signed.');
    }
    key = sig.publicKey;
  } else if (input.sidecar !== null) {
    const sig = parseSignatureJson(input.sidecar);
    if (!sig || !verifySignature(bytes, sig.signature, sig.publicKey)) {
      return fail('The signature file next to the package does not verify: the package was changed after it was signed.');
    }
    key = sig.publicKey;
  }

  const store = await input.lookupStore(m.id).catch(() => 'unreachable' as const);
  const storeUnreachable = store === 'unreachable';
  const listing = store && store !== 'unreachable' ? store : null;
  const prior = input.state.plugins[m.id];

  let trust: FileTrust;
  if (!key) trust = 'unsigned';
  else if (listing && (listing.publisherKey === key || listing.nextPublisherKey === key)) {
    trust = listing.publisher.verified ? 'store-verified' : 'store';
  } else if (prior?.publisherKey && prior.publisherKey === key) trust = 'pinned';
  else trust = 'unknown';

  let problem: string | null = null;
  if (prior?.publisherKey && key && prior.publisherKey !== key) {
    problem = 'This plugin is installed signed by a different publisher key. Uninstall it first if you trust this one.';
  } else if (prior?.publisherKey && !key) {
    problem = 'This plugin is installed signed by its publisher; this copy is unsigned.';
  }
  const platforms = Object.keys(m.binary ?? {});
  const runsHere = platforms.some((p) => input.hereKeys.includes(p));
  if (!problem && !runsHere) problem = `It has no build for this computer (it has: ${platforms.join(', ') || 'none'}).`;
  if (!problem && input.isRevoked(m.id, m.version)) problem = 'This plugin was revoked by the plugin store.';

  const preview: PackagePreview = {
    token: '',
    fileName,
    id: m.id,
    name: typeof m.name === 'string' && m.name ? m.name : m.id,
    version: m.version,
    vendor: typeof m.vendor === 'string' ? m.vendor : '',
    sdk: `${m.sdk?.major ?? '?'}.${m.sdk?.minor ?? '?'}`,
    effects: (Array.isArray(m.effects) ? m.effects : []).map((e) => ({
      matchName: String(e?.matchName ?? ''),
      name: String(e?.name ?? e?.matchName ?? ''),
      category: String(e?.category ?? ''),
    })),
    platforms,
    runsHere,
    trust,
    publisher: listing && (trust === 'store' || trust === 'store-verified') ? listing.publisher.displayName : (typeof m.vendor === 'string' ? m.vendor : ''),
    entitlement: typeof m.entitlement === 'string' ? m.entitlement : null,
    installedVersion: prior?.version ?? null,
    problem,
    storeUnreachable,
  };
  return { result: { ok: true, preview }, unpacked, key };
}

interface Held {
  preview: PackagePreview;
  unpacked: UnpackedPlugin;
  key: string;
  at: number;
}

/**
 * Inspected packages waiting for the user's answer, by token. Bounded: a few
 * at a time, each for ten minutes; the bytes of a 256 MB package are not kept
 * around for a dialog nobody answers.
 */
export class PendingPackages {
  private readonly held = new Map<string, Held>();
  constructor(private readonly now: () => number = Date.now, private readonly max = 4, private readonly ttlMs = 10 * 60_000) {}

  put(preview: PackagePreview, unpacked: UnpackedPlugin, key: string): PackagePreview {
    this.prune();
    while (this.held.size >= this.max) this.held.delete(this.held.keys().next().value as string);
    const token = randomBytes(16).toString('hex');
    const withToken = { ...preview, token };
    this.held.set(token, { preview: withToken, unpacked, key, at: this.now() });
    return withToken;
  }

  take(token: unknown): Held | undefined {
    this.prune();
    if (typeof token !== 'string') return undefined;
    const h = this.held.get(token);
    this.held.delete(token);
    return h;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [t, h] of this.held) if (h.at < cutoff) this.held.delete(t);
  }
}

/** Install a held package. Unknown and unsigned publishers need `allowUnknown`. Never throws. */
export async function installInspected(
  pending: PendingPackages,
  req: unknown,
  deps: { dir: string; platform: NodeJS.Platform; clearQuarantine?: (folder: string) => Promise<void>; now?: () => number },
): Promise<InstallOutcome> {
  const { token, allowUnknown } = (req ?? {}) as { token?: unknown; allowUnknown?: unknown };
  const held = pending.take(token);
  if (!held) return { ok: false, code: 'package', reason: 'That package is no longer open. Open the file again.' };
  const { preview } = held;
  if (preview.problem) return { ok: false, code: preview.runsHere ? 'package' : 'platform', reason: preview.problem };
  if ((preview.trust === 'unknown' || preview.trust === 'unsigned') && allowUnknown !== true) {
    return { ok: false, code: 'unknown-publisher', reason: 'This package is not from a publisher the plugin store knows. Choose "Install anyway" to install it.' };
  }
  // Re-read: the installed set may have changed while the dialog was open.
  const state = await readState(deps.dir);
  const prior = state.plugins[preview.id];
  if (prior?.publisherKey && held.key && prior.publisherKey !== held.key) {
    return { ok: false, code: 'key-changed', reason: 'This plugin is installed signed by a different publisher key. Uninstall it first if you trust this one.' };
  }
  return stageAndSwap(deps, held.unpacked, held.key, state);
}

/** `.pplugin` paths in a launch argv (a double-click on Windows / Linux, or a second launch). */
export function packagePathsIn(argv: readonly string[]): string[] {
  return argv.filter((a) => /\.pplugin$/i.test(a) && !a.startsWith('-'));
}
