/**
 * A stand-in for the plugin sandbox, for tests.
 *
 * jsdom has no module-worker loader, so a host that could only be exercised
 * with a real Worker would be a host whose permission gate is never tested.
 * This is also the more honest instrument: a hostile plugin sends whatever it
 * likes, and a fake worker can send exactly that, which a well-behaved real
 * worker never would.
 *
 * Not a `.test.ts` file — jest's testMatch only picks up `*.test.*`, so this
 * ships as a helper rather than an empty suite. It lives here because three
 * suites (host, menu, manager UI) all need it, and three copies of a fake that
 * has to track the wire protocol is three chances to drift.
 */

import pluginHost from './PluginHost';
import type { HostMessage, WorkerMessage } from './protocol';
import type { PluginPackage } from './pluginPackage';
import type { PluginPermission } from './manifest';

export class FakeWorker {
  /** The most recently constructed worker — i.e. the one just started. */
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

/** Route the host's sandbox construction to `FakeWorker`. Undo with `restore`. */
export function useFakeWorkers(): { restore: () => void } {
  pluginHost.setWorkerFactory(() => new FakeWorker() as unknown as Worker);
  return { restore: () => pluginHost.setWorkerFactory(null) };
}

/** A minimal valid package. */
export function testPackage(
  permissions: PluginPermission[],
  id = 'com.test.plugin',
  extra: { panel?: string; name?: string } = {},
): PluginPackage {
  return {
    manifest: {
      id,
      name: extra.name ?? 'Test Plugin',
      version: '1.0.0',
      description: 'A plugin used by the tests.',
      apiVersion: 1,
      main: 'main.js',
      ...(extra.panel ? { panel: extra.panel } : {}),
      permissions,
    },
    files: {
      'main.js': 'export function activate() {}',
      'plugin.json': '{}',
      ...(extra.panel ? { [extra.panel]: '<p>panel</p>' } : {}),
    },
  };
}

/** Install, boot to `running`, and hand back the fake worker driving it. */
export function bootPlugin(
  pkg: PluginPackage,
  opts: { granted?: readonly PluginPermission[]; source?: 'folder' | 'file' | 'registry'; publisherKey?: string } = {},
): FakeWorker {
  const err = pluginHost.install(pkg, opts.granted ?? pkg.manifest.permissions, {
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.publisherKey ? { publisherKey: opts.publisherKey } : {}),
  });
  if (err) throw new Error(err);
  const w = FakeWorker.last!;
  w.emit({ k: 'ready' });
  w.emit({ k: 'activated' });
  return w;
}
