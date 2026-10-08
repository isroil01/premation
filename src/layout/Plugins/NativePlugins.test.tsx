import { act, fireEvent, render, screen } from '@testing-library/react';
import { engine } from '@core/engine/engineInstance';
import { REGISTRY_NOTICE_KEY, resetRegistryNoticeCacheForTest } from '@core/nativePlugins/nativePlugins';
import { NativePluginsList } from './NativePluginsList';
import { NativePluginsPanel } from './NativePluginsPanel';
import { RegistryPluginsNotice } from './RegistryPluginsNotice';

jest.mock('@core/engine/engineInstance', () => ({ engine: jest.fn() }));

const base = { vendor: 'Acme', sdk: '1.0', error: '', effects: [], gpu: false };

function engineAnswers(plugins: unknown[]): void {
  jest.mocked(engine).mockReturnValue({
    query: jest.fn(async () => ({ ok: true, value: { type: 'listPlugins', plugins }, revision: 1 })),
  } as never);
}

describe('the native plugins list', () => {
  afterEach(() => { delete (window as { motionEditor?: unknown }).motionEditor; });

  it('shows each plugin with its version and status, and a failed one with its reason', async () => {
    engineAnswers([
      { ...base, id: 'com.acme.glow', name: 'Acme Glow', version: '1.2.0', status: 'loaded' },
      { ...base, id: 'com.acme.warp', name: 'Acme Warp', version: '0.3.1', status: 'failed', error: 'built against SDK 2.0; this engine speaks 1.x' },
    ]);
    render(<NativePluginsList />);
    expect(await screen.findByText('Acme Glow')).toBeInTheDocument();
    expect(screen.getByText('v1.2.0 · Acme')).toBeInTheDocument();
    expect(screen.getByText('Loaded')).toBeInTheDocument();
    expect(screen.getByText('Acme Warp')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/built against SDK 2\.0/)).toBeInTheDocument();
  });

  it('has an empty state that says how to install', async () => {
    engineAnswers([]);
    render(<NativePluginsList />);
    expect(await screen.findByText('No native plugins installed')).toBeInTheDocument();
    expect(screen.getByText(/Install one from the plugin store/)).toBeInTheDocument();
  });

  it('shows the engine error instead of a list', async () => {
    jest.mocked(engine).mockReturnValue({
      query: jest.fn(async () => ({ ok: false, error: { code: 'unavailable', message: 'The engine is not running.' }, revision: 0 })),
    } as never);
    render(<NativePluginsList />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The engine is not running.');
  });

  it('refreshes on demand', async () => {
    engineAnswers([]);
    render(<NativePluginsList />);
    await screen.findByText('No native plugins installed');
    engineAnswers([{ ...base, id: 'com.acme.glow', name: 'Acme Glow', version: '1.2.0', status: 'loaded' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Acme Glow')).toBeInTheDocument();
  });

  it('offers Open plugins folder only where the desktop bridge exists, and calls it', async () => {
    engineAnswers([]);
    const { unmount } = render(<NativePluginsPanel />);
    await screen.findByText('No native plugins installed');
    expect(screen.queryByRole('button', { name: 'Open plugins folder' })).toBeNull();
    unmount();

    const openNativeFolder = jest.fn(async () => ({ ok: true, path: '/userData/native-plugins' }));
    (window as { motionEditor?: unknown }).motionEditor = { plugins: { openNativeFolder } };
    render(<NativePluginsPanel />);
    await screen.findByText('No native plugins installed');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open plugins folder' })); });
    expect(openNativeFolder).toHaveBeenCalledTimes(1);
  });
});

describe('the registry plugins notice', () => {
  beforeEach(() => {
    localStorage.clear();
    resetRegistryNoticeCacheForTest();
  });

  it('explains, links to the Plugins page, and stays closed once dismissed', () => {
    const onLearnMore = jest.fn();
    const { unmount } = render(<RegistryPluginsNotice onLearnMore={onLearnMore} />);
    expect(screen.getByText(/The plugin store is back/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Learn more' }));
    expect(onLearnMore).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss plugins notice' }));
    expect(screen.queryByText(/The plugin store is back/)).toBeNull();
    expect(localStorage.getItem(REGISTRY_NOTICE_KEY)).toBe('1');
    unmount();

    // Next session: still dismissed.
    resetRegistryNoticeCacheForTest();
    render(<RegistryPluginsNotice onLearnMore={onLearnMore} />);
    expect(screen.queryByText(/The plugin store is back/)).toBeNull();
  });
});

describe('installed plugins with the store', () => {
  afterEach(() => { delete (window as { motionEditor?: unknown }).motionEditor; });

  it('enables, updates and uninstalls a store-installed plugin through main and the engine', async () => {
    const execute = jest.fn(async () => ({ ok: true, value: { plugins: [] }, revision: 1 }));
    jest.mocked(engine).mockReturnValue({
      query: jest.fn(async () => ({ ok: true, value: { type: 'listPlugins', plugins: [{ ...base, id: 'com.acme.glow', name: 'Acme Glow', version: '1.2.0', status: 'loaded' }] }, revision: 1 })),
      execute,
    } as never);
    const state = { plugins: { 'com.acme.glow': { version: '1.2.0', publisherKey: 'k', enabled: true, installedAt: 1 } }, uninstall: [] as string[] };
    const bridge = {
      openNativeFolder: jest.fn(),
      installed: jest.fn(async () => state),
      install: jest.fn(async () => ({ ok: true, id: 'com.acme.glow', version: '1.3.0', restartNeeded: true })),
      uninstall: jest.fn(async () => { state.uninstall = ['com.acme.glow']; return state; }),
      setEnabled: jest.fn(async () => state),
      host: { platform: 'linux', arch: 'x64' },
    };
    (window as { motionEditor?: unknown }).motionEditor = { plugins: bridge };
    const { api } = await import('@core/api/client');
    jest.spyOn(api, 'checkPluginUpdates').mockResolvedValue([{ id: 'com.acme.glow', latestVersion: '1.3.0', publisherKey: 'k', sha256: 'x', blocked: false, kind: 'native' }]);

    render(<NativePluginsPanel />);
    const update = await screen.findByRole('button', { name: 'Update to 1.3.0' });
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Enable Acme Glow' })); });
    expect(execute).toHaveBeenCalledWith({ type: 'setPluginEnabled', plugin: 'com.acme.glow', enabled: false });
    expect(bridge.setEnabled).toHaveBeenCalledWith({ id: 'com.acme.glow', enabled: false });

    await act(async () => { fireEvent.click(update); });
    expect(bridge.install).toHaveBeenCalledWith({ id: 'com.acme.glow', version: '1.3.0' });
    expect(await screen.findByText(/Restart Premation to use this version/)).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Uninstall Acme Glow' })); });
    expect(bridge.uninstall).toHaveBeenCalledWith('com.acme.glow');
    expect(await screen.findByText('Removed on restart')).toBeInTheDocument();
  });
});

describe('a Premation Cloud plugin without the plan', () => {
  afterEach(() => { delete (window as { motionEditor?: unknown }).motionEditor; });

  it('is listed as requiring Premation Cloud, cannot be switched on, and "Check plan" refreshes the entitlement', async () => {
    jest.mocked(engine).mockReturnValue({
      query: jest.fn(async () => ({ ok: true, value: { type: 'listPlugins', plugins: [{ ...base, id: 'premation.saber', name: 'Saber', version: '1.0.0', status: 'locked', error: 'Requires Premation Cloud (no Premation Cloud sign-in on this computer)' }] }, revision: 1 })),
      execute: jest.fn(),
    } as never);
    const state = { plugins: { 'premation.saber': { version: '1.0.0', publisherKey: 'k', enabled: true, installedAt: 1 } }, uninstall: [] as string[] };
    const bridge = {
      openNativeFolder: jest.fn(),
      installed: jest.fn(async () => state),
      refreshEntitlement: jest.fn(async () => ({ plan: 'pro', validUntil: Date.parse('2026-11-15T00:00:00Z') })),
      host: { platform: 'linux', arch: 'x64' },
    };
    (window as { motionEditor?: unknown }).motionEditor = { plugins: bridge };
    const { api } = await import('@core/api/client');
    jest.spyOn(api, 'checkPluginUpdates').mockResolvedValue([]);

    render(<NativePluginsPanel />);
    expect(await screen.findByText('Requires Premation Cloud')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Enable Saber' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check plan' })); });
    expect(bridge.refreshEntitlement).toHaveBeenCalled();
    expect(await screen.findByText(/Restart Premation to load its plugins/)).toBeInTheDocument();
  });
});

describe('the plugin store page', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    delete (window as { motionEditor?: unknown }).motionEditor;
  });

  it('asks the registry for native plugins and survives a listing missing the native fields', async () => {
    // A row published before the registry knew `kind` has no platforms,
    // effects or sdk. `runsHere` used to throw on the missing platforms and
    // blank the whole page. The registry filters on `kind` (motion-back
    // plugins.service browse), so the page no longer filters again.
    const sparse = { id: 'com.acme.sparse', name: 'Sparse Listing', description: 'd', latestVersion: '1.0.0', installs: 0, publisherKey: 'k', sha256: 's', updatedAt: '', publisher: { namespace: '', displayName: '', verified: false }, categories: [], license: null, iconUrl: null, kind: 'native' };
    const native = { ...sparse, id: 'com.acme.glow', name: 'Acme Glow', platforms: ['linux-x64'], effects: [], sdk: { major: 1, minor: 0 } };
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ items: [sparse, native], total: 2 }) });
    global.fetch = fetchMock;
    (window as { motionEditor?: unknown }).motionEditor = {
      plugins: { installed: jest.fn(async () => null), install: jest.fn(), host: { platform: 'linux', arch: 'x64' } },
    };
    const { PluginStoreBrowser } = await import('./PluginStore');
    const store = { installed: null, updates: new Map(), busy: null, message: null, refresh: jest.fn(), install: jest.fn(), uninstall: jest.fn(), setEnabled: jest.fn(), checkPlan: jest.fn(), clearMessage: jest.fn() };

    render(<PluginStoreBrowser store={store} />);
    expect(await screen.findByText('Acme Glow')).toBeInTheDocument();
    expect(screen.getByText('Sparse Listing')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]![0])).toContain('kind=native');
    expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument();
  });
});
