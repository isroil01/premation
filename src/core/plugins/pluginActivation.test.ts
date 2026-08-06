/**
 * Lazy activation, multi-panel routing, and API 1 compatibility.
 *
 * Split from `pluginHost.test.ts` because it is a different question. That
 * suite asks what a RUNNING plugin may do; this one asks when a plugin runs at
 * all, which is the change this phase makes.
 *
 * Under API 1 every enabled plugin spawned a worker at launch, because the only
 * way to learn what a plugin contributed was to run it. Forty installed plugins
 * meant forty workers racing one 8-second boot timeout, for a user who will use
 * two of them. Contributions are declared now, so the palette can be complete
 * while almost nothing is running.
 *
 * The property under test throughout: an inactive plugin is INDISTINGUISHABLE
 * from a running one at the point of use. Its commands are present, enabled, and
 * invoking one works. The only difference is that no worker existed until then.
 */

import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { getCommandRegistry } from '@core/commands/Command';
import { useSelectionStore } from '@stores/selectionStore';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { FakeWorker, useFakeWorkers, testPackage, bootPlugin } from './fakeWorker.testkit';
import type { PluginPackage } from './pluginPackage';

/**
 * The worker the host just spawned.
 *
 * A function rather than reading `FakeWorker.last` inline: the tests below
 * reset that static to null first, which narrows its type for the rest of the
 * block, so every later `w!` would be `never` and the assertions against it
 * would check nothing at all.
 */
function spawnedWorker(): FakeWorker {
  const w = FakeWorker.last;
  if (!w) throw new Error('expected the host to have spawned a worker');
  return w;
}

const panelCalls: Array<{ op: 'show' | 'hide'; id: string; panelId: string }> = [];
const pkg = testPackage;

beforeAll(async () => {
  seedDefaultScene();
  useFakeWorkers();
    // Payloads live in IndexedDB, so the store must be hydrated before the
    // host will start anything — `configure()` throws otherwise.
    await usePluginStore.getState().hydrate();
  pluginHost.configure({
    getSelection: () => useSelectionStore.getState().ids,
    showPanel: (id, panelId) => { panelCalls.push({ op: 'show', id, panelId }); },
    hidePanel: (id, panelId) => { panelCalls.push({ op: 'hide', id, panelId }); },
  });
});

afterAll(() => { pluginHost.setWorkerFactory(null); });

beforeEach(() => {
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  FakeWorker.last = null;
  panelCalls.length = 0;
});

/** A plugin that declares a command and a panel, and starts on neither. */
const lazy = (id = 'com.lazy.a'): PluginPackage =>
  pkg([], id, {
    apiVersion: 2,
    contributes: {
      commands: [{ id: 'go', label: 'Go' }],
      panels: [{ id: 'main', title: 'Main', entry: 'panel.html' }],
    },
    activationEvents: ['onCommand:go', 'onPanel:main'],
  });

describe('the hydration guard', () => {
  it('refuses to configure before payloads have loaded', () => {
    // "Call hydrate() before configure()" is call-order discipline, and
    // call-order discipline gets violated — by a refactor that moves a line, or
    // by a new entry point (a pop-out window, a fresh test harness) written by
    // someone who never read the note.
    //
    // The failure it prevents is quiet and expensive: with no payloads every
    // installed plugin has an empty `files`, so all of them fail with "the
    // entry module is missing from the package" at once. That reads as every
    // plugin the user installed being corrupt, and the real cause — two lines
    // in the wrong order at boot — appears nowhere in the message.
    const restore = usePluginStore.getState().hydrated;
    usePluginStore.setState({ hydrated: false });
    try {
      expect(() => pluginHost.configure({ getSelection: () => [] })).toThrow(/hydrate/i);
    } finally {
      usePluginStore.setState({ hydrated: restore });
    }
  });
});

