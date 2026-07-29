/**
 * PluginHost — installs, runs, supervises and uninstalls third-party plugins.
 *
 * The single design rule, and the reason this file was rewritten:
 *
 *   > **Plugin code never runs in the host realm.**
 *
 * It runs in a dedicated Worker (`pluginWorker.ts`) with no DOM, no
 * `localStorage` — which is where this app keeps the account bearer token and
 * the user's plaintext AI provider keys — and no network. It reaches the
 * document only by sending a message naming a method, and this file decides,
 * per message, whether the permission that method requires was granted by the
 * user at install time.
 *
 * What that buys, concretely:
 *
 *   | Failure | Before (host realm + `new Function`) | Now |
 *   |---|---|---|
 *   | Plugin loops forever | Editor frozen, needs a kill | Worker terminated, editor untouched |
 *   | Plugin reads the JWT | `localStorage.getItem(…)` | No `localStorage` in the realm |
 *   | Plugin phones home | `fetch(…)` | `fetch` replaced with a throwing stub |
 *   | Plugin deletes the project | Direct `defaultSceneGraph` handle | Needs `scene:write`, and it is one undo |
 *   | User reloads | Everything uninstalled | Installs persist |
 *
 * The `postMessage` origin-gating for plugin PANELS (`registerFrame` below) is
 * kept from the previous host — it was the one part of it that was right.
 */

import { getCommandRegistry, type Command } from '@core/commands/Command';
import { asCommandId, type CommandId } from '@app-types/common';
import { useUIStore } from '@stores/uiStore';
import { usePluginStore, type InstalledPlugin } from '@stores/pluginStore';
import { createHostApi } from './hostApi';
import { spawnPluginWorker } from './spawnPluginWorker';
import {
  METHOD_PERMISSIONS,
  type HostMessage,
  type WorkerMessage,
  type PluginCommandSpec,
  type PluginLogLevel,
} from './protocol';
import type { PluginPackage } from './pluginPackage';
import type { PluginPermission } from './manifest';

export type PluginStatus = 'stopped' | 'starting' | 'running' | 'error';

/** One line of a plugin's own output, kept for the manager's log view. */
export interface PluginLogLine {
  level: PluginLogLevel;
  text: string;
  /** ms since the plugin started, so a reader can see what followed what. */
  at: number;
}

/**
 * How much of a plugin's output to keep.
 *
 * Bounded on purpose: a plugin logging in a loop must not be able to grow the
 * host's memory without limit — the sandbox exists to stop a plugin taking the
 * editor down, and an unbounded array would be a way around it.
 */
const MAX_LOG_LINES = 200;

export interface PluginRuntimeInfo {
  status: PluginStatus;
  /** Present when `status === 'error'`; shown verbatim in the manager. */
  error?: string;
  /** Commands this plugin currently contributes. */
  commands: PluginCommandSpec[];
  panelOpen: boolean;
}

/** How long a plugin gets to boot and activate before we call it hung. */
const ACTIVATE_TIMEOUT_MS = 8000;
/** Heartbeat cadence, and how many missed beats end the plugin. */
const PING_INTERVAL_MS = 4000;
const MAX_MISSED_PINGS = 2;

type WorkerFactory = () => Worker;

interface Runtime {
  worker: Worker;
  info: PluginRuntimeInfo;
  pingTimer: ReturnType<typeof setInterval> | null;
  bootTimer: ReturnType<typeof setTimeout> | null;
  missedPings: number;
  pingSeq: number;
  commandIds: CommandId[];
  /** Set by the panel host component while a panel iframe is mounted. */
  postToPanel?: (data: unknown) => void;
}

class PluginHost {
  private readonly runtimes = new Map<string, Runtime>();
  private listeners: Array<() => void> = [];
  private selectionProvider: () => ReadonlyArray<string> = () => [];
  /** Show / hide a plugin's panel in the dock. Injected — this file must not
   *  import React, and the host is booted in tests where there is no dock. */
  private showPanelHook: ((pluginId: string) => void) | null = null;
  private hidePanelHook: ((pluginId: string) => void) | null = null;
  /** Plugin frames allowed on the postMessage bridge → their expected origin. */
  private readonly frames = new Map<MessageEventSource, string>();
  private workerFactory: WorkerFactory | null = null;

  constructor() {
    this.setupPostMessageBridge();
  }

