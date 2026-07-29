/**
 * How the assistant is powered: our metered AI ('motion') or one of the user's
 * own provider accounts — plus which model, and whether it's usable yet.
 *
 * Only the *choice* lives here. Keys are stored encrypted on the backend (the
 * AI gateway) and are never sent to any client; `status` mirrors what the
 * gateway reports ({present, hint}), so the composer can be gated on "is this
 * usable" without ever holding a key.
 *
 * Three things make that gate actually work, all of which were missing:
 *
 *  1. **The persisted choice is read back.** This module is evaluated when
 *     `authStore` is imported — long before `Application.boot()` registers the
 *     SettingsManager — so `getSettingsManager()` threw on every launch and the
 *     `catch` reset the provider to `anthropic`. A user whose only key was
 *     OpenAI or Gemini got "Connect an AI provider to start" forever, on every
 *     new chat, no matter how many keys they had saved. `persistedValue` reads
 *     the same settings blob without requiring boot.
 *
 *  2. **The status is cached across launches** (masked hints and booleans only —
 *     never key material). The gate is therefore correct on the first frame and
 *     while offline, instead of flashing "no key" until `/ai/keys` answers.
 *
 *  3. **A provider that cannot run is not left selected.** After any status
 *     change the store falls back to a provider the user actually has, so
 *     "I added a key and it still says set up a key" cannot happen.
 */

import { create } from 'zustand';
import { deletePersisted, readPersisted, writePersisted } from '@core/settings/persistedValue';
import { ADAPTERS, type ProviderId } from '@motion/ai-tools';
import { onSessionChange } from '@core/api/session';
import {
  api,
  isAuthenticated,
  type AiKeyStatus,
  type AiMotionStatus,
  type AiProviderId,
  type GatewayProviderId,
} from '@core/api/client';

/** Suggested models per provider. Users can type any id the provider accepts. */
/**
 * FALLBACK model ids, used only until `/ai/models` answers.
 *
 * F13/F15: this used to be the picker's source of truth, and it duplicated
 * `ModelRouter.CAPABILITY_MATRIX` on the backend by hand. Two hand-maintained
 * lists of model ids go stale independently — and the stale one was the list the
 * user actually picked from, while the validated one only decided routing.
 *
 * The backend is now authoritative (`refreshModels`). This list survives so a
 * cold start or an offline editor still shows something pickable rather than an
 * empty dropdown, which is a worse failure than a slightly old list.
 */
export const MODEL_SUGGESTIONS: Record<AiProviderId, readonly string[]> = {
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
  // NOTE: unverified against a live OpenAI key — these are carried over, not
  // confirmed current. Every OpenAI run in the audit used gpt-4o.
  openai: ['gpt-4o', 'gpt-4o-mini', 'o4-mini'],
  // Gemini 3.x only — the 2.x models are retired / unavailable on current keys.
  // gemini-3.5-flash is the current stable; 3.1-pro-preview is the latest Pro.
  gemini: ['gemini-3.5-flash', 'gemini-3.1-pro-preview'],
};

/** The BYOK providers this editor offers, in the order it prefers them. */
export const PROVIDER_IDS: readonly AiProviderId[] = ['anthropic', 'openai', 'gemini'];

/**
 * Where the selection falls back when the chosen provider cannot run.
 *
 * BYOK first: it is the user's own account (no credits, no plan gate), and the
 * Director pipeline is BYOK-only server-side. Motion AI is the last resort.
 */
const FALLBACK_ORDER: readonly GatewayProviderId[] = [...PROVIDER_IDS, 'motion'];

const SETTINGS_KEY = 'aiProvider';
/** The cached gateway answer. Non-secret by construction — see `StatusCache`. */
const STATUS_CACHE_KEY = 'aiProviderStatus';

/**
 * Past this, a cache is too old to be worth trusting on a cold, offline start.
 * It is only ever a head start: `refreshStatus` overwrites it seconds later.
 */
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface Persisted {
  provider: GatewayProviderId;
  models: Partial<Record<AiProviderId, string>>;
}

/**
 * What we persist about key state, and nothing more: booleans and the masked
 * hint the server already computed for display ("sk-…4f2a"). No key material
 * has ever been in the renderer, and none is introduced here — see
 * `core/api/purgeLocalKeys.ts` for what happens when that line is crossed.
 *
 * Scoped by `userId` so signing in as somebody else on the same machine cannot
 * show the previous account's providers as connected.
 */
