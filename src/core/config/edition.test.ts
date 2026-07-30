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

const CAPABILITIES = {
  cloudAccountsEnabled,
  cloudProjectsEnabled,
  billingEnabled,
  cloudSyncEnabled,
  aiEnabled,
  pluginRegistryEnabled,
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
    const on = Object.fromEntries(Object.entries(CAPABILITIES).map(([n, can]) => [n, can()]));
    expect(on).toEqual(Object.fromEntries(Object.keys(CAPABILITIES).map((n) => [n, true])));
  });

  it('turns every cloud capability off in the local edition', () => {
    setEdition('local');
    expect(isLocalEdition()).toBe(true);
    const off = Object.fromEntries(Object.entries(CAPABILITIES).map(([n, can]) => [n, can()]));
    expect(off).toEqual(Object.fromEntries(Object.keys(CAPABILITIES).map((n) => [n, false])));
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
