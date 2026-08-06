/**
 * The signed-in session, held entirely in the main process.
 *
 * ── Why the renderer no longer gets the refresh token ────────────────────────
 *
 * It used to. `credentials:get` handed it over, and the argument for that was
 * reasonable as far as it went: the keystore protects the at-rest case, and
 * reading live process memory already implies control of the machine.
 *
 * That argument holds for a local attacker and fails for the threat this
 * codebase has spent most of its effort on — hostile code running *inside the
 * renderer*, which needs no machine control at all. A compromised npm
 * dependency in the renderer bundle, an XSS, a plugin escape: each of them
 * calls `credentials:get`, receives a 90-day refresh token, and mints access
 * tokens from anywhere, indefinitely. At-rest encryption never touches that.
 *
 * The tell was the asymmetry with `aiKeyVault`, which is write-only and has no
 * read-back verb precisely because the renderer needs that key *used* and never
 * needs it *seen*. The session token is the same class of secret. It now has
 * the same shape: this module holds both tokens, `apiProxy` spends them, and
 * nothing crosses back.
 *
 * ── What the renderer can still learn ────────────────────────────────────────
 *
 * `status()` — signed in or not, who, when the access token expires, and
 * whether the session will survive a restart. Everything a UI legitimately
 * needs to render a sign-in state, and no part of the credential.
 *
 * ── Refresh is single-flight, here rather than there ─────────────────────────
 *
 * The renderer used to serialise this. It had to, and for a sharp reason: the
 * server rotates refresh tokens, so two concurrent refreshes present the same
 * token twice, the second presentation reads as token REUSE, and the server
 * correctly responds by revoking the whole session. Six requests firing on a
 * dashboard mount would log the user out.
 *
 * With the token in main there is one place that can refresh at all, so the
 * property is now structural instead of a discipline the renderer had to keep.
 */

import { clearStoredCredentials, isCredentialStoreAvailable, readStoredCredentials, writeStoredCredentials } from './credentialStore';
import { apiBaseUrl } from './apiBase';

/** Short-lived bearer. Memory only, in main, never written and never sent out. */
let accessToken: string | null = null;
/** Epoch ms at which `accessToken` stops being accepted. */
let accessExpiresAt = 0;
/** The 90-day credential. Mirrored to the OS keystore by `credentialStore`. */
let refreshToken: string | null = null;

let user: { id?: string; email?: string } = {};
/** Whatever the backend last said about entitlement. Not a secret; the UI needs it. */
let plan: string | null = null;
let loaded = false;

export interface AuthStatus {
  signedIn: boolean;
  userId?: string;
  email?: string;
  /** Epoch ms. Lets the UI show "session expires in…" without holding a token. */
  accessExpiresAt?: number;
  plan?: string | null;
  /** False when the OS has no keystore: the session will not survive a restart. */
  persisted: boolean;
}

/** A minute of slack, so a request is never sent with a token that expires in flight. */
const EXPIRY_SLACK_MS = 60_000;

interface TokenPair {
  token?: string;
  refreshToken?: string;
  expiresIn?: number;
  refreshExpiresAt?: string;
  user?: { id?: string; email?: string; plan?: string };
}

/** Load the stored refresh token. Idempotent; called before anything needs it. */
export async function loadSession(): Promise<void> {
  if (loaded) return;
  loaded = true;
  const stored = await readStoredCredentials();
  refreshToken = stored?.refreshToken ?? null;
  user = { id: stored?.userId, email: stored?.email };
}

async function adopt(pair: TokenPair): Promise<void> {
  if (pair.token) {
    accessToken = pair.token;
    accessExpiresAt = Date.now() + Math.max(0, (pair.expiresIn ?? 3600) * 1000 - EXPIRY_SLACK_MS);
  }
  if (pair.user) {
    user = { id: pair.user.id ?? user.id, email: pair.user.email ?? user.email };
    if (pair.user.plan) plan = pair.user.plan;
  }
  // An empty refresh token means the response carried only a bearer. Persisting
  // "" would leave a stored credential that fails on the next launch for no
  // reason, so keep whatever real token is already there.
  if (!pair.refreshToken) return;
  refreshToken = pair.refreshToken;
  await writeStoredCredentials({
    refreshToken: pair.refreshToken,
    refreshExpiresAt: pair.refreshExpiresAt,
    email: user.email,
    userId: user.id,
  });
}

export async function clearSession(): Promise<void> {
  accessToken = null;
  accessExpiresAt = 0;
  refreshToken = null;
  user = {};
  plan = null;
  await clearStoredCredentials();
}

export function accessTokenExpired(): boolean {
  return !accessToken || Date.now() >= accessExpiresAt;
}

export function hasSession(): boolean {
  return Boolean(refreshToken || accessToken);
}

/**
 * The bearer, for `apiProxy` and nothing else.
 *
 * Not exported through any IPC channel. If this value ever needs to leave the
 * main process, the change that makes it leave is the change that undoes this
 * whole module — say so in the review.
 */
