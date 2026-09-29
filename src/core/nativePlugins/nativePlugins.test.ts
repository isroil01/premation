import {
  REGISTRY_NOTICE_KEY,
  dismissRegistryNotice,
  isRegistryNoticeDismissed,
  listNativePlugins,
  nativePluginStatusLabel,
  openNativePluginFolder,
  resetRegistryNoticeCacheForTest,
  subscribeRegistryNotice,
} from './nativePlugins';

const plugin = {
  id: 'com.acme.glow',
  name: 'Acme Glow',
  version: '1.2.0',
  vendor: 'Acme',
  sdk: '1.0',
  status: 'loaded' as const,
  error: '',
  effects: ['com.acme.glow.main'],
  gpu: true,
};

describe('listNativePlugins', () => {
  it("returns the engine's list verbatim", async () => {
    const client = { query: jest.fn(async () => ({ ok: true as const, value: { type: 'listPlugins', plugins: [plugin] }, revision: 1 })) };
    await expect(listNativePlugins(client as never)).resolves.toEqual({ ok: true, plugins: [plugin] });
    expect(client.query).toHaveBeenCalledWith({ type: 'listPlugins' });
  });

  it("reports the engine's error", async () => {
    const client = { query: async () => ({ ok: false as const, error: { code: 'unavailable', message: 'engine down' }, revision: 1 }) };
    await expect(listNativePlugins(client as never)).resolves.toEqual({ ok: false, error: 'engine down' });
  });

  it('never throws', async () => {
    const client = { query: async () => { throw new Error('bridge gone'); } };
    await expect(listNativePlugins(client as never)).resolves.toEqual({ ok: false, error: 'bridge gone' });
  });
});

describe('nativePluginStatusLabel', () => {
  it('names every status', () => {
    expect(['loaded', 'disabled', 'failed', 'quarantined'].map((s) => nativePluginStatusLabel(s as never)))
      .toEqual(['Loaded', 'Disabled', 'Failed', 'Quarantined']);
  });
});

describe('openNativePluginFolder', () => {
  afterEach(() => { delete (window as { motionEditor?: unknown }).motionEditor; });

  it('says so in a build without the folder bridge', async () => {
    await expect(openNativePluginFolder()).resolves.toMatch(/desktop app/);
  });

  it('opens through the bridge and reports an OS error', async () => {
    const openNativeFolder = jest.fn(async () => ({ ok: true, path: '/p' }));
    (window as { motionEditor?: unknown }).motionEditor = { plugins: { openNativeFolder } };
    await expect(openNativePluginFolder()).resolves.toBeNull();
    openNativeFolder.mockResolvedValueOnce({ ok: false, path: '/p', error: 'denied' } as never);
    await expect(openNativePluginFolder()).resolves.toBe('Could not open the plugins folder: denied.');
  });
});

describe('the registry notice dismissal', () => {
  beforeEach(() => {
    localStorage.clear();
    resetRegistryNoticeCacheForTest();
  });

  it('starts visible and is remembered once dismissed', () => {
    expect(isRegistryNoticeDismissed()).toBe(false);
    const listener = jest.fn();
    const off = subscribeRegistryNotice(listener);
    dismissRegistryNotice();
    off();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(REGISTRY_NOTICE_KEY)).toBe('1');
    // A new session reads it back from storage.
    resetRegistryNoticeCacheForTest();
    expect(isRegistryNoticeDismissed()).toBe(true);
  });

  it('survives a storage that throws', () => {
    const get = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    try {
      expect(isRegistryNoticeDismissed()).toBe(false);
      expect(() => dismissRegistryNotice()).not.toThrow();
      // Hidden for this session even though it could not be saved.
      expect(isRegistryNoticeDismissed()).toBe(true);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});