interface StatusCache {
  userId: string;
  keys: Partial<Record<AiProviderId, AiKeyStatus>>;
  motion: AiMotionStatus | null;
  savedAt: number;
}

const DEFAULTS: Persisted = { provider: 'anthropic', models: {} };

function loadPersisted(): Persisted {
  const raw = readPersisted<Partial<Persisted>>(SETTINGS_KEY, DEFAULTS);
  const provider = raw?.provider;
  return {
    provider:
      provider && (FALLBACK_ORDER as readonly string[]).includes(provider)
        ? provider
        : DEFAULTS.provider,
    models: raw?.models && typeof raw.models === 'object' ? raw.models : {},
  };
}

function persist(p: Persisted): void {
  writePersisted<Persisted>(SETTINGS_KEY, p);
}

function loadCache(): StatusCache | null {
  const raw = readPersisted<StatusCache | null>(STATUS_CACHE_KEY, null);
  if (!raw || typeof raw !== 'object' || typeof raw.userId !== 'string') return null;
  if (!raw.savedAt || Date.now() - raw.savedAt > CACHE_MAX_AGE_MS) return null;
  return raw;
}

function saveCache(cache: StatusCache): void {
  writePersisted<StatusCache>(STATUS_CACHE_KEY, cache);
}

/** Keep only the providers this editor offers, so the blob stays small. */
function trimKeys(
  status: Record<AiProviderId, AiKeyStatus> | null,
): Partial<Record<AiProviderId, AiKeyStatus>> {
  const out: Partial<Record<AiProviderId, AiKeyStatus>> = {};
  if (!status) return out;
  for (const p of PROVIDER_IDS) {
    const s = status[p];
    if (s?.present) out[p] = { present: true, hint: s.hint ?? '' };
  }
  return out;
}

