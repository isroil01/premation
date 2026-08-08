/**
 * The one plugin verb that sends data off the machine.
 *
 * Every assertion here is a way the allowlist could be true at the front door
 * and false by the time bytes leave. Those are the interesting failures,
 * because each one passes the check the reviewer looks at:
 *
 *   • A redirect to a host nobody declared.
 *   • A declared, public-looking host resolving to the user's router.
 *   • A response that ignores its own `content-length`.
 *   • Cookies riding along, turning "reach this host" into "act as the user".
 */

import {
  pluginNetFetch,
  setHostResolver,
  netGuardStatus,
  resetNetBudgetForTests,
  NetRefused,
  NET_MAX_BYTES,
  NET_REQUESTS_PER_MINUTE,
  NET_MAX_REDIRECTS,
} from './pluginNetFetch';
import { ReadableStream } from 'node:stream/web';
import type { NetContribution } from './netSchema';

const NET: NetContribution = { hosts: ['api.acme.test', 'cdn.acme.test'] };
const PLUGIN = 'studio.acme.thing';

/**
 * A response with a REAL streaming body.
 *
 * Shaped by hand rather than with `new Response`, which jsdom does not provide.
 * The stream itself is genuine (`node:stream/web`), which is the part that
 * matters: the size cap counts bytes as they arrive, and a stubbed body would
 * agree with whatever the test assumed rather than exercising the counting.
 *
 * Only the three members `readBounded` actually touches are present, so this
 * cannot pass by leaning on something the real path never uses.
 *
 * The body is a getter for a reason — see below.
 */
function reply(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  const bytes = new TextEncoder().encode(body);
  const headers = new Map(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status: init.status ?? 200,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    // A getter, not a field: a stream can be READ ONCE, and a script entry is
    // answered repeatedly (the budget test makes 60 requests against one). A
    // stored stream would be spent after the first read and every later request
    // would fail on a consumed body — which reads as the code under test
    // breaking rather than the fixture running out.
    get body() {
      return new ReadableStream({
        start(c) { c.enqueue(bytes); c.close(); },
      });
    },
  } as unknown as Response;
}

