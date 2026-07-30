/**
 * The assistant's "is a provider connected" gate.
 *
 * Every case here is a way the editor used to tell a user to set up an API key
 * they had already saved:
 *
 *   • the persisted provider choice was read through `getSettingsManager()`,
 *     which throws until the editor core boots — and this store is evaluated
 *     when `authStore` is imported, long before that. So the choice reset to
 *     `anthropic` on every launch, and a user whose key was OpenAI or Gemini
 *     never got past the banner.
 *   • nothing re-pointed the selection at a provider the account actually had.
 *   • the status was not cached, so every launch started at "no key" and stayed
 *     there if `/ai/keys` was slow, offline, or never called.
 *
 * The store is hydrated at MODULE EVALUATION time, which is the whole point of
 * the first bug — so these load it fresh per case with the persisted state
 * already seeded, rather than mutating a store that is already up.
 */

// The API modules read `import.meta.env`, which is ESM-only and unparseable in
// the CommonJS test realm. Same stub the client's own tests use.
jest.mock('@core/api/env', () => ({ API_URL: undefined, IS_ELECTRON: false, BACKEND_ORIGIN: '' }));

import type { AiKeyStatus, AiMotionStatus } from '@core/api/client';
import type { useAiProviderStore as StoreHandle } from './aiProviderStore';

/** Must match `createLocalStorageBackend`'s default key. */
const SETTINGS_BLOB = 'motion-editor.settings';

type Store = typeof StoreHandle;

interface Loaded {
  store: Store;
  setToken: (token: string | null) => void;
}

/** Load a pristine copy of the store, with whatever is in localStorage now. */
function loadStore(): Loaded {
  let loaded!: Loaded;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const client = require('@core/api/client') as { setToken: (t: string | null) => void };
    const mod = require('./aiProviderStore') as { useAiProviderStore: Store };
    /* eslint-enable @typescript-eslint/no-var-requires */
    loaded = { store: mod.useAiProviderStore, setToken: client.setToken };
  });
  return loaded;
}

function seedSettings(values: Record<string, unknown>): void {
  localStorage.setItem(SETTINGS_BLOB, JSON.stringify(values));
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(SETTINGS_BLOB) ?? '{}') as Record<string, unknown>;
}

const NO_KEY: AiKeyStatus = { present: false, hint: '' };

const MOTION_OFF: AiMotionStatus = {
  present: false,
  hint: 'coming soon',
  dialect: 'openai',
  model: null,
  free: true,
  entitled: true,
  credits: 0,
  creditsUsed: 0,
  creditsPerRun: 1,
};

