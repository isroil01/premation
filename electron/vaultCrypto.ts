/**
 * The OS-keystore encryption the three vaults share (aiKeyVault,
 * mediaKeyVault, credentialStore), on Electron's ASYNC safeStorage API.
 *
 * Electron 45 deprecates the synchronous `encryptString` / `decryptString` /
 * `isEncryptionAvailable` and 46 removes them. Vault files written by the
 * synchronous API before this module existed are read once through it (while
 * it still exists) and reported for rewriting, so they move to the async
 * format on their next read.
 */

import { safeStorage } from 'electron';

interface LegacySafeStorage {
  isEncryptionAvailable?: () => boolean;
  encryptString?: (plainText: string) => Buffer;
  decryptString?: (encrypted: Buffer) => string;
}

const legacy = (): LegacySafeStorage => safeStorage as unknown as LegacySafeStorage;
const hasAsync = (): boolean => typeof safeStorage.isAsyncEncryptionAvailable === 'function';

let known: boolean | undefined;

/** Whether a vault can be encrypted on this machine (no keystore → nothing is stored). */
export async function vaultEncryptionAvailable(): Promise<boolean> {
  try {
    known = hasAsync() ? await safeStorage.isAsyncEncryptionAvailable() : (legacy().isEncryptionAvailable?.() ?? false);
  } catch {
    known = false;
  }
  return known;
}

/**
 * The same answer for a synchronous caller: the last one resolved (the async
 * encryptor initialises lazily — `vaultEncryptionAvailable` is started at app
 * ready), else the synchronous API's while it exists, else false.
 */
export function vaultEncryptionKnown(): boolean {
  if (known !== undefined) return known;
  try {
    return legacy().isEncryptionAvailable?.() ?? false;
  } catch {
    return false;
  }
}

export async function encryptVault(plainText: string): Promise<Buffer> {
  if (hasAsync()) return safeStorage.encryptStringAsync(plainText);
  const encrypt = legacy().encryptString;
  if (!encrypt) throw new Error('safeStorage offers no encryption');
  return encrypt(plainText);
}

/**
 * The vault's text. `rewrite`: the file should be written again (the key was
 * rotated, or it is in the synchronous API's format).
 */
export async function decryptVault(encrypted: Buffer): Promise<{ text: string; rewrite: boolean }> {
  if (hasAsync()) {
    try {
      const r = await safeStorage.decryptStringAsync(encrypted);
      return { text: r.result, rewrite: r.shouldReEncrypt };
    } catch (err) {
      const decrypt = legacy().decryptString;
      if (!decrypt) throw err;
      // A vault written by the synchronous API.
      return { text: decrypt(encrypted), rewrite: true };
    }
  }
  const decrypt = legacy().decryptString;
  if (!decrypt) throw new Error('safeStorage offers no decryption');
  return { text: decrypt(encrypted), rewrite: false };
}
