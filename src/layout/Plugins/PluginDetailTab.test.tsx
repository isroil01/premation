/**
 * The plugin page is now the ONLY manager, and these are the claims it makes
 * about state it does not own — which is exactly where a UI drifts from truth.
 *
 * Most of this file used to test a separate manager modal. The modal and this
 * page both described one plugin, and they described it differently: the modal
 * said what the user had GRANTED, the page said what the manifest had ASKED
 * FOR, and whichever screen the user happened to open decided what they
 * believed was true. Merging them is what these tests now protect, so the two
 * cannot come back.
 *
 * Rendered against the real host with a fake worker. A mocked host would only
 * prove the JSX renders.
 */

import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pluginHost from '@core/plugins/PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { FakeWorker, useFakeWorkers, testPackage, bootPlugin } from '@core/plugins/fakeWorker.testkit';
import { PluginDetailTab } from './PluginDetailTab';

// The registry half is mocked away: the SUBJECT here is the machine's view of
// an installed plugin, and every one of these assertions must hold in the local
// edition, which has no registry at all.
jest.mock('@core/plugins/registry', () => ({
  fetchRegistryDetail: jest.fn(async () => null),
  fetchRegistryPackage: jest.fn(),
  registryMediaUrl: (p: string | null) => p,
}));
jest.mock('@core/config/edition', () => ({ pluginRegistryEnabled: () => false }));

beforeAll(async () => {
  useFakeWorkers();
  // Payloads live in IndexedDB, so the store must be hydrated before the host
  // will start anything — `configure()` throws otherwise.
  await usePluginStore.getState().hydrate();
  pluginHost.configure({ getSelection: () => [] });
});
afterAll(() => { pluginHost.setWorkerFactory(null); });

beforeEach(() => {
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  FakeWorker.last = null;
});

/** The page loads its listing asynchronously; assert on the settled render. */
async function show(id = 'com.test.plugin'): Promise<void> {
  await act(async () => { render(<PluginDetailTab pluginId={id} />); });
}

describe('what the page claims the plugin may do', () => {
  it('describes what was GRANTED, not what the manifest asked for', async () => {
    bootPlugin(testPackage(['scene:read', 'timeline']), { granted: ['scene:read'] });
    await show();

    // Both are listed — removing the withheld row would leave the user reading
    // a shorter list with no way to tell it was ever longer — but the withheld
    // one is marked, and the difference is stated rather than left to be
    // inferred by counting.
    expect(screen.getByText(/Read your layers/)).toBeTruthy();
    expect(screen.getByText('Withheld.')).toBeTruthy();
    expect(screen.getByText(/You granted 1 of 2/)).toBeTruthy();
  });

  it('says so when every permission was withheld', async () => {
    bootPlugin(testPackage(['scene:read']), { granted: [] });
    await show();
    expect(screen.getByText(/You granted 0 of 1/)).toBeTruthy();
  });

  it('distinguishes "the user turned it off" from "it is on but not running"', async () => {
    bootPlugin(testPackage([]));
    pluginHost.setEnabled('com.test.plugin', false);
    await show();
    expect(screen.getByText(/Disabled/)).toBeTruthy();

    // Enabled, but the runtime is gone (a sandbox that refused to start).
    await act(async () => { usePluginStore.getState().setEnabled('com.test.plugin', true); });
    expect(screen.getByText(/Not running/)).toBeTruthy();
  });
});

describe('the log', () => {
  it('shows the plugin s own output and the calls the gate refused', async () => {
    const w = bootPlugin(testPackage(['scene:read']));
    w.emit({ k: 'log', level: 'log', text: 'plugin said hello' });
    w.callAndWait('timeline.getTime');

    await show();
    fireEvent.click(screen.getByRole('button', { name: /^Show/ }));

    expect(screen.getByText('plugin said hello')).toBeTruthy();
    expect(screen.getByText(/timeline.getTime refused/)).toBeTruthy();
  });

  it('is still readable after the plugin has crashed', async () => {
    const w = bootPlugin(testPackage([]));
    w.emit({ k: 'log', level: 'log', text: 'last words' });
    w.emit({ k: 'fatal', error: 'it exploded' });

    await show();
    fireEvent.click(screen.getByRole('button', { name: /^Show/ }));
    expect(screen.getByText('last words')).toBeTruthy();
    expect(screen.getAllByText(/it exploded/).length).toBeGreaterThan(0);
  });
});

