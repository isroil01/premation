/**
 * The plugin host's contract: what a plugin may do, what it may not, and what
 * happens when it misbehaves.
 *
 * These run against a FAKE worker rather than a real one — jsdom has no module
 * worker loader — which is the point: the gate being tested lives entirely on
 * the host side. A real worker would only prove that our own worker code plays
 * nicely; a hostile plugin sends whatever it likes, and that is what the fake
 * lets us simulate.
 */

import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { getCommandRegistry } from '@core/commands/Command';
import { useSelectionStore } from '@stores/selectionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { insertPrimitive } from '@core/scene/sceneInsert';
import { FakeWorker, useFakeWorkers, testPackage, bootPlugin } from './fakeWorker.testkit';
import type { PluginPackage } from './pluginPackage';

/** Records the show/hide calls the host makes into the dock. */
const panelCalls: Array<{ op: 'show' | 'hide'; id: string; panelId: string }> = [];

const pkg = testPackage;
const boot = (p: PluginPackage): FakeWorker => bootPlugin(p);

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

describe('install and lifecycle', () => {
  it('installs, persists and starts the plugin', () => {
    const w = boot(pkg([]));
    expect(usePluginStore.getState().get('com.test.plugin')?.enabled).toBe(true);
    expect(pluginHost.info('com.test.plugin').status).toBe('running');
    // The plugin's SOURCE is handed to the sandbox — the host never runs it.
    expect(w.sent[0]).toMatchObject({ k: 'boot', code: 'export function activate() {}' });
  });

  it('grants only what the manifest declared, even if the UI offers more', () => {
    // A UI bug must be able to grant LESS than was disclosed, never more.
    pluginHost.install(pkg(['scene:read']), ['scene:read', 'scene:write', 'animation:write']);
    expect(usePluginStore.getState().get('com.test.plugin')?.granted).toEqual(['scene:read']);
  });

  it('disabling terminates the worker; enabling starts a fresh one', () => {
    const first = boot(pkg([]));
    pluginHost.setEnabled('com.test.plugin', false);
    expect(first.terminated).toBe(true);
    expect(pluginHost.info('com.test.plugin').status).toBe('stopped');

    pluginHost.setEnabled('com.test.plugin', true);
    expect(FakeWorker.last).not.toBe(first);
    expect(FakeWorker.last!.terminated).toBe(false);
  });

  it('uninstalling removes the record and stops the worker', () => {
    const w = boot(pkg([]));
    pluginHost.uninstall('com.test.plugin');
    expect(w.terminated).toBe(true);
    expect(usePluginStore.getState().get('com.test.plugin')).toBeUndefined();
  });

  it('reports a fatal error from the plugin instead of failing silently', () => {
    const w = boot(pkg([]));
    w.emit({ k: 'fatal', error: 'boom' });
    const info = pluginHost.info('com.test.plugin');
    expect(info.status).toBe('error');
    expect(info.error).toBe('boom');
    // …and the error survives the runtime being torn down, so the manager can
    // still say WHY nothing is running.
    expect(w.terminated).toBe(true);
  });

  it('terminates a plugin that stops answering the heartbeat', () => {
    jest.useFakeTimers();
    try {
      const w = boot(pkg([]));
      // Never answers a ping — i.e. its event loop is wedged in a `while(true)`.
      jest.advanceTimersByTime(4000 * 4);
      expect(w.terminated).toBe(true);
      expect(pluginHost.info('com.test.plugin').status).toBe('error');
    } finally {
      jest.useRealTimers();
    }
  });

  it('a restart clears the error and boots a new worker', () => {
    const w = boot(pkg([]));
    w.emit({ k: 'fatal', error: 'boom' });
    pluginHost.restart('com.test.plugin');
    FakeWorker.last!.emit({ k: 'activated' });
    expect(pluginHost.info('com.test.plugin').status).toBe('running');
    expect(pluginHost.info('com.test.plugin').error).toBeUndefined();
  });
});

describe('the permission gate', () => {
  it('refuses a method whose permission was not granted, and says which', () => {
    const w = boot(pkg(['scene:read']));
    const r = w.callAndWait('animation.setKeyframe', 'x', 'y', 0, 1);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('animation:write');
  });

  it('refuses an unknown method rather than probing the host for one', () => {
    const w = boot(pkg(['scene:read', 'scene:write', 'animation:read', 'animation:write', 'timeline']));
    const r = w.callAndWait('scene.__proto__');
    expect(r.ok).toBe(false);
    const r2 = w.callAndWait('constructor');
    expect(r2.ok).toBe(false);
  });

  it('allows a granted method', () => {
    const w = boot(pkg(['scene:read']));
    useSelectionStore.getState().set([]);
    const r = w.callAndWait('scene.getSelection');
    expect(r).toMatchObject({ ok: true, value: [] });
  });

  it('lets a plugin with NO permissions still register commands and notify', () => {
    const w = boot(pkg([]));
    expect(w.callAndWait('ui.notify', 'hello').ok).toBe(true);
    expect(w.callAndWait('commands.register', { id: 'go', label: 'Go' }).ok).toBe(true);
  });

  it('does not let a plugin read the scene without scene:read', () => {
    const w = boot(pkg([]));
    expect(w.callAndWait('scene.getLayers').ok).toBe(false);
  });
});

