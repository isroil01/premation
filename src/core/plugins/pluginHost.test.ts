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
import type { HostMessage, WorkerMessage } from './protocol';
import type { PluginPackage } from './pluginPackage';
import type { PluginPermission } from './manifest';

/** A worker that records what the host sent and lets a test talk back. */
class FakeWorker {
  static last: FakeWorker | null = null;
  readonly sent: HostMessage[] = [];
  onmessage: ((ev: MessageEvent<WorkerMessage>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminated = false;

  constructor() { FakeWorker.last = this; }

  postMessage(msg: HostMessage): void { this.sent.push(msg); }
  terminate(): void { this.terminated = true; }

  /** Simulate the plugin sending something to the host. */
  emit(msg: WorkerMessage): void {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerMessage>);
  }

  /** Reply to the last `call` and return the host's answer. */
  callAndWait(method: string, ...args: unknown[]): Extract<HostMessage, { k: 'result' }> {
    const id = Math.floor(Math.random() * 1e6);
    this.emit({ k: 'call', id, method, args });
    const reply = [...this.sent].reverse().find((m) => m.k === 'result' && m.id === id);
    if (!reply) throw new Error(`host never answered ${method}`);
    return reply as Extract<HostMessage, { k: 'result' }>;
  }
}

function pkg(permissions: PluginPermission[], id = 'com.test.plugin'): PluginPackage {
  return {
    manifest: {
      id,
      name: 'Test Plugin',
      version: '1.0.0',
      description: 'A plugin used by the host tests.',
      apiVersion: 1,
      main: 'main.js',
      permissions,
    },
    files: { 'main.js': 'export function activate() {}', 'plugin.json': '{}' },
  };
}

/** Install, boot to `running`, and hand back the fake worker driving it. */
function boot(p: PluginPackage): FakeWorker {
  expect(pluginHost.install(p, p.manifest.permissions)).toBeNull();
  const w = FakeWorker.last!;
  w.emit({ k: 'ready' });
  w.emit({ k: 'activated' });
  return w;
}

beforeAll(() => {
  seedDefaultScene();
  pluginHost.setWorkerFactory(() => new FakeWorker() as unknown as Worker);
  pluginHost.configure({ getSelection: () => useSelectionStore.getState().ids });
});

afterAll(() => { pluginHost.setWorkerFactory(null); });

beforeEach(() => {
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  FakeWorker.last = null;
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

  it('invoking the command sends it to the plugin with the live selection', () => {
    const w = boot(pkg([], 'com.vendor.a'));
    w.callAndWait('commands.register', { id: 'apply', label: 'Apply' });
    insertPrimitive('shape', 'Selected');
    const id = useSelectionStore.getState().ids[0]!;

    void getCommandRegistry().get('plugin.com.vendor.a.apply' as never)!.execute({} as never);
    expect(w.sent.at(-1)).toEqual({ k: 'invoke', commandId: 'apply', selection: [id] });
  });

  it('unregisters the plugin s commands when it stops', () => {
    const w = boot(pkg([], 'com.vendor.a'));
    w.callAndWait('commands.register', { id: 'apply', label: 'Apply' });
    pluginHost.uninstall('com.vendor.a');
    expect(getCommandRegistry().get('plugin.com.vendor.a.apply' as never)).toBeUndefined();
  });
});
