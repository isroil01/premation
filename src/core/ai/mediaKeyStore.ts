/**
 * Media provider key storage — counterpart to `aiKeyStore` for fal / ElevenLabs / Tripo.
 */

import { api } from '@core/api/client';
import { aiRunsThroughBackend } from '@core/config/edition';
import type { MediaProviderId } from '@core/api/client';
import type { AiKeyStatus, MediaVaultProvider } from '@app-types/motionEditor';
import type { PersistFailure } from './aiKeyStore';

const LOCAL_MEDIA: readonly MediaVaultProvider[] = ['fal', 'elevenlabs', 'tripo'];

const isLocalMedia = (p: string): p is MediaVaultProvider =>
  (LOCAL_MEDIA as readonly string[]).includes(p);

const vault = () => globalThis.window?.motionEditor?.ai?.mediaKeys;

export function supportsMediaProviderLocally(provider: MediaProviderId): boolean {
  if (aiRunsThroughBackend()) return true;
  return isLocalMedia(provider);
}

export async function fetchMediaKeyStatuses(): Promise<Partial<Record<MediaProviderId, AiKeyStatus>>> {
  if (aiRunsThroughBackend()) {
    const all = await api.getAiKeys();
    const out: Partial<Record<MediaProviderId, AiKeyStatus>> = {};
    for (const p of LOCAL_MEDIA) {
      const s = (all as Record<string, AiKeyStatus | undefined>)[p];
      if (s) out[p] = s;
    }
    return out;
  }
  const status = vault()?.status;
  if (!status) return {};
  return (await status()) as Partial<Record<MediaProviderId, AiKeyStatus>>;
}

export async function persistMediaKey(
  provider: MediaProviderId,
  key: string,
): Promise<{ ok: boolean; reason?: PersistFailure; hint?: string }> {
  if (aiRunsThroughBackend()) {
    const res = await api.saveAiKey(provider as never, key);
    return res.ok ? { ok: true } : { ok: false, ...(res.reason ? { reason: res.reason } : {}) };
  }
  if (!isLocalMedia(provider)) return { ok: false, reason: 'unsupported' };
  const set = vault()?.set;
  if (!set) return { ok: false, reason: 'unsupported' };
  const res = await set(provider, key);
  return { ok: true, hint: res.hint };
}

export async function forgetMediaKey(provider: MediaProviderId): Promise<{ ok: boolean }> {
  if (aiRunsThroughBackend()) {
    await api.clearAiKey(provider as never);
    return { ok: true };
  }
  if (!isLocalMedia(provider)) return { ok: true };
  const clear = vault()?.clear;
  if (!clear) return { ok: false };
  await clear(provider);
  return { ok: true };
}
