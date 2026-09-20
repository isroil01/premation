/**
 * Two tabs of the same account must not cost the user the session.
 *
 * Production log, twice for one user twelve hours apart:
 *
 *   [RefreshTokenService] refresh token reuse detected for user 2a32b580…
 *   (family 3a03b716…) — session revoked
 *   POST /api/auth/refresh 8ms → failed
 *
 * The server is right: it cannot tell a second tab from a stolen token, so it
 * revokes the family. The bug is on this side. `refreshInFlight` de-duplicates
 * refreshes within one tab, but a module scope is per-tab, and
 * `webRefreshToken` was seeded once at launch and updated only by this tab's
 * own `setSession`. So tab A refreshed, rotated the token, and tab B kept the
 * dead string in memory until its own expiry — then presented it, and both
 * tabs were signed out mid-edit.
 *
 * Both halves are pinned here: the token is read from storage at the moment of
 * presenting, and a 401 that is really "another tab got there first" adopts the
 * new token instead of ending the session.
 */

const KEY = 'motion-editor.refresh-token';
const LOCK = 'motion-editor.refresh-lock';

/** A session module with no Electron bridge, so it takes the web path. */
async function loadSessionModule() {
  jest.resetModules();
  return import('./session');
}

function tokensFor(refreshToken: string) {
  return {
    token: 'access',
    refreshToken,
    expiresIn: 3600,
    refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

/**
 * A response-shaped object, not a `Response`.
 *
 * This jsdom environment has `Headers` but no `Response` constructor, and a
 * `ReferenceError` thrown inside the fetch mock arrives as a rejected fetch —
 * which `refreshSession` correctly reads as "offline" and reports as `false`.
 * That made every assertion here pass or fail for the wrong reason.
 */
function respond(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** The token a given fetch call presented. */
function presentedIn(init?: RequestInit): string {
  return JSON.parse(String(init?.body)).refreshToken as string;
}

describe('refresh token, across tabs', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    localStorage.clear();
    delete (window as { motionEditor?: unknown }).motionEditor;
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('presents the STORED token, not the one this tab loaded at launch', async () => {
    localStorage.setItem(KEY, 'tab-b-stale');
    const session = await loadSessionModule();
    await session.loadSession();

    // Tab A refreshed in the meantime and rotated the token.
    localStorage.setItem(KEY, 'rotated-by-tab-a');

    const presented: string[] = [];
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      presented.push(presentedIn(init));
      return respond(200, tokensFor('next'));
    }) as unknown as typeof fetch;

    await expect(session.refreshSession()).resolves.toBe(true);
    // The stale string is what got the family revoked in production.
    expect(presented).toEqual(['rotated-by-tab-a']);
  });

  it('a 401 caused by another tab rotating adopts the new token and keeps the session', async () => {
    localStorage.setItem(KEY, 'about-to-be-rotated');
    const session = await loadSessionModule();
    await session.loadSession();

    global.fetch = jest.fn(async () => {
      // The other tab wins the race while this request is in flight.
      localStorage.setItem(KEY, 'rotated-mid-flight');
      return respond(401);
    }) as unknown as typeof fetch;

    await expect(session.refreshSession()).resolves.toBe(false);
    // Not signed out: storage holds a token this tab has never presented.
    expect(localStorage.getItem(KEY)).toBe('rotated-mid-flight');
    expect(session.hasSession()).toBe(true);
  });

  it('a genuinely spent token still ends the session', async () => {
    localStorage.setItem(KEY, 'revoked');
    const session = await loadSessionModule();
    await session.loadSession();

    global.fetch = jest.fn(async () => respond(401)) as unknown as typeof fetch;

    await expect(session.refreshSession()).resolves.toBe(false);
    // Storage unchanged => nobody rotated it => the refusal is real.
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(session.hasSession()).toBe(false);
  });

  it('waits for the tab holding the claim instead of presenting the same token', async () => {
    localStorage.setItem(KEY, 'shared');
    // Another tab claimed the refresh a moment ago and has not finished.
    localStorage.setItem(LOCK, `other-tab:${Date.now()}`);
    const session = await loadSessionModule();
    await session.loadSession();

    global.fetch = jest.fn(async () => {
      throw new Error('must not present a token while another tab holds the claim');
    }) as unknown as typeof fetch;

    // The other tab succeeds and clears its claim.
    setTimeout(() => {
      localStorage.setItem(KEY, 'rotated-by-other-tab');
      localStorage.removeItem(LOCK);
    }, 200);

    const presented: string[] = [];
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      presented.push(presentedIn(init));
      return respond(200, tokensFor('next'));
    }) as unknown as typeof fetch;

    await session.refreshSession();
    // Never the string the other tab was already spending.
    expect(presented).not.toContain('shared');
  });

  it('a claim left by a closed tab expires rather than deadlocking the account', async () => {
    localStorage.setItem(KEY, 'stored');
    // Older than the TTL — the tab that wrote it is gone.
    localStorage.setItem(LOCK, `dead-tab:${Date.now() - 60_000}`);
    const session = await loadSessionModule();
    await session.loadSession();

    global.fetch = jest.fn(async () => respond(200, tokensFor('next'))) as unknown as typeof fetch;

    await expect(session.refreshSession()).resolves.toBe(true);
  });

  it('concurrent callers in one tab still make exactly one request', async () => {
    localStorage.setItem(KEY, 'stored');
    const session = await loadSessionModule();
    await session.loadSession();

    const fetchMock = jest.fn(async () => respond(200, tokensFor('next')));
    global.fetch = fetchMock as unknown as typeof fetch;

    await Promise.all([session.refreshSession(), session.refreshSession(), session.refreshSession()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
