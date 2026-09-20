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
import { resetGeneratorsForPlugin, setGeneratorRunner } from './generator/generatorScheduler';
import { forgetPluginAssetTextures, setPluginAssetHost } from './pluginAssetTextures';
import { setSuperviseHandler } from './paramSupervision';
import { registerEffects, unregisterEffects } from './pluginEffects';
import { registerAudioEffects, unregisterAudioEffects } from './pluginAudioEffects';
import { registerPluginTools, unregisterPluginTools } from './uiTools';
import { setPluginExpressionScope } from '@motion/animation';
import {
  configurePluginExpressions, pluginExpressionScope, registerPluginExpressions,
  unregisterPluginExpressions,
} from './uiExpressions';
import { clearPluginDrawList, configurePluginCanvas, type PluginCanvasEvent } from './uiCanvas';
import { clearPluginStatus } from './uiStatus';
import { findShortcutClash, describeClash } from './uiShortcuts';
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
  type RenderFinishedInfo,
} from './protocol';
import type { PluginPackage } from './pluginPackage';
import { normalizePath } from './moduleGraph';
import {
  consentNeed, loadLocalPackage, loadVerdict, localPluginsAvailable, refreshLocalPlugins,
} from './localPlugins';
import { developerModeEnabled } from './developerMode';
import {
  killNativePlugin, loadNativePlugin, manifestForStaged, stageNativeBinary, stagingPlatformKey,
  sweepStagedNative, unstageNativePlugin, watchNativeEvents, type NativeStatus,
} from './native';
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
/** How long one export step may take before the export fails. */
const EXPORT_STEP_TIMEOUT_MS = 60_000;

/**
 * One export step minus the id the host assigns.
 *
 * Distributive on purpose: a bare `Omit<Union, 'id'>` collapses the four phases
 * into one object type whose only keys are the ones they all share, so
 * `phase: 'frame'` would typecheck without `pixels`.
 */
/** What a host-driven worker task resolves to: export bytes, decoded pixels, or
 *  a generator's raw frame (wrapped, so a generator returning `undefined` is
 *  distinguishable from an export step that resolves with nothing). */
type HostTaskReply =
  | ArrayBuffer
  | undefined
  | { width: number; height: number; pixels: ArrayBuffer }
  | { generated: unknown }
  /** A supervisor's answer: params to write back, or nothing to change. */
  | { supervised: Record<string, unknown> | null };

