/**
 * Somewhere for a plugin to keep things.
 *
 * ── The ceiling this removes ─────────────────────────────────────────────────
 *
 * Nothing in the host API persisted plugin state. Not settings across sessions,
 * not a mapping from a plugin's own domain model onto the layers it created,
 * not anything that travels with the project file. The only persistence channel
 * was layer-kind props, which are scoped to layers of the plugin's own kind — so
 * a plugin with no layer kind had nowhere at all to put a preference, and one
 * with a layer kind could only remember things *about a layer*.
 *
 * That is the single biggest limit on what a plugin can be. An importer cannot
 * remember its last folder; a rig tool cannot remember which bones it named; a
 * theme cannot remember which theme.
 *
 * ── Two scopes, because there are two different questions ────────────────────
 *
 * | Scope     | Lives in         | Travels with the project | Quota  |
 * |-----------|------------------|--------------------------|--------|
 * | `global`  | IndexedDB        | No                       | 1 MB   |
 * | `project` | The document     | Yes                      | 256 KB |
 *
 * "Which folder did I last import from" belongs to the machine and would be
 * wrong to carry into a colleague's copy. "Which layer is this plugin's spine
 * bone" belongs to the document and is useless without it. One store could not
 * be both, and asking authors to encode the difference in a key prefix would
 * mean the wrong answer ships by default.
 *
 * ── No permission, deliberately ──────────────────────────────────────────────
 *
 * Neither scope touches the user's layers, and a ninth consent line reading
 * "remembers its own settings" buys nothing — it costs attention on the one
 * screen where attention is the whole point. The consent screen says it as an
 * informational line when the manifest declares either capability, which is the
 * honest weight: a fact, not a decision.
 *
 * The `project` scope IS user data in one sense — it rides in their file and
 * goes wherever that file goes. That is disclosed the same way, and bounded by
 * the quota.
 *
 * ── Not undoable, and that is a decision ─────────────────────────────────────
 *
 * A `project` write marks the document dirty and is saved with it, but does not
 * enter the undo stack. A plugin remembering a panel's scroll position must not
 * make Ctrl+Z do nothing visible — undo is a promise about the user's work, and
 * filling it with a plugin's bookkeeping breaks that promise far more often
 * than it helps. A plugin that wants undoable state has layer props, which are
 * exactly that.
 */

import { PluginDatabase } from '@core/services/PluginDatabase';

export type StorageScope = 'global' | 'project';

/** Per plugin, per scope. Not per key — a thousand tiny keys is the same cost. */
export const QUOTA_BYTES: Readonly<Record<StorageScope, number>> = {
  /**
   * A megabyte of settings is already an unusual plugin. The number is here to
   * stop unbounded growth on a shared origin, not to be a budget anyone plans
   * against.
   */
  global: 1024 * 1024,
  /**
   * Smaller, because this rides in the user's project file. Every byte here is
   * a byte in something they email, sync and version — and a plugin that
   * quietly quadrupled a document's size would be blamed on the editor.
   */
  project: 256 * 1024,
};

/** One value. Bounded so a single write cannot consume the whole quota. */
export const MAX_VALUE_BYTES = 64 * 1024;
export const MAX_KEY_LENGTH = 200;

/**
 * Thrown when a write would exceed the quota.
 *
 * A named class, not a string match. A plugin that wants to degrade — drop its
 * cache, keep its settings — has to be able to catch exactly this, and
 * `err.message.includes('quota')` is the kind of check that breaks when someone
 * improves the wording.
 */
export class PluginStorageQuotaError extends Error {
  readonly code = 'storage-quota-exceeded';
  constructor(
    readonly scope: StorageScope,
    readonly used: number,
    readonly limit: number,
  ) {
    super(
      `This plugin's ${scope} storage is full (${Math.round(used / 1024)} KB of `
      + `${Math.round(limit / 1024)} KB). Delete a key before writing another.`,
    );
    this.name = 'PluginStorageQuotaError';
  }
}

