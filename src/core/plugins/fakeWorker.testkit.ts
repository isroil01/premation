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
import { parseManifest, type PluginPermission } from './manifest';

export class FakeWorker {
  /** The most recently constructed worker — i.e. the one just started. */
  static last: FakeWorker | null = null;
  readonly sent: HostMessage[] = [];
  onmessage: ((ev: MessageEvent<WorkerMessage>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminated = false;

  constructor() { FakeWorker.last = this; }

  terminate(): void { this.terminated = true; }

  /** Simulate the plugin sending something to the host. */
  emit(msg: WorkerMessage): void {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerMessage>);
  }

  postMessage(msg: HostMessage, _transfer?: Transferable[]): void { this.sent.push(msg); }

  /**
   * Call a SYNCHRONOUS method and return the host's answer.
   *
   * Throws rather than returning undefined when no reply arrived, because the
   * commonest cause is that the method is actually async — and a test that
   * silently got `undefined` back would assert nothing and pass. Use
   * `callAsync` for those.
   */
  callAndWait(method: string, ...args: unknown[]): Extract<HostMessage, { k: 'result' }> {
    const id = this.nextId();
    this.emit({ k: 'call', id, method, args });
    const reply = this.replyTo(id);
    if (!reply) {
      throw new Error(
        `host never answered ${method} synchronously — if it is async, use callAsync().`,
      );
    }
    return reply;
  }

  /**
   * Call a method that resolves later.
   *
   * The asset methods decode and encode, so they answer on a microtask rather
   * than in the same turn. This polls the sent log across turns instead of
   * awaiting a promise the fake worker never sees.
   */
  async callAsync(method: string, ...args: unknown[]): Promise<Extract<HostMessage, { k: 'result' }>> {
    const id = this.nextId();
    this.emit({ k: 'call', id, method, args });
    for (let i = 0; i < 50; i++) {
      const reply = this.replyTo(id);
      if (reply) return reply;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error(`host never answered ${method}`);
  }

  private nextId(): number { return (FakeWorker.seq += 1); }
  private static seq = 0;

  private replyTo(id: number): Extract<HostMessage, { k: 'result' }> | undefined {
    return [...this.sent].reverse().find((m) => m.k === 'result' && m.id === id) as
      | Extract<HostMessage, { k: 'result' }>
      | undefined;
  }
}

/** Route the host's sandbox construction to `FakeWorker`. Undo with `restore`. */
export function useFakeWorkers(): { restore: () => void } {
  pluginHost.setWorkerFactory(() => new FakeWorker() as unknown as Worker);
  return { restore: () => pluginHost.setWorkerFactory(null) };
}

/**
 * A minimal valid package.
 *
 * The manifest is built by running the REAL `parseManifest`, not by writing a
 * `PluginManifest` literal. Hand-writing one lets a test set up a shape the
 * validator would never produce — a missing `contributes`, an unnormalised
 * legacy `panel` — and then pass against a host that never sees such a thing in
 * production. Anything this helper cannot express is something a plugin cannot
 * declare, which is the property worth having.
 */
export function testPackage(
  permissions: PluginPermission[],
  id = 'com.test.plugin',
  extra: {
    /** Legacy API-1 single panel. Normalised to `contributes.panels[main]`. */
    panel?: string;
    name?: string;
    apiVersion?: number;
    contributes?: unknown;
    activationEvents?: string[];
    /** Capabilities the plugin cannot run without. Refused at install if absent. */
    requires?: string[];
    /** Capabilities it uses when present. Never gates anything. */
    optional?: string[];
  } = {},
): PluginPackage {
  const { manifest, errors } = parseManifest({
    id,
    name: extra.name ?? 'Test Plugin',
    version: '1.0.0',
    description: 'A plugin used by the tests.',
    apiVersion: extra.apiVersion ?? 1,
    main: 'main.js',
    ...(extra.panel ? { panel: extra.panel } : {}),
    ...(extra.contributes !== undefined ? { contributes: extra.contributes } : {}),
    ...(extra.activationEvents ? { activationEvents: extra.activationEvents } : {}),
    ...(extra.requires ? { requires: extra.requires } : {}),
    ...(extra.optional ? { optional: extra.optional } : {}),
    permissions,
  });
  if (!manifest) throw new Error(`testPackage built an invalid manifest: ${errors.join(' ')}`);

  const panelFiles: Record<string, string> = {};
  for (const p of manifest.contributes.panels) panelFiles[p.entry] = `<p>${p.id} panel</p>`;

  return {
    manifest,
    files: {
      'main.js': 'export function activate() {}',
      'plugin.json': '{}',
      ...panelFiles,
    },
    binaries: {},
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
