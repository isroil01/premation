/**
 * How the assistant is powered: our metered AI ('motion') or one of the user's
 * own provider accounts — plus which model, and whether it's usable yet.
 *
 * Only the *choice* lives here. Keys are stored encrypted on the backend (the
 * AI gateway) and are never sent to any client; `status` mirrors what the
 * gateway reports ({present, hint}), so the composer can be gated on "is this
 * usable" without ever holding a key.
 */

import { create } from 'zustand';
import { getSettingsManager } from '@core/services/coreServices';
import { ADAPTERS, type ProviderId } from '@motion/ai-tools';
import {
  api,
  isAuthenticated,
  type AiKeyStatus,
  type AiMotionStatus,
  type AiProviderId,
  type GatewayProviderId,
} from '@core/api/client';

/** Suggested models per provider. Users can type any id the provider accepts. */
export const MODEL_SUGGESTIONS: Record<AiProviderId, readonly string[]> = {
  anthropic: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o4-mini'],
  // Gemini 3.x only — the 2.x models are retired / unavailable on current keys.
  // gemini-3.5-flash is the current stable; 3.1-pro-preview is the latest Pro.
  gemini: ['gemini-3.5-flash', 'gemini-3.1-pro-preview'],
};

const SETTINGS_KEY = 'aiProvider';

interface Persisted {
  provider: GatewayProviderId;
  models: Partial<Record<AiProviderId, string>>;
}

function load(): Persisted {
  try {
    return getSettingsManager().get<Persisted>(SETTINGS_KEY, { provider: 'anthropic', models: {} });
  } catch {
    return { provider: 'anthropic', models: {} };
  }
}

function persist(p: Persisted): void {
  try {
    getSettingsManager().set<Persisted>(SETTINGS_KEY, p);
  } catch {
    /* settings not booted — the in-memory choice still applies this session */
  }
}

interface AiProviderState {
  provider: GatewayProviderId;
  models: Partial<Record<AiProviderId, string>>;
  status: Record<AiProviderId, AiKeyStatus> | null;
  motion: AiMotionStatus | null;
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
  refreshStatus: () => Promise<void>;
}

export const useAiProviderStore = create<AiProviderState>((set, get) => ({
  ...load(),
  status: null,
  motion: null,

  setProvider: (provider) => {
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
    return provider === 'motion' ? !!motion?.present : !!status?.[provider]?.present;
  },

  refreshStatus: async () => {
    if (!isAuthenticated()) {
      set({ status: null, motion: null });
      return;
    }
    try {
      const keysResponse = await api.getAiKeys();
      const providers: AiProviderId[] = ['anthropic', 'openai', 'gemini'];
      let updated = false;

      for (const p of providers) {
        if (!keysResponse[p]?.present) {
          try {
            const localKey = localStorage.getItem(`motion_editor_local_ai_key_${p}`);
            if (localKey && localKey.trim()) {
              const saveRes = await api.saveAiKey(p, localKey.trim());
              if (saveRes.ok) {
                updated = true;
              }
            }
          } catch (e) {
            console.error(`Failed to auto-sync local key for ${p}`, e);
          }
        }
      }

      const finalKeys = updated ? await api.getAiKeys() : keysResponse;
      const { motion, ...keys } = finalKeys;
      set({ status: keys, motion });
    } catch {
      set({ status: null, motion: null });
    }
  },
}));
