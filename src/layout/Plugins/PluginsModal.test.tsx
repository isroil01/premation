/**
 * The manager is where a user decides what a plugin is allowed to do, and where
 * they find out why one is not working. Both of those are claims the UI makes
 * about state it does not own, which is exactly where a UI drifts from the
 * truth: the row used to advertise the permissions the plugin ASKED for, so a
 * user who withheld one still read that it had it.
 *
 * These render the real component against the real host (with a fake worker),
 * because a mocked host would only prove the JSX renders.
 */

import { render, screen, fireEvent, within } from '@testing-library/react';
import pluginHost from '@core/plugins/PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { FakeWorker, useFakeWorkers, testPackage, bootPlugin } from '@core/plugins/fakeWorker.testkit';
import { PluginsManager } from './PluginsModal';

beforeAll(() => {
  useFakeWorkers();
  pluginHost.configure({ getSelection: () => [] });
});

afterAll(() => { pluginHost.setWorkerFactory(null); });

beforeEach(() => {
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  FakeWorker.last = null;
});

const row = (): HTMLElement => screen.getByText('Test Plugin').closest('div[class]')!.parentElement!;

describe('what the row claims the plugin may do', () => {
  it('describes what was GRANTED, not what the manifest asked for', () => {
    bootPlugin(testPackage(['scene:read', 'timeline']), { granted: ['scene:read'] });
    render(<PluginsManager close={() => {}} />);

    expect(screen.getByText(/Read your layers/)).toBeTruthy();
    // The withheld one must not be advertised…
    expect(screen.queryByText(/Read your layers · Control the playhead/)).toBeNull();
    // …and the difference is called out rather than left to be inferred.
    expect(screen.getByText(/narrowed from 2/)).toBeTruthy();
  });

  it('says so when every permission was withheld', () => {
    bootPlugin(testPackage(['scene:read']), { granted: [] });
    render(<PluginsManager close={() => {}} />);
    expect(screen.getByText(/All access withheld/)).toBeTruthy();
  });

  it('distinguishes "the user turned it off" from "it is on but not running"', () => {
    bootPlugin(testPackage([]));
    pluginHost.setEnabled('com.test.plugin', false);
    const { unmount } = render(<PluginsManager close={() => {}} />);
    expect(screen.getByText('Disabled', { selector: 'span' })).toBeTruthy();
    unmount();

    // Enabled, but the runtime is gone (a sandbox that refused to start).
    usePluginStore.getState().setEnabled('com.test.plugin', true);
    render(<PluginsManager close={() => {}} />);
    expect(screen.getByText('Not running')).toBeTruthy();
  });
});

describe('the log', () => {
  it('shows the plugin s own output and the calls the gate refused', () => {
    const w = bootPlugin(testPackage(['scene:read']));
    w.emit({ k: 'log', level: 'log', text: 'plugin said hello' });
    w.callAndWait('timeline.getTime');

    render(<PluginsManager close={() => {}} />);
    fireEvent.click(screen.getByText('Log'));

    expect(screen.getByText('plugin said hello')).toBeTruthy();
    expect(screen.getByText(/timeline.getTime refused/)).toBeTruthy();
  });

  it('is still readable after the plugin has crashed', () => {
    const w = bootPlugin(testPackage([]));
    w.emit({ k: 'log', level: 'log', text: 'last words' });
    w.emit({ k: 'fatal', error: 'it exploded' });

    render(<PluginsManager close={() => {}} />);
    fireEvent.click(screen.getByText('Log'));
    expect(screen.getByText('last words')).toBeTruthy();
    expect(screen.getAllByText(/it exploded/).length).toBeGreaterThan(0);
  });
});

describe('changing permissions from the row', () => {
  it('unticking one and applying narrows the grant and restarts the plugin', () => {
    const first = bootPlugin(testPackage(['scene:read', 'timeline']));
    render(<PluginsManager close={() => {}} />);

    fireEvent.click(screen.getByText('Permissions'));
    const editor = screen.getByText(/What Test Plugin may do/).parentElement!;
    const boxes = within(editor).getAllByRole('checkbox');
    // Second box is `timeline` — manifest order.
    fireEvent.click(boxes[1]!);
    fireEvent.click(within(editor).getByText('Apply'));

    expect(usePluginStore.getState().get('com.test.plugin')?.granted).toEqual(['scene:read']);
    expect(first.terminated).toBe(true);
    // The replacement worker was booted with the NARROWED set.
    const boot = FakeWorker.last!.sent.find((m) => m.k === 'boot');
    expect(boot && boot.k === 'boot' && boot.permissions).toEqual(['scene:read']);
  });

  it('offers no permission editor for a plugin that asked for nothing', () => {
    bootPlugin(testPackage([]));
    render(<PluginsManager close={() => {}} />);
    expect(screen.queryByText('Permissions')).toBeNull();
  });
});

describe('reload', () => {
  it('is offered for a plugin installed from a folder', () => {
    bootPlugin(testPackage([]), { source: 'folder' });
    render(<PluginsManager close={() => {}} />);
    expect(screen.getByText('Reload')).toBeTruthy();
  });

  it('is NOT offered for one installed from a .zip — re-picking a file is a different gesture', () => {
    bootPlugin(testPackage([]), { source: 'file' });
    render(<PluginsManager close={() => {}} />);
    expect(screen.queryByText('Reload')).toBeNull();
  });
});

describe('the panel button', () => {
  it('appears only when the plugin has a panel and is running', () => {
    bootPlugin(testPackage([], 'com.test.plugin', { panel: 'panel.html' }));
    const { unmount } = render(<PluginsManager close={() => {}} />);
    expect(screen.getByText('Open Panel')).toBeTruthy();
    unmount();

    pluginHost.setEnabled('com.test.plugin', false);
    render(<PluginsManager close={() => {}} />);
    expect(screen.queryByText('Open Panel')).toBeNull();
  });
});

it('renders the empty state when nothing is installed', () => {
  render(<PluginsManager close={() => {}} />);
  expect(screen.getByText('No plugins installed')).toBeTruthy();
  expect(row).toBeDefined();
});
