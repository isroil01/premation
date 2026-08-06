/**
 * The proxy, driven through the real IPC handlers.
 *
 * Two things are asserted here that an inspection cannot reach:
 *
 *   1. **A sandboxed child frame's invocation is refused before the handler
 *      body runs.** This app embeds third-party plugin panels in iframes, so
 *      the wrapper is the specific control standing between one of them and
 *      the entire IPC surface. The handler is registered exactly the way the
 *      app registers it, and then invoked as a child frame would.
 *
 *   2. **Streaming and cancellation round-trip.** A stream that arrives as one
 *      buffered blob still passes every type check, and cancellation that stops
 *      the renderer's loop without aborting the upstream request looks
 *      identical to the user while the provider keeps billing.
 *
 * What this is NOT: a full Electron integration test. What runs here is the
 * real wrapper, the real handler and the real registration path, with the frame
 * identity stubbed — which is the part the wrapper actually decides on.
 *
 * "A real sandboxed frame in a real BrowserWindow" now exists separately, in
 * `e2e/ipcFrameGuard.spec.ts` (`npm run test:e2e`). It covers the frame check;
 * this file covers what the proxy does once a call is allowed through. They are
 * kept apart deliberately — an Electron launch per proxy assertion would put
 * this suite out of reach of running on every save.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const sent: Array<{ channel: string; payload: unknown }> = [];

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp/motion-proxy-test' },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}));

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

import { registerApiProxyIpc } from './apiProxy';
import { adoptForTests, resetForTests } from './apiSession';

/** A WebContents stand-in that records what main pushed to the renderer. */
const mainFrame = { url: 'file:///C:/app/dist/index.html' };
const sender = {
  mainFrame,
  isDestroyed: () => false,
  send: (channel: string, payload: unknown) => void sent.push({ channel, payload }),
};

/** An invocation from our own top-level renderer. */
const topEvent = { senderFrame: mainFrame, sender };
/** An invocation from a plugin panel: same document, a CHILD frame. */
const panelEvent = { senderFrame: { url: mainFrame.url }, sender };

const invoke = (channel: string, event: unknown, ...args: unknown[]): unknown =>
  handlers.get(channel)!(event, ...args);

/**
 * Wait for the stream to finish, rather than for a fixed number of
 * milliseconds.
 *
 * A `setTimeout(20)` passes on an idle machine and fails under a loaded full
 * suite — which is a flaky test asserting a real property, the worst
 * combination: it gets deleted rather than fixed.
 */
async function settled(timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = sent[sent.length - 1]?.payload as { type?: string } | undefined;
    if (last && (last.type === 'done' || last.type === 'error')) return;
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 1));
  }
}

let upstream: {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  chunks?: string[];
  /** Resolves when the upstream request is aborted. */
  onAbort?: () => void;
} = { status: 200, body: '{}' };

let requestedUrls: string[] = [];

beforeEach(async () => {
  handlers.clear();
  sent.length = 0;
  disk.clear();
  requestedUrls = [];
  resetForTests();
  registerApiProxyIpc();
  await adoptForTests({ token: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600 });

  (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    requestedUrls.push(url);
    const signal = init?.signal;
    const headers = new Map(Object.entries(upstream.headers ?? {}));
    return {
      ok: upstream.status >= 200 && upstream.status < 300,
      status: upstream.status,
      headers: {
        get: (k: string) => headers.get(k) ?? null,
        forEach: (fn: (v: string, k: string) => void) => headers.forEach(fn),
      },
      text: async () => upstream.body ?? '',
      json: async () => JSON.parse(upstream.body ?? '{}'),
      body: upstream.chunks
        ? {
          async *[Symbol.asyncIterator]() {
            for (const chunk of upstream.chunks!) {
              if (signal?.aborted) {
                upstream.onAbort?.();
                throw Object.assign(new Error('aborted'), { name: 'AbortError' });
              }
              yield new TextEncoder().encode(chunk);
              // Yield to the loop so a cancel issued between chunks lands.
              await new Promise((r) => setTimeout(r, 0));
            }
          },
        }
        : null,
    } as unknown as Response;
  });
});

describe('a sandboxed child frame cannot reach the IPC surface', () => {
  it('refuses api:request from a subframe, before the handler runs', async () => {
    await expect(invoke('api:request', panelEvent, { path: '/projects' }))
      .rejects.toThrow(/not available from this frame/);
    // The decisive assertion: no request was made. A wrapper that validated
    // AFTER calling the handler would reject here and still have sent it.
    expect(requestedUrls).toEqual([]);
  });

  it.each(['api:request', 'api:stream', 'api:cancel', 'auth:status', 'auth:signIn', 'auth:signOut'])(
    'refuses %s from a subframe',
    async (channel) => {
      await expect(invoke(channel, panelEvent, {})).rejects.toThrow(/not available from this frame/);
    },
  );

  it('still serves our own top-level renderer', async () => {
    // The positive half. A wrapper that refused everything would pass every
    // assertion above and ship an app that does nothing.
    const result = await invoke('auth:status', topEvent) as { signedIn: boolean };
    expect(result.signedIn).toBe(true);
  });
});

