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
 * Capabilities that need a backend, and are therefore off in the local edition.
 *
 * `aiEnabled` used to be in this list and deliberately is not any more. The
 * assistant needs a KEY, not a backend, and the local edition now holds one in the
 * OS keystore and calls the provider from the Electron main process. What still
 * differs is *where* the key lives, which is `aiRunsThroughBackend` — asserted
 * separately below.
 */
const CLOUD_CAPABILITIES = {
  cloudAccountsEnabled,
  cloudProjectsEnabled,
  billingEnabled,
  cloudSyncEnabled,
  pluginRegistryEnabled,
  aiRunsThroughBackend,
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

  it('keeps the assistant on in BOTH editions', () => {
    // The free tier of this product IS the local edition, and its headline is
    // "the full editor, with your own API key". An assistant that reads "coming
    // soon" there made that headline a false statement — which is exactly what
    // this used to assert. Both editions are BYOK now.
    setEdition('server');
    expect(aiEnabled()).toBe(true);
    setEdition('local');
    expect(aiEnabled()).toBe(true);
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
