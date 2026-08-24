/**
 * API keys for media providers (video, speech, 3D) in the local edition.
 *
 * Same custody model as `aiKeyVault`: write-only over IPC, main-process spend,
 * separate file from chat keys so clearing one does not drop the other.
 */

import { app, safeStorage } from 'electron';
import { handle } from './ipcGuard';
import path from 'node:path';
import { readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';
import { maskKey } from './aiKeyVault';

export const MEDIA_VAULT_PROVIDERS = ['fal', 'elevenlabs', 'tripo'] as const;
export type MediaVaultProvider = (typeof MEDIA_VAULT_PROVIDERS)[number];

const isMediaProvider = (v: unknown): v is MediaVaultProvider =>
  typeof v === 'string' && (MEDIA_VAULT_PROVIDERS as readonly string[]).includes(v);

type Vault = Partial<Record<MediaVaultProvider, string>>;

export interface KeyStatus {
  present: boolean;
  hint: string;
}

const FILE = (): string => path.join(app.getPath('userData'), 'ai-media-keys.bin');

let cached: Vault | undefined;

async function read(): Promise<Vault> {
  if (cached !== undefined) return cached;
  try {
    const encrypted = await readFile(FILE());
    if (!safeStorage.isEncryptionAvailable()) return (cached = {});
    const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as unknown;
    const out: Vault = {};
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (isMediaProvider(k) && typeof v === 'string' && v) out[k] = v;
      }
    }
    cached = out;
  } catch {
    cached = {};
  }
  return cached;
}

async function write(vault: Vault): Promise<boolean> {
  const file = FILE();
  if (Object.keys(vault).length === 0) {
    cached = {};
    await unlink(file).catch(() => undefined);
    return true;
  }
  if (!safeStorage.isEncryptionAvailable()) {
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

/** Main process only — never IPC. */
export async function getMediaKeyForProvider(provider: MediaVaultProvider): Promise<string | null> {
  const vault = await read();
  return vault[provider] ?? null;
}

export async function mediaKeyStatuses(): Promise<Record<MediaVaultProvider, KeyStatus>> {
  const vault = await read();
  const out = {} as Record<MediaVaultProvider, KeyStatus>;
  for (const p of MEDIA_VAULT_PROVIDERS) {
    const key = vault[p];
    out[p] = key ? { present: true, hint: maskKey(key) } : { present: false, hint: '' };
  }
  return out;
}

export function registerMediaKeyIpc(): void {
  handle('mediaKeys:status', async (): Promise<Record<MediaVaultProvider, KeyStatus>> => mediaKeyStatuses());

  handle(
    'mediaKeys:set',
    async (_event, provider: unknown, key: unknown): Promise<{ persisted: boolean; hint: string }> => {
      if (!isMediaProvider(provider) || typeof key !== 'string') {
        return { persisted: false, hint: '' };
      }
      const trimmed = key.trim();
      if (trimmed.length < 8 || trimmed.length > 512) {
        return { persisted: false, hint: '' };
      }
      const vault = { ...(await read()), [provider]: trimmed };
      const persisted = await write(vault);
      return { persisted, hint: maskKey(trimmed) };
    },
  );

  handle('mediaKeys:clear', async (_event, provider: unknown): Promise<void> => {
    if (provider === undefined || provider === null) {
      await write({});
      return;
    }
    if (!isMediaProvider(provider)) return;
    const vault = { ...(await read()) };
    delete vault[provider];
    await write(vault);
  });

  handle('mediaKeys:available', () => safeStorage.isEncryptionAvailable());
}

export function resetMediaVaultCacheForTests(): void {
  cached = undefined;
}
