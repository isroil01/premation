/**
 * The Plugins sidebar (owner-approved mockup board 1, 2026-11-03): Installed
 * and Premation Store sections, one search over both, one inline button per
 * row, and a click / Enter that opens the plugin's page in the main body.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { api } from '@core/api/client';
import { engine } from '@core/engine/engineInstance';
import { resetPluginContribForTest } from '@core/nativePlugins/pluginContrib';
import { usePluginPageStore } from '@stores/pluginPageStore';
import { NativePluginsPanel } from './NativePluginsPanel';

jest.mock('@core/engine/engineInstance', () => {
  const engine = jest.fn();
  return { engine, pluginEngine: (...a: unknown[]) => engine(...a) };
});
jest.mock('@core/api/session', () => ({ ...jest.requireActual('@core/api/session'), hasSession: () => false }));
// The engine's effect list is not asked for here.
jest.mock('@layout/Effects/effectCatalog', () => ({ useAllEffectDefs: () => [] }));

const glow = {
  id: 'premation.deepglow', name: 'Deep Glow', version: '1.0.0', vendor: 'Premation', sdk: '1.2', status: 'loaded',
  error: '', effects: ['premation.deepglow'], gpu: true, panel: true, commands: [], importers: [], outputModules: [],
  panels: [], presets: [],
};
const grade = { ...glow, id: 'acme.grade', name: 'Grade Lab', vendor: 'Acme', status: 'disabled', effects: [], panel: false };

function listing(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id, name, description: `${name} does things`, latestVersion: '2.0.0', installs: 12400, publisherKey: 'k', sha256: 's',
    updatedAt: '2026-10-01T00:00:00.000Z', publisher: { namespace: 'acme', displayName: 'Acme Labs', verified: true },
    categories: [], license: null, iconUrl: null, kind: 'native' as const, tier: 'free' as const, platforms: ['linux-x64'], effects: [], sdk: null,
    ...extra,
  };
}

beforeEach(() => {
  resetPluginContribForTest();
  usePluginPageStore.setState({ pages: [], active: null });
  jest.mocked(engine).mockReturnValue({
    query: jest.fn(async () => ({ ok: true, value: { type: 'listPlugins', plugins: [glow, grade] }, revision: 1 })),
  } as never);
  jest.spyOn(api, 'browseNativePlugins').mockResolvedValue({
    items: [listing('premation.deepglow', 'Deep Glow'), listing('acme.particles', 'Particle Storm')],
    total: 2,
  } as never);
});

afterEach(() => {
  jest.restoreAllMocks();
  delete (window as { motionEditor?: unknown }).motionEditor;
});

const option = (name: RegExp): HTMLElement => screen.getByRole('option', { name });

// First: the store's answer is remembered per search (useCachedQuery), and
// a remembered listing outlives a later failure.
it('keeps the installed list when the store is unreachable, and offers Retry', async () => {
  jest.spyOn(api, 'browseNativePlugins').mockRejectedValue(new Error('offline'));
  render(<NativePluginsPanel />);
  expect(await screen.findByText(/Store unavailable/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
    expect.stringContaining('Deep Glow'),
    expect.stringContaining('Grade Lab'),
  ]);
});

it('lists installed plugins and store plugins not installed, each with a meta line and a status word', async () => {
  render(<NativePluginsPanel />);
  const installed = await screen.findByRole('listbox', { name: 'Installed plugins' });
  expect(within(installed).getAllByRole('option')).toHaveLength(2);
  expect(within(option(/^Deep Glow/)).getByText('Loaded')).toBeInTheDocument();
  // The store's listing fills in the installed row's description and installs.
  expect(within(option(/^Deep Glow/)).getByText('Deep Glow does things')).toBeInTheDocument();
  expect(within(option(/^Deep Glow/)).getByText('Premation · ↓ 12.4K')).toBeInTheDocument();
  expect(within(option(/^Grade Lab/)).getByText('Disabled')).toBeInTheDocument();
  expect(within(option(/^Grade Lab/)).getByRole('button', { name: 'Enable' })).toBeInTheDocument();

  const store = await screen.findByRole('listbox', { name: 'Store plugins' });
  // Deep Glow is installed: only Particle Storm is offered.
  expect(within(store).getAllByRole('option')).toHaveLength(1);
  expect(within(option(/^Particle Storm/)).getByText('Free')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Premation Store/ })).toHaveTextContent('1');
  expect(screen.getByRole('button', { name: /Installed/ })).toHaveTextContent('2');
});

it('filters both sections with one search', async () => {
  render(<NativePluginsPanel />);
  await screen.findByRole('listbox', { name: 'Store plugins' });
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search plugins in store and installed' }), { target: { value: 'grade' } });
  expect(option(/^Grade Lab/)).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /^Deep Glow/ })).toBeNull();
  expect(screen.queryByRole('option', { name: /^Particle Storm/ })).toBeNull();
  expect(await screen.findByText('No store plugin matches “grade”.')).toBeInTheDocument();
});

it('opens a plugin page on click and on Enter, and walks the rows of both sections with the arrows', async () => {
  render(<NativePluginsPanel />);
  await screen.findByRole('listbox', { name: 'Store plugins' });

  fireEvent.click(option(/^Grade Lab/));
  expect(usePluginPageStore.getState().pages).toEqual([{ id: 'acme.grade', name: 'Grade Lab' }]);
  expect(usePluginPageStore.getState().active).toBe('acme.grade');

  act(() => { option(/^Grade Lab/).focus(); });
  fireEvent.keyDown(option(/^Grade Lab/), { key: 'ArrowDown' });
  expect(document.activeElement).toBe(option(/^Particle Storm/));
  expect(option(/^Particle Storm/)).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(option(/^Particle Storm/), { key: 'Enter' });
  expect(usePluginPageStore.getState().active).toBe('acme.particles');
  expect(usePluginPageStore.getState().pages.map((p) => p.id)).toEqual(['acme.grade', 'acme.particles']);
});

it('collapses a section from its header', async () => {
  render(<NativePluginsPanel />);
  await screen.findByRole('listbox', { name: 'Store plugins' });
  fireEvent.click(screen.getByRole('button', { name: /Premation Store/ }));
  expect(screen.queryByRole('listbox', { name: 'Store plugins' })).toBeNull();
  expect(screen.getByRole('listbox', { name: 'Installed plugins' })).toBeInTheDocument();
});

it('installs a store plugin from its row button without opening its page', async () => {
  const install = jest.fn(async () => ({ ok: true, id: 'acme.particles', version: '2.0.0', restartNeeded: true }));
  (window as { motionEditor?: unknown }).motionEditor = {
    plugins: { installed: jest.fn(async () => ({ plugins: {}, uninstall: [] })), install, host: { platform: 'linux', arch: 'x64' } },
  };
  jest.mocked(engine).mockReturnValue({
    query: jest.fn(async () => ({ ok: true, value: { type: 'listPlugins', plugins: [glow, grade] }, revision: 1 })),
    execute: jest.fn(async () => ({ ok: true, value: { plugins: [] }, revision: 1 })),
  } as never);
  render(<NativePluginsPanel />);
  await screen.findByRole('listbox', { name: 'Store plugins' });
  await act(async () => { fireEvent.click(within(option(/^Particle Storm/)).getByRole('button', { name: 'Install' })); });
  expect(install).toHaveBeenCalledWith({ id: 'acme.particles', version: '2.0.0', owner: false });
  expect(usePluginPageStore.getState().pages).toEqual([]);
});
