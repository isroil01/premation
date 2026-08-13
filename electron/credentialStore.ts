/**
 * Credential storage for the desktop app, in the main process.
 *
 * The renderer used to keep the session token in `localStorage`. That is a
 * plaintext file in the app's profile directory, readable by anything running
 * as the user, and trivially editable from DevTools — which the packaged app
 * still ships. For a session that now lasts 90 days, that is the wrong place.
 *
 * Here instead:
 *
 *  • The bytes live in the **main** process, and STAY there. This module
 *    exposes no IPC at all any more: it used to answer `credentials:get`, which
 *    handed the refresh token to the renderer on request and made every other
 *    protection here beside the point (see `apiSession.ts` for the argument).
 *    Its only caller is now `apiSession`, in the same process.
 *  • They are encrypted with Electron's `safeStorage`, which is a wrapper over
 *    the OS keystore: DPAPI on Windows (keyed to the Windows account), the
 *    Keychain on macOS, and libsecret/kwallet on Linux. Copying the file to
 *    another machine or another user account yields nothing.
 *  • The file is written 0600 and atomically (temp + rename), so a crash
 *    mid-write cannot leave a half-written credential that reads as corrupt on
 *    next launch and silently signs the user out.
 *
 * When the OS keystore is unavailable — a Linux box with no secret service is
 * the realistic case — `safeStorage.isEncryptionAvailable` is false. We store
 * nothing rather than writing plaintext and calling it a credential store: the
 * user signs in again each launch, which is honest, where a plaintext fallback
 * would look identical while offering no protection at all.
 */

import { app, safeStorage } from 'electron';
import path from 'node:path';
import { readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';

/** What the renderer asks us to keep. Deliberately small and non-extensible. */
export interface StoredCredentials {
  refreshToken: string;
  /** ISO date the refresh token stops working — lets us drop it unprompted. */
  refreshExpiresAt?: string;
  /** Shown on the sign-in screen ("Continue as …"). Never a secret. */
  email?: string;
  userId?: string;
}

const FILE = (): string => path.join(app.getPath('userData'), 'credentials.bin');

/** Cached in memory so a renderer reload does not re-hit the OS keystore. */
let cached: StoredCredentials | null | undefined;

async function read(): Promise<StoredCredentials | null> {
  if (cached !== undefined) return cached;

  try {
    const encrypted = await readFile(FILE());
    if (!safeStorage.isEncryptionAvailable()) return (cached = null);
    const json = safeStorage.decryptString(encrypted);
    cached = JSON.parse(json) as StoredCredentials;
  } catch {
    // Missing, unreadable, or encrypted under a key we no longer have (the
    // user changed their OS password, or the file came from another machine).
    // All of them mean the same thing: there is no usable session here.
    cached = null;
  }
  return cached;
}

async function write(credentials: StoredCredentials | null): Promise<boolean> {
  const file = FILE();

  if (!credentials) {
    cached = null;
    await unlink(file).catch(() => undefined);
    return true;
  }

  if (!safeStorage.isEncryptionAvailable()) {
    // See the module comment: no keystore, no stored credential. The session
    // still works for as long as the app is open — it just does not persist.
    cached = null;
    return false;
  }

  const encrypted = safeStorage.encryptString(JSON.stringify(credentials));
  const temp = `${file}.tmp`;
  await writeFile(temp, encrypted, { mode: 0o600 });
  await chmod(temp, 0o600).catch(() => undefined);
  await rename(temp, file);
  cached = credentials;
  return true;
}

/** Read the stored session, dropping it if the refresh token has expired. */
export async function readStoredCredentials(): Promise<StoredCredentials | null> {
  const stored = await read();
  if (!stored) return null;

  // Drop an expired refresh token here rather than keeping a credential we
  // already know the server will refuse.
  if (stored.refreshExpiresAt && new Date(stored.refreshExpiresAt).getTime() <= Date.now()) {
    await write(null);
    return null;
  }
  return stored;
}

/**
 * Persist a session. Returns false when there was no keystore to encrypt with.
 *
 * Validates rather than trusts, even though the caller is now in-process: this
 * is the one value written to disk, and a bug upstream should not be able to
 * store a shape that fails to parse on the next launch and silently signs the
 * user out.
 */
export async function writeStoredCredentials(credentials: StoredCredentials): Promise<boolean> {
  if (!credentials || typeof credentials.refreshToken !== 'string') return false;
  return write({
    refreshToken: credentials.refreshToken,
    refreshExpiresAt:
      typeof credentials.refreshExpiresAt === 'string' ? credentials.refreshExpiresAt : undefined,
    email: typeof credentials.email === 'string' ? credentials.email : undefined,
    userId: typeof credentials.userId === 'string' ? credentials.userId : undefined,
  });
}

export async function clearStoredCredentials(): Promise<void> {
  await write(null);
}

/**
 * Whether a session can survive a restart at all.
 *
 * False on a machine with no OS keystore. Surfaced to the UI through
 * `auth.status()` because it changes what the user should expect — not as a
 * silent degradation to plaintext, which would look identical and protect
 * nothing.
 */
export function isCredentialStoreAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}
