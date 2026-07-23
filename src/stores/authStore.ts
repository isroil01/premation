/**
 * Auth store — session state for the motion-back backend.
 *
 * Wraps the api client's token handling with reactive user state so the UI can
 * show signed-in status. On successful auth it pulls the user's cloud assets
 * into the asset store; on boot, `hydrate()` validates any stored token.
 */

import { create } from 'zustand';
import { api, getToken, setToken } from '@core/api/client';
import { useAssetStore } from './assetStore';
import { useAiProviderStore } from './aiProviderStore';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

interface AuthState {
  user: AuthUser | null;
  status: 'idle' | 'loading' | 'authenticated';
  error: string | null;
}

interface AuthActions {
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
  logout: () => void;
  /** Validate a stored token on boot; clears it if the session is dead. */
  hydrate: () => Promise<void>;
  clearError: () => void;
}

async function afterAuth(): Promise<void> {
  // Bring the user's cloud assets into the panel; ignore failures (offline).
  await useAssetStore.getState().loadFromCloud().catch(() => undefined);
  // Sync AI Keys status & decrypt them into localStorage
  await useAiProviderStore.getState().refreshStatus().catch(() => undefined);
}

export const useAuthStore = create<AuthState & AuthActions>((set) => ({
  user: null,
  status: 'idle',
  error: null,

  login: async (email, password) => {
    set({ status: 'loading', error: null });
    try {
      const res = await api.login(email, password);
      setToken(res.token);
      set({ user: res.user, status: 'authenticated', error: null });
      await afterAuth();
    } catch (err) {
      set({ status: 'idle', error: (err as Error).message || 'Sign in failed' });
      throw err;
    }
  },

  register: async (email, password, name) => {
    set({ status: 'loading', error: null });
    try {
      const res = await api.register(email, password, name);
      setToken(res.token);
      set({ user: res.user, status: 'authenticated', error: null });
      await afterAuth();
    } catch (err) {
      set({ status: 'idle', error: (err as Error).message || 'Registration failed' });
      throw err;
    }
  },

  logout: () => {
    setToken(null);
    set({ user: null, status: 'idle', error: null });
  },

  hydrate: async () => {
    if (!getToken()) return;
    set({ status: 'loading' });
    try {
      const user = await api.me();
      set({ user, status: 'authenticated' });
      await afterAuth();
    } catch {
      setToken(null);
      set({ user: null, status: 'idle' });
    }
  },

  clearError: () => set({ error: null }),
}));
