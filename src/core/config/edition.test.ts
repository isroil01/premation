/**
 * The edition contract, from both directions.
 *
 * The first half is the one that matters most: the DEFAULT is 'server' and every
 * capability is on, so a build that sets nothing behaves exactly as it did
 * before this switch existed. If someone later flips a default, this fails.
 *
 * The second half pins what the local edition turns off, and that the API
 * transport is genuinely inert there — not "the UI happens not to call it", but
 * "the one function every call goes through refuses". That is the difference
 * between an offline build and a build that merely looks offline.
 */

import {
  aiEnabled,
  aiRunsThroughBackend,
  billingEnabled,
  cloudAccountsEnabled,
  cloudProjectsEnabled,
  cloudSyncEnabled,
  getEdition,
  isLocalEdition,
  isServerEdition,
  parseEdition,
  pluginRegistryEnabled,
  setEdition,
} from './edition';

/**
 * Capabilities the local edition does not have.
 *
 * `aiEnabled` has been in and out of this list, so the current reason is worth
 * stating plainly: it is here because the local edition does not SHIP the
 * assistant, not because it cannot run one. The key path it grew — OS keystore in
 * the main process, `electron/aiProxy.ts` spending it — still exists and still
 * works; the edition simply does not offer the surface. Every other entry is here
 * for the older, structural reason: no backend to talk to.
 *
 * `aiRunsThroughBackend` stays listed separately from `aiEnabled` even though
 * both are now false in local, because they answer different questions and one is
 * about to be true again the moment someone flips the distribution decision.
 */
const CLOUD_CAPABILITIES = {
  cloudAccountsEnabled,
  cloudProjectsEnabled,
  billingEnabled,
  cloudSyncEnabled,
  pluginRegistryEnabled,
  aiRunsThroughBackend,
  aiEnabled,
};

describe('edition', () => {
  afterEach(() => setEdition('server'));

  it('defaults to the server edition', () => {
    expect(getEdition()).toBe('server');
    expect(isServerEdition()).toBe(true);
    expect(isLocalEdition()).toBe(false);
  });

  it('leaves every capability on in the server edition', () => {
    setEdition('server');
    // Mapped to names so a failure says WHICH capability regressed.
    const on = Object.fromEntries(Object.entries(CLOUD_CAPABILITIES).map(([n, can]) => [n, can()]));
    expect(on).toEqual(Object.fromEntries(Object.keys(CLOUD_CAPABILITIES).map((n) => [n, true])));
  });

  it('turns every cloud capability off in the local edition', () => {
    setEdition('local');
    expect(isLocalEdition()).toBe(true);
    const off = Object.fromEntries(Object.entries(CLOUD_CAPABILITIES).map(([n, can]) => [n, can()]));
    expect(off).toEqual(Object.fromEntries(Object.keys(CLOUD_CAPABILITIES).map((n) => [n, false])));
  });

  it('ships the assistant in the server edition only', () => {
    // This assertion has been all three values, so read the reason before
    // changing it a fourth time. It is NOT "local cannot run the assistant" —
    // local has a complete BYOK path (OS keystore + main-process proxy) and that
    // code is untouched. It is "the local edition does not ship it", a
    // distribution decision, and this predicate is the entire mechanism.
    //
    // Flipping it back on is a one-line change here. What that one line must NOT
    // become again is `() => true` with no callers: this used to be exactly that,
    // which is why turning it false hid nothing until the surfaces were gated
    // individually. `editionAiSurface.test.ts` is what holds that line.
    setEdition('server');
    expect(aiEnabled()).toBe(true);
    setEdition('local');
    expect(aiEnabled()).toBe(false);
  });

  it('routes the assistant through the backend only in the server edition', () => {
    // The real difference: who holds the key. Server → motion-back, encrypted with
    // AI_KEY_SECRET. Local → the OS keystore, via the Electron main process. The
    // renderer holds no key in either case.
    setEdition('server');
    expect(aiRunsThroughBackend()).toBe(true);
    setEdition('local');
    expect(aiRunsThroughBackend()).toBe(false);
  });

  describe('parseEdition', () => {
    it('reads local and its alias', () => {
      expect(parseEdition('local')).toBe('local');
      expect(parseEdition('oss')).toBe('local');
      expect(parseEdition(' LOCAL ')).toBe('local');
    });

    // Unset, empty, or misspelled must NOT silently produce the offline build:
    // a typo in a deploy env would otherwise ship a paying customer an app with
    // no account, no projects and no assistant.
    it('treats anything else — including unset — as server', () => {
      for (const v of [undefined, null, '', 'server', 'localish', 'true', '1']) {
        expect(parseEdition(v)).toBe('server');
      }
    });
  });
});

describe('api transport in the local edition', () => {
  afterEach(() => setEdition('server'));

  it('refuses to send, without touching fetch', async () => {
    // A tripwire, not a mock: if the transport reaches the network at all, this
    // records it and the assertion below fails with the offending path.
    const calls: string[] = [];
    const original = globalThis.fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = (...args: unknown[]) => {
      calls.push(String(args[0]));
      return Promise.reject(new Error('should not be reached'));
    };

    try {
      setEdition('local');
      const { request, conditionalGet } = await import('@core/api/transport');

      await expect(request('/auth/me')).rejects.toThrow(/local edition/i);
      await expect(conditionalGet('/projects')).rejects.toThrow(/local edition/i);
      expect(calls).toEqual([]);
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = original;
    }
  });
});