  /**
   * Wire app services (called once at boot), then start what the user had
   * enabled — the step that makes an install survive a reload.
   *
   * Notifications are NOT injected here: a plugin's message must carry the
   * plugin's name, and the host's own errors need a level, neither of which a
   * bare `notify(string)` can express. Both go through the UI store directly.
   */
  configure(opts: {
    getSelection: () => ReadonlyArray<string>;
    /** Reveal `pluginId`'s panel in the dock. Absent in tests and pop-outs. */
    showPanel?: (pluginId: string) => void;
    /** Hide it again — also called when a plugin stops, so a panel cannot
     *  outlive the worker that was answering it. */
    hidePanel?: (pluginId: string) => void;
  }): void {
    this.selectionProvider = opts.getSelection;
    this.showPanelHook = opts.showPanel ?? null;
    this.hidePanelHook = opts.hidePanel ?? null;
    this.startEnabled();
  }

  /**
   * Override how workers are created.
   *
   * Exists for tests: a jsdom environment has no module-worker loader, and a
   * host that could not be exercised without a real browser would be a host
   * whose permission gate is never tested.
   */
  setWorkerFactory(factory: WorkerFactory | null): void {
    this.workerFactory = factory;
  }

  private createWorker(): Worker {
    if (this.workerFactory) return this.workerFactory();
    return spawnPluginWorker();
  }

  // ── Install / uninstall ────────────────────────────────────────────────

  /**
   * Install (or update) a validated package with the permissions the user just
   * approved. Returns an error string, or null on success.
   *
   * `granted` is intersected with what the manifest asks for, so a UI bug can
   * only ever grant LESS than was disclosed, never more.
   */
  install(
    pkg: PluginPackage,
    granted: readonly PluginPermission[],
    origin: { source?: 'folder' | 'file' | 'registry'; publisherKey?: string } = {},
  ): string | null {
    const id = pkg.manifest.id;
    const existing = usePluginStore.getState().get(id);
    if (existing) this.stop(id);

    const entry: InstalledPlugin = {
      manifest: pkg.manifest,
      files: pkg.files,
      granted: pkg.manifest.permissions.filter((p) => granted.includes(p)),
      enabled: true,
      installedAt: existing?.installedAt ?? Date.now(),
      updatedAt: Date.now(),
      ...(origin.source ? { source: origin.source } : existing?.source ? { source: existing.source } : {}),
      // Carried forward on update: the pin belongs to the plugin, not to one
      // download of it, and losing it on reinstall would silently downgrade
      // every later update to unverified.
      ...(origin.publisherKey
        ? { publisherKey: origin.publisherKey }
        : existing?.publisherKey
          ? { publisherKey: existing.publisherKey }
          : {}),
    };
    this.logs.delete(id);
    if (!usePluginStore.getState().put(entry)) {
      return 'Could not save the plugin — the browser storage quota is full.';
    }
    this.emit();
    this.start(entry);
    return null;
  }

  uninstall(id: string): void {
    this.stop(id);
    usePluginStore.getState().remove(id);
    this.logs.delete(id);
    this.errors.delete(id);
    this.emit();
  }

  /**
   * Change what a plugin is allowed to do, after it was installed.
   *
   * Consent at install time is a single yes/no over the whole list, which is
   * the wrong granularity for the one question users actually ask later —
   * "why does this thing need my keyframes?". `granted` is intersected with the
   * manifest, so this can only ever narrow what was disclosed; and it restarts
   * the plugin, because a live worker was booted with the old set and told what
   * it had.
   */
  setGranted(id: string, permissions: readonly PluginPermission[]): void {
    const entry = usePluginStore.getState().get(id);
    if (!entry) return;
    const next = entry.manifest.permissions.filter((p) => permissions.includes(p));
    usePluginStore.getState().setGranted(id, next);
    this.appendLog(id, 'warn', `permissions changed to: ${next.join(', ') || 'none'}`);
    if (entry.enabled) this.restart(id);
    this.emit();
  }

  setEnabled(id: string, enabled: boolean): void {
    usePluginStore.getState().setEnabled(id, enabled);
    if (enabled) {
      const entry = usePluginStore.getState().get(id);
      if (entry) this.start(entry);
    } else {
      this.stop(id);
    }
    this.emit();
  }