export function currentAccessToken(): string | null {
  return accessToken;
}

/** In-flight refresh, shared by every waiter. See the module comment. */
let refreshInFlight: Promise<boolean> | null = null;

/**
 * Exchange the refresh token for a new pair.
 *
 * Resolves false when there is nothing to refresh with or the server refused —
 * in which case the session has been cleared and the caller should surface a
 * sign-in prompt rather than retry. Every concurrent caller resolves on the
 * SAME promise, so a burst of 401s produces exactly one network call.
 */
export function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  if (!refreshToken) return Promise.resolve(false);

  const presented = refreshToken;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${apiBaseUrl()}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: presented }),
      });

      if (!res.ok) {
        // 401/403 means the token is spent, revoked or expired — all terminal.
        // A 5xx or a network failure is not: the session is probably fine, and
        // dropping it would sign a user out because the server hiccuped.
        if (res.status === 401 || res.status === 403) await clearSession();
        return false;
      }

      await adopt((await res.json()) as TokenPair);
      return true;
    } catch {
      // Offline. Keep the refresh token — the session is probably still valid
      // and the next attempt when connectivity returns will say so.
      return false;
    } finally {
      // Cleared in `finally` so a rejection cannot wedge every later refresh on
      // a settled promise. Every waiter has already resolved off this handle.
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * Sign in.
 *
 * The renderer posts credentials and gets back a STATUS, not a token. Which
 * means the password never becomes something the renderer holds afterwards,
 * and the session it establishes is one it cannot read.
 */
export async function signIn(
  path: string,
  body: unknown,
  clientName?: string,
): Promise<{ ok: true; status: AuthStatus } | { ok: false; status: number; body: unknown }> {
  // An allowlist, not a free path: these are the only routes that mint a
  // session, and accepting an arbitrary one would make this a general
  // credential-carrying POST bridge.
  const ALLOWED = [
    '/auth/login',
    '/auth/register',
    '/auth/oauth/exchange',
    '/auth/verify-email',
    // Spending a reset link mints a session, so it belongs here rather than on
    // the generic proxy — which handed its tokens to the renderer and left main
    // with nothing to attach to the next request.
    '/auth/reset-password',
  ];
  if (!ALLOWED.includes(path)) {
    return { ok: false, status: 400, body: { message: `"${path}" is not a sign-in route.` } };
  }

  const res = await fetch(`${apiBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(clientName ? { 'X-Client-Name': clientName } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });

  if (!res.ok) {
    const parsed = await res.json().catch(() => undefined);
    return { ok: false, status: res.status, body: parsed };
  }

  await adopt((await res.json()) as TokenPair);
  return { ok: true, status: status() };
}

/**
 * Sign out.
 *
 * Invalidated server-side FIRST, then dropped locally — and dropped locally
 * even if the server call fails. A logout that leaves a usable refresh token
 * behind because the network was down is not a logout.
 */
export async function signOut(): Promise<AuthStatus> {
  const presented = refreshToken;
  if (presented) {
    await fetch(`${apiBaseUrl()}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ refreshToken: presented }),
    }).catch(() => undefined);
  }
  await clearSession();
  return status();
}

/** What the UI is allowed to know. Never the token. */
export function status(): AuthStatus {
  return {
    signedIn: hasSession(),
    ...(user.id ? { userId: user.id } : {}),
    ...(user.email ? { email: user.email } : {}),
    ...(accessToken ? { accessExpiresAt } : {}),
    plan,
    persisted: isCredentialStoreAvailable(),
  };
}

/** Record the plan the backend reported, so `status()` can carry it. */
export function setPlan(next: string | null): void {
  plan = next;
}

/**
 * Adopt a refresh token the renderer found in its own `localStorage`.
 *
 * The migration path for a session created before this change, and the only
 * channel in this module that carries a credential — note the DIRECTION. The
 * renderer hands one in and receives a status; it can still never ask for one
 * back. That asymmetry is the whole design, and it is why this verb is safe
 * where `credentials:get` was not.
 *
 * Refused once a session already exists, so a compromised renderer cannot use
 * it to swap a signed-in user's session for an attacker's.
 */
export async function adoptLegacyRefreshToken(token: unknown): Promise<AuthStatus> {
  await loadSession();
  if (typeof token === 'string' && token.length > 0 && !hasSession()) {
    refreshToken = token;
    await writeStoredCredentials({ refreshToken: token });
    // Verify it immediately: a token that no longer works should sign the user
    // out now, at a moment they can act on, rather than at their next save.
    if (!(await refreshSession())) await clearSession();
  }
  return status();
}

/** Test seam: drop all in-memory state. Never reachable from the renderer. */
export function resetForTests(): void {
  accessToken = null;
  accessExpiresAt = 0;
  refreshToken = null;
  user = {};
  plan = null;
  loaded = false;
  refreshInFlight = null;
}

/** Test seam: adopt a pair without a network round trip. */
export async function adoptForTests(pair: TokenPair): Promise<void> {
  loaded = true;
  await adopt(pair);
}