/** Records what was asked for, and answers from a script. */
function fakeFetch(script: Array<Response | ((url: string) => Response)>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = script[Math.min(i++, script.length - 1)]!;
    return Promise.resolve(typeof next === 'function' ? next(url) : next);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const go = (url: string, impl: typeof fetch, net: NetContribution | null = NET) =>
  pluginNetFetch(PLUGIN, net, url, {}, impl);

beforeEach(() => resetNetBudgetForTests());

describe('the declared host list', () => {
  it('allows a declared host over https', async () => {
    const { impl } = fakeFetch([reply('ok')]);
    await expect(go('https://api.acme.test/v1', impl)).resolves.toMatchObject({ body: 'ok' });
  });

  it('★ refuses a host the plugin never declared', async () => {
    const { impl, calls } = fakeFetch([reply('ok')]);

    await expect(go('https://evil.test/steal', impl)).rejects.toBeInstanceOf(NetRefused);
    // Nothing left the machine. The refusal happens BEFORE the request.
    expect(calls).toEqual([]);
  });

  it('★ does not widen a declared host to its subdomains', async () => {
    // `api.acme.test` must not permit `evil.api.acme.test`. Anyone who can
    // create a subdomain of a declared host would otherwise inherit its grant.
    const { impl } = fakeFetch([reply('ok')]);
    await expect(go('https://evil.api.acme.test/', impl)).rejects.toThrow(/did not declare/);
  });

  it('refuses plain http', async () => {
    // Readable and modifiable by anything on the path, carrying whatever the
    // plugin was given access to.
    const { impl } = fakeFetch([reply('ok')]);
    await expect(go('http://api.acme.test/', impl)).rejects.toBeInstanceOf(NetRefused);
  });

  it('refuses everything when the plugin declared no hosts', async () => {
    const { impl } = fakeFetch([reply('ok')]);
    await expect(go('https://api.acme.test/', impl, null)).rejects.toBeInstanceOf(NetRefused);
  });

  it('★ names only the host in the refusal, not the whole URL', async () => {
    // The URL is attacker-chosen and the message may end up in a log or a
    // screenshot. The host is the part a user can act on.
    const { impl } = fakeFetch([reply('ok')]);
    // Typed as the rejection, not the union with a successful response — this
    // call must not resolve, and asserting that first means a regression that
    // let it through fails HERE rather than on a confusing `.message` read.
    const err = await go('https://evil.test/?secret=abc', impl).then(
      () => { throw new Error('the request was allowed'); },
      (e: Error) => e,
    );
    expect(err.message).not.toContain('secret=abc');
    expect(err.message).toContain('evil.test');
  });
});

describe('★ redirects', () => {
  it('re-checks every hop, and refuses one that leaves the list', async () => {
    /*
      The hole a front-door-only check leaves wide open. A declared host that
      answers `302 https://evil.test/` would reach an undeclared destination
      while passing every check a reviewer reads.
    */
    const { impl, calls } = fakeFetch([
      reply('', { status: 302, headers: { location: 'https://evil.test/collect' } }),
      reply('stolen'),
    ]);

    await expect(go('https://api.acme.test/start', impl)).rejects.toThrow(/did not declare/);
    // The redirect was READ but never followed.
    expect(calls).toHaveLength(1);
  });

  it('follows a redirect to another DECLARED host', async () => {
    const { impl, calls } = fakeFetch([
      reply('', { status: 302, headers: { location: 'https://cdn.acme.test/file' } }),
      reply('contents'),
    ]);

    await expect(go('https://api.acme.test/start', impl)).resolves.toMatchObject({ body: 'contents' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.acme.test/start',
      'https://cdn.acme.test/file',
    ]);
  });

  it('resolves a relative Location against the current URL', async () => {
    // A relative `Location` is legal and common. Treating it as absolute would
    // throw on a valid response.
    const { impl, calls } = fakeFetch([
      reply('', { status: 302, headers: { location: '/v2/thing' } }),
      reply('ok'),
    ]);

    await go('https://api.acme.test/v1/thing', impl);
    expect(calls[1]!.url).toBe('https://api.acme.test/v2/thing');
  });

  it('gives up rather than looping forever', async () => {
    const { impl } = fakeFetch([
      (url) => reply('', { status: 302, headers: { location: `${url}/deeper` } }),
    ]);

    await expect(go('https://api.acme.test/a', impl)).rejects.toThrow(/redirected too many times/);
  });

  it('bounds the hops at the declared limit', async () => {
    const { impl, calls } = fakeFetch([
      (url) => reply('', { status: 302, headers: { location: `${url}/x` } }),
    ]);

    await go('https://api.acme.test/a', impl).catch(() => undefined);
    expect(calls.length).toBe(NET_MAX_REDIRECTS + 1);
  });

  it('refuses a redirect with no destination', async () => {
    const { impl } = fakeFetch([reply('', { status: 302 })]);
    await expect(go('https://api.acme.test/', impl)).rejects.toThrow(/no destination/);
  });
});

describe('★ private addresses and DNS rebinding', () => {
  afterEach(() => setHostResolver(null));

  it('refuses a declared host that resolves onto the local network', async () => {
    /*
      The rebinding case. `api.acme.test` is public-looking, declared, approved
      — and points at the user's router. The host list cannot catch this; only
      resolving before connecting can.
    */
    setHostResolver(async () => ['192.168.1.1']);
    const { impl, calls } = fakeFetch([reply('ok')]);

    await expect(go('https://api.acme.test/', impl)).rejects.toThrow(/local network/);
    expect(calls).toEqual([]);
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['RFC1918 10/8', '10.0.0.5'],
    ['RFC1918 172.16/12', '172.20.1.1'],
    ['cloud metadata', '169.254.169.254'],
    ['carrier-grade NAT', '100.72.0.1'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unique-local', 'fd00::1'],
    ['IPv4-mapped private', '::ffff:192.168.0.1'],
  ])('refuses %s', async (_label, address) => {
    setHostResolver(async () => [address]);
    const { impl } = fakeFetch([reply('ok')]);
    await expect(go('https://api.acme.test/', impl)).rejects.toThrow(/local network/);
  });

  it('allows an ordinary public address', async () => {
    // The control. A guard that refused everything would pass every assertion
    // above and break the feature.
    setHostResolver(async () => ['93.184.216.34']);
    const { impl } = fakeFetch([reply('ok')]);
    await expect(go('https://api.acme.test/', impl)).resolves.toMatchObject({ status: 200 });
  });

  it('refuses when ANY resolved address is private', async () => {
    // A name answering with both a public and a private address is the
    // rebinding attack in one response.
    setHostResolver(async () => ['93.184.216.34', '10.1.2.3']);
    const { impl } = fakeFetch([reply('ok')]);
    await expect(go('https://api.acme.test/', impl)).rejects.toThrow(/local network/);
  });

  it('★ reports honestly when the check cannot run', () => {
    /*
      A renderer cannot resolve DNS, so this guard is only active where
      something injects a resolver — the desktop main process. Left as a
      reported hole rather than a silent skip: a protection everyone assumes is
      on, and is not, is worse than one known to be missing.
    */
    expect(netGuardStatus().rebindingCheck).toBe(false);
    setHostResolver(async () => ['1.2.3.4']);
    expect(netGuardStatus().rebindingCheck).toBe(true);
  });

  it('does not turn an unresolvable name into a security refusal', async () => {
    // A name that does not resolve is not a decision — let the request fail on
    // its own terms rather than reporting it as a block.
    setHostResolver(async () => { throw new Error('ENOTFOUND'); });
    const { impl } = fakeFetch([reply('ok')]);
    await expect(go('https://api.acme.test/', impl)).resolves.toMatchObject({ status: 200 });
  });
});

describe('★ what the request carries', () => {
  it('sends no cookies', async () => {
    /*
      Otherwise "reach this host" quietly means "act as the user at this host".
      A plugin granted access to an API the user is signed into would inherit
      that session.
    */
    const { impl, calls } = fakeFetch([reply('ok')]);
    await go('https://api.acme.test/', impl);

    expect(calls[0]!.init.credentials).toBe('omit');
  });

  it('never lets the browser follow redirects for us', async () => {
    // `redirect: 'follow'` would land on an undeclared host before this code
    // ever saw the hop.
    const { impl, calls } = fakeFetch([reply('ok')]);
    await go('https://api.acme.test/', impl);

    expect(calls[0]!.init.redirect).toBe('manual');
  });
});

describe('★ the response', () => {
  it('refuses a body larger than the cap, even without a content-length', async () => {
    /*
      A `content-length` is a claim by the server. The cap has to hold against
      one that lies, so the body is counted as it streams rather than trusted.
    */
    const huge = 'x'.repeat(NET_MAX_BYTES + 1024);
    const { impl } = fakeFetch([reply(huge)]);

    await expect(go('https://api.acme.test/', impl)).rejects.toThrow(/larger than/);
  });

  it('accepts a body at the limit', async () => {
    const { impl } = fakeFetch([reply('y'.repeat(1024))]);
    await expect(go('https://api.acme.test/', impl)).resolves.toMatchObject({ status: 200 });
  });

  it('★ withholds response headers the plugin has no use for', async () => {
    /*
      `set-cookie` is the obvious one, and the reasoning is broader: response
      headers carry infrastructure detail a plugin has every reason not to be
      able to report back.
    */
    const { impl } = fakeFetch([
      reply('ok', {
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=secret',
          'x-served-by': 'edge-42',
        },
      }),
    ]);

    const res = await go('https://api.acme.test/', impl);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['x-served-by']).toBeUndefined();
  });

  it('passes the status through, including failures', async () => {
    // A 404 is an answer, not an error — a plugin needs to see it to behave.
    const { impl } = fakeFetch([reply('nope', { status: 404 })]);
    await expect(go('https://api.acme.test/', impl)).resolves.toMatchObject({ status: 404 });
  });
});

