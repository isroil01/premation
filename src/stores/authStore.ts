/**
 * Auth store — session state for the motion-back backend.
 *
 * Wraps the api client's token handling with reactive user state so the UI can
 * show signed-in status. On successful auth it pulls the user's cloud assets
 * into the asset store; on boot, `hydrate` validates any stored token.
 */

import { create } from 'zustand';
import { api, clearCache, type UserRole } from '@core/api/client';
import {
  clearSession,
  hasSession,
  loadSession,
  refreshSession,
  setSession,
} from '@core/api/session';
import { useAssetStore } from './assetStore';
import { useAiProviderStore } from './aiProviderStore';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  /**
   * Platform privilege, as reported by the backend.
   *
   * Informational only here — the desktop app has no admin surface to gate. The
   * operator console lives in the motion-landing web app, and the server
   * re-checks the role against the database on every /api/admin call regardless.
   */
  role: UserRole;
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
  /**
   * Adopt a session established outside this store — today that is the OAuth
   * callback, which exchanges its one-time code itself.
   *
   * It exists because that page used to call `setState` directly and therefore
   * skipped every post-sign-in step: a user who signed in with Google got no
   * cloud assets and, more visibly, no AI key status — so the assistant told
   * them to set up an API key they had already saved, for the whole session.
   */
  adoptSession: (user: AuthUser) => Promise<void>;
  clearError: () => void;
}

async function afterAuth(userId: string): Promise<void> {
  // Bring the user's cloud assets into the panel; ignore failures (offline).
  await useAssetStore.getState().loadFromCloud().catch(() => undefined);
  // Which account the assistant's key status belongs to. MUST come before the
  // refresh: it drops a cached status left by a different user on this machine,
  // and it is what lets the refresh persist a new one.
  useAiProviderStore.getState().setAccount(userId);
  // Pull the encrypted-at-rest key status ({present, hint} only — no key ever
  // leaves the server) so the assistant knows which providers can run.
  await useAiProviderStore.getState().refreshStatus().catch(() => undefined);
}

export const useAuthStore = create<AuthState & AuthActions>((set) => ({
  user: null,
  status: 'idle',
  error: null,

  login: async (email, password) => {
    set({ status: 'loading', error: null });
    try {
      // Whatever the previous session cached belongs to the previous session.
      clearCache();
      const res = await api.login(email, password);
      // Stores the refresh token in the OS keystore on desktop; the access
      // token stays in memory. See core/api/session.
      await setSession(res);
      set({ user: res.user, status: 'authenticated', error: null });
      await afterAuth(res.user.id);
    } catch (err) {
      set({ status: 'idle', error: (err as Error).message || 'Sign in failed' });
      throw err;
    }
  },

  register: async (email, password, name) => {
    set({ status: 'loading', error: null });
    try {
      clearCache();
      const res = await api.register(email, password, name);
      await setSession(res);
      set({ user: res.user, status: 'authenticated', error: null });
      await afterAuth(res.user.id);
    } catch (err) {
      set({ status: 'idle', error: (err as Error).message || 'Registration failed' });
      throw err;
    }
  },

  logout: () => {
    // Tell the server first, so the refresh token is revoked rather than just
    // forgotten — a token this client discards without saying so stays valid
    // for 90 days on whatever copied it. Fire-and-forget: being signed out
    // locally must not depend on the network.
    void api.logout().catch(() => undefined);
    void clearSession();
    // Everything cached was fetched under a session that is now gone — leaving
    // it would show the previous account's projects to the next person to sign
    // in on this machine.
    clearCache();
    // Same reasoning for the assistant: the cached key status is persisted
    // across launches, so it has to be dropped explicitly rather than just
    // forgotten in memory.
    useAiProviderStore.getState().reset();
    set({ user: null, status: 'idle', error: null });
  },

  hydrate: async () => {
    // Reads the OS keystore on desktop, localStorage in the browser.
    await loadSession();
    if (!hasSession()) return;

    set({ status: 'loading' });
    try {
      // A stored session has only a refresh token — the access token was never
      // persisted — so exchange it before the first real call. `api.me`
      // would trigger this anyway via the 401 path; doing it up front means
      // the boot sequence is one round trip instead of a failure and a retry.
      await refreshSession();

      const user = await api.me();
      set({ user, status: 'authenticated' });
      await afterAuth(user.id);
    } catch {
      await clearSession();
      clearCache();
      useAiProviderStore.getState().reset();
      set({ user: null, status: 'idle' });
    }
  },

  adoptSession: async (user) => {
    set({ user, status: 'authenticated', error: null });
    await afterAuth(user.id);
  },

  clearError: () => set({ error: null }),
}));
