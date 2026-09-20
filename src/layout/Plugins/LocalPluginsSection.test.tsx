/**
 * The plugins-folder section, driven through a fake desktop bridge.
 *
 * The assertions that earn their place are the gate ones. A folder plugin is
 * unsigned code sitting on the user's disk, and the whole tier rests on two
 * behaviours being true in the UI and not merely in a pure function: that
 * nothing loads while Developer Mode is off, and that turning it on is a
 * decision the user made rather than one a checkbox made for them.
 *
 * The third is absence: in a build with no filesystem bridge the section must
 * render NOTHING, or the browser build grows a control for a folder it does not
 * have.
 */

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { LocalPluginsSection } from './LocalPluginsSection';
import pluginHost from '@core/plugins/PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { resetDeveloperModeForTests, setDeveloperMode } from '@core/plugins/developerMode';
import type { DiscoveredLocalPlugin, LocalPackageRead } from '@app-types/motionEditor';

const confirmResult = { ok: true };
jest.mock('@components/Modal/Dialogs', () => ({
  customAlert: jest.fn(async () => {}),
  customConfirm: jest.fn(async () => confirmResult.ok),
}));

const MANIFEST = {
  id: 'com.test.folder',
  name: 'Folder Plugin',
  version: '1.2.0',
  description: 'Read from a folder on this machine.',
  apiVersion: 1,
  main: 'main.js',
  permissions: [],
};

const scan: { found: DiscoveredLocalPlugin[] } = {
  found: [
    {
      path: '/plugins/folder-plugin',
      kind: 'folder',
      source: 'user',
      root: '/plugins',
      manifestText: JSON.stringify(MANIFEST),
      modifiedAt: 1,
    },
  ],
};

const openFolder = jest.fn(async () => ({ ok: true, dir: '/plugins' }));
const watch = jest.fn(async () => ({ ok: true, watching: true }));
const read = jest.fn(
  async (): Promise<LocalPackageRead> => ({
    ok: true,
    kind: 'folder',
    files: { 'plugin.json': JSON.stringify(MANIFEST), 'main.js': 'export function activate() {}' },
    binaries: {},
  }),
);

function installBridge(): void {
  (window as unknown as { motionEditor?: unknown }).motionEditor = {
    plugins: {
      paths: async () => [{ kind: 'user' as const, dir: '/plugins' }],
      scan: async () => scan.found,
      read,
      openFolder,
      watch,
      onChanged: () => () => {},
    },
  };
}

beforeAll(async () => {
  await usePluginStore.getState().hydrate();
  pluginHost.setWorkerFactory(() => ({
    postMessage: () => {},
    terminate: () => {},
    onmessage: null,
    onerror: null,
  }) as unknown as Worker);
});

afterAll(() => {
  pluginHost.setWorkerFactory(null);
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
});

beforeEach(() => {
  installBridge();
  resetDeveloperModeForTests();
  confirmResult.ok = true;
  read.mockClear();
  openFolder.mockClear();
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
});

describe('without a desktop bridge', () => {
  it('renders nothing at all', () => {
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
    const { container } = render(<LocalPluginsSection />);
    expect(container.firstChild).toBeNull();
  });
});

describe('the folder list', () => {
  it('lists what the scan found, with where it came from', async () => {
    render(<LocalPluginsSection />);
    expect(await screen.findByText('Folder Plugin')).toBeInTheDocument();
    expect(screen.getByText(/1\.2\.0 · Folder/)).toBeInTheDocument();
  });

  it('shows the folders it is scanning in the info modal, so "why is it not here" is answerable', async () => {
    render(<LocalPluginsSection />);
    fireEvent.click(await screen.findByRole('button', { name: /plugins folder info/i }));
    expect(await screen.findByText('/plugins')).toBeInTheDocument();
  });

  /*
    The gate, in the UI. `localPlugins.test.ts` proves the decision; this proves
    the button is actually wired to it — an enabled Load that refuses on click
    would be a worse failure than either.
  */
  it('refuses to load an unsigned folder while Developer Mode is off', async () => {
    render(<LocalPluginsSection />);
    const load = await screen.findByRole('button', { name: 'Load' });
    expect(load).toBeDisabled();
    expect(screen.getByText(/enable Developer Mode/i)).toBeInTheDocument();
  });

  it('loads it once Developer Mode is on', async () => {
    act(() => { setDeveloperMode(true); });
    render(<LocalPluginsSection />);
    const load = await screen.findByRole('button', { name: 'Load' });
    expect(load).toBeEnabled();
    fireEvent.click(load);
    await waitFor(() => expect(read).toHaveBeenCalledWith('/plugins/folder-plugin'));
  });

  it('opens the plugins folder on this computer', async () => {
    render(<LocalPluginsSection />);
    fireEvent.click(await screen.findByRole('button', { name: /open plugins folder/i }));
    await waitFor(() => expect(openFolder).toHaveBeenCalled());
  });

  it('opens and closes the plugins folder info modal', async () => {
    render(<LocalPluginsSection />);
    fireEvent.click(await screen.findByRole('button', { name: /plugins folder info/i }));
    expect(await screen.findByText('Plugins Folder')).toBeInTheDocument();
    expect(screen.getByText('Scanned Folders')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByText('Scanned Folders')).not.toBeInTheDocument();
    });
  });
});

describe('the Developer Mode switch in info modal', () => {
  it('does not turn on until the warning is accepted', async () => {
    confirmResult.ok = false;
    render(<LocalPluginsSection />);
    fireEvent.click(await screen.findByRole('button', { name: /plugins folder info/i }));
    const toggle = await screen.findByRole('checkbox');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());
  });

  it('turns on when it is', async () => {
    render(<LocalPluginsSection />);
    fireEvent.click(await screen.findByRole('button', { name: /plugins folder info/i }));
    const toggle = await screen.findByRole('checkbox');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
  });

  /* Turning it OFF asks nothing — narrowing what may run is never a decision
     that needs defending. */
  it('turns off without asking', async () => {
    act(() => { setDeveloperMode(true); });
    render(<LocalPluginsSection />);
    fireEvent.click(await screen.findByRole('button', { name: /plugins folder info/i }));
    const toggle = await screen.findByRole('checkbox');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());
  });
});

describe('two copies of the same plugin', () => {
  it('says which one it kept', async () => {
    scan.found = [
      { ...scan.found[0]!, path: '/machine/p', source: 'machine', manifestText: JSON.stringify({ ...MANIFEST, version: '1.0.0' }) },
      { ...scan.found[0]!, path: '/user/p', source: 'user', manifestText: JSON.stringify({ ...MANIFEST, version: '2.0.0' }) },
    ];
    render(<LocalPluginsSection />);
    expect(await screen.findByText(/using 2\.0\.0 from/)).toBeInTheDocument();
    scan.found = [scan.found[1]!];
  });
});