describe('changing permissions', () => {
  it('unticking one and applying narrows the grant and restarts the plugin', async () => {
    const first = bootPlugin(testPackage(['scene:read', 'timeline']));
    await show();

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    const editor = screen.getByRole('button', { name: 'Apply' }).closest('div')!.parentElement!;
    const boxes = within(editor).getAllByRole('checkbox');
    // Second box is `timeline` — manifest order.
    fireEvent.click(boxes[1]!);
    fireEvent.click(within(editor).getByRole('button', { name: 'Apply' }));

    expect(usePluginStore.getState().get('com.test.plugin')?.granted).toEqual(['scene:read']);
    expect(first.terminated).toBe(true);
    // The replacement worker was booted with the NARROWED set. Asserting on the
    // store alone would pass for a host that saved the change and kept running
    // the old worker with the old grant.
    const boot = FakeWorker.last!.sent.find((m) => m.k === 'boot');
    expect(boot && boot.k === 'boot' && boot.permissions).toEqual(['scene:read']);
  });

  it('offers no permission editor for a plugin that asked for nothing', async () => {
    bootPlugin(testPackage([]));
    await show();
    expect(screen.getByText(/asks for no access/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  });
});

describe('reload', () => {
  it('is offered for a plugin installed from a folder', async () => {
    bootPlugin(testPackage([]), { source: 'folder' });
    await show();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('is NOT offered for one installed from a .zip — re-picking a file is a different gesture', async () => {
    bootPlugin(testPackage([]), { source: 'file' });
    await show();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
  });
});

describe('the panel button', () => {
  it('appears only when the plugin has a panel and is running', async () => {
    bootPlugin(testPackage([], 'com.test.plugin', { panel: 'panel.html' }));
    await show();
    expect(screen.getByRole('button', { name: 'Open Panel' })).toBeTruthy();

    await act(async () => { pluginHost.setEnabled('com.test.plugin', false); });
    expect(screen.queryByRole('button', { name: 'Open Panel' })).toBeNull();
  });
});

describe('a plugin the registry has never heard of', () => {
  it('renders from the installed package rather than a dead end', async () => {
    // The failure this replaces: clicking a plugin installed from a folder, or
    // ANY plugin in the local edition, opened a page saying the registry was
    // unavailable. True, and useless — the manifest on this machine already
    // holds the name, version, permissions and contributions.
    bootPlugin(testPackage(['scene:read'], 'com.test.folder', { name: 'Work In Progress' }), {
      source: 'folder',
    });
    await show('com.test.folder');

    expect(screen.getByText('Work In Progress')).toBeTruthy();
    expect(screen.getByText(/installed from a folder/)).toBeTruthy();
    expect(screen.queryByText(/no longer in the registry/i)).toBeNull();
  });

  it('is a real empty state only when it is neither installed nor listed', async () => {
    await show('com.test.nothing');
    expect(screen.getByText(/registry isn.t available in this edition/i)).toBeTruthy();
  });
});

/**
 * The consolidation itself, asserted as a fact about the tree.
 *
 * A second manager is not a bug that shows up in a rendering test — both
 * managers render fine. It shows up months later, as two screens disagreeing
 * about one plugin. So the check is that the file is gone and stays gone.
 */
describe('there is one manager', () => {
  it('has no PluginsModal to drift from', () => {
    expect(existsSync(join(__dirname, 'PluginsModal.tsx'))).toBe(false);
  });
});
