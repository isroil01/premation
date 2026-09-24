/**
 * engineHost — the C++ engine process wired into the app (NATIVE_CORE_PLAN §5 C3).
 *
 * Behind a flag, default OFF: `PREMATION_ENGINE=process` in the environment,
 * or `{ "backend": "process" }` in `<userData>/engine.json`. When it is off
 * the only thing registered is `engine:status` (answers `enabled: false`), so
 * the renderer can ask without a handler error and nothing starts.
 *
 * When on:
 *  - `EngineSupervisor` (engineSupervisor.ts) starts `premation-engine` after
 *    `app` is ready, restarts it on a crash or hang, falls back after a crash
 *    loop, and restarts it on purpose when Chromium's GPU process goes away
 *    (the engine must follow Chromium's adapter — docs/VIEWPORT_ROUTE.md).
 *  - IPC, all through ipcGuard (top frame of our own page only):
 *      engine:request        invoke  encoded EngineMessage{request} → encoded response (or {ok:false})
 *      engine:status         invoke  EngineHostStatus
 *      engine:receiverReady  send    the page's sharedTexture receiver is (not) installed
 *    and pushes to the main window: engine:events (encoded EventBatch bytes),
 *    engine:state, engine:restarted, engine:fallback.
 *  - Frames: the engine's FrameSlots/FrameReady (frame channel, fd 3) become
 *    `sharedTexture.importSharedTexture` + `sendSharedTexture` into the main
 *    frame; the ring slot is released back to the engine on
 *    `allReferencesReleased`. Main NEVER closes a slot handle — the engine owns
 *    them (it duplicated them into this process and closes them itself when a
 *    ring is retired). Nothing is sent until the page says its receiver is
 *    installed: C4 measured every early send timing out.
 *
 * Main stays a relay: it never decodes a document or an event batch.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { handle, on } from './ipcGuard';
import type { EngineFrameMessage, FrameReadyMessage, SlotsMessage } from './engineFraming';
import { EngineGoneError } from './engineTransport';
import {
  EngineSupervisor,
  chromiumGpuVendor,
  resolveEngineExecutable,
  type EngineChild,
  type EngineRestartedInfo,
  type FallbackInfo,
  type SupervisorOptions,
  type SupervisorState,
} from './engineSupervisor';

/** Every channel this module registers (pinned by ipcRegistration.test.ts). */
export const ENGINE_IPC_CHANNELS = [
  'engine:receiverReady',
  'engine:request',
  'engine:status',
] as const;

/** Pushes to the renderer. */
export const ENGINE_PUSH_CHANNELS = ['engine:events', 'engine:state', 'engine:restarted', 'engine:fallback'] as const;

// ── the flag ─────────────────────────────────────────────────────────────────

/** Is the process backend on? Env wins; then the preference file; default off. */
export function engineBackendEnabled(env: Record<string, string | undefined>, prefFile: string | null, read: (p: string) => string | null = readText): boolean {
  const v = env.PREMATION_ENGINE?.trim().toLowerCase();
  if (v === 'process') return true;
  if (v === 'ts' || v === 'off' || v === 'typescript') return false;
  if (!prefFile) return false;
  const text = read(prefFile);
  if (!text) return false;
  try {
    return (JSON.parse(text) as { backend?: unknown }).backend === 'process';
  } catch {
    return false;
  }
}

