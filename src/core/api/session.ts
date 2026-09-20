/**
 * The signed-in session, from the renderer's side of the fence.
 *
 * On the desktop build this module holds **no credential at all**. Both tokens
 * live in the main process; sign-in, sign-out and refresh are operations the
 * renderer asks for, and what comes back is a status — signed in, who, when the
 * access token expires — never a token.
 *
 * That is a change, and the reasoning belongs here as much as in
 * `electron/apiSession.ts`. The previous design kept the refresh token in the
 * OS keystore and handed it to the renderer on request (`credentials:get`). The
 * argument was that the keystore covers the at-rest case, and that reading live
 * process memory implies control of the machine. True for a local attacker, and
 * beside the point for the threat this app is actually built around: hostile
 * code running *inside the renderer*. A compromised dependency in this bundle
 * called `credentials.get()`, got a 90-day credential, and was done. Encryption
 * at rest never touched that path.
 *
 * ── The browser build is different, and that is stated rather than hidden ────
 *
 * There is no main process in a browser, so there is nowhere else for a token
 * to live: the refresh token goes to `localStorage` and the access token to
 * memory. The browser build is therefore NOT the protected surface, and
 * `docs/PLUGINS.md` §3 says so in as many words. Everything below that is
 * `WEB ONLY` exists solely for that build; the desktop paths never touch it.
 */

import { IS_ELECTRON } from './env';
import type { AuthStatus } from '../../types/motionEditor';

/** WEB ONLY. Legacy key, read once at boot so an existing session survives. */
const LEGACY_TOKEN_KEY = 'motion-editor.auth-token';
/** WEB ONLY. Browser-build home for the refresh token. */
const WEB_REFRESH_KEY = 'motion-editor.refresh-token';
/**
 * Which tab is currently spending the refresh token. See `claimRefresh`.
 *
 * Not a real mutex — localStorage has no compare-and-swap — but the failure it
 * guards is two tabs refreshing in the same instant, and for that a claim plus
 * a short wait is enough. The worst case if it is lost is the behaviour we
 * already handle: one tab presents a rotated token and adopts the new one.
 */
const WEB_REFRESH_LOCK_KEY = 'motion-editor.refresh-lock';
/** How long a claim is honoured before it is assumed to belong to a dead tab. */
const REFRESH_LOCK_TTL_MS = 10_000;
/** How long to wait for the tab that holds the claim, before going anyway. */
const REFRESH_LOCK_POLL_MS = 150;
const REFRESH_LOCK_WAIT_TRIES = 20;

export interface SessionTokens {
  token: string;
  refreshToken: string;
  /** Seconds the access token is valid for, from the moment it was issued. */
  expiresIn: number;
  refreshExpiresAt?: string;
  user?: { id: string; email: string };
}

/**
 * WEB ONLY. Tokens, in this realm.
 *
 * Never populated under Electron — `bridge()` short-circuits every writer. A
 * guard test asserts these names appear in no other renderer file, so the one
 * place a credential can exist in this process is the one place that has to.
 */
let webAccessToken: string | null = null;
let webAccessExpiresAt = 0;
let webRefreshToken: string | null = null;

/** Desktop: the last status main reported. Claims only, no credential. */
let desktopStatus: AuthStatus | null = null;

let loaded = false;

type Listener = (signedIn: boolean) => void;
const listeners = new Set<Listener>();

/** Notified when the session ends for a reason the user did not ask for. */
export function onSessionChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const bridge = (): NonNullable<Window['motionEditor']>['auth'] | undefined =>
  typeof window === 'undefined' ? undefined : window.motionEditor?.auth;

/**
 * Load the session. Call once, before the app decides what to render.
 *
 * Returns true when there is a session worth restoring. On desktop it does not
 * verify it — that happens on the first API call, which main will refresh
 * through if needed, so verifying here would just be doing it twice.
 */
