/**
 * PluginHost — installs, runs, supervises and uninstalls third-party plugins.
 *
 * The single design rule, and the reason this file was rewritten:
 *
 *   > **Plugin code never runs in the host realm.**
 *
 * It runs in a dedicated Worker (`pluginWorker.ts`) with no DOM, no
 * `localStorage` — which is where this app keeps the account bearer token and
 * the user's plaintext AI provider keys — and no network reachable directly:
 * `fetch`, `XMLHttpRequest` and `WebSocket` are all removed at lockdown. It
 * reaches the document only by sending a message naming a method, and this file
 * decides, per message, whether the permission that method requires was granted
 * by the user at install time.
 *
 * Network is not an exception to that, it is an instance of it. A plugin that
 * declared hosts and was granted `net:fetch` reaches them by sending the
 * `net.fetch` message like any other — the request is made HERE, in the host,
 * against the hosts in that plugin's own manifest. There is still no socket in
 * the worker realm.
 *
 * What that buys, concretely:
 *
 *   | Failure | Before (host realm + `new Function`) | Now |
 *   |---|---|---|
 *   | Plugin loops forever | Editor frozen, needs a kill | Worker terminated, editor untouched |
 *   | Plugin reads the JWT | `localStorage.getItem(…)` | No `localStorage` in the realm |
 *   | Plugin phones home | `fetch(…)` anywhere | Only hosts it declared and the user approved |
 *   | Plugin deletes the project | Direct `defaultSceneGraph` handle | Needs `scene:write`, and it is one undo |
 *   | User reloads | Everything uninstalled | Installs persist |
 *
 * The `postMessage` origin-gating for plugin PANELS (`registerFrame` below) is
 * kept from the previous host — it was the one part of it that was right.
 */

import { getCommandRegistry, type Command } from '@core/commands/Command';
import { asCommandId, type CommandId } from '@app-types/common';
import { useUIStore } from '@stores/uiStore';
import { registerLayerKinds, unregisterLayerKinds } from './layerKindRegistry';
import { registerEffects, unregisterEffects } from './pluginEffects';
import { clearLayerChangeListeners, notifyAuthoredChange } from './layerChangeNotifier';
import { revocationFor, refreshRevocations } from './revocation';
import { fetchRevocationList } from './registry';
import { noteManualEdit } from './proxySubtree';
import { setPluginPropWriteHandler } from '@core/scene/pluginPropWrites';
import { readCustomLayer, customLayerComponent } from './customLayers';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { splitKind } from './layerKindSchema';
import { usePluginStore, type InstalledPlugin } from '@stores/pluginStore';
import { createHostApi } from './hostApi';
import { spawnPluginWorker } from './spawnPluginWorker';
import {
  METHOD_PERMISSIONS,
  collectTransferables,
  type HostMessage,
  type WorkerMessage,
  type PluginCommandSpec,
  type PluginLogLevel,
} from './protocol';
import type { PluginPackage } from './pluginPackage';
import { activatesOnStartup, expandPermissions, type PluginPermission } from './manifest';
import { checkCapabilities, hostCapabilities } from './capabilities';
import { forgetGlobalStorage, loadGlobalStorage } from './pluginStorage';
import { releaseAssetBudget } from './assets';

/**
 * Where a plugin is, from the user's point of view.
 *
 * `inactive` is the one that earns its place. Three of these look identical in
 * a naive UI — "not running" — and the user resolves them three different ways:
 *
 *   • `stopped`  — the user turned it off. Turn it back on.
 *   • `inactive` — installed, enabled, contributions known, worker not spawned.
 *     Nothing is wrong. Use it and it starts.
 *   • `error`    — it tried and failed. Read the log.
 *
 * Collapsing `inactive` into `stopped` would make every lazily-activated plugin
 * look broken; collapsing it into `running` would promise a worker that is not
 * there. It is its own state because it is its own situation.
 */
export type PluginStatus = 'stopped' | 'inactive' | 'starting' | 'running' | 'error';

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
  /** Commands this plugin registered AT RUNTIME. Declared ones outlive the
   *  worker — they are what makes an inactive plugin usable — so they are
   *  tracked separately, against enabled-ness rather than against a process. */
  commandIds: CommandId[];
  /** Panel id → poster, set by each mounted panel iframe. */
  panelPosters: Map<string, (data: unknown) => void>;
  /**
   * Resolved when `activate()` returns, or rejected-as-false when boot fails.
   *
   * Lazy activation needs this: invoking a command on an inactive plugin has to
   * wait for the worker to come up before dispatching, and several invocations
   * can arrive during the same boot.
   */
  activationWaiters: Array<(ok: boolean) => void>;
}