function readText(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// ── shared-texture frame forwarding ─────────────────────────────────────────

/** The part of Electron's `sharedTexture` main uses (injectable for tests). */
export interface SharedTextureApi {
  importSharedTexture(options: {
    textureInfo: { pixelFormat: 'rgba'; codedSize: { width: number; height: number }; handle: { ntHandle: Buffer } };
    allReferencesReleased?: () => void;
  }): { release(): void };
  sendSharedTexture(options: { frame: unknown; importedSharedTexture: { release(): void } }, ...args: unknown[]): Promise<void>;
}

export interface FrameForwarderStats {
  forwarded: number;
  /** Released at once: no receiver yet, a transfer in flight, offscreen slots, or an unknown generation. */
  dropped: number;
  engineDropped: number;
  errors: string[];
}

/**
 * FrameReady → one shared-texture transfer into the page, at most one in
 * flight (a frame that arrives meanwhile goes straight back to the ring: drop,
 * never block). Slot handles are per ring generation AND per engine process
 * (`epoch`): a release that belongs to a dead process is never sent to its
 * successor, whose generation numbers start over.
 */
export class FrameForwarder {
  private rings = new Map<number, SlotsMessage>();
  private epoch = 0;
  private receiverReady = false;
  private inFlight = false;
  readonly stats: FrameForwarderStats = { forwarded: 0, dropped: 0, engineDropped: 0, errors: [] };

  constructor(
    private readonly deps: {
      sharedTexture: SharedTextureApi | null;
      /** The page frame to send to (the main window's main frame), or null. */
      target(): unknown;
      release(generation: number, slot: number): void;
      now?(): number;
    },
  ) {}

  /** A new engine process: forget every ring of the old one. */
  engineStarted(): void {
    this.epoch += 1;
    this.rings.clear();
    this.inFlight = false;
  }

  setReceiverReady(ready: boolean): void {
    this.receiverReady = ready;
  }

  get ready(): boolean {
    return this.receiverReady;
  }

  onFrame(m: EngineFrameMessage): void {
    if (m.type === 'slots') {
      // A new ring retires every older generation of this process.
      this.rings.clear();
      this.rings.set(m.generation, m);
      return;
    }
    if (m.type === 'frameReady') this.onFrameReady(m);
  }

  private onFrameReady(f: FrameReadyMessage): void {
    this.stats.engineDropped += f.dropped;
    const ring = this.rings.get(f.generation);
    const handle = ring?.handles[f.slot];
    const target = this.deps.target();
    const st = this.deps.sharedTexture;
    if (!ring || !ring.shared || !handle || !st || !target || !this.receiverReady || this.inFlight) {
      this.stats.dropped += 1;
      this.deps.release(f.generation, f.slot);
      return;
    }
    const epoch = this.epoch;
    const releaseOnce = (() => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        if (epoch === this.epoch) this.deps.release(f.generation, f.slot);
      };
    })();
    this.inFlight = true;
    let imported: { release(): void };
    try {
      const nt = Buffer.alloc(8);
      nt.writeBigUInt64LE(BigInt(handle));
      imported = st.importSharedTexture({
        textureInfo: { pixelFormat: 'rgba', codedSize: { width: f.width, height: f.height }, handle: { ntHandle: nt } },
        allReferencesReleased: releaseOnce,
      });
    } catch (e) {
      this.inFlight = false;
      this.fail(e);
      releaseOnce();
      return;
    }
    const meta = {
      viewport: f.viewport, generation: f.generation, slot: f.slot, frame: f.frame, time: f.time, revision: f.revision,
      width: f.width, height: f.height, dropped: f.dropped, renderStartUs: f.renderStartUs, renderDoneUs: f.renderDoneUs,
      sentUs: (this.deps.now?.() ?? Date.now()) * 1000,
    };
    st.sendSharedTexture({ frame: target, importedSharedTexture: imported }, meta)
      .then(() => {
        this.stats.forwarded += 1;
      })
      .catch((e: unknown) => {
        this.fail(e);
      })
      .finally(() => {
        // Main's reference goes; the slot is freed once the page's goes too
        // (allReferencesReleased). A failed send leaves only ours: this frees it.
        try {
          imported.release();
        } catch (e) {
          this.fail(e);
        }
        if (epoch === this.epoch) this.inFlight = false;
      });
  }

  private fail(e: unknown): void {
    this.stats.errors.push(e instanceof Error ? e.message : String(e));
    if (this.stats.errors.length > 20) this.stats.errors.shift();
  }
}

// ── the host ─────────────────────────────────────────────────────────────────

export interface EngineHostOptions {
  enabled: boolean;
  isDev: boolean;
  isPackaged: boolean;
  resourcesPath: string;
  /** Repo root in development (for native/build/<preset>/engine). */
  appPath: string;
  hostPid: number;
  appVersion: string;
  getGPUInfo(level: 'complete'): Promise<unknown>;
  getWindow(): BrowserWindow | null;
  sharedTexture: SharedTextureApi | null;
  supervisor?: Partial<SupervisorOptions>;
  /** G1: the native plugin folder (bundles with premation-plugin.json) the engine scans. */
  nativePluginDir?: string;
  /** G1: the plugin crash journal — a plugin that killed the engine is quarantined at the next start. */
  nativePluginJournal?: string;
  log?(line: string): void;
}

/**
 * The engine's plugin arguments (G1, docs/PLUGIN_SDK.md). The engine process
 * hosts native SDK plugins itself; `PREMATION_PLUGIN_PATH` adds folders on its side.
 */
export function nativePluginArgs(dir: string | undefined, journal: string | undefined): string[] {
  const args: string[] = [];
  if (dir) args.push('--plugins', dir);
  if (journal) args.push('--plugin-journal', journal);
  return args;
}

export interface EngineHostStatusReply {
  enabled: boolean;
  state: SupervisorState | 'disabled';
  engine?: string;
  engineVersion?: string;
  revision?: number;
  fallbackReason?: string;
}

export class EngineHost {
  readonly supervisor: EngineSupervisor | null;
  readonly frames: FrameForwarder;
  private fallbackReason: string | undefined;