describe('the request budget', () => {
  it('stops a plugin hammering a host', async () => {
    const { impl } = fakeFetch([reply('ok')]);
    for (let i = 0; i < NET_REQUESTS_PER_MINUTE; i++) {
      await go('https://api.acme.test/', impl);
    }

    await expect(go('https://api.acme.test/', impl)).rejects.toThrow(/more than/);
  });

  it('is per plugin, not global', async () => {
    // One noisy plugin must not silence another.
    const { impl } = fakeFetch([reply('ok')]);
    for (let i = 0; i < NET_REQUESTS_PER_MINUTE; i++) {
      await pluginNetFetch(PLUGIN, NET, 'https://api.acme.test/', {}, impl);
    }

    await expect(pluginNetFetch('studio.other.thing', NET, 'https://api.acme.test/', {}, impl))
      .resolves.toMatchObject({ status: 200 });
  });

  it('counts a refused destination too', async () => {
    /*
      Otherwise probing for a reachable host is free: a plugin could try
      thousands of URLs a second looking for one the guard lets through, and
      the budget would never notice.
    */
    const { impl } = fakeFetch([reply('ok')]);
    for (let i = 0; i < NET_REQUESTS_PER_MINUTE; i++) {
      await go('https://evil.test/', impl).catch(() => undefined);
    }

    await expect(go('https://api.acme.test/', impl)).rejects.toThrow(/more than/);
  });
});
