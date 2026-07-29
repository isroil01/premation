/**
 * The signed-in session: where each token lives, and how it is renewed.
 *
 * Two tokens with deliberately different homes:
 *
 *   **Access token** — a short-lived JWT (an hour). Kept in **memory only**,
 *   never written anywhere. It expires on its own, so persisting it would add
 *   a place to steal it from and save nothing: the refresh token can always
 *   mint another.
 *
 *   **Refresh token** — the 90-day credential that makes the desktop app stay
 *   signed in across launches, the way a desktop app should. On Electron it is
 *   handed to the main process and encrypted with the OS keystore (DPAPI /
 *   Keychain / libsecret) — out of reach of DevTools and of anything reading
 *   the profile directory. In a plain browser build there is no such vault, so
 *   it falls back to `localStorage`; that is stated plainly rather than
 *   pretended away, and it is why the *desktop* build is the one that gets the
 *   long session.
 *
 * Renewal is silent and single-flight: the first request to see a 401 triggers
 * one refresh, every other in-flight request waits on that same promise, and
 * they all retry once. A user editing at 59 minutes past the hour notices
 * nothing.
 */

import { IS_ELECTRON } from './env';

/** Legacy key. Read once at boot so an existing session survives the upgrade. */
const LEGACY_TOKEN_KEY = 'motion-editor.auth-token';
/** Browser-build fallback home for the refresh token. */
const WEB_REFRESH_KEY = 'motion-editor.refresh-token';

export interface SessionTokens {
  token: string;
  refreshToken: string;
  /** Seconds the access token is valid for, from the moment it was issued. */
  expiresIn: number;
  refreshExpiresAt?: string;
  user?: { id: string; email: string };
}

/**
 * The access token, in memory.
 *
 * A module-level variable rather than a store: `request` needs it
 * synchronously on every call, and a subscription would be ceremony around a
 * value that has exactly one writer.
 */
let accessToken: string | null = null;
/** Epoch ms at which `accessToken` stops being accepted. */
let accessExpiresAt = 0;
let refreshToken: string | null = null;

/** Set once the boot-time load has run, so callers can tell "no session" from "not yet asked". */
let loaded = false;

type Listener = (signedIn: boolean) => void;
const listeners = new Set<Listener>();

/** Notified when the session ends for a reason the user did not ask for. */
export function onSessionChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const bridge = (): NonNullable<Window['motionEditor']>['credentials'] | undefined =>
  typeof window === 'undefined' ? undefined : window.motionEditor?.credentials;

/**
 * Load the stored session. Call once, before the app decides what to render.
 *
 * Returns true when there is a refresh token worth trying. It does NOT verify
 * it — that happens on the first refresh, which is also the first API call, so
 * verifying here would just be doing it twice.
 */
export async function loadSession(): Promise<boolean> {
  if (loaded) return Boolean(refreshToken);
  loaded = true;

  if (IS_ELECTRON) {
    const stored = await bridge()?.get?.().catch(() => null);
    refreshToken = stored?.refreshToken ?? null;
  } else {
    refreshToken = safeGet(WEB_REFRESH_KEY);
  }

  /**
   * Migration for sessions created before refresh tokens existed.
   *
   * Those users hold a 7-day access token in localStorage and no refresh
   * token. Adopting it as the in-memory access token lets them keep working;
   * when it expires there is nothing to refresh with, so they sign in once and
   * land on the new scheme. The alternative — signing everyone out on upgrade —
   * is a worse first impression than one extra sign-in at some point that week.
   */
  const legacy = safeGet(LEGACY_TOKEN_KEY);
  if (legacy && !accessToken) {
    accessToken = legacy;
    accessExpiresAt = Date.now() + 60_000;
    safeRemove(LEGACY_TOKEN_KEY);
  }

  return Boolean(refreshToken);
}

/** The bearer for the next request, or null. Synchronous by design. */
export function getAccessToken(): string | null {
  return accessToken;
}

/** True when a refresh token exists — i.e. a session is worth restoring. */
export function hasSession(): boolean {
  return Boolean(refreshToken || accessToken);
}

/**
 * The refresh token, for the two calls that must present it: `/auth/refresh`
 * and `/auth/logout`.
 *
 * It is in renderer memory while the app runs — unavoidable, since the
 * renderer is what makes those HTTP calls. What the keystore buys is the *at
 * rest* case, which is the one that matters here: nothing on disk, nothing in
 * localStorage, nothing a curious user or a script running as them can read
 * between launches. Reading it out of live process memory is a categorically
 * harder problem, and one that already implies control of the machine.
 */