  constructor(private readonly o: EngineHostOptions) {
    this.frames = new FrameForwarder({
      sharedTexture: o.sharedTexture,
      target: () => {
        const w = o.getWindow();
        return w && !w.isDestroyed() ? w.webContents.mainFrame : null;
      },
      release: (g, s) => this.supervisor?.releaseSlot(g, s),
    });
    if (!o.enabled) {
      this.supervisor = null;
      return;
    }
    const log = o.log ?? ((line: string) => console.info(line));
    this.supervisor = new EngineSupervisor(
      {
        spawn: (exe, args) =>
          spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true }) as unknown as EngineChild,
        resolveExe: () =>
          resolveEngineExecutable({
            isPackaged: o.isPackaged,
            resourcesPath: o.resourcesPath,
            appPath: o.appPath,
            platform: process.platform,
            vars: process.env,
            exists: existsSync,
          }),
        gpuVendor: () => chromiumGpuVendor(o.getGPUInfo),
        hostPid: o.hostPid,
        hello: { client: 'premation-ui', clientVersion: o.appVersion, capabilities: ['frames.sharedTexture'] },
        log: (level, event, data) => log(`[engine] ${level} ${event}${data ? ` ${JSON.stringify(data)}` : ''}`),
      },
      {
        ...o.supervisor,
        extraArgs: [...(o.supervisor?.extraArgs ?? []), ...nativePluginArgs(o.nativePluginDir, o.nativePluginJournal)],
      },
    );
    const sup = this.supervisor;
    sup.on('ready', () => this.frames.engineStarted());
    sup.on('frame', (m) => this.frames.onFrame(m));
    sup.on('events', (b) => this.push('engine:events', b.bytes));
    sup.on('state', (s) => this.push('engine:state', s));
    sup.on('engine-restarted', (info: EngineRestartedInfo) =>
      this.push('engine:restarted', { attempt: info.attempt, cause: info.cause, exitCode: info.exitCode, signal: info.signal, logTail: info.logTail.slice(-20) }),
    );
    sup.on('fallback', (info: FallbackInfo) => {
      this.fallbackReason = info.reason;
      this.push('engine:fallback', { reason: info.reason, logTail: info.logTail.slice(-20) });
    });
    if (o.isDev) {
      // Engine warnings and errors in the terminal (its stderr is JSON lines).
      sup.on('log', (line) => {
        if (/"level":"(warn|error)"/.test(line)) log(`[premation-engine] ${line}`);
      });
    }
  }

  get enabled(): boolean {
    return this.supervisor !== null;
  }

  start(): Promise<void> {
    return this.supervisor?.start() ?? Promise.resolve();
  }

  /** Clean shutdown (before-quit): Goodbye, then the supervisor's kill timer. */
  stop(): Promise<void> {
    return this.supervisor?.stop() ?? Promise.resolve();
  }

  /** Chromium's GPU process went away: the engine follows it onto the (possibly new) adapter. */
  gpuProcessGone(reason: string): void {
    this.supervisor?.restart(`chromium GPU process gone (${reason})`);
  }

  /** The page (re)loaded or went away: its receiver is gone until it says otherwise. */
  pageReset(): void {
    this.frames.setReceiverReady(false);
  }

  status(): EngineHostStatusReply {
    const sup = this.supervisor;
    if (!sup) return { enabled: false, state: 'disabled' };
    const w = sup.welcome;
    return {
      enabled: true,
      state: sup.state,
      ...(w ? { engine: w.engine, engineVersion: w.engineVersion, revision: w.revision } : {}),
      ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}),
    };
  }

  async request(bytes: Uint8Array): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: 'gone' | 'disabled' | 'invalid'; message: string }> {
    const sup = this.supervisor;
    if (!sup) return { ok: false, reason: 'disabled', message: 'the engine process backend is switched off' };
    if (!(bytes instanceof Uint8Array)) return { ok: false, reason: 'invalid', message: 'engine:request takes the encoded request bytes' };
    try {
      // Copy: the IPC buffer is not ours to keep while the pipe write is pending.
      const res = await sup.request(Uint8Array.from(bytes));
      return { ok: true, bytes: res };
    } catch (e) {
      if (e instanceof EngineGoneError) return { ok: false, reason: 'gone', message: e.message };
      return { ok: false, reason: 'invalid', message: e instanceof Error ? e.message : String(e) };
    }
  }

  private push(channel: (typeof ENGINE_PUSH_CHANNELS)[number], payload: unknown): void {
    const w = this.o.getWindow();
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
    w.webContents.send(channel, payload);
  }
}

/** Register the engine channels. `engine:status` always; the rest only when the host is enabled. */
export function registerEngineIpc(host: EngineHost): void {
  handle('engine:status', () => host.status());
  if (!host.enabled) return;
  handle('engine:request', (_e: IpcMainInvokeEvent, bytes: Uint8Array) => host.request(bytes));
  on('engine:receiverReady', (_e: IpcMainEvent, ready: boolean) => host.frames.setReceiverReady(ready === true));
}

/** `<userData>/engine.json` — the persistent switch (`{ "backend": "process" }`). */
export function enginePreferenceFile(userData: string): string {
  return path.join(userData, 'engine.json');
}
