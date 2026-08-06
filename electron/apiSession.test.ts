/**
 * The session in main: what it refuses to hand back, and the one race that used
 * to sign people out.
 *
 * The refresh race is the interesting half. The server ROTATES refresh tokens,
 * so presenting the same one twice is not a retry — it is token reuse, which a
 * correct server answers by revoking the entire session. Six requests firing on
 * a dashboard mount against an expired access token is enough to do it. The
 * renderer used to serialise this by hand; now there is one place that can
 * refresh at all, and these assert that it behaves like one.
 */

let encryptionAvailable = true;

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp/motion-session-test' },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}));

// An in-memory disk, so nothing here touches the real filesystem.
const disk = new Map<string, Buffer>();
jest.mock('node:fs/promises', () => ({
  readFile: async (p: string) => {
    const found = disk.get(p);
    if (!found) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return found;
  },
  writeFile: async (p: string, data: Buffer) => void disk.set(p, Buffer.from(data)),
  rename: async (from: string, to: string) => {
    const v = disk.get(from);
    if (v) { disk.set(to, v); disk.delete(from); }
  },
  unlink: async (p: string) => void disk.delete(p),
  chmod: async () => undefined,
}));

import {
  adoptForTests,
  clearSession,
  currentAccessToken,
  hasSession,
  refreshSession,
  resetForTests,
  signOut,
  status,
} from './apiSession';

/** Calls made to `fetch`, so a race can be counted rather than described. */
let calls: Array<{ url: string; body: unknown }> = [];
let respond: (url: string) => { status: number; body?: unknown } = () => ({ status: 200 });

beforeEach(() => {
  jest.resetModules();
  disk.clear();
  calls = [];
  encryptionAvailable = true;
  resetForTests();
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const { status: s, body } = respond(url);
    return {
      ok: s >= 200 && s < 300,
      status: s,
      json: async () => body ?? {},
      text: async () => JSON.stringify(body ?? {}),
    } as unknown as Response;
  });
});

describe('refresh is single-flight', () => {
  it('answers a burst of callers with exactly one network call', async () => {
    await adoptForTests({ token: 'a1', refreshToken: 'r1', expiresIn: 3600 });
    // A slow server, so all six callers are genuinely in flight together. A
    // resolved-immediately stub would serialise them by accident and the test
    // would pass against the broken version.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    respond = () => ({ status: 200, body: { token: 'a2', refreshToken: 'r2', expiresIn: 3600 } });
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      await gate;
      return {
        ok: true, status: 200,
        json: async () => ({ token: 'a2', refreshToken: 'r2', expiresIn: 3600 }),
      } as unknown as Response;
    });

    const waiters = [refreshSession(), refreshSession(), refreshSession(),
      refreshSession(), refreshSession(), refreshSession()];
    release();
    const results = await Promise.all(waiters);

    expect(calls.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(1);
    // Every waiter resolves on the same answer — not merely "does not crash".
    expect(results).toEqual([true, true, true, true, true, true]);
    expect(currentAccessToken()).toBe('a2');
  });

  it('presents the stored token, and only ever the stored one', async () => {
    await adoptForTests({ token: 'a1', refreshToken: 'r1', expiresIn: 3600 });
    respond = () => ({ status: 200, body: { token: 'a2', refreshToken: 'r2', expiresIn: 3600 } });
    await Promise.all([refreshSession(), refreshSession()]);
    expect(calls[0]!.body).toEqual({ refreshToken: 'r1' });
  });

  it('fails every waiter coherently when the server refuses, without deadlocking', async () => {
    await adoptForTests({ token: 'a1', refreshToken: 'r1', expiresIn: 3600 });
    respond = () => ({ status: 401 });

    const results = await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
    expect(results).toEqual([false, false, false]);
    // 401 is terminal: the token is spent, revoked or expired. The session is
    // dropped rather than left in a state that fails every later call.
    expect(hasSession()).toBe(false);

    // And the in-flight handle was released, so a later attempt is not wedged
    // on a settled promise.
    expect(await refreshSession()).toBe(false);
  });

  it('keeps the session when the failure is the server, not the token', async () => {
    await adoptForTests({ token: 'a1', refreshToken: 'r1', expiresIn: 3600 });
    respond = () => ({ status: 503 });
    expect(await refreshSession()).toBe(false);
    // A 5xx says nothing about the credential. Dropping it here would sign a
    // user out because the backend hiccuped.
    expect(hasSession()).toBe(true);
  });
});

describe('signing out', () => {
  it('invalidates server-side and leaves nothing usable', async () => {
    await adoptForTests({ token: 'a1', refreshToken: 'r1', expiresIn: 3600 });
    respond = () => ({ status: 200 });

    const after = await signOut();

    const logout = calls.find((c) => c.url.endsWith('/auth/logout'));
    expect(logout?.body).toEqual({ refreshToken: 'r1' });
    expect(after.signedIn).toBe(false);
    expect(currentAccessToken()).toBeNull();
    expect(hasSession()).toBe(false);
    expect(disk.size).toBe(0);
  });

  it('still drops the local credential when the server call fails', async () => {
    await adoptForTests({ token: 'a1', refreshToken: 'r1', expiresIn: 3600 });
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => { throw new Error('offline'); });

    await signOut();

    // A sign-out that leaves a usable refresh token behind because the network
    // was down is not a sign-out.
    expect(hasSession()).toBe(false);
    expect(disk.size).toBe(0);
  });
});

describe('what the renderer is told', () => {
  it('reports claims and no part of a credential', async () => {
    await adoptForTests({
      token: 'a1', refreshToken: 'r1', expiresIn: 3600,
      user: { id: 'u1', email: 'a@b.test', plan: 'pro' },
    });
    const s = status();
    expect(s.signedIn).toBe(true);
    expect(s.userId).toBe('u1');
    expect(s.plan).toBe('pro');
    // The assertion that matters: nothing in this object is spendable.
    expect(JSON.stringify(s)).not.toContain('a1');
    expect(JSON.stringify(s)).not.toContain('r1');
  });

  it('says the session will not survive a restart when there is no keystore', async () => {
    encryptionAvailable = false;
    await adoptForTests({ token: 'a1', refreshToken: 'r1', expiresIn: 3600 });

    // Degraded VISIBLY, and with no plaintext fallback: nothing was written.
    // A plaintext file would look identical to the user and protect nothing.
    expect(status().persisted).toBe(false);
    expect(disk.size).toBe(0);
    // The session still works for as long as the app is open.
    expect(hasSession()).toBe(true);
  });

  it('persists when there is a keystore', async () => {
    await adoptForTests({ token: 'a1', refreshToken: 'r1', expiresIn: 3600 });
    expect(status().persisted).toBe(true);
    expect(disk.size).toBe(1);
    // Encrypted, not stored as-is.
    expect([...disk.values()][0]!.toString()).toContain('enc:');
  });

  it('forgets everything on clear', async () => {
    await adoptForTests({ token: 'a1', refreshToken: 'r1', expiresIn: 3600 });
    await clearSession();
    expect(status()).toEqual({ signedIn: false, plan: null, persisted: true });
  });
});