describe('argument validation at the boundary', () => {
  it('rejects a non-finite keyframe time instead of writing it at zero', () => {
    const w = boot(pkg(['animation:write', 'scene:write']));
    insertPrimitive('shape', 'Target');
    const id = useSelectionStore.getState().ids[0]!;
    const r = w.callAndWait('animation.setKeyframe', id, 'x', 'soon', 5);
    expect(r.ok).toBe(false);
    expect(defaultAnimation.isAnimated(id, 'x')).toBe(false);
  });

  it('rejects an unknown layer id rather than creating one', () => {
    const w = boot(pkg(['scene:read']));
    const r = w.callAndWait('scene.getLayer', 'no-such-layer');
    expect(r.ok).toBe(false);
  });

  it('refuses to delete a composition root', () => {
    const w = boot(pkg(['scene:write']));
    const rootId = defaultSceneGraph.getRoots()[0]!.id;
    const r = w.callAndWait('scene.deleteLayer', rootId);
    expect(r.ok).toBe(false);
    expect(defaultSceneGraph.getNode(rootId)).toBeDefined();
  });

  it('refuses to create a layer kind plugins have no business minting', () => {
    const w = boot(pkg(['scene:write']));
    expect(w.callAndWait('scene.createLayer', { kind: 'camera' }).ok).toBe(false);
    expect(w.callAndWait('scene.createLayer', { kind: 'comp' }).ok).toBe(false);
  });

  it('caps a single bulk keyframe write', () => {
    const w = boot(pkg(['animation:write', 'scene:write']));
    insertPrimitive('shape', 'Target');
    const id = useSelectionStore.getState().ids[0]!;
    const huge = Array.from({ length: 5001 }, (_, i) => ({ t: i * 0.01, value: i }));
    expect(w.callAndWait('animation.setKeyframes', id, 'x', huge).ok).toBe(false);
  });
});

describe('contributed commands', () => {
  it('namespaces a command with the plugin id so two vendors cannot collide', () => {
    const a = boot(pkg([], 'com.vendor.a'));
    a.callAndWait('commands.register', { id: 'apply', label: 'Apply' });
    const b = boot(pkg([], 'com.vendor.b'));
    b.callAndWait('commands.register', { id: 'apply', label: 'Apply' });

    const registry = getCommandRegistry();
    expect(registry.get('plugin.com.vendor.a.apply' as never)).toBeDefined();
    expect(registry.get('plugin.com.vendor.b.apply' as never)).toBeDefined();
  });

  it('invoking the command sends it to the plugin with the live selection', async () => {
    const w = boot(pkg([], 'com.vendor.a'));
    w.callAndWait('commands.register', { id: 'apply', label: 'Apply' });
    insertPrimitive('shape', 'Selected');
    const id = useSelectionStore.getState().ids[0]!;

    // Awaited, because invoking now goes through activation first — a command
    // may be dispatched at a plugin that is not running yet.
    await getCommandRegistry().get('plugin.com.vendor.a.apply' as never)!.execute({} as never);
    expect(w.sent.at(-1)).toEqual({ k: 'invoke', commandId: 'apply', selection: [id] });
  });

  it('unregisters the plugin s commands when it stops', () => {
    const w = boot(pkg([], 'com.vendor.a'));
    w.callAndWait('commands.register', { id: 'apply', label: 'Apply' });
    pluginHost.uninstall('com.vendor.a');
    expect(getCommandRegistry().get('plugin.com.vendor.a.apply' as never)).toBeUndefined();
  });
});

describe('logs', () => {
  it('keeps the plugin s console output for the manager', () => {
    const w = boot(pkg([]));
    w.emit({ k: 'log', level: 'log', text: 'hello from the plugin' });
    expect(pluginHost.log('com.test.plugin').map((l) => l.text)).toContain('hello from the plugin');
  });

  it('records a refused call — the plugin may swallow the rejection', () => {
    const w = boot(pkg(['scene:read']));
    w.callAndWait('animation.setKeyframe', 'x', 'y', 0, 1);
    const lines = pluginHost.log('com.test.plugin');
    expect(lines.some((l) => l.level === 'warn' && l.text.includes('animation:write'))).toBe(true);
  });

  it('keeps the log after the plugin dies — that is when it is read', () => {
    const w = boot(pkg([]));
    w.emit({ k: 'log', level: 'log', text: 'before the crash' });
    w.emit({ k: 'fatal', error: 'boom' });
    const lines = pluginHost.log('com.test.plugin');
    expect(lines.map((l) => l.text)).toEqual(expect.arrayContaining(['before the crash', 'boom']));
  });

  it('bounds the buffer so a logging loop cannot grow the host without limit', () => {
    const w = boot(pkg([]));
    for (let i = 0; i < 500; i += 1) w.emit({ k: 'log', level: 'log', text: `line ${i}` });
    const lines = pluginHost.log('com.test.plugin');
    expect(lines.length).toBeLessThanOrEqual(200);
    // The tail is what matters — a plugin's last words, not its first.
    expect(lines.at(-1)?.text).toBe('line 499');
  });

  it('drops the log when the plugin is uninstalled', () => {
    const w = boot(pkg([]));
    w.emit({ k: 'log', level: 'log', text: 'x' });
    pluginHost.uninstall('com.test.plugin');
    expect(pluginHost.log('com.test.plugin')).toEqual([]);
  });
});

