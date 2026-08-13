/**
 * The layer that actually opens the socket.
 *
 * `pluginNetFetch.test.ts` covers the renderer's half — declared hosts, the
 * redirect loop, the budget. None of that reaches the network. This file covers
 * the half that does, and the assertions here are the ones that only make sense
 * in a process with DNS:
 *
 *   • The RESOLVED address is what gets refused, not the name. This is the
 *     whole DNS-rebinding defence, and a check on the hostname string cannot
 *     do it — `api.acme.com` resolving to `127.0.0.1` reads as a perfectly
 *     ordinary public name.
 *   • A redirect is RETURNED, never followed. Main does not know which hosts
 *     the plugin declared, so following one here would reach a destination
 *     nothing checked.
 *   • The byte cap holds against a server that lies about `content-length`.
 *
 * Both processes re-check the scheme and the address on purpose. Main is where
 * the connection happens, so it does not take a destination on trust from a
 * caller, even a caller it believes.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();

jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}));

/** What every hostname resolves to, per test. */
let dnsAnswers: Record<string, string[]> = {};

jest.mock('node:dns/promises', () => ({
  lookup: async (hostname: string) => {
    const found = dnsAnswers[hostname];
    if (!found) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  },
}));

// From Node's own built-ins: the suite runs under jsdom, which has no
// `ReadableStream`. The stream has to be REAL — the byte cap counts bytes as
// they arrive, and a stubbed body would agree with whatever the test assumed
// rather than exercising the counting.
import { ReadableStream } from 'node:stream/web';
import { pluginNetRequest, registerPluginNetIpc } from './pluginNet';

/**
 * A response with a real stream, so the cap counts real bytes.
 *
 * `body` is a getter because a stream can be read once and the fetch stub
 * answers repeatedly.
 */
function reply(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  const bytes = new TextEncoder().encode(body);
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    status: init.status ?? 200,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    get body() {
      return new ReadableStream({
        start(c) { c.enqueue(bytes); c.close(); },
      });
    },
  } as unknown as Response;
}

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];

function stubFetch(response: Response | ((url: string) => Response)): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return typeof response === 'function' ? response(url) : response;
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  dnsAnswers = { 'api.acme.test': ['93.184.216.34'] };
});

afterEach(() => { globalThis.fetch = realFetch; });