export async function loadSession(): Promise<boolean> {
  if (loaded) return isAuthenticatedInternal();
  loaded = true;

  if (IS_ELECTRON) {
    desktopStatus = (await bridge()?.status?.().catch(() => null)) ?? null;
    await migrateLegacyRendererCredentials();
    return Boolean(desktopStatus?.signedIn);
  }

  webRefreshToken = safeGet(WEB_REFRESH_KEY);

  /**
   * WEB ONLY. Migration for sessions created before refresh tokens existed.
   *
   * Those users hold a 7-day access token in localStorage and no refresh token.
   * Adopting it lets them keep working; when it expires there is nothing to
   * refresh with, so they sign in once and land on the new scheme.
   */
  const legacy = safeGet(LEGACY_TOKEN_KEY);
  if (legacy && !webAccessToken) {
    webAccessToken = legacy;
    webAccessExpiresAt = Date.now() + 60_000;
    safeRemove(LEGACY_TOKEN_KEY);
  }

  return Boolean(webRefreshToken || webAccessToken);
}

function isAuthenticatedInternal(): boolean {
  if (IS_ELECTRON) return Boolean(desktopStatus?.signedIn);
  return Boolean(webRefreshToken || webAccessToken);
}

/**
 * The bearer for the next request, or null.
 *
 * **Always null on desktop**, and that is not a degradation — it is the change.
 * Main attaches the header; nothing in this process needs, or can obtain, the
 * token. Callers that used to build an `Authorization` header from this now go
 * through `api.request`, which is the only reason they can still work.
 */
export function getAccessToken(): string | null {
  return IS_ELECTRON ? null : webAccessToken;
}

/** True when a session exists — gates cloud features. */
export function hasSession(): boolean {
  return isAuthenticatedInternal();
}

/** Claims about the session. Never a credential. Desktop only; null on web. */
export function sessionStatus(): AuthStatus | null {
  return desktopStatus;
}

/**
 * Adopt a session.
 *
 * On desktop, tokens never arrive here: sign-in happens through
 * `auth.signIn`, main keeps what it minted, and this only refreshes the cached
 * status. The parameter is accepted and ignored so the web and desktop sign-in
 * screens stay one code path.
 */
export async function setSession(tokens: SessionTokens): Promise<void> {
  loaded = true;

  if (IS_ELECTRON) {
    desktopStatus = (await bridge()?.status?.().catch(() => null)) ?? desktopStatus;
    return;
  }

  webAccessToken = tokens.token;
  // A minute of slack, so a request is never sent with a token that expires
  // while it is in flight — clock skew between client and server is real, and
  // the cost of refreshing a minute early is one extra call an hour.
  webAccessExpiresAt = Date.now() + Math.max(0, tokens.expiresIn - 60) * 1000;

  // An empty refresh token means the caller has only a bare access token (the
  // test suite). Persisting "" would leave a stored credential that fails on
  // the next launch for no reason.
  if (!tokens.refreshToken) return;
  webRefreshToken = tokens.refreshToken;
  safeSet(WEB_REFRESH_KEY, tokens.refreshToken);
}

/**
 * Sign in.
 *
 * On desktop the credentials go straight to main, which posts them, keeps the
 * tokens and returns a status. The password is never held here afterwards, and
 * the session it establishes is one this process cannot read.
 */
export async function signIn(
  path: string,
  body: unknown,
): Promise<{ ok: true } | { ok: false; status: number; body?: unknown }> {
  const result = await bridge()?.signIn?.({ path, body, clientName: clientName() });
  if (!result) return { ok: false, status: 0, body: { message: 'Sign-in is unavailable.' } };
  if (result.ok) {
    desktopStatus = result.status;
    loaded = true;
    return { ok: true };
  }
  return { ok: false, status: result.status, body: result.body };
}

/** Forget everything. Called on sign-out and whenever a refresh is refused. */
export async function clearSession(): Promise<void> {
  if (IS_ELECTRON) {
    // Main invalidates server-side and drops the stored credential. It drops it
    // even if the network call fails: a sign-out that leaves a usable refresh
    // token behind because the connection was down is not a sign-out.
    desktopStatus = (await bridge()?.signOut?.().catch(() => null)) ?? { signedIn: false, persisted: false };
  } else {
    webAccessToken = null;
    webAccessExpiresAt = 0;
    webRefreshToken = null;
    safeRemove(WEB_REFRESH_KEY);
    safeRemove(LEGACY_TOKEN_KEY);
    releaseRefresh();
  }
  for (const fn of listeners) fn(false);
}

