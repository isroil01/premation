/**
 * Desktop sign-in returns a USER, not just a status.
 *
 * The regression this pins down broke sign-in completely on the desktop build.
 * Main answers `auth.signIn` with an `AuthStatus` — signedIn, an id, an email —
 * so `authRequest` returned a hand-built shim and cast it to `AuthResult`. The
 * cast was a lie: there was no `user` on it. Every caller
 * (`authStore.login`/`register`, `OAuthCallbackPage`) reads `res.user.id` on
 * the next line, so every sign-in threw
 *
 *     TypeError: Cannot read properties of undefined (reading 'id')
 *
 * and it threw *after* main had already adopted the tokens. Hence the pair of
 * symptoms: the app refused to sign in, and then came up signed in on the next
 * launch off the session that same attempt had quietly established.
 *
 * A type cast is what let it compile, so the guard has to be a runtime one.
 */

// IS_ELECTRON is computed from `window.motionEditor` at import time, so the
// bridge has to exist before `./client` is pulled in — hence the mock rather
// than assigning to `window` in `beforeEach`.
jest.mock('./env', () => ({
  IS_ELECTRON: true,
  API_URL: 'http://localhost:4000/api',
  BACKEND_ORIGIN: 'http://localhost:4000',
}));

const ACCOUNT = {
  id: 'user_1',
  email: 'a@b.c',
  name: 'Ada',
  role: 'user',
  plan: 'free',
  access: { canWrite: true },
  emailVerified: true,
  trialEndsAt: null,
  storageBytes: 0,
  assetCount: 0,
  projectCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

// The proxy path wraps main's reply in a `Response`, which jsdom does not
// provide. Only the three members `transport.responseFrom` consumers touch.
if (typeof globalThis.Response === 'undefined') {
  class TestResponse {
    readonly status: number;
    readonly headers: Headers;
    private readonly bodyText: string;
    constructor(body: string | null, init: { status: number; headers: HeadersInit }) {
      this.bodyText = body ?? '';
      this.status = init.status;
      this.headers = new Headers(init.headers);
    }
    get ok(): boolean {
      return this.status >= 200 && this.status < 300;
    }
    async text(): Promise<string> {
      return this.bodyText;
    }
    async json(): Promise<unknown> {
      return JSON.parse(this.bodyText);
    }
  }
  (globalThis as unknown as { Response: unknown }).Response = TestResponse;
}

const signIn = jest.fn();
const request = jest.fn();

beforeEach(() => {
  jest.resetModules();
  signIn.mockReset();
  request.mockReset();

  signIn.mockResolvedValue({ ok: true, status: { signedIn: true, persisted: true } });
  request.mockImplementation(async ({ path }: { path: string }) => {
    if (path.startsWith('/auth/me')) {
      return { ok: true, status: 200, headers: {}, body: JSON.stringify(ACCOUNT) };
    }
    throw new Error(`unexpected proxied path: ${path}`);
  });

  (window as unknown as { motionEditor: unknown }).motionEditor = {
    platform: 'win32',
    version: '2.0.0',
    api: { request },
    auth: { signIn, status: async () => ({ signedIn: true, persisted: true }) },
  };
});

afterEach(() => {
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
});

describe('desktop sign-in', () => {
  test('api.login resolves with a populated user', async () => {
    const { api } = await import('./client');

    const res = await api.login('a@b.c', 'pw');

    // The actual crash: `res.user.id` on the next line in authStore.
    expect(res.user).toBeDefined();
    expect(res.user.id).toBe('user_1');
    expect(res.user.email).toBe('a@b.c');
    // Drives which page the user lands on after sign-in.
    expect(res.user.emailVerified).toBe(true);
  });

  test('api.register resolves with a populated user', async () => {
    const { api } = await import('./client');

    const res = await api.register('a@b.c', 'pw', 'Ada');

    expect(res.user?.id).toBe('user_1');
  });

  test('api.oauthExchange resolves with a populated user', async () => {
    const { api } = await import('./client');

    const res = await api.oauthExchange('one-time-code');

    expect(res.user?.id).toBe('user_1');
  });

  test('still carries no token into this realm', async () => {
    const { api } = await import('./client');

    const res = await api.login('a@b.c', 'pw');

    // The point of routing sign-in through main is that the credential stays
    // there. Filling in `user` must not have walked that back.
    expect(res.token).toBe('');
    expect(res.refreshToken).toBe('');
  });

  test('a rejected sign-in throws with the server message and never asks for /auth/me', async () => {
    signIn.mockResolvedValue({ ok: false, status: 401, body: { message: 'Invalid credentials.' } });
    const { api } = await import('./client');

    await expect(api.login('a@b.c', 'wrong')).rejects.toThrow('Invalid credentials.');
    expect(request).not.toHaveBeenCalled();
  });

  test('resetPassword mints through main rather than the generic proxy', async () => {
    const { api } = await import('./client');

    const res = await api.resetPassword('emailed-token', 'new-pw');

    // It used to go through `request`, so main never adopted the tokens and the
    // renderer was left "signed in" with no session at all.
    expect(signIn).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/auth/reset-password' }),
    );
    expect(res.user?.id).toBe('user_1');
  });
});
