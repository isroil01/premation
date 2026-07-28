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
 *  • The bytes live in the **main** process. The renderer never holds the
 *    refresh token in a place it can be inspected from — it asks for it over
 *    IPC and holds only the short-lived access token in memory.
 *  • They are encrypted with Electron's `safeStorage`, which is a wrapper over
 *    the OS keystore: DPAPI on Windows (keyed to the Windows account), the
 *    Keychain on macOS, and libsecret/kwallet on Linux. Copying the file to
 *    another machine or another user account yields nothing.
 *  • The file is written 0600 and atomically (temp + rename), so a crash
 *    mid-write cannot leave a half-written credential that reads as corrupt on
 *    next launch and silently signs the user out.
 *
 * When the OS keystore is unavailable — a Linux box with no secret service is
 * the realistic case — `safeStorage.isEncryptionAvailable()` is false. We store
 * nothing rather than writing plaintext and calling it a credential store: the
 * user signs in again each launch, which is honest, where a plaintext fallback
 * would look identical while offering no protection at all.
 */

import { app, ipcMain, safeStorage } from 'electron';
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

/**
 * IPC surface. Three verbs, no more: the renderer can save the session, read
 * it back, and drop it. It cannot enumerate, cannot read arbitrary paths, and
 * cannot ask where the file is.
 */
export function registerCredentialIpc(): void {
  ipcMain.handle('credentials:get', async (): Promise<StoredCredentials | null> => {
    const stored = await read();
    if (!stored) return null;

    // Drop an expired refresh token here rather than handing the renderer a
    // credential we already know the server will refuse.
    if (stored.refreshExpiresAt && new Date(stored.refreshExpiresAt).getTime() <= Date.now()) {
      await write(null);
      return null;
    }
    return stored;
  });

  ipcMain.handle(
    'credentials:set',
    async (_event, credentials: StoredCredentials): Promise<{ persisted: boolean }> => {
      // Validate rather than trust: this is the one IPC channel whose payload
      // is written to disk, and a renderer bug should not be able to store an
      // arbitrary object shape that fails to parse on the next launch.
      if (!credentials || typeof credentials.refreshToken !== 'string') {
        return { persisted: false };
      }
      const persisted = await write({
        refreshToken: credentials.refreshToken,
        refreshExpiresAt:
          typeof credentials.refreshExpiresAt === 'string' ? credentials.refreshExpiresAt : undefined,
        email: typeof credentials.email === 'string' ? credentials.email : undefined,
        userId: typeof credentials.userId === 'string' ? credentials.userId : undefined,
      });
      return { persisted };
    },
  );

  ipcMain.handle('credentials:clear', async (): Promise<void> => {
    await write(null);
  });

  ipcMain.handle('credentials:available', () => safeStorage.isEncryptionAvailable());
}