/**
 * Keys are opaque, printable, and short.
 *
 * No whitespace and no `/ \ ' "`, which is narrower than it needs to be for any
 * storage reason. It is narrow because keys end up in error messages, in log
 * lines, and — for the project scope — in a JSON document a human may open. A
 * key containing a newline turns one log line into two, and one containing a
 * quote turns a message into something that reads as truncated.
 */
const KEY_RE = /^[^\s/\\'"]{1,200}$/;

export function isValidKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_RE.test(key);
}

function assertKey(key: unknown): string {
  if (!isValidKey(key)) {
    throw new Error(
      `"${String(key)}" is not a usable storage key. Keys are 1–${MAX_KEY_LENGTH} characters `
      + 'with no whitespace and none of / \\ \' ".',
    );
  }
  return key;
}

/** Serialise, and refuse what cannot be stored — loudly, at the call. */
function encode(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    // A cycle, or a BigInt. Reported at the write rather than discovered at the
    // read, when the plugin has long since moved on.
    throw new Error(`That value cannot be stored: ${(err as Error).message}`);
  }
  if (text === undefined) {
    // `JSON.stringify(undefined)` is `undefined`, not `"undefined"`. Storing it
    // would make `get` indistinguishable from a missing key.
    throw new Error('`undefined` cannot be stored. Use `storage.delete(scope, key)` instead.');
  }
  if (byteLength(text) > MAX_VALUE_BYTES) {
    throw new Error(
      `That value is ${Math.round(byteLength(text) / 1024)} KB; a single value is limited to `
      + `${MAX_VALUE_BYTES / 1024} KB.`,
    );
  }
  return text;
}

/** UTF-8 length, which is what a quota is actually spending. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** One plugin's slice of one scope. Values are the SERIALISED text. */
export type StorageBag = Record<string, string>;
/** Plugin id → its bag. */
export type ScopeStore = Record<string, StorageBag>;

function bagBytes(bag: StorageBag): number {
  let total = 0;
  for (const [k, v] of Object.entries(bag)) total += byteLength(k) + byteLength(v);
  return total;
}

// ── The project scope ──────────────────────────────────────────────────────

/**
 * Project storage, held in memory and captured into the document.
 *
 * Module-level rather than in a store, for the same reason the scene graph is:
 * this is read and written by the host on a `postMessage`, which has no React
 * context, and `captureDocument` reads it synchronously.
 */
let projectStore: ScopeStore = {};

/** Called by `restoreDocument`. Replaces everything — see `captureProjectStorage`. */
export function restoreProjectStorage(stored: unknown): void {
  projectStore = isScopeStore(stored) ? structuredClone(stored) : {};
}

/**
 * What the document should carry.
 *
 * Returns `undefined` when empty, so a document with no plugin storage reads
 * back byte-identical and needs no migration — the same rule the plugin
 * dependency block follows.
 *
 * Data for an UNINSTALLED plugin is retained. That is the whole point: opening
 * a project on a machine that lacks the plugin and saving it must not destroy
 * state that machine cannot even see. Garbage collection is an explicit user
 * action, never a side effect of opening a file.
 */
export function captureProjectStorage(): ScopeStore | undefined {
  const out: ScopeStore = {};
  for (const [id, bag] of Object.entries(projectStore)) {
    if (Object.keys(bag).length > 0) out[id] = { ...bag };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isScopeStore(value: unknown): value is ScopeStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const bag of Object.values(value as Record<string, unknown>)) {
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return false;
    for (const v of Object.values(bag as Record<string, unknown>)) {
      if (typeof v !== 'string') return false;
    }
  }
  return true;
}

/** Plugin ids with project storage, whether or not they are installed. */
export function projectStorageOwners(): string[] {
  return Object.keys(projectStore).filter((id) => Object.keys(projectStore[id] ?? {}).length > 0);
}

/** Drop one plugin's project storage. An explicit user action, never automatic. */
export function forgetProjectStorage(pluginId: string): void {
  delete projectStore[pluginId];
}

// ── The global scope ───────────────────────────────────────────────────────

/**
 * Global storage, mirrored in memory and written through to IndexedDB.
 *
 * In memory because the host answers a `storage.get` synchronously — a plugin
 * awaiting a round trip through IndexedDB for a preference would make every
 * `activate()` slower than the boot deadline allows. Written through because a
 * setting that did not survive a restart is not a setting.
 */