export function currentRefreshToken(): string | null {
  return refreshToken;
}

/** Adopt a fresh pair from /auth/login, /auth/register, or /auth/refresh. */
export async function setSession(tokens: SessionTokens): Promise<void> {
  accessToken = tokens.token;
  // A minute of slack, so a request is never sent with a token that expires
  // while it is in flight — clock skew between client and server is real, and
  // the cost of refreshing a minute early is one extra call an hour.
  accessExpiresAt = Date.now() + Math.max(0, tokens.expiresIn - 60) * 1000;
  loaded = true;

  // An empty refresh token means the caller only has a bare access token (the
  // legacy `setToken` path, and the test suite). Persisting "" would leave a
  // stored credential that fails on the next launch for no reason, so keep
  // whatever real token is already there.
  if (!tokens.refreshToken) return;
  refreshToken = tokens.refreshToken;

  if (IS_ELECTRON) {
    await bridge()
      ?.set?.({
        refreshToken: tokens.refreshToken,
        refreshExpiresAt: tokens.refreshExpiresAt,
        email: tokens.user?.email,
        userId: tokens.user?.id,
      })
      .catch(() => undefined);
  } else {
    safeSet(WEB_REFRESH_KEY, tokens.refreshToken);
  }
}

/** Forget everything. Called on sign-out and whenever a refresh is refused. */
export async function clearSession(): Promise<void> {
  accessToken = null;
  accessExpiresAt = 0;
  refreshToken = null;
  safeRemove(WEB_REFRESH_KEY);
  safeRemove(LEGACY_TOKEN_KEY);
  if (IS_ELECTRON) await bridge()?.clear?.().catch(() => undefined);
  for (const fn of listeners) fn(false);
}

/**
 * In-flight refresh, shared by every caller.
 *
 * Without this, a dashboard that fires six requests on mount against an expired
 * token would run six refreshes. Five of them would present a token that the
 * first has already rotated away — which the server correctly reads as token
 * reuse, and answers by revoking the whole session. The single-flight promise
 * is not an optimisation here; it is what stops the app from logging itself out.
 */
let refreshInFlight: Promise<boolean> | null = null;

/**
 * Exchange the refresh token for a new pair.
 *
 * Resolves false when there is nothing to refresh with or the server refused —
 * in which case the session has been cleared and the caller should surface a
 * sign-in prompt rather than retry.
 */
export function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  if (!refreshToken) return Promise.resolve(false);

  const presented = refreshToken;
  refreshInFlight = (async () => {
    try {
      // A bare fetch, not `request`: that helper retries through *this*
      // function on a 401, and a refresh that refreshes is an infinite loop.
      const { API_URL } = await import('./env');
      const res = await fetch(`${API_URL || 'http://localhost:4000/api'}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...clientNameHeader() },
        body: JSON.stringify({ refreshToken: presented }),
      });

      if (!res.ok) {
        // 401 means the token is spent, revoked, or expired — all terminal.
        // A 5xx or a network failure is not: the session may well be fine, and
        // dropping it would sign a user out because the server hiccuped.
        if (res.status === 401 || res.status === 403) await clearSession();
        return false;
      }

      await setSession((await res.json()) as SessionTokens);
      return true;
    } catch {
      // Offline. Keep the refresh token — the session is probably still valid,
      // and the next attempt when connectivity returns will say so.
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/** True when the access token is missing or within its slack window of expiry. */
export function accessTokenExpired(): boolean {
  return !accessToken || Date.now() >= accessExpiresAt;
}

/**
 * What to call this device in the account's session list.
 *
 * Sent on every call that creates or rotates a session, so "Motion Desktop on
 * Windows" appears instead of a raw Chrome user-agent string.
 */
export function clientNameHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const api = window.motionEditor;
  if (!api) return {};
  return { 'X-Client-Name': `Motion Desktop ${api.version ?? ''} (${api.platform ?? 'desktop'})`.trim() };
}

// localStorage is unavailable in some embeddings (a sandboxed iframe, a
// hardened profile) and throws rather than returning null. None of this is
// worth failing a sign-in over.
function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
