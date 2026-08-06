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
import { useEntitlementStore } from './entitlementStore';

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
  /**
   * Whether the account's email is confirmed. Email/password sign-ups start
   * `false` and are gated to the confirm-code page until they enter it (see
   * RequireAuth); OAuth accounts arrive already `true`. The write guards on the
   * server are the real enforcement — this only drives routing.
   */
  emailVerified: boolean;
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
  /** Flip the local user to verified after the confirm-code step succeeds. */
  markEmailVerified: () => void;
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
  // Whether this account may WRITE to the cloud, so the editor knows to enter
  // read-only mode before the user hits a 403 rather than after. Best-effort:
  // the write guards are the real enforcement, this is only the friendly warning.
  // Not forced: hydrate() has just populated the `account` cache from the same
  // /auth/me, so this reads it rather than making a second identical round trip.
  await useEntitlementStore.getState().refresh().catch(() => undefined);
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
      // A sign-in can fail *after* the server has already minted the session —
      // anything past `api.login` throws with a live refresh token sitting in
      // the keystore. Leaving it is what produced the ghost: the screen said
      // sign-in failed, and the next launch came up signed in anyway. If we
      // report failure, there must be no session left to restore.
      await clearSession().catch(() => undefined);
      set({ status: 'idle', user: null, error: (err as Error).message || 'Sign in failed' });
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
      // Same reasoning as `login`: a failure reported after the account was
      // created must not leave a restorable session behind.
      await clearSession().catch(() => undefined);
      set({ status: 'idle', user: null, error: (err as Error).message || 'Registration failed' });
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
    // And the entitlement decision — the next person to sign in on this machine
    // must not briefly inherit the previous account's read-only banner.
    useEntitlementStore.getState().reset();
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

  markEmailVerified: () =>
    set((s) => (s.user ? { user: { ...s.user, emailVerified: true } } : {})),

  clearError: () => set({ error: null }),
}));