describe('changing permissions after install', () => {
  it('narrows what the plugin may do, and the gate follows immediately', () => {
    const w = boot(pkg(['scene:read', 'animation:write']));
    expect(w.callAndWait('scene.getSelection').ok).toBe(true);

    pluginHost.setGranted('com.test.plugin', ['scene:read']);
    expect(usePluginStore.getState().get('com.test.plugin')?.granted).toEqual(['scene:read']);

    // Restarted with the new set: the fresh worker is the one now gated.
    const fresh = FakeWorker.last!;
    fresh.emit({ k: 'activated' });
    const r = fresh.callAndWait('animation.setKeyframe', 'x', 'y', 0, 1);
    expect(r.ok === false && r.error).toContain('animation:write');
  });

  it('cannot grant something the manifest never asked for', () => {
    boot(pkg(['scene:read']));
    pluginHost.setGranted('com.test.plugin', ['scene:read', 'scene:write', 'timeline']);
    expect(usePluginStore.getState().get('com.test.plugin')?.granted).toEqual(['scene:read']);
  });

  it('the boot message carries the narrowed set, not the manifest s', () => {
    boot(pkg(['scene:read', 'timeline']));
    pluginHost.setGranted('com.test.plugin', ['timeline']);
    const boot0 = FakeWorker.last!.sent.find((m) => m.k === 'boot');
    expect(boot0 && boot0.k === 'boot' && boot0.permissions).toEqual(['timeline']);
  });
});

/**
 * `ui.openPanel` used to flip a flag nobody read, so a plugin could not put its
 * own interface on screen — the one documented API that did nothing. These pin
 * the plumbing that replaced it.
 */
describe('panels', () => {
  it('opens the dock panel when the plugin asks for it', () => {
    const w = boot(pkg([], 'com.test.plugin', { panel: 'panel.html' }));
    expect(w.callAndWait('ui.openPanel').ok).toBe(true);
    expect(panelCalls).toContainEqual({ op: 'show', id: 'com.test.plugin', panelId: 'main' });
  });

  it('refuses openPanel from a plugin whose manifest declares no panel', () => {
    const w = boot(pkg([]));
    const r = w.callAndWait('ui.openPanel');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('panel');
    expect(panelCalls).toHaveLength(0);
  });

  it('closes the panel when the plugin stops, so no frame outlives its worker', () => {
    boot(pkg([], 'com.test.plugin', { panel: 'panel.html' }));
    panelCalls.length = 0;
    pluginHost.setEnabled('com.test.plugin', false);
    expect(panelCalls).toContainEqual({ op: 'hide', id: 'com.test.plugin', panelId: 'main' });
  });

  it('gives each declared panel an Open command, and takes it away again', async () => {
    // The id carries the PANEL id now — a plugin may contribute several, and
    // one `….panel` command could only ever open one of them.
    boot(pkg([], 'com.vendor.p', { panel: 'panel.html' }));
    const cmd = getCommandRegistry().get('plugin.com.vendor.p.panel.main' as never);
    expect(cmd).toBeDefined();

    await cmd!.execute({} as never);
    expect(panelCalls).toContainEqual({ op: 'show', id: 'com.vendor.p', panelId: 'main' });

    pluginHost.uninstall('com.vendor.p');
    expect(getCommandRegistry().get('plugin.com.vendor.p.panel.main' as never)).toBeUndefined();
  });

  it('does not invent a panel command for a plugin without a panel', () => {
    boot(pkg([], 'com.vendor.n'));
    expect(getCommandRegistry().get('plugin.com.vendor.n.panel.main' as never)).toBeUndefined();
  });

  it('counts only the plugin s OWN commands, not the host s panel command', () => {
    const w = boot(pkg([], 'com.vendor.c', { panel: 'panel.html' }));
    w.callAndWait('commands.register', { id: 'apply', label: 'Apply' });
    expect(pluginHost.info('com.vendor.c').commands).toHaveLength(1);
  });
});
