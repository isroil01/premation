/**
 * A plugin's page in the main body (mockup board 1, 2026-11-03): the header,
 * the right actions for what the plugin is here, and the Effects / Presets /
 * Panels tabs that apply, apply, and dock.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { api, type StorePluginDetail } from '@core/api/client';
import { edit } from '@core/engine/uiEdits';
import { setPluginEffectDefs } from '@core/inspector/pluginEffectDefs';
import { resetPluginContribForTest, setPluginContrib } from '@core/nativePlugins/pluginContrib';
import { setPluginPresets } from '@core/nativePlugins/pluginPresets';
import { addEffectEdit } from '@layout/Effects/effectEdits';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { PluginDetailPage } from './PluginDetailPage';

jest.mock('@core/engine/engineInstance', () => ({ engine: jest.fn(), pluginEngine: jest.fn(() => ({ query: jest.fn(async () => ({ ok: false, error: { message: '' } })) })) }));
jest.mock('@core/engine/uiEdits', () => ({ edit: jest.fn(async () => ({ ok: true })) }));
jest.mock('@layout/Effects/effectEdits', () => ({ addEffectEdit: jest.fn(async () => []) }));
jest.mock('@layout/Effects/effectCatalog', () => ({ useAllEffectDefs: () => [] }));
jest.mock('@core/api/session', () => ({ ...jest.requireActual('@core/api/session'), hasSession: () => false }));

const glow = {
  id: 'premation.deepglow', name: 'Deep Glow', version: '1.0.0', vendor: 'Premation', sdk: '1.2', status: 'loaded' as const,
  error: '', effects: ['premation.deepglow'], gpu: true, panel: true, commands: [], importers: [], outputModules: [],
  panels: [], presets: [], layerTypes: [],
    interpolators: [],
    tools: [],
    audio: [],
    isolation: 'engine',
    isolationPin: '',
};

const listing: StorePluginDetail = {
  id: 'premation.deepglow', name: 'Deep Glow', description: 'Physically based glow', latestVersion: '1.0.0', installs: 12400,
  publisherKey: 'k', sha256: 's', updatedAt: '2026-10-10T00:00:00.000Z',
  publisher: { namespace: 'premation', displayName: 'Premation', verified: true }, categories: [], license: 'Proprietary',
  iconUrl: null, kind: 'native', tier: 'free', platforms: ['linux-x64'], effects: [], sdk: { major: 1, minor: 2 },
  readme: 'Glows **well**.', versionHistory: [{ version: '1.0.0', createdAt: '2026-10-10T00:00:00.000Z', releaseNotes: 'First.' }],
};

const openPanel = jest.fn();
const closePanel = jest.fn();
let real: { openPanel: (id: string) => void; closePanel: (id: string) => void };

beforeEach(() => {
  resetPluginContribForTest();
  setPluginContrib([glow]);
  setPluginEffectDefs([{ matchName: 'premation.deepglow', displayName: 'Deep Glow', category: 'Stylize', gpu: true, provider: 'premation.deepglow', params: [], supportsFloat: true, audio: false, actions: [], groups: [], customUis: [] }]);
  setPluginPresets([{ id: 'premation.deepglow', presets: [{ name: 'Neon', effect: 'premation.deepglow', values: [], category: '' }] }]);
  real = { openPanel: useLayoutStore.getState().openPanel, closePanel: useLayoutStore.getState().closePanel };
  useLayoutStore.setState({ openPanel, closePanel });
  openPanel.mockClear();
  closePanel.mockClear();
  jest.mocked(edit).mockClear();
  jest.mocked(addEffectEdit).mockClear();
  useSelectionStore.setState({ ids: ['layer-1'], primary: 'layer-1' });
});

afterEach(() => {
  useLayoutStore.setState(real);
  useSelectionStore.setState({ ids: [], primary: null });
  setPluginEffectDefs([]);
  setPluginPresets([]);
  resetPluginContribForTest();
  jest.restoreAllMocks();
  delete (window as { motionEditor?: unknown }).motionEditor;
});

it('shows an installed, store-listed plugin and applies its effects and presets', async () => {
  jest.spyOn(api, 'storePluginDetail').mockResolvedValue(listing);
  render(<PluginDetailPage id="premation.deepglow" name="Deep Glow" />);
  expect(screen.getByRole('heading', { name: 'Deep Glow' })).toBeInTheDocument();
  expect(await screen.findByText('Physically based glow')).toBeInTheDocument();
  expect(screen.getByText('12,400 installs')).toBeInTheDocument();
  expect(screen.getByLabelText('Verified')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'About' })).toBeInTheDocument(); // the README

  fireEvent.click(screen.getByRole('tab', { name: /Effects\s*1/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(addEffectEdit).toHaveBeenCalledWith(['layer-1'], 'premation.deepglow');

  fireEvent.click(screen.getByRole('tab', { name: /Presets\s*1/ }));
  const neon = screen.getByText('Neon').closest('li')!;
  await act(async () => { fireEvent.click(within(neon).getByRole('button', { name: 'Apply' })); });
  expect(edit).toHaveBeenCalledWith('Apply Neon', expect.objectContaining({ type: 'addEffect' }));

  fireEvent.click(screen.getByRole('tab', { name: 'Changelog' }));
  expect(screen.getByText('First.')).toBeInTheDocument();
});

it('docks and undocks a plugin panel from its checkbox, and opens it', async () => {
  jest.spyOn(api, 'storePluginDetail').mockResolvedValue(listing);
  const order = useLayoutStore.getState().panelOrder;
  render(<PluginDetailPage id="premation.deepglow" name="Deep Glow" />);
  fireEvent.click(screen.getByRole('tab', { name: /Panels\s*1/ }));
  const box = screen.getByRole('checkbox', { name: 'Show as sidebar tab' });
  expect(box).not.toBeChecked();
  fireEvent.click(box);
  expect(openPanel).toHaveBeenCalledWith('plugin:premation.deepglow');

  act(() => { useLayoutStore.setState({ panelOrder: { ...order, rightInspector: [...(order.rightInspector ?? []), 'plugin:premation.deepglow'] } }); });
  expect(screen.getByRole('checkbox', { name: 'Show as sidebar tab' })).toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show as sidebar tab' }));
  expect(closePanel).toHaveBeenCalledWith('plugin:premation.deepglow');
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  expect(openPanel).toHaveBeenCalledTimes(2);
  act(() => { useLayoutStore.setState({ panelOrder: order }); });
});

it('shows the manifest for a plugin the store does not list', async () => {
  // Its own id: the store's answers are remembered per plugin.
  setPluginContrib([glow, { ...glow, id: 'local.tool', name: 'Local Tool', effects: [], panel: false }]);
  jest.spyOn(api, 'storePluginDetail').mockRejectedValue(new Error('Not found'));
  render(<PluginDetailPage id="local.tool" name="Local Tool" />);
  expect(await screen.findByText(/the Premation Store does not list it/)).toBeInTheDocument();
  expect(screen.getByText('Plugins folder')).toBeInTheDocument();
});

it('offers Install for a store plugin that is not installed', async () => {
  (window as { motionEditor?: unknown }).motionEditor = {
    plugins: { installed: jest.fn(async () => ({ plugins: {}, uninstall: [] })), install: jest.fn(), host: { platform: 'linux', arch: 'x64' } },
  };
  jest.spyOn(api, 'storePluginDetail').mockResolvedValue({ ...listing, id: 'acme.particles', name: 'Particle Storm', effects: [{ matchName: 'acme.particles', name: 'Particles', category: 'Generate' }] });
  render(<PluginDetailPage id="acme.particles" name="Particle Storm" />);
  expect(await screen.findByRole('button', { name: 'Install' })).toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: /Presets/ })).toBeNull();
  // What it adds, from the listing, without Apply.
  fireEvent.click(screen.getByRole('tab', { name: /Effects\s*1/ }));
  expect(screen.getByText('Particles')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
});