describe('★ the resolved address, not the name', () => {
  // Each of these is a name that passes every text-level check and lands
  // somewhere a plugin must never reach.
  const REBINDS: Array<[string, string]> = [
    ['loopback', '127.0.0.1'],
    ['all-zeros', '0.0.0.0'],
    ['RFC1918 /8', '10.1.2.3'],
    ['RFC1918 /12', '172.20.0.5'],
    ['RFC1918 /16', '192.168.1.1'],
    ['link-local, incl. cloud metadata', '169.254.169.254'],
    ['carrier-grade NAT', '100.100.0.1'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unique-local', 'fd00::1'],
    ['IPv4-mapped IPv6', '::ffff:192.168.1.1'],
  ];

  it.each(REBINDS)('refuses a declared host resolving to %s', async (_label, address) => {
    dnsAnswers = { 'api.acme.test': [address] };
    stubFetch(reply('ok'));

    const result = await pluginNetRequest({ url: 'https://api.acme.test/data' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('private-address');
    // Refused BEFORE connecting. A check that fires after the request has left
    // has already reached the thing it was meant to protect.
    expect(calls).toEqual([]);
  });

  it('refuses when ANY answer is private, not only when all are', async () => {
    // A name that returns a public address and a private one is the shape of a
    // rebinding attack that survives a "first answer" check.
    dnsAnswers = { 'api.acme.test': ['93.184.216.34', '127.0.0.1'] };
    stubFetch(reply('ok'));

    const result = await pluginNetRequest({ url: 'https://api.acme.test/data' });
    expect(result.reason).toBe('private-address');
  });

  it('allows an ordinary public address — the control for the above', async () => {
    stubFetch(reply('hello'));
    const result = await pluginNetRequest({ url: 'https://api.acme.test/data' });
    expect({ ok: result.ok, body: result.body }).toEqual({ ok: true, body: 'hello' });
  });

  it('refuses a name that does not resolve rather than connecting anyway', async () => {
    dnsAnswers = {};
    stubFetch(reply('ok'));
    const result = await pluginNetRequest({ url: 'https://nowhere.test/' });
    expect({ ok: result.ok, reason: result.reason }).toEqual({ ok: false, reason: 'dns' });
    expect(calls).toEqual([]);
  });
});

describe('the scheme', () => {
  it('refuses http, even though the renderer already checked', async () => {
    stubFetch(reply('ok'));
    const result = await pluginNetRequest({ url: 'http://api.acme.test/' });
    expect(result.reason).toBe('insecure-scheme');
    expect(calls).toEqual([]);
  });

  it('refuses a non-URL without throwing across IPC', async () => {
    const result = await pluginNetRequest({ url: 'not a url' });
    expect(result.ok).toBe(false);
  });
});

describe('★ redirects are returned, never followed', () => {
  it('hands a 3xx back with its Location instead of chasing it', async () => {
    // Main has no idea which hosts this plugin declared. Following the hop here
    // would reach a destination that nothing checked.
    stubFetch(reply('', { status: 302, headers: { location: 'https://evil.test/' } }));

    const result = await pluginNetRequest({ url: 'https://api.acme.test/go' });

    expect({ ok: result.ok, status: result.status }).toEqual({ ok: true, status: 302 });
    expect(result.headers?.location).toBe('https://evil.test/');
    // One request. The second would be the hop it must not take.
    expect(calls).toHaveLength(1);
  });

  it('asks the fetch layer not to follow either', async () => {
    stubFetch(reply('ok'));
    await pluginNetRequest({ url: 'https://api.acme.test/' });
    expect(calls[0]!.init.redirect).toBe('manual');
  });
});

describe('what the request carries', () => {
  it('sends no cookies', async () => {
    // "Reach this host" must not become "act as the user at this host".
    stubFetch(reply('ok'));
    await pluginNetRequest({ url: 'https://api.acme.test/' });
    expect(calls[0]!.init.credentials).toBe('omit');
  });

  it('passes the method and body through', async () => {
    stubFetch(reply('ok'));
    await pluginNetRequest({ url: 'https://api.acme.test/', method: 'POST', body: '{"a":1}' });
    expect({ method: calls[0]!.init.method, body: calls[0]!.init.body })
      .toEqual({ method: 'POST', body: '{"a":1}' });
  });
});

describe('★ the response', () => {
  it('refuses a body over the cap even when content-length lies', async () => {
    // The cap is counted as bytes arrive. A `content-length` is a claim by the
    // server, and a body that ignores it is the whole attack.
    const huge = 'x'.repeat(9 * 1024 * 1024);
    stubFetch(reply(huge, { headers: { 'content-length': '12' } }));

    const result = await pluginNetRequest({ url: 'https://api.acme.test/' });
    expect({ ok: result.ok, reason: result.reason }).toEqual({ ok: false, reason: 'too-large' });
  });

  it('returns only the headers the renderer needs', async () => {
    stubFetch(reply('ok', {
      headers: {
        'content-type': 'application/json',
        'set-cookie': 'session=secret',
        'x-served-by': 'edge-42',
      },
    }));

    const result = await pluginNetRequest({ url: 'https://api.acme.test/' });

    expect(Object.keys(result.headers ?? {})).toEqual(['content-type']);
  });

  it('passes a failing status through as a real answer', async () => {
    // A 404 is the server's answer, not a refusal by us. Reporting it as
    // `ok: false` would make a security decision indistinguishable from a
    // missing page.
    stubFetch(reply('nope', { status: 404 }));
    const result = await pluginNetRequest({ url: 'https://api.acme.test/' });
    expect({ ok: result.ok, status: result.status }).toEqual({ ok: true, status: 404 });
  });
});

describe('registration', () => {
  it('goes through the guarded wrapper, so a panel cannot invoke it', () => {
    // The wrapper is the control that refuses a subframe. A handler registered
    // any other way would be reachable from a plugin's own panel.
    registerPluginNetIpc();
    expect([...handlers.keys()].sort()).toEqual(['plugin:net-request', 'plugin:net-resolve']);
  });
});
