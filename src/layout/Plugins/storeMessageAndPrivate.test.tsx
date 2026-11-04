/**
 * 2026-10-13 QA (real app, localhost backend):
 *   - a free account's Install on a Premation Cloud plugin showed the store's
 *     402 text and no way on — P3 says "Included with Premation Cloud —
 *     Upgrade": the line now carries an Upgrade button to the Plan page;
 *   - a publisher's PRIVATE plugin was not in the Store tab (only in Publish ▸
 *     Your plugins). The registry's browse is the public, cacheable listing and
 *     never names it, so the page adds the signed-in publisher's own private
 *     plugins from `/plugins/mine/list`, and they install as the owner.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { StoreMessageLine } from './StoreMessageLine';

jest.mock('@core/config/edition', () => ({ ...jest.requireActual('@core/config/edition'), billingEnabled: () => true }));
jest.mock('@core/api/session', () => ({ ...jest.requireActual('@core/api/session'), hasSession: () => true }));
jest.mock('@core/engine/engineInstance', () => ({ engine: jest.fn(), pluginEngine: jest.fn() }));

function Where(): JSX.Element {
  const l = useLocation();
  return <span data-testid="where">{l.pathname + l.search}</span>;
}

describe('the store message line', () => {
  it('a plan refusal offers Upgrade, which opens the Plan page', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard?tab=plugins']}>
        <Routes><Route path="*" element={<><StoreMessageLine message={{ text: 'This plugin is included with Premation Cloud. Upgrade to install it.', error: true, upgrade: true }} /><Where /></>} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('included with Premation Cloud');
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/dashboard?tab=billing');
  });

  it('any other message is the text alone', () => {
    render(<StoreMessageLine message={{ text: 'The publisher signature does not verify.', error: true }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('signature');
    expect(screen.queryByRole('button', { name: 'Upgrade' })).toBeNull();
  });
});

describe('the Store tab for a publisher', () => {
  afterEach(() => { jest.restoreAllMocks(); delete (window as { motionEditor?: unknown }).motionEditor; });

  it('lists the publisher\'s own private plugin, and Install asks for it as the owner', async () => {
    const pub = { id: 'com.acme.glow', name: 'Acme Glow', description: 'glow', latestVersion: '1.0.0', installs: 0, publisherKey: 'k', sha256: 's', updatedAt: '', publisher: { namespace: 'acme', displayName: 'Acme', verified: true }, categories: [], license: null, iconUrl: null, kind: 'native' as const, platforms: ['linux-x64'], effects: [], sdk: { major: 1, minor: 0 }, visibility: 'public' as const };
    const grade = { ...pub, id: 'com.me.grade', name: 'My Grade', description: 'private grade', visibility: 'private' as const };
    const { api } = await import('@core/api/client');
    jest.spyOn(api, 'browseNativePlugins').mockResolvedValue({ items: [pub], total: 1 } as never);
    jest.spyOn(api, 'myPlugins').mockResolvedValue([grade, { ...pub, visibility: 'public' }] as never);
    (window as { motionEditor?: unknown }).motionEditor = {
      plugins: { installed: jest.fn(async () => null), install: jest.fn(), host: { platform: 'linux', arch: 'x64' } },
    };
    const { PluginStoreBrowser } = await import('./PluginStore');
    const install = jest.fn();
    const store = { installed: null, updates: new Map(), busy: null, message: null, refresh: jest.fn(), install, uninstall: jest.fn(), setEnabled: jest.fn(), setIsolation: jest.fn(), checkPlan: jest.fn(), clearMessage: jest.fn() };
    render(<PluginStoreBrowser store={store} />);
    expect(await screen.findByText('My Grade')).toBeInTheDocument();
    expect(screen.getByText('Acme Glow')).toBeInTheDocument();
    // Listed once each: the public one is not repeated from the publisher's list.
    expect(screen.getAllByRole('button', { name: 'Install' })).toHaveLength(2);
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Install' })[0]!); });
    expect(install).toHaveBeenCalledWith('com.me.grade', '1.0.0', true);
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Install' })[1]!); });
    expect(install).toHaveBeenLastCalledWith('com.acme.glow', '1.0.0', false);
  });
});
