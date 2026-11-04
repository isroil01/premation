/**
 * The store sells a plugin before it is installed (owner request 2026-10-13):
 * a Free account sees a Premation Cloud plugin's cover, icon, screenshots,
 * About and what's new, and is shown the way to Premation Cloud instead of an
 * Install that would only answer 402. The publisher manages the listing.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { StorePluginDetail } from '@core/api/client';

jest.mock('@core/config/edition', () => ({
  ...jest.requireActual('@core/config/edition'),
  billingEnabled: () => true,
  cloudProjectsEnabled: () => true,
}));
jest.mock('@core/api/session', () => ({ ...jest.requireActual('@core/api/session'), hasSession: () => true }));
jest.mock('@core/engine/engineInstance', () => ({ engine: jest.fn(), pluginEngine: jest.fn() }));

const cloud: StorePluginDetail = {
  id: 'com.premation.model3d', name: 'Model 3D', description: 'Real 3D models in a comp', latestVersion: '1.2.0', installs: 40,
  publisherKey: 'k', sha256: 's', updatedAt: '2026-10-10T00:00:00.000Z',
  publisher: { namespace: 'premation', displayName: 'Premation', verified: true }, categories: ['3d'], license: 'Proprietary',
  iconUrl: '/plugins/media/icon-1', coverUrl: '/plugins/media/shot-1', screenshotCount: 2,
  kind: 'native', tier: 'cloud', platforms: ['linux-x64'], effects: [{ matchName: 'premation.model3d', name: 'Model 3D', category: '3D' }],
  sdk: { major: 1, minor: 2 }, visibility: 'public',
  readme: '## What it does\n\nLoads **glTF** models.',
  screenshots: [
    { id: 'shot-1', url: '/plugins/media/shot-1', width: 1600, height: 900 },
    { id: 'shot-2', url: '/plugins/media/shot-2', width: 1600, height: 900 },
  ],
  whatsNew: { version: '1.2.0', releaseNotes: '- New: clay material' },
  versionHistory: [
    { version: '1.2.0', createdAt: '2026-10-10T00:00:00.000Z', releaseNotes: '- New: clay material', reviewStatus: 'approved' },
    { version: '1.1.0', createdAt: '2026-10-01T00:00:00.000Z', releaseNotes: null, reviewStatus: 'approved' },
  ],
};

function storeState() {
  return { installed: null, updates: new Map(), busy: null, message: null, refresh: jest.fn(), install: jest.fn(), uninstall: jest.fn(), setEnabled: jest.fn(), setIsolation: jest.fn(), checkPlan: jest.fn(), clearMessage: jest.fn() };
}

async function freeAccount(): Promise<void> {
  const { useEntitlementStore } = await import('@stores/entitlementStore');
  useEntitlementStore.setState({ access: { read: true, write: true, reason: 'free', plan: 'free' } as never });
}

describe('the plugin store showcase', () => {
  beforeEach(() => {
    (window as { motionEditor?: unknown }).motionEditor = {
      plugins: { installed: jest.fn(async () => null), install: jest.fn(), host: { platform: 'linux', arch: 'x64' } },
    };
  });
  afterEach(() => { jest.restoreAllMocks(); delete (window as { motionEditor?: unknown }).motionEditor; });

  it('a card shows the cover and the tier; a Free account gets Premation Cloud instead of Install', async () => {
    await freeAccount();
    const { api } = await import('@core/api/client');
    jest.spyOn(api, 'browseNativePlugins').mockResolvedValue({ items: [cloud], total: 1 } as never);
    jest.spyOn(api, 'myPlugins').mockResolvedValue([] as never);
    const { PluginStoreBrowser } = await import('./PluginStore');
    const { container } = render(<PluginStoreBrowser store={storeState()} />);
    expect(await screen.findByText('Model 3D')).toBeInTheDocument();
    expect(container.querySelector('img[src$="/plugins/media/shot-1"]')).not.toBeNull();
    expect(screen.getAllByText('Premation Cloud').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Get Premation Cloud/ }));
    expect(window.location.hash).toBe('#/dashboard?tab=billing');
  });

  it('the page shows the screenshots, what is new, About and the versions, with the pitch', async () => {
    await freeAccount();
    const { api } = await import('@core/api/client');
    jest.spyOn(api, 'storePluginDetail').mockResolvedValue(cloud);
    const { StorePluginDetailCard } = await import('./PluginStore');
    render(<StorePluginDetailCard id={cloud.id} store={storeState()} onBack={jest.fn()} />);
    expect(await screen.findByText(/comes with Premation Cloud/)).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Screenshots' }).querySelectorAll('button')).toHaveLength(2);
    expect(screen.getByText(/What.s new in v1.2.0/)).toBeInTheDocument();
    // react-markdown is a children-only stub under jest: the About text arrives as written.
    expect(screen.getByRole('heading', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByText(/Loads \*\*glTF\*\* models/)).toBeInTheDocument();
    expect(screen.getByText('v1.1.0')).toBeInTheDocument();
    expect(screen.queryByLabelText('Edit listing')).toBeNull();
  });

  it('the publisher edits the listing: release notes go to the version', async () => {
    const { api } = await import('@core/api/client');
    jest.spyOn(api, 'myPluginDetail').mockResolvedValue(cloud);
    const notes = jest.spyOn(api, 'setPluginReleaseNotes').mockResolvedValue({ version: '1.1.0', releaseNotes: 'Fixed' });
    const { StorePluginDetailCard } = await import('./PluginStore');
    render(<StorePluginDetailCard id={cloud.id} owner store={storeState()} onBack={jest.fn()} />);
    expect(await screen.findByText('Your listing')).toBeInTheDocument();
    expect(screen.getByText('Screenshots (2/3)')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Version' }), { target: { value: '1.1.0' } });
    fireEvent.change(screen.getByPlaceholderText(/New: …/), { target: { value: 'Fixed' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save release notes' })); });
    expect(notes).toHaveBeenCalledWith(cloud.id, '1.1.0', 'Fixed');
  });
});
