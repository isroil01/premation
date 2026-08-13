/**
 * Provider API keys for the local edition, in the main process.
 *
 * In the server edition the backend holds these: the renderer posts a key once,
 * motion-back encrypts it with AI_KEY_SECRET, and every model call goes out from
 * there. The local edition has no backend, so the desktop shell has to be the
 * vault — and the bar it has to clear is the one the *absence* of a backend
 * removed, not a lower one.
 *
 * ── What "strongly protected" means here, concretely ────────────────────────
 *
 *  • The bytes live in the MAIN process, encrypted with `safeStorage` — DPAPI on
 *    Windows (keyed to the Windows account), the Keychain on macOS,
 *    libsecret/kwallet on Linux. Copying `ai-keys.bin` to another machine, or to
 *    another user account on the same machine, yields nothing.
 *
 *  • **There is no read-back verb.** This is the one real difference from
 *    `credentialStore`, and it is the whole point. That store exposes
 *    `credentials:get` because the renderer genuinely needs the refresh token —
 *    it has to put it in a request to our own API. A provider key has no such
 *    need: the renderer never talks to a provider, `aiProxy` does. So the IPC
 *    surface can be write-only, and a compromised renderer — an XSS in a plugin
 *    panel, a malicious imported document, someone typing into the DevTools
 *    console of a packaged build — has no channel through which to ask for the
 *    key. It can spend it, which is unavoidable, but it cannot exfiltrate it.
 *
 *  • Separate file from `credentials.bin`. A session token and a provider key
 *    have different lifetimes and different blast radii; signing out must not
 *    drop the user's OpenAI key, and clearing keys must not sign them out.
 *
 *  • 0600 and written atomically (temp + rename), so a crash mid-write cannot
 *    leave a half-written vault that reads as corrupt and silently loses keys.
 *
 * When the OS keystore is unavailable — a Linux box with no secret service —
 * nothing is stored at all. The user re-enters the key each launch, which is
 * honest; a plaintext fallback would look identical and protect nothing.
 */

import { app, safeStorage } from 'electron';
import { handle } from './ipcGuard';
import path from 'node:path';
import { readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';

/**
 * Providers the vault will hold a key for.
 *
 * An allowlist, not a free-form string: the vault is keyed by this value and
 * `aiProxy` maps it to an endpoint, so accepting arbitrary names would let a
 * renderer write entries no proxy can ever spend — and would turn a typo into a
 * silently missing key.
 */
export const VAULT_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;
export type VaultProvider = (typeof VAULT_PROVIDERS)[number];

const isVaultProvider = (v: unknown): v is VaultProvider =>
  typeof v === 'string' && (VAULT_PROVIDERS as readonly string[]).includes(v);

/** On disk: provider → key. Deliberately flat and non-extensible. */
type Vault = Partial<Record<VaultProvider, string>>;

/** What the renderer is allowed to know: that a key exists, and its tail. */
export interface KeyStatus {
  present: boolean;
  /** e.g. "sk-…4f2a". Enough to tell two keys apart, useless as a credential. */
  hint: string;
}

const FILE = (): string => path.join(app.getPath('userData'), 'ai-keys.bin');

/** Cached in memory so a renderer reload does not re-hit the OS keystore. */
let cached: Vault | undefined;

/**
 * Last four characters, prefix preserved.
 *
 * Matches the backend's `maskKey` so the settings UI reads identically in both
 * editions — the same key connected locally and in the cloud must not look like
 * two different keys.
 */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '…';
  const prefix = trimmed.slice(0, 3);
  return `${prefix}…${trimmed.slice(-4)}`;
}

async function read(): Promise<Vault> {
  if (cached !== undefined) return cached;
  try {
    const encrypted = await readFile(FILE());
    if (!safeStorage.isEncryptionAvailable()) return (cached = {});
    const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as unknown;
    const out: Vault = {};
    // Re-validate on the way in. The file could have been written by an older
    // build with a provider we no longer proxy, and an unknown entry must be
    // dropped rather than surfaced as a connected provider that cannot work.
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (isVaultProvider(k) && typeof v === 'string' && v) out[k] = v;
      }
    }
    cached = out;
  } catch {
    // Missing, unreadable, or encrypted under a key we no longer have (the user
    // changed their OS password, or the file came from another machine). All of
    // them mean the same thing: there are no usable keys here.
    cached = {};
  }
  return cached;
}