class PluginHost {
  private readonly runtimes = new Map<string, Runtime>();
  private listeners: Array<() => void> = [];
  private selectionProvider: () => ReadonlyArray<string> = () => [];
  /** Show / hide a plugin's panel in the dock. Injected — this file must not
   *  import React, and the host is booted in tests where there is no dock. */
  private showPanelHook: ((pluginId: string, panelId: string) => void) | null = null;
  private hidePanelHook: ((pluginId: string, panelId: string) => void) | null = null;
  /** Plugin frames allowed on the postMessage bridge → their expected origin. */
  private readonly frames = new Map<MessageEventSource, string>();
  private workerFactory: WorkerFactory | null = null;
  /** Commands registered from a plugin's MANIFEST. Keyed by plugin id and tied
   *  to enabled-ness, not to a running worker — an inactive plugin's commands
   *  are in the palette, which is what lets invoking one start it. */
  private readonly declaredCommandIds = new Map<string, CommandId[]>();
  /** The registry has answered about revocations at least once this session. */
  private revocationsConfirmed = false;
  /** A revocation fetch is outstanding — do not start a second. */
  private revocationCheckInFlight = false;
  /** Plugins whose `malicious` notice the user has not yet acknowledged. */
  private readonly unacknowledgedTakedowns = new Set<string>();

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
    /** Reveal one of `pluginId`'s panels in the dock. Absent in tests and pop-outs. */
    showPanel?: (pluginId: string, panelId: string) => void;
    /** Hide it again — also called when a plugin stops, so a panel cannot
     *  outlive the worker that was answering it. */
    hidePanel?: (pluginId: string, panelId: string) => void;
  }): void {
    // Enforced, not documented. "`hydrate()` must run before `configure()`" is
    // call-order discipline, and call-order discipline is violated eventually —
    // by a refactor that moves a line, or by a new entry point (a pop-out
    // window, a test harness) written by someone who never read the note.
    //
    // The failure it prevents is quiet and expensive: without payloads, every
    // installed plugin has an empty `files`, so `start()` reports "the entry
    // module is missing from the package" for all of them at once. That reads
    // as every plugin the user installed being corrupt, and the real cause —
    // two lines in the wrong order at boot — is nowhere in the message.
    if (!usePluginStore.getState().hydrated) {
      throw new Error(
        'pluginHost.configure() was called before usePluginStore.hydrate() finished. '
        + 'Package payloads live in IndexedDB and are loaded asynchronously; starting '
        + 'plugins before they arrive makes every one of them look broken.',
      );
    }
    this.selectionProvider = opts.getSelection;
    this.showPanelHook = opts.showPanel ?? null;
    this.hidePanelHook = opts.hidePanel ?? null;

    /*
      Two plugin behaviours, hooked at the ONE place an authored property write
      happens (`SceneGraph.writeProp`).

      Doing it here rather than in the inspector is what makes both structural:
      a user editing a plugin-generated layer detaches it wherever the edit came
      from, and `onLayerChanged` cannot fire during playback at all — animation
      samples tracks, it never writes props, so it cannot reach that path.
    */
    setPluginPropWriteHandler((nodeId, componentId, propName) => {
      // A generated child the user touched: the plugin stops managing it.
      noteManualEdit(nodeId);

      // An authored edit on a custom layer's OWN property: tell its plugin.
      const node = defaultSceneGraph.getNode(nodeId);
      if (!node) return;
      const record = readCustomLayer(node);
      if (!record) return;
      // Only the component carrying the declared props, so a transform nudge
      // is not reported as a schema change.
      if (customLayerComponent(node)?.id !== componentId) return;
      if (propName.startsWith('__')) return;
      notifyAuthoredChange(nodeId, record.kind, propName);
    });

    /*
      The CACHED list is enforced first, before anything is brought up.

      Not an optimisation, and not redundant with the fetch below. The fetch
      only enforces when it obtains a NEW list — a 304, or no network at all,
      correctly changes nothing — so a plugin already named in the cached list
      would otherwise be started by `bringUpEnabled` on every cold start and
      stopped only if the registry happened to send a different list.

      Enforcing first rather than after also means it never runs: the entry is
      disabled by the time `bringUpEnabled` looks at it, so there is no window
      in which a revoked plugin's `activate()` has executed.
    */
    this.enforceRevocations();

    /*
      Global plugin storage, loaded once.

      Not awaited, and that is a real trade rather than an oversight. Awaiting
      would delay every plugin's `activate()` behind an IndexedDB open, against
      an 8-second boot deadline, for data most plugins never read. Not awaiting
      means a plugin that reads a preference in the first turn of `activate()`
      can see `null` where a value exists.

      The load is one small record and resolves in a microtask or two, so the
      race needs a plugin that reads storage synchronously at the very top of
      activation. It is documented rather than engineered around: a plugin that
      cares reads its settings on first use, which is also when it needs them.
    */
    void loadGlobalStorage();

    this.bringUpEnabled();

    /*
      And then ask whether the list has changed.

      Deliberately not awaited: an editor that delayed its own startup because a
      revocation check had not answered would be worse than the problem, and
      working offline is normal. Anything NEW it finds is enforced the moment it
      arrives rather than at the next restart.
    */
    this.checkRevocations();
  }

  /**
   * Ask the registry about revocations, at most once successfully per session.
   *
   * Called at boot and again before the first plugin actually starts. The
   * second call is not redundancy — it covers the case the first cannot: a
   * machine that launched the editor offline, or behind a captive portal, got
   * nothing at boot and would otherwise run whatever it has installed until the
   * next restart, which for an editor left open may be days.
   *
   * The flag is set on a SERVER ANSWER, not on the attempt. A fetch that timed
   * out, or a list that failed verification, leaves it clear so the next
   * activation tries again — otherwise one bad response silences the check for
   * the session, which is what an attacker serving garbage would want.
   *
   * Not awaited by either caller, including the one before activation. Blocking
   * a plugin's start on a network round trip would put the registry in the path
   * of every command a user runs. The check is still worth having unblocking:
   * the answer lands seconds later and `enforceRevocations` stops anything it
   * names mid-session, exactly as it does for a takedown that arrives an hour
   * into a session.
   */
  private checkRevocations(): void {
    if (this.revocationsConfirmed || this.revocationCheckInFlight) return;
    this.revocationCheckInFlight = true;
    void refreshRevocations(fetchRevocationList, () => this.enforceRevocations())
      .then((answered) => { if (answered) this.revocationsConfirmed = true; })
      .catch(() => { /* `refreshRevocations` does not throw; belt and braces. */ })
      .finally(() => { this.revocationCheckInFlight = false; });
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
    origin: {
      source?: 'folder' | 'file' | 'registry';
      publisherKey?: string;
      /** The successor the listing advertised. Recorded BEFORE any rotation
       *  uses it — see `InstalledPlugin.nextPublisherKey`. */
      nextPublisherKey?: string;
      nextPublisherKeyMethod?: 'backup' | 'dashboard';
    } = {},
  ): string | null {
    const id = pkg.manifest.id;

    // Refused, with the operator's reason. A revoked plugin that can be
    // reinstalled is a revocation the user can undo by accident.
    const revoked = revocationFor(id, pkg.manifest.version);
    if (revoked) {
      return `"${pkg.manifest.name}" was withdrawn by the registry and cannot be installed: ${revoked.reason}`;
    }

    /*
      Capabilities, checked HERE and not at the first call.

      A plugin that installs and then fails is worse than one that never
      installs: the user has already granted its permissions, it sits in their
      list looking healthy, and the failure arrives later attached to whatever
      they happened to be doing — with a message about a method name rather than
      about this machine.

      A manifest with no `requires` is judged by what its `apiVersion` implied,
      which is what makes every plugin published before capabilities existed
      install unchanged. See `capabilities.ts`.
    */
    const caps = checkCapabilities(pkg.manifest.apiVersion, pkg.manifest.requires);
    if (!caps.ok) {
      return `"${pkg.manifest.name}" cannot run here. ${caps.message}`;
    }

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
      /*
        The successor, refreshed on every install and update.

        Carried forward when this install brought none, for the same reason the
        pin is: losing it would silently downgrade the next rotation from "a key
        this machine already knew was authorised" to "a key never seen here" —
        which is the strongest warning, shown for the safest case.
      */
      ...(origin.nextPublisherKey
        ? { nextPublisherKey: origin.nextPublisherKey }
        : existing?.nextPublisherKey
          ? { nextPublisherKey: existing.nextPublisherKey }
          : {}),
      ...(origin.nextPublisherKeyMethod
        ? { nextPublisherKeyMethod: origin.nextPublisherKeyMethod }
        : existing?.nextPublisherKeyMethod
          ? { nextPublisherKeyMethod: existing.nextPublisherKeyMethod }
          : {}),
      // Survives an update: the log is about this plugin on this machine, not
      // about one version of it.
      ...(existing?.securityEvents ? { securityEvents: existing.securityEvents } : {}),
    };
    this.logs.delete(id);
    if (!usePluginStore.getState().put(entry)) {
      return 'Could not save the plugin — the browser storage quota is full.';
    }
    this.emit();
    this.bringUp(entry);
    return null;
  }

  /**
   * Remove a plugin from this machine.
   *
   * `keepData` decides what happens to its GLOBAL storage — its settings on
   * this machine. Default is to delete: uninstall should mean uninstall, and
   * leaving state behind by default is how an origin accumulates data from
   * software the user removed years ago. Keeping it is offered because
   * reinstalling a plugin you removed by mistake, or to try a different
   * version, should not cost you your configuration.
   *
   * PROJECT storage is never touched here, whatever this says. It lives in
   * documents, not on this machine, and those documents may be open on someone
   * else's laptop — deleting it would reach into files this uninstall has no
   * business editing. It is garbage-collected only by an explicit action on the
   * document itself. See `pluginStorage.ts`.
   */
  uninstall(id: string, opts: { keepData?: boolean } = {}): void {
    this.stop(id);
    this.unregisterContributions(id);
    usePluginStore.getState().remove(id);
    this.logs.delete(id);
    this.errors.delete(id);
    if (!opts.keepData) void forgetGlobalStorage(id);
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
    if (enabled) {
      // Same rule as install: while it is on the list, it does not run.
      const entry = usePluginStore.getState().get(id);
      const revoked = entry && revocationFor(id, entry.manifest.version);
      if (revoked) {
        this.appendLog(id, 'error', `Withdrawn by the registry: ${revoked.reason}`);
        return;
      }
    }
    usePluginStore.getState().setEnabled(id, enabled);
    if (enabled) {
      const entry = usePluginStore.getState().get(id);
      if (entry) this.bringUp(entry);
    } else {
      this.stop(id);
      // Disabling takes the contributions out of the palette too. An inactive
      // plugin's commands are meant to be there; a DISABLED one's are not, and
      // leaving them would make "off" mean nothing the user can see.
      this.unregisterContributions(id);
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

  private bringUpEnabled(): void {
    for (const entry of usePluginStore.getState().plugins) {
      if (entry.enabled) this.bringUp(entry);
    }
  }

  /**
   * Make a plugin's contributions live, and start it only if it asked to start.
   *
   * This is the whole point of the phase. Under API 1 every enabled plugin was
   * spawned here, because the only way to find out what it contributed was to
   * run it — with forty installed that is forty workers at launch, each racing
   * the same 8-second boot timeout, for a user who will use two of them.
   * Contributions are declared now, so the palette can be complete while almost
   * nothing is running.
   */
  private bringUp(entry: InstalledPlugin): void {
    this.registerContributions(entry);
    if (activatesOnStartup(entry.manifest)) this.start(entry);
    this.emit();
  }

  private start(entry: InstalledPlugin): void {
    const id = entry.manifest.id;
    if (this.runtimes.has(id)) return;

    // The single funnel every plugin passes through to actually run, which is
    // why the pre-activation revocation check hangs here rather than on the
    // handful of paths that lead to it. A no-op once the registry has answered.
    this.checkRevocations();

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
      panelPosters: new Map(),
      activationWaiters: [],
    };
    this.runtimes.set(id, rt);

    const api = createHostApi(entry.manifest, {
      registerCommand: (spec) => this.registerPluginCommand(entry, spec),
      openPanel: (panelId) => this.setPanelOpen(id, panelId, true),
      closePanel: (panelId) => this.setPanelOpen(id, panelId, false),
      warn: (text) => this.appendLog(id, 'warn', text),
      // Read live from the store rather than captured:  narrows a
      // grant and restarts the plugin, but reading through means a batch can
      // never be judged against a set the user has already revoked.
      granted: () => expandPermissions(usePluginStore.getState().get(id)?.granted ?? []),
      emitLayerChanged: (event) => {
        // Guarded: a worker that died between the edit and the coalesce window
        // is the normal case for a plugin that crashed mid-drag.
        const live = this.runtimes.get(id);
        if (!live || live.info.status === 'stopped' || live.info.status === 'error') return;
        const e = event as { layerId: string; kindId: string; props: string[] };
        try {
          live.worker.postMessage({ k: 'layerChanged', ...e } satisfies HostMessage);
        } catch { /* terminated between the check and the send */ }
      },
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
      // Resolved at boot, not at module load: `webgpu` depends on the renderer
      // tier, which is decided during app startup.
      capabilities: [...hostCapabilities()],
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
    // Take the panels down with the worker. A frame left on screen after its
    // plugin is disabled, uninstalled or killed still accepts clicks and
    // answers nothing — it reads as the editor being broken.
    const entry = usePluginStore.getState().get(id);
    for (const panel of entry?.manifest.contributes.panels ?? []) this.hidePanelHook?.(id, panel.id);
    if (rt.pingTimer) clearInterval(rt.pingTimer);
    if (rt.bootTimer) clearTimeout(rt.bootTimer);
    // Only the RUNTIME-registered commands. Declared ones survive: the plugin
    // is going inactive, not away, and its commands are how it comes back.
    for (const cid of rt.commandIds) getCommandRegistry().unregister(cid);
    // Anyone still waiting on this boot is waiting forever otherwise.
    for (const w of rt.activationWaiters.splice(0)) w(false);
    try { rt.worker.terminate(); } catch { /* already gone */ }
    this.runtimes.delete(id);
    // Its image budget goes back at the same moment its memory does.
    releaseAssetBudget(id);
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
        for (const w of rt.activationWaiters.splice(0)) w(true);
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
        // Only the named panel's frame. A plugin with two panels sending to one
        // must not have the message appear in the other.
        rt.panelPosters.get(msg.panelId)?.(msg.data);
        break;

      case 'log':
        this.appendLog(id, msg.level, msg.text);
        break;

      case 'call': {
        const required = METHOD_PERMISSIONS[msg.method];
        const reply = (m: HostMessage): void => {
          try {
            // Binary results (an image's pixels) are TRANSFERRED, not cloned.
            // For a 4K frame that is the difference between a pointer and 33 MB
            // of copy on the main thread.
            const transfer = collectTransferables(m);
            if (transfer.length > 0) rt.worker.postMessage(m, transfer);
            else rt.worker.postMessage(m);
          } catch { /* terminated */ }
        };

        if (required === undefined) {
          reply({ k: 'result', id: msg.id, ok: false, error: `Unknown API method "${msg.method}".` });
          return;
        }
        // `expandPermissions`, never `entry.granted` directly. A plugin holding
        // `scene:write` also holds `scene:proxy` — the second is a proper
        // subset of the first — and refusing it would be both nonsense and the
        // migration failing for every proxy plugin installed before that
        // permission existed. See `PERMISSION_IMPLIES`.
        if (required !== null && !expandPermissions(entry.granted).has(required)) {
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
        const failed = (err: unknown): void => {
          const message = err instanceof Error ? err.message : String(err);
          /*
            Logged, not only returned.

            A permission refusal above is logged for a reason that applies just
            as well here: the plugin may swallow the rejection, and then the
            refusal is invisible to everyone including its author. That became
            load-bearing with layer kinds — a plugin refused for reaching at
            ANOTHER plugin's kind must leave a trace, both because it is the
            author's only clue and because it is the one refusal that describes
            an attempt to act as someone else.
          */
          this.appendLog(id, 'warn', `${msg.method} refused — ${message}`);
          reply({ k: 'result', id: msg.id, ok: false, error: message });
        };
        try {
          const value = api[msg.method]!(...(Array.isArray(msg.args) ? msg.args : []));
          // The asset methods decode and encode, so they are async. Awaited
          // here rather than resolved worker-side, because a rejected promise
          // that nobody adopts is an unhandled rejection in the HOST realm —
          // and the plugin's call would hang with no error either way.
          if (value instanceof Promise) {
            void value.then(
              (v) => reply({ k: 'result', id: msg.id, ok: true, value: v === undefined ? null : v }),
              failed,
            );
          } else {
            reply({ k: 'result', id: msg.id, ok: true, value: value === undefined ? null : value });
          }
        } catch (err) {
          failed(err);
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

  // ── Contributions ──────────────────────────────────────────────────────

  /**
   * Put a plugin's DECLARED commands and panels in the palette.
   *
   * Called when a plugin becomes enabled, not when its worker starts — that
   * separation is the feature. Every command here is enabled and invokable
   * while the plugin is inactive; invoking one is what starts it.
   */
  private registerContributions(entry: InstalledPlugin): void {
    const pid = entry.manifest.id;
    if (this.declaredCommandIds.has(pid)) this.unregisterContributions(pid);
    const ids: CommandId[] = [];

    for (const spec of entry.manifest.contributes.commands) {
      const cid = asCommandId(`plugin.${pid}.${spec.id}`);
      getCommandRegistry().register({
        id: cid,
        label: `${entry.manifest.name}: ${spec.label}`,
        icon: spec.icon ?? 'plugin',
        // Deliberately NOT gated on the plugin running. A command that greys
        // out until you have started the thing it starts is a loop the user
        // cannot get into.
        enabled: () => (spec.needsSelection ? this.selectionProvider().length > 0 : true),
        execute: () => { void this.invokeCommand(pid, spec.id); },
      });
      ids.push(cid);
    }

    // One "open" command per declared panel, so a plugin's UI is reachable from
    // the palette without going through the manager. These are kept OUT of
    // `info.commands`: that list is what the PLUGIN contributed and the manager
    // counts it, so counting a command the host invented would misreport it.
    for (const panel of entry.manifest.contributes.panels) {
      const cid = asCommandId(`plugin.${pid}.panel.${panel.id}`);
      getCommandRegistry().register({
        id: cid,
        label: `${entry.manifest.name}: ${panel.title}`,
        icon: 'plugin',
        enabled: () => true,
        execute: () => { void this.showPanel(pid, panel.id); },
      });
      ids.push(cid);
    }

    this.declaredCommandIds.set(pid, ids);

    /*
      Layer kinds, registered on ENABLE rather than on start — the same rule the
      commands above follow, and for the same reason. A declared kind has to be
      creatable before its worker has ever booted, or every plugin that defines
      one has to start at launch just so its layer type appears in a menu, which
      is exactly what `activationEvents` exists to avoid.
    */
    registerLayerKinds(pid, entry.manifest.name, entry.manifest.contributes.layerKinds);

    /*
      Effects, on ENABLE for the same reason and with one more of its own: an
      effect is a compiled shader plus a parameter block, and none of that needs
      the plugin's worker. A document using one keeps rendering with the worker
      stopped — which is the property that makes an effect worth shipping at
      all, because a plugin whose output vanishes when it is not running is one
      nobody can rely on in a project they hand to someone else.
    */
    registerEffects(pid, entry.manifest.name, entry.manifest.contributes.effects);
  }

  private unregisterContributions(id: string): void {
    for (const cid of this.declaredCommandIds.get(id) ?? []) getCommandRegistry().unregister(cid);
    this.declaredCommandIds.delete(id);
    // A stopped plugin's kinds must not stay creatable: a menu that offers a
    // layer nothing can drive, and a document that gains a reference to a
    // plugin the user has already turned off.
    unregisterLayerKinds(id);
    // Its callbacks go with its kinds. A listener for a plugin that is no
    // longer running is a message posted into a dead worker every time a user
    // touches a layer it used to manage.
    clearLayerChangeListeners(id);
    // And its effects. A disabled plugin whose effect stayed registered would
    // keep drawing — including one the user disabled BECAUSE it was implicated
    // in a device loss, which is the case where that matters most.
    unregisterEffects(id);
  }

  /**
   * Start a plugin if it is not already up, and resolve once it has activated.
   *
   * Returns false when it could not be started — the error path has already
   * notified and logged by then, so callers do not report it a second time.
   */
  private ensureActive(pid: string): Promise<boolean> {
    const rt = this.runtimes.get(pid);
    if (rt?.info.status === 'running') return Promise.resolve(true);

    const entry = usePluginStore.getState().get(pid);
    if (!entry || !entry.enabled) return Promise.resolve(false);

    if (!rt) {
      this.start(entry);
      this.emit();
    }
    const live = this.runtimes.get(pid);
    if (!live) return Promise.resolve(false);
    if (live.info.status === 'running') return Promise.resolve(true);
    // Several invocations can arrive during one boot; they all wait on the same
    // list and are answered together by `activated` or by `stop`.
    return new Promise<boolean>((resolve) => { live.activationWaiters.push(resolve); });
  }

  /**
   * Run one of a plugin's commands, activating it first if need be.
   *
   * The boot deadline is the existing 8-second one — a lazily started plugin
   * fails exactly the way an eagerly started one does, with the same message,
   * because it is the same code path.
   */
  private async invokeCommand(pid: string, commandId: string): Promise<void> {
    const started = await this.ensureActive(pid);
    const live = this.runtimes.get(pid);
    if (!started || !live) {
      // `setError` already told the user when boot failed. This branch is the
      // other case: disabled, or uninstalled between palette and keystroke.
      if (!this.errors.has(pid)) {
        useUIStore.getState().notify({
          level: 'warning',
          message: `${usePluginStore.getState().get(pid)?.manifest.name ?? pid} is not available.`,
          durationMs: 4000,
        });
      }
      return;
    }
    live.worker.postMessage({
      k: 'invoke',
      commandId,
      selection: [...this.selectionProvider()],
    } satisfies HostMessage);
  }

  /**
   * A command registered at RUNTIME by `commands.register`.
   *
   * Still the only route for API-1 plugins, and still supported for API-2 ones
   * — `hostApi` logs a nudge when an API-2 plugin registers something it did
   * not declare. Skipped when the id was already declared, so a plugin that
   * both declares and registers (the migration state) does not get two palette
   * entries for one command.
   */
  private registerPluginCommand(entry: InstalledPlugin, spec: PluginCommandSpec): void {
    const pid = entry.manifest.id;
    const rt = this.runtimes.get(pid);
    if (!rt) return;
    if (entry.manifest.contributes.commands.some((c) => c.id === spec.id)) {
      rt.info = { ...rt.info, commands: [...rt.info.commands, spec] };
      this.emit();
      return;
    }
    // Namespaced with the plugin id: two vendors may both ship "apply", and the
    // command registry is a flat id space.
    const cid = asCommandId(`plugin.${pid}.${spec.id}`);
    const cmd: Command = {
      id: cid,
      label: `${entry.manifest.name}: ${spec.label}`,
      icon: spec.icon ?? 'plugin',
      enabled: () => (spec.needsSelection ? this.selectionProvider().length > 0 : true),
      execute: () => { void this.invokeCommand(pid, spec.id); },
    };
    getCommandRegistry().register(cmd);
    rt.commandIds.push(cid);
    rt.info = { ...rt.info, commands: [...rt.info.commands, spec] };
    this.emit();
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
  private setPanelOpen(id: string, panelId: string, open: boolean): void {
    if (open) this.showPanelHook?.(id, panelId);
    else this.hidePanelHook?.(id, panelId);
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.info = { ...rt.info, panelOpen: open };
    this.emit();
  }

  /**
   * Public entry for the manager's "Open" button, the Plugins menu and the
   * palette. Activates the plugin first — `onPanel:<id>` is an activation
   * event, and a panel frame whose worker is not running answers nothing.
   *
   * `panelId` is optional and defaults to the plugin's sole panel, which is the
   * overwhelmingly common case.
   */
  async showPanel(id: string, panelId?: string): Promise<void> {
    const entry = usePluginStore.getState().get(id);
    const panels = entry?.manifest.contributes.panels ?? [];
    const target = panelId ?? panels[0]?.id;
    if (!target) return;
    // Shown first, then activated: the dock opening immediately is the pending
    // state. Opening it only after an 8-second boot would read as a dead click.
    this.setPanelOpen(id, target, true);
    await this.ensureActive(id);
  }

  /**
   * Wake the plugins a just-opened document depends on.
   *
   * `onLayerKind:<id>` is the activation event that makes lazy activation work
   * for layer kinds: a plugin that defines one should start when a project
   * containing it is opened, and at no other time. Without this the manifest
   * validates the event and nothing ever raises it — so a document full of
   * custom layers would sit inert until the user happened to run one of the
   * plugin's commands.
   *
   * Deliberately fire-and-forget. Opening a project must not wait on a worker
   * boot; the layers render from their proxy children meanwhile, and go live
   * when their plugin is up.
   */
  activateForDocument(kinds: readonly string[]): void {
    const wanted = new Set<string>();
    for (const kind of kinds) {
      const split = splitKind(kind);
      if (split) wanted.add(split.pluginId);
    }
    for (const pid of wanted) {
      const entry = usePluginStore.getState().get(pid);
      // Not installed, or the user turned it off. Both are states the layer
      // already knows how to render inert — starting it is not our call.
      if (!entry?.enabled) continue;
      void this.ensureActive(pid);
    }
  }

  /**
   * Stop every installed plugin that is on the revocation list.
   *
   * Called after a list is adopted, NOT only at boot. Waiting for a restart
   * would leave the window open for as long as the user keeps the app running,
   * which is the exact failure a revocation list exists to close — a takedown
   * that arrives an hour after the user opened the editor has to land now.
   *
   * The package is not deleted and nothing the user made is destroyed,
   * consistent with the blocked-plugin rule: documents that reference it keep
   * opening, and a `proxy` layer's children keep rendering. Breaking someone's
   * project is usually a bigger harm than the one a takedown addresses.
   */
  enforceRevocations(): Array<{ id: string; reason: string }> {
    const stopped: Array<{ id: string; reason: string }> = [];

    for (const entry of usePluginStore.getState().plugins) {
      const id = entry.manifest.id;
      const revoked = revocationFor(id, entry.manifest.version);
      if (!revoked) continue;

      const wasRunning = this.runtimes.get(id)?.info.status === 'running';
      // Disabled rather than merely stopped: a stop alone would be undone by
      // the next thing that lazily activates it.
      usePluginStore.getState().setEnabled(id, false);
      this.stop(id);
      this.unregisterContributions(id);

      // The operator's own words. A plugin that disappears with no explanation
      // is worse than the takedown it implements — the user assumes a bug and
      // goes looking for the plugin, or reinstalls it.
      this.appendLog(id, 'error', `Withdrawn by the registry: ${revoked.reason}`);

      /*
        How loudly to say it depends on WHY.

        A plugin withdrawn because it broke on a new release and one withdrawn
        because it was uploading projects both stop running, and telling the
        user about them in the same 12-second toast is wrong in one direction:
        the second is a reason to go and check what that plugin had access to,
        and a toast that expires while they are looking at the canvas is a
        notice they never received.

        So `malicious` gets a notice that does not expire on its own, and stays
        recorded against the plugin until the user acknowledges it. Everything
        else keeps the toast it had, because most takedowns are mild and a
        product that shouts about all of them teaches people to dismiss the
        shouting.
      */
      const severe = revoked.category === 'malicious';
      if (severe) this.unacknowledgedTakedowns.add(id);

      if (wasRunning || severe) {
        // A toast only when it was actually RUNNING — a plugin that was already
        // inactive stopping is not news, one that vanished mid-session is — or
        // when the reason is severe enough that the user should be told
        // regardless of whether they were using it at that moment.
        useUIStore.getState().notify({
          level: 'error',
          message: severe
            ? `"${entry.manifest.name}" was withdrawn by the registry as malicious: ${revoked.reason}`
            : `"${entry.manifest.name}" was withdrawn by the registry: ${revoked.reason}`,
          // `0` is "until dismissed". The user has to have seen it to close it,
          // which is the whole difference between telling someone and logging.
          durationMs: severe ? 0 : 12000,
        });
      }
      stopped.push({ id, reason: revoked.reason });
    }

    if (stopped.length > 0) this.emit();
    return stopped;
  }

  /**
   * Is this plugin under a takedown the user has not acknowledged?
   *
   * Read by the plugin's row, which shows the notice permanently until it is
   * acknowledged. A toast is a moment; this is the record of it, and it is what
   * a user who dismissed the toast by reflex has left to find.
   */
  hasUnacknowledgedTakedown(id: string): boolean {
    return this.unacknowledgedTakedowns.has(id);
  }

  /** The user has read the takedown notice for this plugin. */
  acknowledgeTakedown(id: string): void {
    if (this.unacknowledgedTakedowns.delete(id)) this.emit();
  }

  /** Called by each panel component while its iframe is mounted. */
  attachPanel(id: string, panelId: string, postToPanel: (data: unknown) => void): () => void {
    const rt = this.runtimes.get(id);
    if (!rt) return () => {};
    rt.panelPosters.set(panelId, postToPanel);
    return () => {
      if (rt.panelPosters.get(panelId) === postToPanel) rt.panelPosters.delete(panelId);
    };
  }

  /** Deliver a message from one of a plugin's panels to that plugin's worker. */
  deliverPanelMessage(id: string, panelId: string, data: unknown): void {
    const rt = this.runtimes.get(id);
    rt?.worker.postMessage({ k: 'panelMessage', panelId, data } satisfies HostMessage);
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

  /**
   * What the manager renders.
   *
   * The order matters. An error outranks everything — it is the state the user
   * has to act on. Otherwise a live runtime speaks for itself.
   *
   * With neither, the answer turns on what the plugin ASKED FOR. A lazily
   * activated plugin with no worker is `inactive`: nothing is wrong, and it
   * starts when used. An `onStartup` plugin with no worker is a plugin that
   * said it wanted to be running and is not — that is `stopped`, and the
   * manager labels it "Not running". Reporting both as `inactive` would tell a
   * user whose plugin failed to launch that everything is fine.
   */
  info(id: string): PluginRuntimeInfo {
    const error = this.errors.get(id);
    if (error) return { status: 'error', error, commands: [], panelOpen: false };
    const rt = this.runtimes.get(id);
    if (rt) return rt.info;
    const entry = usePluginStore.getState().get(id);
    if (entry?.enabled && !activatesOnStartup(entry.manifest)) {
      return {
        status: 'inactive',
        // From the MANIFEST, without running anything — which is the point.
        commands: [...entry.manifest.contributes.commands],
        panelOpen: false,
      };
    }
    return {
      status: 'stopped',
      commands: entry?.enabled ? [...entry.manifest.contributes.commands] : [],
      panelOpen: false,
    };
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
      // A panel talks to its OWN plugin's worker, as its OWN panel, and nothing
      // else. Both halves of that come from which FRAME sent the message —
      // never from the body. A panel that names another plugin's panel id in
      // its payload is describing itself inaccurately, and is ignored, because
      // nothing here reads the payload to decide where it goes.
      const owner = this.panelOwners.get(event.source!);
      if (!owner) return;
      this.deliverPanelMessage(owner.pluginId, owner.panelId, (data as { data?: unknown }).data);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }

  private readonly panelOwners = new Map<MessageEventSource, { pluginId: string; panelId: string }>();

  /** Bind a registered frame to the plugin AND panel that own it. */
  claimFrame(source: MessageEventSource, pluginId: string, panelId: string): () => void {
    this.panelOwners.set(source, { pluginId, panelId });
    return () => { this.panelOwners.delete(source); };
  }
}

export const pluginHost = new PluginHost();
export default pluginHost;
