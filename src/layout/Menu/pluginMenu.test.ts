/**
 * The Plugins menu is the discovery path: before it existed, a plugin's
 * commands lived only in the palette, so you had to already know a plugin had
 * contributed one in order to find it.
 *
 * These pin the two things that make the group honest — a plugin that is
 * installed is always visible (running or not), and a running plugin's items
 * point at the namespaced command ids the host actually registered.
 */

import pluginHost from '@core/plugins/PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { buildPluginsMenuGroup } from './pluginMenu';
import { FakeWorker, useFakeWorkers, testPackage } from '@core/plugins/fakeWorker.testkit';
import type { PluginPackage } from '@core/plugins/pluginPackage';

const pkg = (id: string, name: string, panel?: string): PluginPackage =>
  testPackage([], id, { name, ...(panel ? { panel } : {}) });

const labels = (): string[] =>
  buildPluginsMenuGroup().items.map((i) => i.label ?? i.commandId ?? (i.separator ? '—' : ''));
const commandIds = (): string[] =>
  buildPluginsMenuGroup().items.flatMap((i) => (i.commandId ? [i.commandId] : []));

beforeAll(async () => {
  useFakeWorkers();
    // Payloads live in IndexedDB, so the store must be hydrated before the
    // host will start anything — `configure()` throws otherwise.
    await usePluginStore.getState().hydrate();
  pluginHost.configure({ getSelection: () => [] });
});

afterAll(() => { pluginHost.setWorkerFactory(null); });

beforeEach(() => {
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
});

it('always offers the manager, even with nothing installed', () => {
  expect(commandIds()).toEqual(['view.marketplace']);
  expect(labels()).toContain('No plugins installed');
});

it('lists a running plugin s panel and its contributed commands', () => {
  pluginHost.install(pkg('com.menu.a', 'Alpha', 'panel.html'), []);
  FakeWorker.last!.emit({ k: 'activated' });
  FakeWorker.last!.emit({ k: 'call', id: 1, method: 'commands.register', args: [{ id: 'go', label: 'Go' }] });

  expect(commandIds()).toEqual([
    'plugin.com.menu.a.panel.main',
    'plugin.com.menu.a.go',
    'view.marketplace',
  ]);
});

it('still shows a disabled plugin, and says why it is not there', () => {
  pluginHost.install(pkg('com.menu.b', 'Beta'), []);
  FakeWorker.last!.emit({ k: 'activated' });
  pluginHost.setEnabled('com.menu.b', false);

  // Present but inert: no commandId means the renderers draw it greyed out.
  // Omitting it entirely is what makes a user ask whether it installed at all.
  expect(labels().some((l) => l.startsWith('Beta ('))).toBe(true);
  expect(commandIds()).toEqual(['view.marketplace']);
});

it('sorts plugins by name so the menu does not reshuffle on reinstall', () => {
  pluginHost.install(pkg('com.menu.z', 'Zulu'), []);
  FakeWorker.last!.emit({ k: 'activated' });
  pluginHost.install(pkg('com.menu.m', 'Mike'), []);
  FakeWorker.last!.emit({ k: 'activated' });

  const shown = labels().filter((l) => l.startsWith('Mike') || l.startsWith('Zulu'));
  expect(shown[0]!.startsWith('Mike')).toBe(true);
});