type ExportStepInput<T = Extract<HostMessage, { k: 'export' }>> =
  T extends unknown ? Omit<T, 'id'> : never;

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
  /** Make one of `pluginId`'s tools the active tool. Absent in tests. */
  private activateToolHook: ((pluginId: string, toolId: string) => void) | null = null;
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
    /*
      The two UI registries that have to reach a worker.

      Injected rather than imported the other way round: the viewport paints a
      draw list and the animation engine calls an expression function, and
      neither may pull the plugin host into a test that has no worker. This is
      the only place that knows both halves.
    */
    configurePluginCanvas({
      deliver: (pluginId, event) => { this.deliverCanvasEvent(pluginId, event); },
    });
    // `plugin.<namespace>.<fn>()` in an expression. The animation package holds
    // one injected provider rather than importing any of this, so an engine
    // test evaluates expressions with no plugin host in the graph at all.
    setPluginExpressionScope(pluginExpressionScope);
    configurePluginExpressions({
      compute: (pluginId, name, args) => { this.requestExpressionValue(pluginId, name, args); },
      // A value that lands between frames has to reach the next one. The scene
      // bump is what every sampled value in the app already rebuilds from.
      onValue: () => { this.emit(); },
    });
  }

  /**
   * Post one viewport event to the plugin that drew the thing it landed on.
   *
   * Activates first — the plugin may have been asleep since launch, and a
   * gesture that starts by waking it is the same contract `invokeCommand` has.
   * The event is dropped rather than queued if the worker cannot be started:
   * replaying a pointer-down after an 8-second boot would land it somewhere the
   * user is no longer pointing.
   */
  private deliverCanvasEvent(pluginId: string, event: PluginCanvasEvent): void {
    const live = this.runtimes.get(pluginId);
    if (live?.info.status === 'running') {
      try { live.worker.postMessage({ k: 'canvas', event } satisfies HostMessage); } catch { /* terminated */ }
      return;
    }
    void this.ensureActive(pluginId).then((started) => {
      if (!started) return;
      const rt = this.runtimes.get(pluginId);
      try { rt?.worker.postMessage({ k: 'canvas', event } satisfies HostMessage); } catch { /* terminated */ }
    });
  }

  /** Ask a plugin for one expression value. Never waits — see `uiExpressions.ts`. */
  private requestExpressionValue(pluginId: string, name: string, args: readonly number[]): void {
    void this.ensureActive(pluginId).then((started) => {
      if (!started) return;
      const rt = this.runtimes.get(pluginId);
      try {
        rt?.worker.postMessage({ k: 'expression', name, args: [...args] } satisfies HostMessage);
      } catch { /* terminated */ }
    });
  }

  /**
   * Tell a plugin the user picked (or left) one of its tools.
   *
   * Public because the toolbar is what knows, and it reaches the host rather
   * than the worker — a tool is selectable while its plugin is asleep, and
   * selecting it is what wakes it (`onTool:<id>`).
   */
  notifyToolChanged(pluginId: string, toolId: string, active: boolean): void {
    if (!active) {
      // Its drawing goes with it. A gizmo left on the canvas after the user
      // switched to Select is chrome nothing on screen explains.
      clearPluginDrawList(pluginId);
      const rt = this.runtimes.get(pluginId);
      try { rt?.worker.postMessage({ k: 'tool', toolId, active: false } satisfies HostMessage); } catch { /* gone */ }
      return;
    }
    void this.ensureActive(pluginId).then((started) => {
      if (!started) return;
      const rt = this.runtimes.get(pluginId);
      try {
        rt?.worker.postMessage({ k: 'tool', toolId, active: true } satisfies HostMessage);
      } catch { /* terminated */ }
    });
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
    /** Select one of `pluginId`'s contributed tools. Absent in tests and pop-outs. */
    activateTool?: (pluginId: string, toolId: string) => void;
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
    this.activateToolHook = opts.activateTool ?? null;

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

    this.watchNative();

    this.bringUpEnabled();

    /*
      And then ask whether the list has changed.

      Deliberately not awaited: an editor that delayed its own startup because a
      revocation check had not answered would be worse than the problem, and
      working offline is normal. Anything NEW it finds is enforced the moment it
      arrives rather than at the next restart.
    */
    this.checkRevocations();

    void this.refreshFolderPlugins();
    void this.sweepNativeStaging();
  }

  /** Unsubscribe for the native host's event stream. Null until `configure`. */
  private nativeEventsOff: (() => void) | null = null;

  /**
   * Listen to what the native host has to say, and put it in the plugin's log.
   *
   * A crash, a call that timed out and a session disable all happen to a
   * PROCESS, so none of them is the return value of anything — they arrive as
   * events, often while the plugin is idle, and before this they arrived
   * nowhere. A user whose compiled effect stopped working saw the effect stop
   * working, and the log that exists precisely to tell them why said nothing.
   *
   * One line per EVENT, never per frame: a crashed plugin's calls each fail as
   * well, and those are the scheduler's business (`takeNativeErrors`, which the
   * export gate drains). The three events here are the ones that change what the
   * plugin IS, and there are at most four of them before it is disabled for the
   * session.
   */
  private watchNative(): void {
    this.nativeEventsOff?.();
    this.nativeEventsOff = watchNativeEvents((event) => {
      if (event.type === 'crashed') {
        const n = event.restarts ?? 0;
        this.appendLog(
          event.pluginId,
          'error',
          `native module: the process stopped unexpectedly${event.message ? ` — ${event.message}` : ''}`
          + (n > 0 ? ` (restart ${n})` : ''),
        );
      } else if (event.type === 'disabled') {
        this.appendLog(
          event.pluginId,
          'error',
          event.message
            ?? 'native module: it crashed repeatedly and is off for the rest of this session.',
        );
      }
      // `ready` and `stopped` are not logged. A process starting and stopping is
      // the tier working, and a line per idle-timeout would push the crash that
      // matters off the end of a bounded log.
    });
  }

  /** Stop listening. Paired with `watchNative`, for a host that is torn down. */
  stopWatchingNative(): void {
    this.nativeEventsOff?.();
    this.nativeEventsOff = null;
  }

  /**
   * Collect staging directories left behind by plugins that are gone.
   *
   * At boot and nowhere else: it is the one moment the whole installed list is
   * known and nothing is mid-install, so an id that is staged and not installed
   * is an orphan rather than a race. Not awaited, like every other boot tidy
   * here — a directory that survives one more launch costs nothing, and a
   * filesystem walk in front of the editor's own startup costs the user.
   */
  private async sweepNativeStaging(): Promise<void> {
    try {
      const installed = usePluginStore.getState().plugins.map((p) => p.manifest.id);
      await sweepStagedNative(installed);
    } catch {
      // No bridge, or a staging root that could not be listed. A sweep that
      // does not happen is the state this code was added to improve on.
    }
  }

  /**
   * Re-read the plugins folders at boot, for packages the user already said
   * yes to.
   *
   * This is the half of the folder tier that makes it feel like a plugins
   * folder rather than an importer. An AE plugin is in `MediaCore` and is there
   * at the next launch; a Premation one would have been a thing you pressed
   * "Load" on every session, which is not an install — it is an import with
   * extra steps.
   *
   * The boundary is strict, and it is what makes this safe to do with nobody
   * watching:
   *
   *   • Only an id ALREADY INSTALLED on this machine. A new folder appearing is
   *     never started by itself — it waits in the panel for the consent screen.
   *   • Only when `consentNeed` says nothing changed: same tier, no permission
   *     the user has not already granted, no new publisher key.
   *   • Only what the trust gate allows — a signature, or Developer Mode.
   *
   * So what this can do is replace an installed copy with the newer bytes of
   * the same plugin, with the same grants. A plugin cannot widen what it may do
   * by editing a file on disk; that path goes through the panel and the sheet.
   *
   * Not awaited by `configure`, for the same reason the revocation check is
   * not: reading packages off a disk must not sit in front of the editor's own
   * startup.
   */
  private async refreshFolderPlugins(): Promise<void> {
    if (!localPluginsAvailable()) return;
    try {
      const { plugins } = await refreshLocalPlugins();
      for (const candidate of plugins) {
        const manifest = candidate.manifest;
        if (!manifest) continue;
        const existing = usePluginStore.getState().get(manifest.id);
        if (!existing) continue;
        if (!loadVerdict(candidate).allowed) continue;

        const { pkg, errors, signature, native } = await loadLocalPackage(candidate);
        if (!pkg) {
          this.appendLog(manifest.id, 'warn', `Could not re-read this plugin from disk: ${errors.join(' ')}`);
          continue;
        }
        if (consentNeed(pkg.manifest, existing, signature) !== 'none') continue;

        const error = this.install(pkg, existing.granted, {
          source: candidate.kind === 'archive' ? 'file' : 'folder',
          ...(signature?.ok && signature.publisherKey ? { publisherKey: signature.publisherKey } : {}),
          ...(native ? { native } : {}),
        });
        if (error) this.appendLog(manifest.id, 'warn', error);
      }
    } catch {
      // A bridge that answered badly, or a folder that vanished mid-scan. The
      // panel re-scans on demand and says what it found; a failure here must
      // not be the thing that stops the editor booting.
    }
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
      /**
       * A FOLDER install's compiled modules: where they are, and what the main
       * process measured them to hash to (`loadLocalPackage`).
       *
       * Absent for everything else, and absence is not "no native module" — an
       * archive's binary is staged out of `pkg.binaries` instead, because a file
       * inside a zip cannot be loaded where it lies. See `bringUpNative`.
       */
      native?: { dir: string; hashes: Record<string, string> };
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
      /*
        The binaries, which this used to DROP.

        `PluginPackage` has carried them since packages were allowed to ship
        media, and `pluginStore.put` writes them to IndexedDB — but the record
        built here never set the key, so every install arrived with its assets
        missing and only `hydrate()` (which reads the payload back) could see
        them. Harmless while nothing could read a package file; not harmless now
        that `package.read` is the whole point of shipping one.
      */
      ...(pkg.binaries && Object.keys(pkg.binaries).length > 0 ? { binaries: pkg.binaries } : {}),
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
    // Not awaited, and not allowed to fail the install: a compiled module that
    // will not come up is a plugin that runs its JavaScript path, which is what
    // every native call site already does when there is no process. See below.
    void this.bringUpNative(pkg, origin);
    return null;
  }

  /**
   * Bring a plugin's COMPILED module up, if it declared one.
   *
   * Returns on the first line for every plugin without a `native` block, which
   * is all of them today: no process, no staging, no hash, nothing written.
   *
   * Two shapes arrive and only one of them is already a file. A FOLDER's binary
   * is loaded where it lies, from the hashes the scan measured. An ARCHIVE's is
   * written out first — `require` cannot open a file inside a zip — and the
   * manifest it is loaded with names the STAGED file rather than the author's
   * path inside the package, which is what `manifestForStaged` is for.
   *
   * Asynchronous while `install` is synchronous, so it is fire-and-forget. The
   * consent sheet's button and the folder re-scan both call `install` inside a
   * render, and a load that has to launch a process and wait for `describe()`
   * cannot sit in front of either. What a caller would have done with the
   * answer is what happens here instead: it goes in the plugin's own log.
   */
  private async bringUpNative(
    pkg: PluginPackage,
    origin: { publisherKey?: string; native?: { dir: string; hashes: Record<string, string> } },
  ): Promise<void> {
    const manifest = pkg.manifest;
    if (!manifest.native) return;

    try {
      // A pinned key IS the signature verdict here: nothing sets it that did not
      // verify the bytes against it first, and nothing else on this side knows
      // any more about the signature than that.
      const signature = origin.publisherKey ? { ok: true, publisherKey: origin.publisherKey } : null;
      const developerMode = developerModeEnabled();

      if (origin.native) {
        this.reportNativeLoad(await loadNativePlugin({
          manifest,
          dir: origin.native.dir,
          hashes: origin.native.hashes,
          signature,
          developerMode,
        }));
        return;
      }

      const staged = await stageNativeBinary(manifest, pkg.binaries ?? {});
      if (!staged) return; // No bridge — a browser build has no processes at all.
      if (staged.error || !staged.dir) {
        this.appendLog(manifest.id, 'error', `native module: ${staged.error ?? 'it could not be staged.'}`);
        return;
      }
      /*
        The staged file's own name, and the platform key it now stands for.

        `stageNativeBinary` keys its hash map by the BASENAME the file landed
        under, and the key is read from the bridge rather than guessed from the
        manifest because two platforms may legitimately declare the same file
        name — the example SDK package declares `motion_example.node` for all
        four — and matching on the name alone would rewrite the wrong entry.
      */
      const fileName = Object.keys(staged.hashes)[0] ?? '';
      this.reportNativeLoad(await loadNativePlugin({
        manifest: manifestForStaged(manifest, stagingPlatformKey(), fileName),
        dir: staged.dir,
        hashes: staged.hashes,
        signature,
        developerMode,
      }));
    } catch (err) {
      // A bridge that answered badly, a staging directory that is not writable.
      // The plugin is installed and its JavaScript runs; this is the note the
      // author needs to know why the fast path did not.
      this.appendLog(manifest.id, 'error', `native module: ${(err as Error).message}`);
    }
  }

  /** One log line for a native load that did not end with a running process. */
  private reportNativeLoad(status: NativeStatus): void {
    if (status.loaded || status.code === 'not-declared') return;
    // A package that ships no binary for THIS machine is a fact to list, not a
    // fault to report — see `NativeStatus.unavailableHere`.
    this.appendLog(
      status.pluginId,
      status.unavailableHere ? 'warn' : 'error',
      `native module: ${status.error ?? status.code ?? 'it did not load.'}`,
    );
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
    /*
      The compiled module, and everything staged for it.

      `killNativePlugin` drops the consent and the process; `unstageNativePlugin`
      deletes the bytes. Both, because they are two different leaks: a consent
      record that outlives its plugin would silently authorise the NEXT install
      of the same id, and a staging directory that outlives it is a copy of a
      binary nothing will ever load again sitting in the user's profile.
    */
    void killNativePlugin(id);
    void unstageNativePlugin(id);
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
      // The compiled module too. "Off" that left a process running — holding
      // memory, holding a file mapped, still answering calls the render path
      // made before it noticed — would make the switch a lie about the half of
      // the plugin that is not in the sandbox.
      void killNativePlugin(id);
      // Disabling takes the contributions out of the palette too. An inactive
      // plugin's commands are meant to be there; a DISABLED one's are not, and
      // leaving them would make "off" mean nothing the user can see.
      this.unregisterContributions(id);
    }
    this.emit();
  }

  /** Restart a plugin — the fix for "it stopped responding" without a reload. */
  private exportSeq = 0;
  /**
   * Replies the host is waiting on, keyed by request id.
   *
   * One map for exports AND imports, because both draw ids from
   * `exportSeq` — two maps sharing one counter would be two places a reply can
   * fail to find its waiter, for no gain.
   */
  private readonly exportWaiters = new Map<
    number,
    { resolve: (v: HostTaskReply) => void; reject: (e: Error) => void }
  >();

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

    /*
      ★ The native tier is DECLARED but has no runtime yet.

      `runtime: "native"` asks to be imported into this realm — synchronous
      handles, per-frame code, no permission gate. The grammar understands it
      (see `runtimeTier.ts`, which also carries the trust model and the rule
      that a sandboxed plugin turning native on update must re-ask), but the
      loader that would run it is not built.

      Refused here rather than quietly started in the Worker. A native module
      expects handles the sandbox cannot give it, so running it the safe way
      would start something certain to fail in a way its author never saw — and
      that reads as the platform being broken rather than as a missing feature.
      Same reasoning as the refusal of `scale` and `reads` on effect passes.
    */
    if (entry.manifest.runtime === 'native') {
      this.setError(
        id,
        'This plugin asks to run without the sandbox, which this build cannot do yet.',
      );
      return;
    }

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
      // Read live for the same reason `granted` is: the record is replaced
      // wholesale on update, and a captured payload would serve a file from
      // the version the worker happened to boot with.
      readPackageFile: (path, as) => this.readPackageFile(id, path, as),
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

    /*
      The whole module graph, not only the entry.

      A blob URL has no directory, so `import './util.js'` inside the entry
      module used to resolve against the blob origin and fail — which made a
      plugin exactly one file. The worker now builds a blob per file and
      rewrites each relative specifier to the URL its target landed at, so what
      it needs is every TEXT file in the package.

      `code` stays, and is still the entry's source. The worker prefers `files`
      when it is there; keeping both means a graph that cannot be planned (a
      cycle, a bare npm specifier) still reports its own error rather than
      failing to boot at all. Binaries are deliberately NOT sent: they can be
      hundreds of megabytes, and `package.read` fetches the one that is wanted.
    */
    const boot: HostMessage = {
      k: 'boot',
      manifest: entry.manifest,
      code,
      files: entry.files,
      entry: entry.manifest.main.replace(/^\.\//, ''),
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

  /**
   * One file out of a plugin's own installed package — the `package.read` verb.
   *
   * The containment argument, in one sentence: there is no path here that is
   * not a key of the package record, so "reach outside the package" is not a
   * thing this can be asked to do — `..` folds away in `normalizePath`, and a
   * folded path that names nothing in the record is a miss, not an escape.
   *
   * Bytes are COPIED before they leave. The reply is transferred (see
   * `collectTransferables`), and transferring the stored array would neuter the
   * installed record — the second read of the same file would come back empty,
   * with nothing in the message to say why.
   */
  /**
   * The same file, for the HOST's own use — a generator's sprite atlas.
   *
   * Routed through `readPackageFile` rather than reaching into the store
   * beside it, so there is exactly one implementation of "resolve a path inside
   * an installed payload" and a future narrowing of it cannot apply to the
   * plugin's route and miss the host's. It REJECTS with the same sentences a
   * plugin would have been told, which is what the caller turns into a log line
   * naming the file; swallowing them would leave "no such file" and "this
   * plugin is gone" indistinguishable.
   */
  async readPackageBytes(pluginId: string, path: string): Promise<Uint8Array> {
    const buffer = await this.readPackageFile(pluginId, path, 'bytes');
    return new Uint8Array(buffer as ArrayBuffer);
  }

  /**
   * A named failure from a host subsystem working on a plugin's behalf — a
   * packaged texture that would not decode, say.
   *
   * The plugin's OWN log, which is the surface a user opens when something a
   * plugin contributed does not appear. A console line would be invisible
   * there, and a toast would fire at frame rate.
   */
  reportError(id: string, text: string): void {
    this.appendLog(id, 'error', text);
  }

  private async readPackageFile(
    pluginId: string,
    rawPath: unknown,
    as: unknown,
  ): Promise<string | ArrayBuffer> {
    const entry = usePluginStore.getState().get(pluginId);
    if (!entry) throw new Error('This plugin is no longer installed.');
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      throw new Error('package.read(path) needs the path of a file in your package.');
    }
    if (as !== undefined && as !== null && as !== 'text' && as !== 'bytes') {
      throw new Error('The second argument to package.read is "text" or "bytes".');
    }

    const path = normalizePath(rawPath);
    const text = entry.files[path];
    const bytes = entry.binaries?.[path];
    if (text === undefined && bytes === undefined) {
      throw new Error(`"${rawPath}" is not in this plugin's package.`);
    }

    if (as === 'text') {
      return text !== undefined ? text : new TextDecoder().decode(bytes);
    }
    if (text !== undefined) {
      // A text file asked for as bytes. Encoded rather than refused: `.wgsl`
      // and `.json` are text in the package and bytes to whatever the plugin
      // hands them to, and making the author care which side of that line a
      // file fell on would be an implementation detail leaking into an API.
      return new TextEncoder().encode(text).buffer as ArrayBuffer;
    }
    return bytes!.slice().buffer as ArrayBuffer;
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

      case 'importResult': {
        const pending = this.exportWaiters.get(msg.id);
        if (!pending) break;
        this.exportWaiters.delete(msg.id);
        if (msg.ok) pending.resolve({ width: msg.width, height: msg.height, pixels: msg.pixels });
        else pending.reject(new Error(msg.error));
        break;
      }

      case 'exportResult': {
        const pending = this.exportWaiters.get(msg.id);
        if (!pending) break; // A reply to a step whose export was already torn down.
        this.exportWaiters.delete(msg.id);
        if (msg.ok) pending.resolve(msg.bytes);
        else pending.reject(new Error(msg.error));
        break;
      }

      case 'superviseResult': {
        const pending = this.exportWaiters.get(msg.id);
        if (!pending) break;
        this.exportWaiters.delete(msg.id);
        if (msg.ok) pending.resolve({ supervised: msg.params });
        else pending.reject(new Error(msg.error));
        break;
      }

      case 'generateResult': {
        const pending = this.exportWaiters.get(msg.id);
        // Normal, and frequent: the scheduler abandons a frame the moment the
        // playhead moves past it, so a reply to a superseded scrub arrives with
        // nobody waiting. Dropping it is the whole of "latest-wins" on this side.
        if (!pending) break;
        this.exportWaiters.delete(msg.id);
        if (msg.ok) pending.resolve({ generated: msg.value });
        else pending.reject(new Error(msg.error));
        break;
      }

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
      /*
        The chord, if the plugin asked for one AND nothing else holds it.

        Checked here rather than at parse time, because the answer depends on
        what is installed and on what the user has rebound — neither of which a
        manifest validator can see, and both of which change after install. A
        refusal is a log line, never a failed install: the command still works
        from the menu and the palette, and the user can bind their own chord in
        Customize…, which walks this registry.
      */
      const wanted = entry.manifest.contributes.shortcuts.find((s) => s.command === spec.id);
      const clash = wanted ? findShortcutClash(wanted.key, cid as unknown as string) : null;
      if (wanted && clash) this.appendLog(pid, 'warn', describeClash(wanted.chord, clash));
      getCommandRegistry().register({
        id: cid,
        label: `${entry.manifest.name}: ${spec.label}`,
        icon: spec.icon ?? 'plugin',
        ...(wanted && !clash ? { shortcut: wanted.key } : {}),
        // Deliberately NOT gated on the plugin running. A command that greys
        // out until you have started the thing it starts is a loop the user
        // cannot get into.
        enabled: () => (spec.needsSelection ? this.selectionProvider().length > 0 : true),
        execute: () => { void this.invokeCommand(pid, spec.id); },
      });
      ids.push(cid);
    }

    /*
      Tools, on ENABLE like everything else here.

      A tool has to be on the toolbar before its worker has ever run — picking
      it is the `onTool:<id>` activation event, and a tool that only appears
      once the plugin is awake can only be reached by a route that requires it
      to be awake already.
    */
    registerPluginTools(pid, entry.manifest.name, entry.manifest.contributes.tools);
    for (const tool of entry.manifest.contributes.tools) {
      const cid = asCommandId(`plugin.${pid}.tool.${tool.id}`);
      getCommandRegistry().register({
        id: cid,
        label: `${entry.manifest.name}: ${tool.label}`,
        icon: tool.icon as Command['icon'],
        enabled: () => true,
        execute: () => { this.activateToolHook?.(pid, tool.id); },
      });
      ids.push(cid);
    }

    /*
      Expression functions. Registered on enable for the same reason effects
      are: an expression using one must keep evaluating with the worker
      stopped, answering from the cache and from the declared default, rather
      than throwing in a document the user opened without touching the plugin.
    */
    for (const problem of registerPluginExpressions(pid, entry.manifest.contributes.expressions)) {
      this.appendLog(pid, 'error', problem);
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
    // And its AUDIO effects. Registered on enable like the visual ones and for
    // the same reason: an effect has to be addable to a layer before the
    // plugin's worker boots. A declared node chain needs no worker at all.
    registerAudioEffects(pid, entry.manifest.name, entry.manifest.contributes.audioEffects);
  }

  private unregisterContributions(id: string): void {
    for (const cid of this.declaredCommandIds.get(id) ?? []) getCommandRegistry().unregister(cid);
    this.declaredCommandIds.delete(id);
    // A stopped plugin's kinds must not stay creatable: a menu that offers a
    // layer nothing can drive, and a document that gains a reference to a
    // plugin the user has already turned off.
    unregisterLayerKinds(id);
    // And the geometry its generator kinds produced. Keeping it would leave a
    // stopped plugin's particles on screen — a layer that draws content nothing
    // can now regenerate, which reads as the plugin still running.
    resetGeneratorsForPlugin(id);
    // And the images it shipped, decoded from its package. This path is also
    // the developer-mode RELOAD (a re-registered plugin unregisters first), and
    // that is the case that matters: an author editing `atlas.png` and
    // reloading must see the new file, not the bitmap the app decoded at
    // startup. A stale texture after a reload looks exactly like the edit not
    // having saved.
    forgetPluginAssetTextures(id);
    // Its callbacks go with its kinds. A listener for a plugin that is no
    // longer running is a message posted into a dead worker every time a user
    // touches a layer it used to manage.
    clearLayerChangeListeners(id);
    // And its effects. A disabled plugin whose effect stayed registered would
    // keep drawing — including one the user disabled BECAUSE it was implicated
    // in a device loss, which is the case where that matters most.
    unregisterEffects(id);
    unregisterAudioEffects(id);
    /*
      And its UI. All four for the same reason, which is the one this whole
      block is about: a contribution that outlives the plugin is a control the
      user can operate and nothing can answer.

      A tool left on the toolbar swallows clicks; a drawing left in the viewport
      is chrome nothing explains; a status line is a claim from a plugin that is
      gone; an expression function would keep answering from a cache the user
      has no way to see is stale. Contributed PARAMETERS are deliberately not
      cleared — those are values in the user's document, and they read back as
      an inert, read-only section exactly as a missing layer kind's do.
    */
    unregisterPluginTools(id);
    clearPluginDrawList(id);
    clearPluginStatus(id);
    unregisterPluginExpressions(id);
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
   * One step of a plugin-driven export, awaited.
   *
   * ── Why the timeout is here and not in the sink ─────────────────────────
   *
   * The render queue awaits this, so a plugin that never answers stops the
   * queue rather than just its own export. The supervision heartbeat would
   * eventually terminate a wedged worker, but "eventually" is up to 8 seconds
   * of a user watching a progress bar that has stopped — and a terminated
   * worker never replies at all, so the promise would still be pending. So the
   * bound lives on the promise, and a step that overruns fails the export with
   * a message naming the plugin.
   *
   * Generous: an encoder doing real work on a 4K frame is not fast, and a
   * timeout that fires on a slow-but-working plugin is worse than one that
   * takes a while to catch a broken one.
   */
  private runExportStep(pluginId: string, msg: ExportStepInput): Promise<HostTaskReply> {
    const live = this.runtimes.get(pluginId);
    if (!live || live.info.status !== 'running') {
      return Promise.reject(new Error(`The plugin "${pluginId}" is not running.`));
    }
    const id = (this.exportSeq += 1);
    return new Promise<HostTaskReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.exportWaiters.has(id)) return;
        this.exportWaiters.delete(id);
        reject(new Error(`The plugin "${pluginId}" stopped responding during the export.`));
      }, EXPORT_STEP_TIMEOUT_MS);

      this.exportWaiters.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      const full = { ...msg, id } as Extract<HostMessage, { k: 'export' }>;
      try {
        live.worker.postMessage(full, collectTransferables(full));
      } catch (e) {
        this.exportWaiters.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * Drive a plugin's exporter for one export. Returned to `videoSink`.
   *
   * The plugin is STARTED if it is not already up: a user who picked the format
   * has asked for it by name, which is a stronger signal than any activation
   * event. Failing with "the plugin is not running" when the user just selected
   * it from a dropdown would be the host refusing to do the one thing it was
   * asked.
   */
  async openExport(
    pluginId: string,
    exporterId: string,
    info: { width: number; height: number; fps: number; durationSec: number; compositionName: string },
  ): Promise<{
    addFrame: (index: number, width: number, height: number, pixels: ArrayBuffer) => Promise<void>;
    finish: () => Promise<ArrayBuffer>;
    dispose: () => Promise<void>;
  }> {
    /*
      The permission gate, checked HERE rather than in `METHOD_PERMISSIONS`.

      That table gates worker→host calls, and this is the other direction: the
      host is about to push every rendered pixel of the composition INTO a
      worker. Nothing in the call table would ever run, so a reader looking
      there would find this surface ungated — which is why the check is at the
      one door frames pass through, before the plugin is even started.

      Read live from the store, like `granted` in `createHostApi`, so a
      permission the user revoked between queueing a render and running it is
      honoured rather than a set captured at install.
    */
    const entry = usePluginStore.getState().get(pluginId);
    if (!entry) throw new Error(`The plugin "${pluginId}" is not installed.`);
    if (!expandPermissions(entry.granted ?? []).has('export:frames')) {
      throw new Error(
        `"${entry.manifest.name}" needs permission to receive your rendered frames, `
        + 'which you have not granted. Turn it on under Plugins ▸ Manage Plugins… ▸ Permissions.',
      );
    }

    await this.ensureActive(pluginId);
    await this.runExportStep(pluginId, { k: 'export', exporterId, phase: 'begin', info });

    return {
      addFrame: async (index, width, height, pixels) => {
        await this.runExportStep(pluginId, { k: 'export', exporterId, phase: 'frame', index, width, height, pixels });
      },
      finish: async () => {
        const bytes = await this.runExportStep(pluginId, { k: 'export', exporterId, phase: 'finish' });
        if (!(bytes instanceof ArrayBuffer)) {
          throw new Error(`The plugin "${pluginId}" finished the export without producing a file.`);
        }
        return bytes;
      },
      dispose: async () => {
        // Best effort: this runs on the failure path, where the plugin may be
        // exactly what failed.
        try { await this.runExportStep(pluginId, { k: 'export', exporterId, phase: 'dispose' }); }
        catch { /* already broken */ }
      },
    };
  }

  /**
   * Decode one file through a plugin's importer.
   *
   * Gated on `import:files`, checked here for the same reason `openExport`
   * checks `export:frames`: this pushes data INTO a worker, so the worker→host
   * call table would never run and a reader looking there would find the
   * surface ungated.
   *
   * Starts the plugin if it is not running — the user opened a file only this
   * plugin can read, which is as explicit a request as choosing its format from
   * a dropdown.
   */
  async runImport(
    pluginId: string,
    importerId: string,
    fileName: string,
    bytes: ArrayBuffer,
  ): Promise<{ width: number; height: number; pixels: ArrayBuffer }> {
    const entry = usePluginStore.getState().get(pluginId);
    if (!entry) throw new Error(`The plugin "${pluginId}" is not installed.`);
    if (!expandPermissions(entry.granted ?? []).has('import:files')) {
      throw new Error(
        `"${entry.manifest.name}" needs permission to read files you open with it, `
        + 'which you have not granted. Turn it on under Plugins ▸ Manage Plugins… ▸ Permissions.',
      );
    }
    await this.ensureActive(pluginId);
    const reply = await this.runExportStep(pluginId, {
      k: 'import', importerId, fileName, bytes,
    } as never);
    // Narrowed by SHAPE rather than by elimination: the waiter map is shared
    // with exports and generator frames, so "not an ArrayBuffer" stopped being
    // enough to mean "decoded pixels" the moment a third reply kind existed.
    if (!reply || reply instanceof ArrayBuffer || !('pixels' in reply)) {
      throw new Error(`"${entry.manifest.name}" did not return an image for "${fileName}".`);
    }
    return reply;
  }

  /**
   * Produce one frame of a plugin's `render: "generator"` layer kind.
   *
   * ── Why this needs no permission ─────────────────────────────────────────
   *
   * `openExport` and `runImport` both check one, because both push the USER's
   * data into a worker — every rendered pixel, or a file they opened. This
   * pushes the layer's own declared properties, the composition's size and the
   * time, at a layer OF THIS PLUGIN'S OWN KIND. A plugin that can read its own
   * layer's properties has learned nothing it did not write, and `composition
   * .get` is already ungated for the same reason.
   *
   * The plugin is NOT started on demand. `openExport` does, because the user
   * picked that format by name; here the trigger is the playhead moving, and a
   * document that happens to contain a generator layer must not wake a worker
   * during playback. A stopped plugin's generator simply produces nothing and
   * the layer draws empty — which is the same thing that happens when the
   * plugin is uninstalled, and is what `render: "generator"` costs.
   */
  /**
   * Ask a running plugin what to do about one of its own controls moving.
   *
   * Does NOT start the plugin. A stopped plugin simply does not supervise, and
   * the user's own edit stands — which is the same degradation a generator
   * layer takes, and for the same reason: the trigger here is a slider, not a
   * thing the user named.
   */
  async runSupervise(
    pluginId: string,
    req: { effectId: string; instanceId: string; changed: string; params: Record<string, unknown> },
  ): Promise<Record<string, unknown> | null> {
    const live = this.runtimes.get(pluginId);
    if (!live || live.info.status !== 'running') return null;
    const reply = await this.runExportStep(pluginId, { k: 'supervise', ...req } as never);
    if (!reply || reply instanceof ArrayBuffer || !('supervised' in reply)) return null;
    return (reply as { supervised: Record<string, unknown> | null }).supervised;
  }

  async runGenerate(pluginId: string, kindId: string, request: unknown): Promise<unknown> {
    const live = this.runtimes.get(pluginId);
    if (!live || live.info.status !== 'running') {
      throw new Error(`The plugin "${pluginId}" is not running, so its generator layers cannot be drawn.`);
    }
    const reply = await this.runExportStep(pluginId, { k: 'generate', kindId, request } as never);
    if (!reply || reply instanceof ArrayBuffer || !('generated' in reply)) {
      throw new Error(`The plugin "${pluginId}" did not return a frame for "${kindId}".`);
    }
    return reply.generated;
  }

  /**
   * Tell every interested plugin that a render left the queue.
   *
   * ── Why this wakes plugins, and why that is not a leak ──────────────────
   *
   * A plugin declaring `onRenderFinished` is STARTED by one, the same way
   * `onLayerKind` starts a plugin when a document needs it. A post-render
   * action that only runs if the plugin happened to already be awake is a
   * post-render action that silently does not run, which is worse than not
   * having one.
   *
   * Gated on `scene:read`, and no new permission. Everything in the payload is
   * either the composition's own name and size — which a plugin holding
   * `scene:read` can already read whenever it likes — or the fact that a render
   * happened. Splitting that into its own consent line would ask the user to
   * make a distinction they cannot act on, when the wider grant is already the
   * one they gave.
   *
   * Fire-and-forget, and never awaited by the queue: a wedged plugin must not
   * be able to hold up the next render. A worker that is still booting misses
   * the event it was started for on purpose — delivering it after `activate()`
   * would mean the queue's timing depends on worker boot time.
   */
  notifyRenderFinished(info: RenderFinishedInfo): void {
    for (const entry of usePluginStore.getState().plugins) {
      const id = entry.manifest.id;
      if (!entry.enabled) continue;
      // `expandPermissions` because `scene:write` implies `scene:proxy`, and a
      // future implication involving `scene:read` must not silently miss here.
      if (!expandPermissions(entry.granted ?? []).has('scene:read')) continue;

      const wants = entry.manifest.activationEvents.includes('onRenderFinished');
      const live = this.runtimes.get(id);
      if (!live || live.info.status === 'stopped' || live.info.status === 'error') {
        if (wants) void this.ensureActive(id);
        continue;
      }
      try {
        live.worker.postMessage({ k: 'renderFinished', render: info } satisfies HostMessage);
      } catch { /* terminated between the check and the send */ }
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
      // A takedown has to reach the process as well as the worker. The sandbox
      // is what makes a revoked SANDBOXED plugin harmless once it is stopped;
      // a compiled one is native code in a process of its own, and leaving it
      // running would make the strongest refusal this system has the weakest.
      void killNativePlugin(id);
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

/*
  Give the generator scheduler its route to plugin code.

  Injected rather than imported from the other side, and that direction is the
  point: `generatorScheduler` is reached from `buildSnapshot`, which runs in the
  render-tests harness and in the export worker, neither of which has a plugin
  host, a store or a Worker. A scheduler that imported this file would drag all
  three into every snapshot build in the repo.

  Here, in the app graph, the wiring is one line and it happens the moment
  anything touches the host at all.
*/
setGeneratorRunner({
  generate: (pluginId, kindId, request) => pluginHost.runGenerate(pluginId, kindId, request),
});

/*
  And the route to a plugin's own packaged FILES, for the same reason and by the
  same rule: the texture cache is reached from the render path, which runs in
  the harness and the export worker with no store behind it.

  `readPackageFile` is the `package.read` implementation — the identical
  resolution, inside the identical installed payload — so the host reading a
  plugin's sprite atlas can reach exactly what the plugin itself could, and
  nothing else on the machine.
*/
setPluginAssetHost({
  read: (pluginId, path) => pluginHost.readPackageBytes(pluginId, path),
  log: (pluginId, message) => pluginHost.reportError(pluginId, message),
});

/*
  And the route for param supervision.

  Wired here for the third time for the third instance of the same reason:
  `paramSupervision` is reached from `updateEffectParam`, which the AI tools,
  the CLI and the export path all call — none of which has a plugin host. The
  orchestration (coalescing, the loop guard, filtering the answer) lives there
  and is tested over a plain function; this is the one line that makes it talk
  to a real worker.
*/
setSuperviseHandler((req) =>
  pluginHost.runSupervise(req.pluginId, {
    effectId: req.effectId,
    instanceId: req.instanceId,
    changed: req.changed,
    params: req.params,
  }),
);
export default pluginHost;