async function write(vault: Vault): Promise<boolean> {
  const file = FILE();

  // An empty vault is a deleted file, not a file containing `{}`. Leaving an
  // encrypted empty object behind would keep an OS-keystore entry alive for data
  // the user has explicitly removed.
  if (Object.keys(vault).length === 0) {
    cached = {};
    await unlink(file).catch(() => undefined);
    return true;
  }

  if (!safeStorage.isEncryptionAvailable()) {
    // See the module comment: no keystore, no stored key.
    cached = {};
    return false;
  }

  const encrypted = safeStorage.encryptString(JSON.stringify(vault));
  const temp = `${file}.tmp`;
  await writeFile(temp, encrypted, { mode: 0o600 });
  await chmod(temp, 0o600).catch(() => undefined);
  await rename(temp, file);
  cached = vault;
  return true;
}

/**
 * Read a key for immediate use. **Main process only.**
 *
 * Not exposed over IPC, and must never be. `aiProxy` imports this directly to put
 * the key in an Authorization header inside the same process; anything that would
 * hand the return value to the renderer is a bug that undoes the entire design of
 * this file.
 */
export async function getKeyForProvider(provider: VaultProvider): Promise<string | null> {
  const vault = await read();
  return vault[provider] ?? null;
}

/** Which providers have a key, and their masked tails. Safe to send anywhere. */
export async function keyStatuses(): Promise<Record<VaultProvider, KeyStatus>> {
  const vault = await read();
  const out = {} as Record<VaultProvider, KeyStatus>;
  for (const p of VAULT_PROVIDERS) {
    const key = vault[p];
    out[p] = key ? { present: true, hint: maskKey(key) } : { present: false, hint: '' };
  }
  return out;
}

/**
 * IPC surface. Three verbs, and note what is missing.
 *
 * The renderer can say "here is a key", "forget this provider", and "which
 * providers am I connected to". It cannot read a key, cannot enumerate the raw
 * vault, and cannot ask where the file is.
 */
export function registerAiKeyIpc(): void {
  handle('aiKeys:status', async (): Promise<Record<VaultProvider, KeyStatus>> => keyStatuses());

  handle(
    'aiKeys:set',
    async (_event, provider: unknown, key: unknown): Promise<{ persisted: boolean; hint: string }> => {
      // Validate rather than trust: this is the one channel whose payload is
      // written to disk, and a renderer bug must not be able to store a shape
      // that fails to parse on the next launch.
      if (!isVaultProvider(provider) || typeof key !== 'string') {
        return { persisted: false, hint: '' };
      }
      const trimmed = key.trim();
      // A length bound, not a format check. Provider key formats change without
      // notice and rejecting an unfamiliar-looking key would be worse than
      // letting the provider be the one to refuse it — but an unbounded string
      // here is an unbounded write.
      if (trimmed.length < 8 || trimmed.length > 512) {
        return { persisted: false, hint: '' };
      }

      const vault = { ...(await read()), [provider]: trimmed };
      const persisted = await write(vault);
      return { persisted, hint: maskKey(trimmed) };
    },
  );

  handle('aiKeys:clear', async (_event, provider: unknown): Promise<void> => {
    if (provider === undefined || provider === null) {
      await write({});
      return;
    }
    if (!isVaultProvider(provider)) return;
    const vault = { ...(await read()) };
    delete vault[provider];
    await write(vault);
  });

  /** False when the OS has no keystore — the app then never persists a key. */
  handle('aiKeys:available', () => safeStorage.isEncryptionAvailable());
}

/** Test seam: drop the in-memory cache so the next read hits disk again. */
export function resetVaultCacheForTests(): void {
  cached = undefined;
}