/** Stand in for the gateway. `keys` overrides only the providers named. */
function mockGateway(
  keys: Partial<Record<string, AiKeyStatus>>,
  motion: AiMotionStatus = MOTION_OFF,
): jest.Mock {
  const fetchMock = jest.fn(async (url: unknown, init?: { method?: string }) => {
    const href = String(url);
    const method = init?.method ?? 'GET';
    // PUT /ai/keys/:provider and DELETE /ai/keys/:provider answer {ok}, not the
    // status map — sharing one branch is how a passing mock hides a real bug.
    if (href.includes('/ai/keys/') && method !== 'GET') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (href.includes('/ai/keys')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ anthropic: NO_KEY, openai: NO_KEY, gemini: NO_KEY, ...keys, motion }),
      };
    }
    if (href.includes('/ai/models')) {
      return { ok: true, status: 200, json: async () => ({ models: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('aiProviderStore', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    localStorage.clear();
    jest.resetModules();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('the persisted choice survives a launch', () => {
    it('restores the saved provider even though the editor core has not booted', () => {
      // No `Application.boot()` here — exactly like the real app when this
      // module is first evaluated. The old code called getSettingsManager(),
      // caught the "not registered" throw, and silently returned 'anthropic'.
      seedSettings({ aiProvider: { provider: 'gemini', models: { gemini: 'gemini-3.5-flash' } } });

      const { store } = loadStore();

      expect(store.getState().provider).toBe('gemini');
      expect(store.getState().models.gemini).toBe('gemini-3.5-flash');
    });

    it('writes the choice back where the next launch will read it', () => {
      const { store } = loadStore();
      store.getState().setProvider('openai');
      store.getState().setModel('openai', 'gpt-4o');

      expect(readSettings().aiProvider).toEqual({
        provider: 'openai',
        models: { openai: 'gpt-4o' },
      });
    });

    it('ignores a persisted provider that is not a provider', () => {
      seedSettings({ aiProvider: { provider: 'not-a-provider', models: {} } });
      expect(loadStore().store.getState().provider).toBe('anthropic');
    });
  });

  describe('a connected provider is never left unselected', () => {
    it('moves to the provider the account actually has a key for', async () => {
      // The reported bug: a Gemini key saved, the selection stuck on Anthropic,
      // so the panel said "connect an AI provider" forever.
      seedSettings({ aiProvider: { provider: 'anthropic', models: {} } });
      const { store, setToken } = loadStore();
      setToken('token');
      mockGateway({ gemini: { present: true, hint: 'AIz…9f2a' } });

      await store.getState().refreshStatus();

      expect(store.getState().provider).toBe('gemini');
      expect(store.getState().ready()).toBe(true);
    });

    it('leaves a working choice alone even when other providers are connected', async () => {
      seedSettings({ aiProvider: { provider: 'openai', models: {} } });
      const { store, setToken } = loadStore();
      setToken('token');
      mockGateway({
        openai: { present: true, hint: 'sk-…1111' },
        anthropic: { present: true, hint: 'sk-…2222' },
      });

      await store.getState().refreshStatus();

      expect(store.getState().provider).toBe('openai');
    });

    it('keeps the user’s own choice when nothing at all is connected', async () => {
      seedSettings({ aiProvider: { provider: 'gemini', models: {} } });
      const { store, setToken } = loadStore();
      setToken('token');
      mockGateway({});

      await store.getState().refreshStatus();

      // Swapping it for another equally-unusable provider would just make the
      // "not configured" message point at one the user never picked.
      expect(store.getState().provider).toBe('gemini');
      expect(store.getState().ready()).toBe(false);
      expect(store.getState().anyReady()).toBe(false);
    });

    it('never falls back to hosted AI, even if the server claims it is available', async () => {
      // This test used to assert the opposite: that the store WOULD select
      // 'motion' when it was the only runnable option. Hosted AI has been deleted
      // server-side, so selecting it now would point the composer at a provider
      // whose every request fails — and it would do that precisely when the user
      // has no working key and is least equipped to work out why.
      //
      // The gateway response is faked as still offering it, because a stale
      // deployment or a cached status blob genuinely can say that, and the store
      // must not act on it.
      const { store, setToken } = loadStore();
      setToken('token');
      mockGateway({}, { ...MOTION_OFF, present: true, hint: '400 credits left' });

      await store.getState().refreshStatus();

      expect(store.getState().provider).not.toBe('motion');
      expect(store.getState().ready()).toBe(false);
      expect(store.getState().anyReady()).toBe(false);
    });
  });

  describe('the gate is right on the first frame', () => {
    it('hydrates from the cached status, before any request', () => {
      seedSettings({
        aiProvider: { provider: 'openai', models: {} },
        aiProviderStatus: {
          userId: 'user-1',
          keys: { openai: { present: true, hint: 'sk-…1111' } },
          motion: null,
          savedAt: Date.now(),
        },
      });

      const { store } = loadStore();

      expect(store.getState().ready()).toBe(true);
      // …but it is not passed off as confirmed: the banner waits for this.
      expect(store.getState().verified).toBe(false);
    });

    it('ignores a cache old enough to be meaningless', () => {
      seedSettings({
        aiProviderStatus: {
          userId: 'user-1',
          keys: { anthropic: { present: true, hint: 'sk-…1111' } },
          motion: null,
          savedAt: Date.now() - 400 * 24 * 60 * 60 * 1000,
        },
      });

      expect(loadStore().store.getState().ready()).toBe(false);
    });

    it('persists what the gateway said, so the next launch starts correct', async () => {
      const { store, setToken } = loadStore();
      setToken('token');
      store.getState().setAccount('user-1');
      mockGateway({ anthropic: { present: true, hint: 'sk-…4f2a' } });

      await store.getState().refreshStatus();

      expect(readSettings().aiProviderStatus).toMatchObject({
        userId: 'user-1',
        keys: { anthropic: { present: true, hint: 'sk-…4f2a' } },
      });
    });

    it('caches nothing that could be a credential', async () => {
      const { store, setToken } = loadStore();
      setToken('token');
      store.getState().setAccount('user-1');
      mockGateway({ anthropic: { present: true, hint: 'sk-…4f2a' } });
      await store.getState().refreshStatus();

      // The whole persisted blob, not just the fields we expect to be there.
      const blob = JSON.stringify(readSettings().aiProviderStatus);
      expect(blob).toContain('sk-…4f2a'); // the masked hint the server computed
      expect(blob).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/); // never a real key
    });
  });

  describe('one account’s keys never show up as another’s', () => {
    it('drops a cache belonging to a different user', () => {
      seedSettings({
        aiProviderStatus: {
          userId: 'user-1',
          keys: { anthropic: { present: true, hint: 'sk-…1111' } },
          motion: null,
          savedAt: Date.now(),
        },
      });
      const { store } = loadStore();
      expect(store.getState().ready()).toBe(true);

      store.getState().setAccount('user-2');

      expect(store.getState().ready()).toBe(false);
      expect(store.getState().status).toBeNull();
      expect(readSettings().aiProviderStatus).toBeUndefined();
    });

    it('keeps the cache when the same user signs back in', () => {
      seedSettings({
        aiProviderStatus: {
          userId: 'user-1',
          keys: { anthropic: { present: true, hint: 'sk-…1111' } },
          motion: null,
          savedAt: Date.now(),
        },
      });
      const { store } = loadStore();

      store.getState().setAccount('user-1');

      expect(store.getState().ready()).toBe(true);
    });

    it('reset() erases the cache from storage, not just from memory', () => {
      seedSettings({
        aiProviderStatus: {
          userId: 'user-1',
          keys: { anthropic: { present: true, hint: 'sk-…1111' } },
          motion: null,
          savedAt: Date.now(),
        },
      });
      const { store } = loadStore();

      store.getState().reset();

      expect(store.getState().status).toBeNull();
      expect(readSettings().aiProviderStatus).toBeUndefined();
      // A persisted cache that survived sign-out is the same class of bug as a
      // persisted key: the next person on this machine inherits it.
      expect(loadStore().store.getState().ready()).toBe(false);
    });
  });

  describe('failures do not un-connect a working account', () => {
    it('keeps the cached status when the gateway is unreachable', async () => {
      seedSettings({
        aiProvider: { provider: 'anthropic', models: {} },
        aiProviderStatus: {
          userId: 'user-1',
          keys: { anthropic: { present: true, hint: 'sk-…1111' } },
          motion: null,
          savedAt: Date.now(),
        },
      });
      const { store, setToken } = loadStore();
      setToken('token');
      global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;

      await store.getState().refreshStatus();

      // Being offline is not evidence that the user's keys are gone.
      expect(store.getState().ready()).toBe(true);
    });

    it('keeps the cached status when there is no session yet', async () => {
      seedSettings({
        aiProviderStatus: {
          userId: 'user-1',
          keys: { anthropic: { present: true, hint: 'sk-…1111' } },
          motion: null,
          savedAt: Date.now(),
        },
      });
      const { store } = loadStore();
      // No setToken: this is boot, before loadSession() has read the keystore.
      // Clearing here is what made the panel flash "connect a provider".
      await store.getState().refreshStatus();

      expect(store.getState().ready()).toBe(true);
    });

    it('single-flights concurrent refreshes', async () => {
      const { store, setToken } = loadStore();
      setToken('token');
      const fetchMock = mockGateway({ anthropic: { present: true, hint: 'sk-…1111' } });

      await Promise.all([
        store.getState().refreshStatus(),
        store.getState().refreshStatus(),
        store.getState().refreshStatus(),
      ]);

      const keyCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/ai/keys'));
      expect(keyCalls).toHaveLength(1);
    });
  });

  describe('saving and removing a key', () => {
    it('connects the provider and selects it, without waiting for a round trip', async () => {
      const { store, setToken } = loadStore();
      setToken('token');
      mockGateway({});

      const res = await store.getState().saveKey('gemini', 'AIzaSyExampleKeyValue9f2a');

      expect(res.ok).toBe(true);
      expect(store.getState().provider).toBe('gemini');
      expect(store.getState().status?.gemini?.present).toBe(true);
      // The masked tail, computed the same way the backend computes it.
      expect(store.getState().status?.gemini?.hint).toBe('AIz…9f2a');
    });

    it('reports a refused save and connects nothing', async () => {
      const { store, setToken } = loadStore();
      setToken('token');
      global.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, reason: 'unavailable' }),
      })) as unknown as typeof fetch;

      const res = await store.getState().saveKey('openai', 'sk-example-key-value');

      expect(res).toEqual({ ok: false, reason: 'unavailable' });
      expect(store.getState().status?.openai?.present).toBeFalsy();
      expect(store.getState().provider).not.toBe('openai');
    });

    it('moves off a provider whose key was just removed', async () => {
      seedSettings({ aiProvider: { provider: 'openai', models: {} } });
      const { store, setToken } = loadStore();
      setToken('token');
      mockGateway({
        openai: { present: true, hint: 'sk-…1111' },
        anthropic: { present: true, hint: 'sk-…2222' },
      });
      await store.getState().refreshStatus();
      expect(store.getState().provider).toBe('openai');

      // The refresh that follows the delete must see it gone, or it would just
      // put the selection back.
      mockGateway({ anthropic: { present: true, hint: 'sk-…2222' } });
      await store.getState().clearKey('openai');

      expect(store.getState().provider).toBe('anthropic');
      expect(store.getState().ready()).toBe(true);
    });

    it('leaves the status alone when the delete never reached the server', async () => {
      const { store, setToken } = loadStore();
      setToken('token');
      mockGateway({ anthropic: { present: true, hint: 'sk-…1111' } });
      await store.getState().refreshStatus();

      global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
      const res = await store.getState().clearKey('anthropic');

      expect(res.ok).toBe(false);
      // Showing "not configured" for a key that is still stored is a lie the
      // user would act on by pasting it again.
      expect(store.getState().status?.anthropic?.present).toBe(true);
    });
  });
});