describe('lazy activation', () => {
  it('installs without spawning a worker', () => {
    pluginHost.install(lazy(), []);
    expect(FakeWorker.last).toBeNull();
    expect(pluginHost.info('com.lazy.a').status).toBe('inactive');
  });

  it('reports its declared commands while inactive, without having run', () => {
    // The whole point of declaring contributions: the manager can say what a
    // plugin offers before a line of it has executed.
    pluginHost.install(lazy(), []);
    expect(pluginHost.info('com.lazy.a').commands).toEqual([{ id: 'go', label: 'Go' }]);
  });

  it('puts an inactive plugin command in the palette, ENABLED', () => {
    pluginHost.install(lazy(), []);
    const cmd = getCommandRegistry().get('plugin.com.lazy.a.go' as never);
    expect(cmd).toBeDefined();
    // A command that greys out until you have started the thing it starts is a
    // loop the user cannot get into.
    expect(cmd!.enabled?.()).toBe(true);
  });

  it('invoking the command starts the plugin and then dispatches', async () => {
    pluginHost.install(lazy(), []);
    FakeWorker.last = null;

    const run = getCommandRegistry().get('plugin.com.lazy.a.go' as never)!.execute({} as never);
    // The worker exists as soon as the command is invoked…
    const w = spawnedWorker();
    expect(pluginHost.info('com.lazy.a').status).toBe('starting');

    // …but the dispatch waits for activate() to resolve. Sending `invoke` into
    // a worker that has not run its activate() yet would arrive before the
    // plugin registered its handler, and be dropped in silence.
    expect(w.sent.find((m) => m.k === 'invoke')).toBeUndefined();

    w.emit({ k: 'ready' });
    w.emit({ k: 'activated' });
    await run;

    expect(pluginHost.info('com.lazy.a').status).toBe('running');
    expect(w.sent.at(-1)).toMatchObject({ k: 'invoke', commandId: 'go' });
  });

  it('opening a declared panel starts the plugin', async () => {
    pluginHost.install(lazy(), []);
    FakeWorker.last = null;

    const opening = pluginHost.showPanel('com.lazy.a', 'main');
    // Shown FIRST: the dock opening IS the pending state. Waiting out an
    // 8-second boot before anything moved would read as a dead click.
    expect(panelCalls).toContainEqual({ op: 'show', id: 'com.lazy.a', panelId: 'main' });

    const w = spawnedWorker();
    w.emit({ k: 'ready' });
    w.emit({ k: 'activated' });
    await opening;
    expect(pluginHost.info('com.lazy.a').status).toBe('running');
  });

  it('a boot failure during lazy activation surfaces exactly as an eager one', async () => {
    pluginHost.install(lazy(), []);
    FakeWorker.last = null;

    const run = getCommandRegistry().get('plugin.com.lazy.a.go' as never)!.execute({} as never);
    spawnedWorker().emit({ k: 'fatal', error: 'it exploded' });
    await run;

    const info = pluginHost.info('com.lazy.a');
    expect(info.status).toBe('error');
    expect(info.error).toContain('it exploded');
  });

  it('several invocations during one boot all dispatch, and spawn one worker', async () => {
    pluginHost.install(lazy(), []);
    FakeWorker.last = null;
    const cmd = getCommandRegistry().get('plugin.com.lazy.a.go' as never)!;

    const first = cmd.execute({} as never);
    const w = spawnedWorker();
    const second = cmd.execute({} as never);
    // The second invocation must not start a SECOND sandbox for one plugin.
    expect(FakeWorker.last).toBe(w);

    w.emit({ k: 'ready' });
    w.emit({ k: 'activated' });
    await Promise.all([first, second]);
    expect(w.sent.filter((m) => m.k === 'invoke')).toHaveLength(2);
  });

  it('keeps commands when it stops, and removes them when disabled', () => {
    pluginHost.install(lazy(), []);
    const id = 'plugin.com.lazy.a.go';

    // Stopping is not going away: the command is how it comes back.
    pluginHost.stop('com.lazy.a');
    expect(getCommandRegistry().get(id as never)).toBeDefined();

    // Disabling IS the user saying "off", and off has to mean something visible.
    pluginHost.setEnabled('com.lazy.a', false);
    expect(getCommandRegistry().get(id as never)).toBeUndefined();
    expect(pluginHost.info('com.lazy.a').status).toBe('stopped');
  });

  it('an onStartup plugin with no worker is NOT reported as inactive', () => {
    // The distinction the manager depends on. An `onStartup` plugin that is not
    // running is one that said it wanted to run and did not — telling that user
    // "Inactive (starts when used)" would report a failure as normal.
    bootPlugin(pkg([], 'com.eager.a'));
    pluginHost.stop('com.eager.a');
    expect(pluginHost.info('com.eager.a').status).toBe('stopped');
  });
});