  /** Restart a plugin — the fix for "it stopped responding" without a reload. */
  restart(id: string): void {
    const entry = usePluginStore.getState().get(id);
    if (!entry) return;
    this.stop(id);
    if (entry.enabled) this.start(entry);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  private startEnabled(): void {
    for (const entry of usePluginStore.getState().plugins) {
      if (entry.enabled) this.start(entry);
    }
  }

  private start(entry: InstalledPlugin): void {
    const id = entry.manifest.id;
    if (this.runtimes.has(id)) return;

    let worker: Worker;
    try {
      worker = this.createWorker();
    } catch (err) {
      this.setError(id, `Could not start the sandbox: ${(err as Error).message}`);
      return;
    }

    this.logStartedAt.set(id, Date.now());
    const rt: Runtime = {
      worker,
      info: { status: 'starting', commands: [], panelOpen: false },
      pingTimer: null,
      bootTimer: null,
      missedPings: 0,
      pingSeq: 0,
      commandIds: [],
    };
    this.runtimes.set(id, rt);

    const api = createHostApi(entry.manifest, {
      registerCommand: (spec) => this.registerPluginCommand(entry, spec),
      openPanel: () => this.setPanelOpen(id, true),
      closePanel: () => this.setPanelOpen(id, false),
    });

    worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
      this.handleWorkerMessage(entry, rt, api, ev.data);
    };
    worker.onerror = (ev) => {
      // `ev.message` is empty for a cross-origin script error; the plugin's own
      // module is same-origin (a blob), so this is normally informative.
      this.setError(id, ev.message || 'The plugin crashed while loading.');
    };

    const code = entry.files[entry.manifest.main.replace(/^\.\//, '')];
    if (code === undefined) {
      this.setError(id, `The entry module "${entry.manifest.main}" is missing from the package.`);
      return;
    }

    const boot: HostMessage = {
      k: 'boot',
      manifest: entry.manifest,
      code,
      permissions: [...entry.granted],
    };
    worker.postMessage(boot);

    rt.bootTimer = setTimeout(() => {
      if (this.runtimes.get(id)?.info.status === 'starting') {
        this.setError(id, 'The plugin did not finish loading within 8 seconds and was stopped.');
      }
    }, ACTIVATE_TIMEOUT_MS);
  }

  stop(id: string): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    // Take the panel down with the worker. A frame left on screen after its
    // plugin is disabled, uninstalled or killed still accepts clicks and
    // answers nothing — it reads as the editor being broken.
    this.hidePanelHook?.(id);
    if (rt.pingTimer) clearInterval(rt.pingTimer);
    if (rt.bootTimer) clearTimeout(rt.bootTimer);
    for (const cid of rt.commandIds) getCommandRegistry().unregister(cid);
    try { rt.worker.terminate(); } catch { /* already gone */ }
    this.runtimes.delete(id);
    this.emit();
  }

  /** Terminate everything — used on sign-out / project close. */
  stopAll(): void {
    for (const id of [...this.runtimes.keys()]) this.stop(id);
  }

  private setError(id: string, error: string): void {
    const rt = this.runtimes.get(id);
    const entry = usePluginStore.getState().get(id);
    this.stop(id);
    // Keep the error visible after the runtime is gone: "it just isn't running"
    // with no reason is the report we are trying to make impossible.
    this.errors.set(id, error);
    this.appendLog(id, 'error', error);
    if (rt || entry) {
      useUIStore.getState().notify({
        level: 'error',
        message: `${entry?.manifest.name ?? id}: ${error}`,
        durationMs: 8000,
      });
    }
    this.emit();
  }

  private readonly errors = new Map<string, string>();

  // ── Worker messages ────────────────────────────────────────────────────

  private handleWorkerMessage(
    entry: InstalledPlugin,
    rt: Runtime,
    api: Record<string, (...args: unknown[]) => unknown>,
    msg: WorkerMessage,
  ): void {
    const id = entry.manifest.id;
    switch (msg.k) {
      case 'ready':
        break;

      case 'activated': {
        if (rt.bootTimer) { clearTimeout(rt.bootTimer); rt.bootTimer = null; }
        this.errors.delete(id);
        rt.info = { ...rt.info, status: 'running', error: undefined };
        rt.pingTimer = setInterval(() => this.beat(id), PING_INTERVAL_MS);
        // A plugin with a panel gets one command for free, so its UI is
        // reachable from the palette and the Plugins menu without the user
        // going through the manager. Registered on activation, not on install:
        // a panel whose plugin is not running has nothing to talk to.
        if (entry.manifest.panel) this.registerPanelCommand(entry, rt);
        this.emit();
        break;
      }

      case 'pong':
        rt.missedPings = 0;
        break;

      case 'fatal':
        this.setError(id, msg.error);
        break;

      case 'toPanel':
        rt.postToPanel?.(msg.data);
        break;

      case 'log':
        this.appendLog(id, msg.level, msg.text);
        break;

      case 'call': {
        const required = METHOD_PERMISSIONS[msg.method];
        const reply = (m: HostMessage): void => { try { rt.worker.postMessage(m); } catch { /* terminated */ } };

        if (required === undefined) {
          reply({ k: 'result', id: msg.id, ok: false, error: `Unknown API method "${msg.method}".` });
          return;
        }
        if (required !== null && !entry.granted.includes(required)) {
          // Refused, loudly. A plugin silently doing nothing because a
          // permission is missing is indistinguishable from a broken plugin.
          // Also logged: the plugin may swallow the rejection, and then the
          // refusal is invisible to everyone including its author.
          this.appendLog(id, 'warn', `${msg.method} refused — permission "${required}" not granted`);
          reply({
            k: 'result',
            id: msg.id,
            ok: false,
            error: `Permission "${required}" was not granted to this plugin.`,
          });
          return;
        }
        try {
          const value = api[msg.method]!(...(Array.isArray(msg.args) ? msg.args : []));
          reply({ k: 'result', id: msg.id, ok: true, value: value === undefined ? null : value });
        } catch (err) {
          reply({ k: 'result', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
    }
  }

  /** One heartbeat. Two missed in a row means the plugin's event loop is wedged. */
  private beat(id: string): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    if (rt.missedPings >= MAX_MISSED_PINGS) {
      this.setError(id, 'The plugin stopped responding and was terminated. Restart it to try again.');
      return;
    }
    rt.missedPings += 1;
    rt.pingSeq += 1;
    try { rt.worker.postMessage({ k: 'ping', id: rt.pingSeq } satisfies HostMessage); } catch { /* terminated */ }
  }

  // ── Commands ───────────────────────────────────────────────────────────

  private registerPluginCommand(entry: InstalledPlugin, spec: PluginCommandSpec): void {
    const pid = entry.manifest.id;
    const rt = this.runtimes.get(pid);
    if (!rt) return;
    // Namespaced with the plugin id: two vendors may both ship "apply", and the
    // command registry is a flat id space.
    const cid = asCommandId(`plugin.${pid}.${spec.id}`);
    const cmd: Command = {
      id: cid,
      label: `${entry.manifest.name}: ${spec.label}`,
      icon: spec.icon ?? 'plugin',
      enabled: () => (spec.needsSelection ? this.selectionProvider().length > 0 : true),
      execute: () => {
        const live = this.runtimes.get(pid);
        if (!live) {
          useUIStore.getState().notify({
            level: 'warning',
            message: `${entry.manifest.name} is not running.`,
            durationMs: 4000,
          });
          return;
        }
        live.worker.postMessage({
          k: 'invoke',
          commandId: spec.id,
          selection: [...this.selectionProvider()],
        } satisfies HostMessage);
      },
    };
    getCommandRegistry().register(cmd);
    rt.commandIds.push(cid);
    rt.info = { ...rt.info, commands: [...rt.info.commands, spec] };
    this.emit();
  }

  /**
   * The implicit "open my panel" command.
   *
   * Kept OUT of `info.commands`: that list is what the plugin itself
   * contributed, and the manager counts it ("3 commands"). Counting a command
   * the host invented would misreport the plugin.
   */
  private registerPanelCommand(entry: InstalledPlugin, rt: Runtime): void {
    const pid = entry.manifest.id;
    const cid = asCommandId(`plugin.${pid}.panel`);
    getCommandRegistry().register({
      id: cid,
      label: `${entry.manifest.name}: Open Panel`,
      icon: 'plugin',
      enabled: () => this.isRunning(pid),
      execute: () => this.showPanel(pid),
    });
    rt.commandIds.push(cid);
  }

  // ── Panels ─────────────────────────────────────────────────────────────

  /**
   * Show or hide a plugin's panel.
   *
   * This used to flip a flag nobody read, which made the documented
   * `motion.ui.openPanel()` a no-op: a plugin could not put its own interface
   * on screen, and the user had to find it in the manager. The flag is still
   * kept — the manager reads it — but the hook is what actually opens the dock.
   */
  private setPanelOpen(id: string, open: boolean): void {
    if (open) this.showPanelHook?.(id);
    else this.hidePanelHook?.(id);
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.info = { ...rt.info, panelOpen: open };
    this.emit();
  }

  /** Public entry for the manager's "Open" button and the Plugins menu. */
  showPanel(id: string): void {
    this.setPanelOpen(id, true);
  }

  /** Called by the panel component while its iframe is mounted. */
  attachPanel(id: string, postToPanel: (data: unknown) => void): () => void {
    const rt = this.runtimes.get(id);
    if (!rt) return () => {};
    rt.postToPanel = postToPanel;
    return () => { if (rt.postToPanel === postToPanel) rt.postToPanel = undefined; };
  }

  /** Deliver a message from a plugin's panel to that plugin's worker. */
  deliverPanelMessage(id: string, data: unknown): void {
    const rt = this.runtimes.get(id);
    rt?.worker.postMessage({ k: 'panelMessage', data } satisfies HostMessage);
  }

  // ── Logs ───────────────────────────────────────────────────────────────

  /** Kept OUTSIDE the runtime map: the most interesting log is the one from a
   *  plugin that has just died, and its runtime is gone by the time anyone
   *  looks. Cleared on uninstall, not on stop. */
  private readonly logs = new Map<string, PluginLogLine[]>();
  private readonly logStartedAt = new Map<string, number>();

  private appendLog(id: string, level: PluginLogLevel, text: string): void {
    const lines = this.logs.get(id) ?? [];
    const started = this.logStartedAt.get(id) ?? Date.now();
    lines.push({ level, text, at: Date.now() - started });
    if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
    this.logs.set(id, lines);
    this.emit();
  }

  log(id: string): readonly PluginLogLine[] {
    return this.logs.get(id) ?? [];
  }

  clearLog(id: string): void {
    this.logs.delete(id);
    this.emit();
  }

  // ── Reads for the UI ───────────────────────────────────────────────────

  info(id: string): PluginRuntimeInfo {
    const rt = this.runtimes.get(id);
    if (rt) return rt.info;
    const error = this.errors.get(id);
    return { status: error ? 'error' : 'stopped', error, commands: [], panelOpen: false };
  }

  isRunning(id: string): boolean {
    return this.runtimes.get(id)?.info.status === 'running';
  }

  subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((f) => f !== fn); };
  }

  /** Bumped on every runtime change so `useSyncExternalStore` can key off it. */
  private revision = 0;
  getRevision(): number { return this.revision; }

  private emit(): void {
    this.revision += 1;
    for (const fn of this.listeners) fn();
  }

  // ── Panel postMessage bridge (kept from the previous host) ─────────────

  /**
   * Register a plugin frame as allowed to drive the postMessage bridge.
   *
   * Whoever creates a plugin iframe calls this with the window it created and
   * the origin it was loaded from. Nothing else can talk to the bridge.
   */
  registerFrame(source: MessageEventSource, origin: string): () => void {
    this.frames.set(source, origin);
    return () => { this.frames.delete(source); };
  }

  /**
   * Messages from plugin panels.
   *
   * `window.addEventListener('message')` fires for anything that can reach this
   * window — an embedder, an opener, an injected frame — so the sender must be
   * a frame WE created, still registered, and still on the origin it was
   * registered with (a navigated frame is a different app). Panel frames are
   * sandboxed without `allow-same-origin`, so their origin is the opaque
   * `"null"`, and that is what they are registered with.
   */
  private setupPostMessageBridge(): () => void {
    if (typeof window === 'undefined') return () => {};
    const listener = (event: MessageEvent) => {
      const expected = event.source ? this.frames.get(event.source) : undefined;
      if (expected === undefined || event.origin !== expected) return;

      const data = event.data;
      if (!data || typeof data !== 'object') return;
      // The panel shell also reports its own lifecycle (`__panelReady`). Those
      // are ours, not the panel's — forwarding one would wake the plugin's
      // `onPanelMessage` handler with `undefined`.
      if (!('data' in data)) return;
      // A panel talks to its OWN plugin's worker and nothing else. It cannot
      // name a method, a node or a plugin — routing is by which frame sent it.
      const pluginId = this.panelOwners.get(event.source!);
      if (!pluginId) return;
      this.deliverPanelMessage(pluginId, (data as { data?: unknown }).data);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }

  private readonly panelOwners = new Map<MessageEventSource, string>();

  /** Bind a registered frame to the plugin that owns it. */
  claimFrame(source: MessageEventSource, pluginId: string): () => void {
    this.panelOwners.set(source, pluginId);
    return () => { this.panelOwners.delete(source); };
  }
}

export const pluginHost = new PluginHost();
export default pluginHost;