let globalStore: ScopeStore = {};
let globalLoaded = false;

/** Load once, at plugin-host boot. Safe to call again. */
export async function loadGlobalStorage(): Promise<void> {
  if (globalLoaded) return;
  globalLoaded = true;
  const stored = await PluginDatabase.getStorage();
  if (isScopeStore(stored)) globalStore = stored;
}

/**
 * Persist the global scope.
 *
 * Fire-and-forget, and the failure is deliberately silent: a full disk should
 * not turn a plugin's preference write into an exception in `activate()`. The
 * value is already in memory, so the session behaves correctly and only the
 * survival across restart is lost.
 */
function persistGlobal(): void {
  void PluginDatabase.putStorage(globalStore);
}

/** Drop one plugin's global storage — uninstall, unless the user kept it. */
export async function forgetGlobalStorage(pluginId: string): Promise<void> {
  delete globalStore[pluginId];
  await PluginDatabase.putStorage(globalStore);
}

// ── The verbs ──────────────────────────────────────────────────────────────

function bagFor(scope: StorageScope, pluginId: string): StorageBag {
  const store = scope === 'project' ? projectStore : globalStore;
  return (store[pluginId] ??= {});
}

export function storageGet(scope: StorageScope, pluginId: string, key: unknown): unknown {
  const text = bagFor(scope, pluginId)[assertKey(key)];
  if (text === undefined) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Corrupt, hand-edited, or written by a build that stored something else.
    // `null` rather than a throw: a plugin reading a preference should degrade,
    // not fail to activate.
    return null;
  }
}

/**
 * Write one value.
 *
 * The quota is checked against what the bag would BECOME, not against what it
 * is, and the key being replaced is discounted — otherwise a plugin at its
 * limit could not overwrite a value with a smaller one, which is the exact
 * moment it is trying to behave.
 */
export function storageSet(
  scope: StorageScope,
  pluginId: string,
  key: unknown,
  value: unknown,
): void {
  const k = assertKey(key);
  const text = encode(value);
  const bag = bagFor(scope, pluginId);

  const existing = bag[k];
  const after = bagBytes(bag)
    - (existing === undefined ? 0 : byteLength(k) + byteLength(existing))
    + byteLength(k) + byteLength(text);

  if (after > QUOTA_BYTES[scope]) {
    throw new PluginStorageQuotaError(scope, after, QUOTA_BYTES[scope]);
  }

  bag[k] = text;
  if (scope === 'global') persistGlobal();
}

export function storageDelete(scope: StorageScope, pluginId: string, key: unknown): void {
  const bag = bagFor(scope, pluginId);
  delete bag[assertKey(key)];
  if (scope === 'global') persistGlobal();
}

/**
 * Keys, optionally filtered by prefix.
 *
 * Sorted, so a plugin iterating them twice sees the same order. Insertion order
 * would be stable in practice and is not a promise any storage layer should
 * make — the project scope round-trips through JSON, and the global one through
 * structured clone.
 */
export function storageList(scope: StorageScope, pluginId: string, prefix?: unknown): string[] {
  if (prefix !== undefined && typeof prefix !== 'string') {
    throw new Error('`prefix` must be a string when given.');
  }
  const keys = Object.keys(bagFor(scope, pluginId));
  const filtered = prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  return filtered.sort();
}

/** How much of the quota one plugin is using, for the UI. */
export function storageUsage(scope: StorageScope, pluginId: string): { used: number; limit: number } {
  return { used: bagBytes(bagFor(scope, pluginId)), limit: QUOTA_BYTES[scope] };
}

/** Validate a scope name coming across `postMessage`. */
export function assertScope(scope: unknown): StorageScope {
  if (scope !== 'global' && scope !== 'project') {
    throw new Error(`"${String(scope)}" is not a storage scope. Use "global" or "project".`);
  }
  return scope;
}

/** Test seam. Never called by the app. */
export function resetStorageForTests(): void {
  projectStore = {};
  globalStore = {};
  globalLoaded = false;
}