describe('API 1 compatibility', () => {
  it('still activates eagerly, with no contributes block at all', () => {
    pluginHost.install(pkg([], 'com.old.a'), []);
    // Installed and immediately spawned, exactly as before this phase.
    expect(FakeWorker.last).not.toBeNull();
  });

  it('still registers commands at runtime, and they still invoke', async () => {
    const w = bootPlugin(pkg([], 'com.old.b'));
    w.callAndWait('commands.register', { id: 'apply', label: 'Apply' });
    const cmd = getCommandRegistry().get('plugin.com.old.b.apply' as never);
    expect(cmd).toBeDefined();
    await cmd!.execute({} as never);
    expect(w.sent.at(-1)).toMatchObject({ k: 'invoke', commandId: 'apply' });
  });

  it('does not nudge an API 1 plugin for registering at runtime', () => {
    const w = bootPlugin(pkg([], 'com.old.c'));
    w.callAndWait('commands.register', { id: 'apply', label: 'Apply' });
    // Runtime registration is the ONLY route at API 1. Nudging an author who
    // has no alternative is noise in the one place they look when debugging.
    expect(pluginHost.log('com.old.c').some((l) => l.text.includes('contributes.commands'))).toBe(false);
  });

  it('warns an API 2 plugin that registers a command it did not declare', () => {
    const w = bootPlugin(pkg([], 'com.new.a', {
      apiVersion: 2,
      contributes: { commands: [{ id: 'declared', label: 'Declared' }] },
      activationEvents: ['onStartup'],
    }));
    const r = w.callAndWait('commands.register', { id: 'undeclared', label: 'Undeclared' });
    // Accepted — the goal is migration, not breakage…
    expect(r.ok).toBe(true);
    expect(getCommandRegistry().get('plugin.com.new.a.undeclared' as never)).toBeDefined();
    // …and logged, because otherwise the author never finds out.
    expect(pluginHost.log('com.new.a').some((l) => l.text.includes('undeclared'))).toBe(true);
  });

  it('counts a declared command once when the plugin also registers it', () => {
    const w = bootPlugin(pkg([], 'com.new.b', {
      apiVersion: 2,
      contributes: { commands: [{ id: 'go', label: 'Go' }] },
      activationEvents: ['onStartup'],
    }));
    w.callAndWait('commands.register', { id: 'go', label: 'Go' });
    // The migration state — declared AND registered — must not produce two
    // palette entries for one command.
    expect(getCommandRegistry().get('plugin.com.new.b.go' as never)).toBeDefined();
    expect(pluginHost.info('com.new.b').commands.filter((c) => c.id === 'go')).toHaveLength(1);
  });
});

describe('multiple panels', () => {
  const twoPanels = (): PluginPackage =>
    pkg([], 'com.two.p', {
      apiVersion: 2,
      contributes: {
        panels: [
          { id: 'main', title: 'Main', entry: 'panel.html' },
          { id: 'inspector', title: 'Inspector', entry: 'inspector.html' },
        ],
      },
      activationEvents: ['onStartup'],
    });

  it('gives every declared panel its own open command', () => {
    bootPlugin(twoPanels());
    expect(getCommandRegistry().get('plugin.com.two.p.panel.main' as never)).toBeDefined();
    expect(getCommandRegistry().get('plugin.com.two.p.panel.inspector' as never)).toBeDefined();
  });

  it('refuses openPanel with no id when the plugin declares more than one', () => {
    const w = bootPlugin(twoPanels());
    const r = w.callAndWait('ui.openPanel');
    // Guessing would open the wrong panel silently. The error names the choices.
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('inspector');
  });

  it('opens the named panel', () => {
    const w = bootPlugin(twoPanels());
    const r = w.callAndWait('ui.openPanel', 'inspector');
    expect(r.ok).toBe(true);
    expect(panelCalls).toContainEqual({ op: 'show', id: 'com.two.p', panelId: 'inspector' });
  });

  it('refuses a panel id the manifest does not declare', () => {
    const w = bootPlugin(twoPanels());
    const r = w.callAndWait('ui.openPanel', 'nope');
    expect(r.ok).toBe(false);
    expect(panelCalls.some((c) => c.panelId === 'nope')).toBe(false);
  });

  it('routes a message to only the panel it names', () => {
    const w = bootPlugin(twoPanels());
    const seen: Array<{ panelId: string; data: unknown }> = [];
    pluginHost.attachPanel('com.two.p', 'main', (data) => seen.push({ panelId: 'main', data }));
    pluginHost.attachPanel('com.two.p', 'inspector', (data) => seen.push({ panelId: 'inspector', data }));

    w.emit({ k: 'toPanel', panelId: 'inspector', data: 'hello' });
    expect(seen).toEqual([{ panelId: 'inspector', data: 'hello' }]);
  });

  it('takes every panel down when the plugin stops', () => {
    bootPlugin(twoPanels());
    panelCalls.length = 0;
    pluginHost.setEnabled('com.two.p', false);
    // A frame left on screen after its worker is gone still accepts clicks and
    // answers nothing — it reads as the editor being broken.
    expect(panelCalls).toContainEqual({ op: 'hide', id: 'com.two.p', panelId: 'main' });
    expect(panelCalls).toContainEqual({ op: 'hide', id: 'com.two.p', panelId: 'inspector' });
  });

  it('lets a single-panel plugin keep omitting the id', () => {
    const w = bootPlugin(pkg([], 'com.one.p', { panel: 'panel.html' }));
    expect(w.callAndWait('ui.openPanel').ok).toBe(true);
    expect(panelCalls).toContainEqual({ op: 'show', id: 'com.one.p', panelId: 'main' });
  });
});