describe('api:request', () => {
  it('attaches the bearer in main and returns no token', async () => {
    upstream = { status: 200, headers: { etag: 'W/"1"' }, body: '{"items":[]}' };
    const result = await invoke('api:request', topEvent, { path: '/projects' }) as {
      ok: boolean; status: number; headers: Record<string, string>; body: string;
    };

    const init = ((globalThis.fetch as jest.Mock).mock.calls[0]![1]) as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
    // …and nothing about the credential comes back.
    expect(JSON.stringify(result)).not.toContain('access-1');
    expect(result).toMatchObject({ ok: true, status: 200, body: '{"items":[]}' });
    expect(result.headers.etag).toBe('W/"1"');
  });

  it('refuses a path that is not part of this backend', async () => {
    const result = await invoke('api:request', topEvent, { path: 'https://evil.test/steal' }) as {
      status: number; reason: string;
    };
    expect(result.status).toBe(0);
    expect(result.reason).toBe('absolute-url');
    expect(requestedUrls).toEqual([]);
  });

  it('refuses a renderer-supplied Authorization header', async () => {
    upstream = { status: 200, body: '{}' };
    await invoke('api:request', topEvent, {
      path: '/projects',
      headers: { Authorization: 'Bearer stolen', 'X-Fine': 'yes' },
    });
    const init = ((globalThis.fetch as jest.Mock).mock.calls[0]![1]) as RequestInit;
    const headers = init.headers as Record<string, string>;
    // Ours wins, theirs is dropped — a renderer that could set this could send
    // a token of its choosing.
    expect(headers.Authorization).toBe('Bearer access-1');
    expect(headers['X-Fine']).toBe('yes');
  });

  it('refuses the routes whose response IS a credential', async () => {
    // These must go through auth:signIn, where main keeps what it minted.
    // Proxying them generically would hand the tokens straight back.
    for (const path of ['/auth/login', '/auth/register', '/auth/refresh', '/auth/oauth/exchange']) {
      const result = await invoke('api:request', topEvent, { path, method: 'POST' }) as { status: number };
      expect({ path, status: result.status }).toEqual({ path, status: 0 });
    }
    expect(requestedUrls).toEqual([]);
  });
});

describe('streaming', () => {
  it('resolves on headers, then delivers chunks in order', async () => {
    upstream = { status: 200, headers: { 'content-type': 'text/event-stream' }, chunks: ['a', 'b', 'c'] };

    const start = await invoke('api:stream', topEvent, { path: '/ai/stream', method: 'POST' }) as
      { ok: true; requestId: string; status: number };
    expect(start.ok).toBe(true);
    expect(start.status).toBe(200);

    await settled();
    const events = sent.filter((s) => s.channel === 'api:stream:event').map((s) => s.payload) as
      Array<{ type: string; text?: string }>;
    expect(events.filter((e) => e.type === 'chunk').map((e) => e.text)).toEqual(['a', 'b', 'c']);
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('reports a failed start through the invoke, not the event channel', async () => {
    // So the renderer learns about a 401 immediately rather than after waiting
    // for a stream that will never produce a chunk.
    upstream = { status: 401, body: '{"code":"auth"}' };
    const start = await invoke('api:stream', topEvent, { path: '/ai/stream', method: 'POST' }) as
      { ok: false; status: number; body?: string };
    expect(start.ok).toBe(false);
    expect(start.status).toBe(401);
    expect(start.body).toBe('{"code":"auth"}');
    expect(sent).toEqual([]);
  });

  it('aborts the UPSTREAM request on cancel', async () => {
    let aborted = false;
    upstream = {
      status: 200,
      chunks: ['a', 'b', 'c', 'd', 'e'],
      onAbort: () => { aborted = true; },
    };

    const start = await invoke('api:stream', topEvent, { path: '/ai/stream', method: 'POST' }) as
      { ok: true; requestId: string };
    await new Promise((r) => setTimeout(r, 1));
    // Awaited: the wrapper is async, so every handler resolves rather than returns.
    expect(await invoke('api:cancel', topEvent, start.requestId)).toBe(true);
    await settled();

    // The point: the provider stopped generating, not merely that our loop
    // stopped reading. The two are indistinguishable from the renderer and very
    // different on the bill.
    expect(aborted).toBe(true);
    const events = sent.map((s) => s.payload) as Array<{ type: string }>;
    // An abort is a completed stream from the renderer's point of view — it
    // asked for this — so it ends rather than errors.
    expect(events[events.length - 1]!.type).toBe('done');
  });

  it('answers cancel for an unknown id with false rather than throwing', async () => {
    expect(await invoke('api:cancel', topEvent, 'not-a-request')).toBe(false);
    expect(await invoke('api:cancel', topEvent, 42)).toBe(false);
  });
});