/** "sk-proj-abc…4f2a" → "sk-…4f2a". Mirrors `maskKey` on the backend. */
function maskKey(key: string): string {
  return key.length <= 8 ? '…' : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

function isUsable(
  p: GatewayProviderId,
  status: Record<AiProviderId, AiKeyStatus> | null,
  motion: AiMotionStatus | null,
): boolean {
  return p === 'motion' ? !!motion?.present : !!status?.[p]?.present;
}

/**
 * The provider to select, given what the account can actually run.
 *
 * Returns `null` to mean "leave the current one alone" — either it works, or
 * nothing works and naming the user's own choice in the UI beats silently
 * swapping it for another one that is equally unusable.
 */
function resolveProvider(
  current: GatewayProviderId,
  status: Record<AiProviderId, AiKeyStatus> | null,
  motion: AiMotionStatus | null,
): GatewayProviderId | null {
  if (isUsable(current, status, motion)) return null;
  for (const p of FALLBACK_ORDER) {
    if (p !== current && isUsable(p, status, motion)) return p;
  }
  return null;
}

interface AiProviderState {
  provider: GatewayProviderId;
  models: Partial<Record<AiProviderId, string>>;
  status: Record<AiProviderId, AiKeyStatus> | null;
  motion: AiMotionStatus | null;
  /** The account `status`/`motion` describe. Guards a cache from another user. */
  accountId: string | null;
  /** True once a live `/ai/keys` answer has landed this session. */
  verified: boolean;
  setProvider: (p: GatewayProviderId) => void;
  setModel: (p: AiProviderId, model: string) => void;
  /**
   * Which provider's WIRE FORMAT to speak. For our metered AI that's whatever
   * our own key happens to be, which the gateway reports.
   */
  dialect: () => ProviderId;
  /** The model id to request, falling back to the adapter default. */
  model: () => string;
  /** True when the active choice can actually run a prompt. */
  ready: () => boolean;
  /** True when ANY provider on this account can run a prompt. */
  anyReady: () => boolean;
  refreshStatus: (opts?: { force?: boolean }) => Promise<void>;
  /**
   * Adopt the signed-in account. Drops a cache belonging to anyone else, so the
   * next user on this machine never sees the previous user's providers.
   */
  setAccount: (userId: string) => void;
  /** Forget everything account-scoped. Called on sign-out and on session loss. */
  reset: () => void;
  /**
   * Save a key through the gateway and make its provider the active one — that
   * is why the user just connected it. Updates `status` without waiting for the
   * round trip so the composer unlocks immediately, then confirms with a fetch.
   */
  saveKey: (
    p: AiProviderId,
    key: string,
  ) => Promise<{ ok: boolean; reason?: 'invalid' | 'unavailable' | 'network' }>;
  /** Remove a key, and move off it if it was the active provider. */
  clearKey: (p: AiProviderId) => Promise<{ ok: boolean }>;
  /**
   * Model ids the BACKEND says it can route to, once `/ai/models` has answered.
   * `null` until then, which is when `modelsFor` falls back to MODEL_SUGGESTIONS.
   */
  serverModels: Partial<Record<AiProviderId, readonly string[]>> | null;
  /** Fetch the authoritative model list. Safe to call repeatedly. */
  refreshModels: () => Promise<void>;
  /** The ids to offer for a provider — server list if known, fallback if not. */
  modelsFor: (p: AiProviderId) => readonly string[];
  /**
   * Reconcile the selection and the persisted cache with the current status.
   * Internal: every path that changes `status`/`motion` ends here, which is what
   * guarantees a connected provider is never left unselected.
   */
  applyStatus: () => void;
}

/**
 * The in-flight `/ai/keys` fetch, shared by every caller.
 *
 * The settings page, the chat hook and the billing panel all refresh on mount,
 * and the chat panel refreshes again after a `no_key` failure. Without this that
 * is four identical requests in one tick, and the last one to land wins — which
 * can be the oldest answer.
 */
let inFlight: Promise<void> | null = null;
/** Identifies the current refresh, so an older one cannot free a newer one's slot. */
let inFlightId = 0;

const cached = loadCache();

export const useAiProviderStore = create<AiProviderState>((set, get) => ({
  ...loadPersisted(),
  // Optimistic hydrate: whatever this machine last saw for the last account to
  // sign in here. `setAccount` drops it if a different user signs in, and
  // `refreshStatus` replaces it with the truth within a second of boot.
  status: (cached?.keys as Record<AiProviderId, AiKeyStatus> | undefined) ?? null,
  motion: cached?.motion ?? null,
  accountId: cached?.userId ?? null,
  verified: false,
  serverModels: null,

  setProvider: (provider) => {
    if (get().provider === provider) return;
    set({ provider });
    persist({ provider, models: get().models });
  },

  setModel: (p, model) => {
    const models = { ...get().models, [p]: model };
    set({ models });
    persist({ provider: get().provider, models });
  },

  dialect: () => {
    const { provider, motion } = get();
    return provider === 'motion' ? motion?.dialect ?? 'anthropic' : provider;
  },

  model: () => {
    const { provider, models, motion } = get();
    // Motion AI: the server forces its own model anyway — send what it named
    // so the request body is coherent if the provider echoes it back.
    if (provider === 'motion') return motion?.model || ADAPTERS[get().dialect()].defaultModel;
    return models[provider] || ADAPTERS[provider].defaultModel;
  },

  ready: () => {
    const { provider, status, motion } = get();
    return isUsable(provider, status, motion);
  },

  anyReady: () => {
    const { status, motion } = get();
    return FALLBACK_ORDER.some((p) => isUsable(p, status, motion));
  },

  refreshModels: async () => {
    if (!isAuthenticated()) return;
    try {
      const { models } = await api.getAiModels();
      const grouped: Partial<Record<AiProviderId, string[]>> = {};
      for (const m of models) {
        if (!m?.provider || !m?.model) continue;
        (grouped[m.provider] ??= []).push(m.model);
      }
      // Only adopt a provider's list if the server named at least one model for
      // it. An empty group means the backend has no route, and replacing a
      // working fallback with nothing would empty the picker.
      const adopted: Partial<Record<AiProviderId, readonly string[]>> = {};
      for (const [provider, list] of Object.entries(grouped)) {
        if (list?.length) adopted[provider as AiProviderId] = list;
      }
      if (Object.keys(adopted).length) set({ serverModels: adopted });
    } catch {
      // Offline or unauthenticated — the fallback list is still pickable, which
      // is a much better failure than an empty dropdown.
    }
  },

  modelsFor: (p) => get().serverModels?.[p] ?? MODEL_SUGGESTIONS[p],

  setAccount: (userId) => {
    if (get().accountId === userId) return;
    // A different person is signing in on this machine. Everything cached
    // describes the previous account's keys and credits.
    set({ status: null, motion: null, verified: false, accountId: userId });
    deletePersisted(STATUS_CACHE_KEY);
  },

  reset: () => {
    set({ status: null, motion: null, verified: false, accountId: null });
    deletePersisted(STATUS_CACHE_KEY);
  },

  refreshStatus: async (opts) => {
    if (!isAuthenticated()) {
      // Do NOT wipe what we have. This is reached during boot, before
      // `loadSession()` has read the keystore — clearing here is what made the
      // panel say "connect a provider" for the first second of every launch.
      // Real sign-out goes through `reset()`, which is unambiguous.
      return;
    }
    if (inFlight && !opts?.force) return inFlight;

    const id = ++inFlightId;
    const mine = (async () => {
      try {
        const { motion, ...keys } = await api.getAiKeys();
        const status = keys as Record<AiProviderId, AiKeyStatus>;
        set({ status, motion, verified: true });
        get().applyStatus();
        // Same trip: a picker that knew which keys were connected but not which
        // models the server can route to would still be driven by the stale list.
        void get().refreshModels();
      } catch {
        // Offline, or the gateway is down. The cached status is the best answer
        // available and is still probably right — dropping it would tell the
        // user their keys are gone because their wifi dropped.
      } finally {
        // Only if this is still the current one: a forced refresh started while
        // this was in flight owns the slot now, and clearing it would let a
        // third caller start a duplicate.
        if (inFlightId === id) inFlight = null;
      }
    })();

    inFlight = mine;
    return mine;
  },

  saveKey: async (p, key) => {
    const trimmed = key.trim();
    if (!trimmed) return { ok: false, reason: 'invalid' };
    try {
      const res = await api.saveAiKey(p, trimmed);
      if (!res.ok) return { ok: false, ...(res.reason ? { reason: res.reason } : {}) };
    } catch {
      return { ok: false, reason: 'network' };
    }
    // The gateway accepted it. Reflect that immediately — a user who just
    // connected a provider should not watch a second round trip before the
    // composer unlocks. `hint` is the same masked tail the server computes and
    // is all that is ever displayed; the key itself is not kept.
    const status = {
      ...(get().status ?? ({} as Record<AiProviderId, AiKeyStatus>)),
      [p]: { present: true, hint: maskKey(trimmed) },
    } as Record<AiProviderId, AiKeyStatus>;
    set({ status });
    get().setProvider(p);
    get().applyStatus();
    // Confirm against the server, and pick up anything that changed with it
    // (model routes, motion credits). Failure is fine — we already know.
    void get().refreshStatus({ force: true });
    return { ok: true };
  },

  clearKey: async (p) => {
    try {
      await api.clearAiKey(p);
    } catch {
      // Leave the status alone: we do not know whether the delete landed, and
      // showing "not configured" for a key that is still there is a lie the
      // user would act on.
      return { ok: false };
    }
    const status = {
      ...(get().status ?? ({} as Record<AiProviderId, AiKeyStatus>)),
      [p]: { present: false, hint: '' },
    } as Record<AiProviderId, AiKeyStatus>;
    set({ status });
    // Removing the key you were using must move the selection, or the composer
    // stays pointed at a provider that now 400s.
    get().applyStatus();
    void get().refreshStatus({ force: true });
    return { ok: true };
  },

  applyStatus: () => {
    const { provider, status, motion, accountId } = get();
    const next = resolveProvider(provider, status, motion);
    if (next) get().setProvider(next);
    // Only cache once we know whose account this is — an unattributed cache is
    // one the next user to sign in here would inherit.
    if (accountId) {
      saveCache({ userId: accountId, keys: trimKeys(status), motion, savedAt: Date.now() });
    }
  },
}));

/**
 * A session that ends without `logout()` — a refused refresh, a revoked token —
 * still ends. Everything account-scoped goes with it.
 */
onSessionChange((signedIn) => {
  if (!signedIn) useAiProviderStore.getState().reset();
});
