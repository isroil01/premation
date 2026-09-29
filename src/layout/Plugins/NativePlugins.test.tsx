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
    expect(screen.getByText(/Copy a plugin into the plugins folder/)).toBeInTheDocument();
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
    expect(screen.getByText(/aren't supported in Premation 0\.9 yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Learn more' }));
    expect(onLearnMore).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss plugins notice' }));
    expect(screen.queryByText(/aren't supported in Premation 0\.9 yet/)).toBeNull();
    expect(localStorage.getItem(REGISTRY_NOTICE_KEY)).toBe('1');
    unmount();

    // Next session: still dismissed.
    resetRegistryNoticeCacheForTest();
    render(<RegistryPluginsNotice onLearnMore={onLearnMore} />);
    expect(screen.queryByText(/aren't supported in Premation 0\.9 yet/)).toBeNull();
  });
});