/**
 * WEB ONLY in-flight refresh, shared by every caller.
 *
 * Without this, a dashboard firing six requests against an expired token runs
 * six refreshes. Five present a token the first has already rotated away, which
 * the server correctly reads as token reuse and answers by revoking the whole
 * session. On desktop this property is now structural rather than a discipline
 * kept here: main is the only thing that can refresh at all.
 *
 * This guard is per-TAB, because a module scope is. Two tabs of the same
 * account are the case it does not cover, and the one production actually hit
 * (`refresh token reuse detected ... session revoked`, same user, same family,
 * twice): both tabs read the stored token at launch, tab A refreshes and
 * rotates it, tab B still holds the old string in `webRefreshToken` and
 * presents it on its next expiry. The server is right to call that reuse — it
 * cannot tell a second tab from a stolen token — and it revokes the family,
 * signing the user out of BOTH tabs mid-edit.
 *
 * So the stored value, not the in-memory one, is the source of truth at the
 * moment of presenting, and a refusal is re-checked against storage before it
 * is allowed to end the session. See `readStoredRefreshToken`.
 */
let refreshInFlight: Promise<boolean> | null = null;

/** This tab's identity for the duration of the page. */
const TAB_ID = Math.random().toString(36).slice(2);

/**
 * Take the cross-tab refresh claim, or report who holds it.
 *
 * Re-read after writing: two tabs that write in the same instant both see the
 * last write, so exactly one of them sees its own id and proceeds. That is the
 * whole guarantee, and it is the one that matters — the loser waits instead of
 * presenting the same token a moment later and getting the family revoked.
 */
function claimRefresh(): boolean {
  const held = safeGet(WEB_REFRESH_LOCK_KEY);
  if (held) {
    const [, at] = held.split(':');
    const age = Date.now() - Number(at);
    // A claim from a tab that was closed mid-refresh must not deadlock the
    // account, so it expires. Longer than any refresh round trip, shorter than
    // a user will wait staring at a stalled app.
    if (Number.isFinite(age) && age >= 0 && age < REFRESH_LOCK_TTL_MS) return false;
  }
  safeSet(WEB_REFRESH_LOCK_KEY, `${TAB_ID}:${Date.now()}`);
  return safeGet(WEB_REFRESH_LOCK_KEY)?.startsWith(`${TAB_ID}:`) ?? true;
}

function releaseRefresh(): void {
  if (safeGet(WEB_REFRESH_LOCK_KEY)?.startsWith(`${TAB_ID}:`)) safeRemove(WEB_REFRESH_LOCK_KEY);
}

/**
 * The refresh token as it is RIGHT NOW, not as this tab last saw it.
 *
 * `webRefreshToken` is seeded once in `loadSession` and updated only by this
 * tab's own `setSession`, so it goes stale the moment another tab rotates.
 */
function readStoredRefreshToken(): string | null {
  return safeGet(WEB_REFRESH_KEY) ?? webRefreshToken;
}

