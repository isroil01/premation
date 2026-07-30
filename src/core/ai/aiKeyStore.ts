/**
 * Where provider keys are kept — the storage counterpart to `aiTransport`.
 *
 *  • **server** — motion-back holds them, encrypted at rest with AI_KEY_SECRET.
 *    `GET /ai/keys` reports presence and a masked tail; the key itself is never
 *    returned to any client.
 *
 *  • **local** — the Electron main process holds them in the OS keystore, and
 *    `aiKeys:status` reports presence and a masked tail. The key itself has no
 *    read-back channel at all (electron/aiKeyVault.ts).
 *
 * Both report exactly the same shape, and neither can be asked for a key. The
 * store above this layer therefore needs no branch on edition — which is the
 * point, because a branch there would be a second place for the two editions to
 * drift apart.
 *
 * ── One honest limitation ───────────────────────────────────────────────────
 *
 * The desktop vault holds keys for the three providers the local proxy can
 * actually call: openai, anthropic, gemini. The media providers (fal, runway,
 * luma, tripo, meshy, elevenlabs) are cloud-only for now, because each needs its
 * own endpoint and auth scheme in `electron/aiProxy.ts` and a stored key that
 * nothing can spend is worse than no key — it renders as a connected provider
 * that fails on use. `supportsProviderLocally` is what the UI should ask so it can
 * say so plainly instead of offering a field that silently does nothing.
 */

import { api } from '@core/api/client';
import { aiRunsThroughBackend } from '@core/config/edition';
import type { AiProviderId } from '@core/api/client';
import type { AiKeyStatus, AiVaultProvider } from '@app-types/motionEditor';

/** The reasons `persistKey` can refuse, matching what the store already renders. */
export type PersistFailure = 'invalid' | 'unavailable' | 'network' | 'unsupported';

/** Providers the desktop vault can hold AND the desktop proxy can spend. */
const LOCAL_PROVIDERS: readonly AiVaultProvider[] = ['openai', 'anthropic', 'gemini'];

const isLocalProvider = (p: string): p is AiVaultProvider =>
  (LOCAL_PROVIDERS as readonly string[]).includes(p);

const vault = () => globalThis.window?.motionEditor?.ai?.keys;

/** Can this build store a key for this provider at all? */
export function supportsProviderLocally(provider: AiProviderId): boolean {
  if (aiRunsThroughBackend()) return true;
  return isLocalProvider(provider);
}

/** Does connecting a key require being signed in? Only when the server holds it. */
export function keyStorageRequiresAccount(): boolean {
  return aiRunsThroughBackend();
}

/**
 * True when a key can be persisted across launches.
 *
 * False in the local edition on a machine with no OS keystore — a Linux box with
 * no secret service. The assistant still works for the session; it just forgets
 * the key on quit, and the UI should say that rather than let the user wonder why
 * they retype it every morning.
 */
export async function keyStorageIsPersistent(): Promise<boolean> {
  if (aiRunsThroughBackend()) return true;
  const available = vault()?.available;
  return available ? await available() : false;
}

/** Presence and masked tails for every provider. Never key material. */
export async function fetchKeyStatuses(): Promise<Partial<Record<AiProviderId, AiKeyStatus>>> {
  if (aiRunsThroughBackend()) {
    return (await api.getAiKeys()) as unknown as Partial<Record<AiProviderId, AiKeyStatus>>;
  }
  const status = vault()?.status;
  if (!status) return {};
  // The vault answers for its three providers; the rest are simply absent here,
  // which is the truth rather than a `present: false` that implies "you could
  // connect this if you wanted to".
  return (await status()) as Partial<Record<AiProviderId, AiKeyStatus>>;
}

export async function persistKey(
  provider: AiProviderId,
  key: string,
): Promise<{ ok: boolean; reason?: PersistFailure; hint?: string }> {
  if (aiRunsThroughBackend()) {
    const res = await api.saveAiKey(provider, key);
    return res.ok ? { ok: true } : { ok: false, ...(res.reason ? { reason: res.reason } : {}) };
  }

  // Refused rather than stored: see the module comment. A key the local proxy
  // cannot spend would render as a connected provider that fails on use.
  if (!isLocalProvider(provider)) return { ok: false, reason: 'unsupported' };

  const set = vault()?.set;
  if (!set) return { ok: false, reason: 'unsupported' };

  const res = await set(provider, key);
  // `persisted: false` from a vault that accepted the key means there is no OS
  // keystore. That is not a failure to report as one — the key is usable for this
  // session — so it succeeds, and `keyStorageIsPersistent()` is what the UI reads
  // to explain why it will be forgotten.
  return { ok: true, hint: res.hint };
}

export async function forgetKey(provider: AiProviderId): Promise<{ ok: boolean }> {
  if (aiRunsThroughBackend()) {
    await api.clearAiKey(provider);
    return { ok: true };
  }
  if (!isLocalProvider(provider)) return { ok: true };
  const clear = vault()?.clear;
  if (!clear) return { ok: false };
  await clear(provider);
  return { ok: true };
}