export function refreshSession(): Promise<boolean> {
  // Desktop: `api.request` refreshes inside main, before and after the call it
  // is making. There is nothing for this side to do, and pretending otherwise
  // would mean a second refresh racing the real one.
  if (IS_ELECTRON) return Promise.resolve(Boolean(desktopStatus?.signedIn));

  if (refreshInFlight) return refreshInFlight;

  if (!readStoredRefreshToken()) return Promise.resolve(false);

  refreshInFlight = (async () => {
    // Another tab is already spending the token. Wait for it rather than
    // presenting the same string — a second presentation is indistinguishable
    // from a stolen token and costs the whole session.
    let claimed = claimRefresh();
    for (let i = 0; !claimed && i < REFRESH_LOCK_WAIT_TRIES; i++) {
      await new Promise((r) => setTimeout(r, REFRESH_LOCK_POLL_MS));
      claimed = claimRefresh();
    }

    // Re-read AFTER the wait: if the other tab succeeded, storage now holds a
    // fresh token and this is the whole refresh — nothing to present.
    const presented = readStoredRefreshToken();
    if (!presented) {
      if (claimed) releaseRefresh();
      return false;
    }
    // Adopt what storage says, so a token another tab rotated is not left
    // behind in memory to be presented again later.
    webRefreshToken = presented;

    try {
      // A bare fetch, not `request`: that helper retries through *this*
      // function on a 401, and a refresh that refreshes is an infinite loop.
      const { API_URL } = await import('./env');
      const res = await fetch(`${API_URL || '/api'}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...clientNameHeader() },
        body: JSON.stringify({ refreshToken: presented }),
      });

      if (!res.ok) {
        // 401/403 means the token is spent, revoked or expired — all terminal.
        // A 5xx or a network failure is not: the session may well be fine, and
        // dropping it would sign a user out because the server hiccuped.
        if (res.status === 401 || res.status === 403) {
          // Unless another tab rotated it while this call was in flight, which
          // is the ONE benign reason a well-formed refresh is refused. Storage
          // now holds a token this tab has never presented; the session is
          // alive and clearing it here would sign the user out of a working
          // account. Adopt it and let the caller retry.
          const current = safeGet(WEB_REFRESH_KEY);
          if (current && current !== presented) {
            webRefreshToken = current;
            return false;
          }
          await clearSession();
        }
        return false;
      }

      await setSession((await res.json()) as SessionTokens);
      return true;
    } catch {
      // Offline. Keep the refresh token — the session is probably still valid.
      return false;
    } finally {
      if (claimed) releaseRefresh();
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/** True when the access token is missing or within its slack window of expiry. */
export function accessTokenExpired(): boolean {
  // Desktop: main owns expiry and refreshes around its own calls. Answering
  // "expired" from a cached status would make this side refresh-happy for no
  // benefit; answering "not expired" is the honest "not my problem".
  if (IS_ELECTRON) return false;
  return !webAccessToken || Date.now() >= webAccessExpiresAt;
}

function clientName(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const api = window.motionEditor;
  if (!api) return undefined;
  return `Motion Desktop ${api.version ?? ''} (${api.platform ?? 'desktop'})`.trim();
}

/**
 * What to call this device in the account's session list.
 *
 * Sent on every call that creates or rotates a session, so "Motion Desktop on
 * Windows" appears instead of a raw Chrome user-agent string.
 */
export function clientNameHeader(): Record<string, string> {
  const name = clientName();
  return name ? { 'X-Client-Name': name } : {};
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

/**
 * Move any credential this build left in `localStorage` into the main process,
 * then delete it.
 *
 * Runs once at boot on desktop, and both halves matter. A migration that copies
 * without deleting has done nothing: the old refresh token stays readable from
 * DevTools and from anything in this bundle, and the whole change is cosmetic
 * until it is gone. So the write is confirmed before the delete, and the delete
 * is verified after.
 *
 * The second launch is a no-op, because there is nothing left to find.
 */
export async function migrateLegacyRendererCredentials(): Promise<void> {
  if (!IS_ELECTRON) return;

  const stranded = safeGet(WEB_REFRESH_KEY);
  if (stranded) {
    // Hand it in first. If this fails, the entry stays where it is: signing the
    // user out to tidy up a storage key is a worse outcome than the key.
    const adopted = await bridge()?.adoptLegacy?.(stranded).catch(() => null);
    if (adopted) desktopStatus = adopted;
    if (!adopted) return;
  }

  safeRemove(WEB_REFRESH_KEY);
  safeRemove(LEGACY_TOKEN_KEY);

  // Confirm, rather than assume. `safeRemove` swallows a throwing
  // `localStorage` — which is right for a boot path and wrong to be silent
  // about when what it swallowed was the deletion of a credential.
  if (safeGet(WEB_REFRESH_KEY) || safeGet(LEGACY_TOKEN_KEY)) {
    console.error(
      '[session] a credential could not be removed from localStorage; it is still readable here.',
    );
  }
}
