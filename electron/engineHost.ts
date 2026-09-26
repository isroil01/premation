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
import { peekEnvelope, withCausedBy, withEnvelopeSeq, type EngineFrameMessage, type FrameGeometryMessage, type FrameReadyMessage, type SlotsMessage } from './engineFraming';
import { EngineCommandLog } from './engineCommandLog';
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

/**
 * F2 (NATIVE_CORE_PLAN §5 Phase F): does the ENGINE own the document — the
 * editor's New / Open / Save / Revert / autosave / recovery go through engine
 * requests, the page holding only the mirror? Needs the process backend on.
 * `PREMATION_ENGINE_OWNER=engine` (or `ui`) wins; then `{ "owner": "engine" }`
 * in the preference file; default off — the TypeScript engine stays the owner
 * for one release (the plan's F2 row).
 */
export function engineOwnsDocument(env: Record<string, string | undefined>, prefFile: string | null, read: (p: string) => string | null = readText): boolean {
  if (!engineBackendEnabled(env, prefFile, read)) return false;
  const v = env.PREMATION_ENGINE_OWNER?.trim().toLowerCase();
  if (v === 'engine') return true;
  if (v === 'ui' || v === 'ts' || v === 'off') return false;
  if (!prefFile) return false;
  const text = read(prefFile);
  if (!text) return false;
  try {
    return (JSON.parse(text) as { owner?: unknown }).owner === 'engine';
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
      this.geometry = null;
      return;
    }
    if (m.type === 'geometry') {
      this.onGeometry(m);
      return;
    }
    if (m.type === 'frameReady') this.onFrameReady(m);
  }

  /**
   * B4 round 2: the overlay geometry of the NEXT FrameReady (setOverlayGeometry) —
   * collected over its parts, then handed to the page WITH that frame (its meta),
   * so the overlays draw the geometry of the very frame they are drawn over.
   */
  private geometry: { viewport: number; generation: number; frame: number; layers: FrameGeometryMessage['layers']; complete: boolean } | null = null;

  private onGeometry(g: FrameGeometryMessage): void {
    const cur = this.geometry;
    const same = cur !== null && !cur.complete && cur.viewport === g.viewport && cur.generation === g.generation && cur.frame === g.frame;
    this.geometry = same
      ? { ...cur, layers: [...cur.layers, ...g.layers], complete: g.last }
      : { viewport: g.viewport, generation: g.generation, frame: g.frame, layers: [...g.layers], complete: g.last };
  }

  /** The collected geometry for `f` (and forget it): only a complete set for this very frame. */
  private takeGeometry(f: FrameReadyMessage): FrameGeometryMessage['layers'] | undefined {
    const g = this.geometry;
    this.geometry = null;
    return g && g.complete && g.viewport === f.viewport && g.generation === f.generation && g.frame === f.frame ? g.layers : undefined;
  }

  private onFrameReady(f: FrameReadyMessage): void {
    this.stats.engineDropped += f.dropped;
    const geometry = this.takeGeometry(f);
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
      ...(geometry ? { geometry } : {}),
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
  /** F2: the engine owns the document (engineOwnsDocument); reported in `engine:status`. */
  ownsDocument?: boolean;
  isDev: boolean;
  isPackaged: boolean;
  resourcesPath: string;
  /** Repo root in development (for native/build/<preset>/engine). */
  appPath: string;
  hostPid: number;
  appVersion: string;
  getGPUInfo(level: 'complete'): Promise<unknown>;
  getWindow(): BrowserWindow | null;
  /**
   * F2: every window that mirrors the engine (the main window and its pop-outs).
   * Events and notices go to each; frames only to `getWindow()`. Default: the
   * main window alone.
   */
  getWindows?(): BrowserWindow[];
  /** F2: keep the command log here and replay it into a restarted engine (default true). */
  recordLog?: boolean;
  sharedTexture: SharedTextureApi | null;
  supervisor?: Partial<SupervisorOptions>;
  /** G1: the native plugin folder (bundles with premation-plugin.json) the engine scans. */
  nativePluginDir?: string;
  /** G1: the plugin crash journal — a plugin that killed the engine is quarantined at the next start. */
  nativePluginJournal?: string;
  /** F2 / D5: the recovery copy the engine-owned document's autosave writes (reported with ownsDocument). */
  recoveryPath?: string;
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
  /** F2: the engine owns the document (the page's lifecycle goes through engine requests). */
  ownsDocument?: boolean;
  /** F2 / D5: where autosave writes the recovery copy (with ownsDocument). */
  recoveryPath?: string;
  /** F2: main keeps the command log and replays it after a restart (renderer clients record none). */
  hostCommandLog?: boolean;
}

/** Where a request came from: the webContents id of the window that sent it. */
export type EngineRequestSender = number;

interface InFlight {
  sender: EngineRequestSender | undefined;
  seq: number;
}

/** What the renderer is told after a restart the HOST recovered (the renderer client must not replay). */
export interface HostRecoveryInfo {
  replayedByHost: true;
  replayed: number;
  mismatches: number;
  ms: number;
}

export class EngineHost {
  readonly supervisor: EngineSupervisor | null;
  readonly frames: FrameForwarder;
  private fallbackReason: string | undefined;
  /** F2: the engine's command log (engineCommandLog.ts), replayed by main after a restart. */
  readonly commandLog: EngineCommandLog;
  /** Main's seq space on the engine connection: every window's requests renumbered. */
  private hostSeq = 0;
  private readonly inFlight = new Map<number, InFlight>();
  /** While a restarted engine is being replayed into: requests wait, events are not relayed. */
  private recovering: Promise<void> | null = null;
  private lastRecovery: HostRecoveryInfo | null = null;

  constructor(private readonly o: EngineHostOptions) {
    this.commandLog = new EngineCommandLog(o.recordLog ?? true);
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
    sup.on('events', (b) => this.relayEvents(b.bytes, b.causedBy));
    sup.on('state', (s) => this.push('engine:state', s));
    sup.on('engine-restarted', (info: EngineRestartedInfo) => void this.recoverRestarted(info));
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
      ...(this.o.ownsDocument ? { ownsDocument: true, ...(this.o.recoveryPath ? { recoveryPath: this.o.recoveryPath } : {}) } : {}),
      ...((this.o.recordLog ?? true) ? { hostCommandLog: true } : {}),
    };
  }

  /** The last restart main recovered by replaying its command log (HUD, tests). */
  get recovery(): HostRecoveryInfo | null {
    return this.lastRecovery;
  }

  /**
   * One request from a window. F2: main is the engine's ONE client — the
   * window's `seq` is renumbered into main's space (two windows both number
   * from 1), the response is renumbered back, and the applied request goes on
   * the command log. Requests wait while a restarted engine is being replayed.
   */
  async request(bytes: Uint8Array, sender?: EngineRequestSender): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: 'gone' | 'disabled' | 'invalid'; message: string }> {
    const sup = this.supervisor;
    if (!sup) return { ok: false, reason: 'disabled', message: 'the engine process backend is switched off' };
    if (!(bytes instanceof Uint8Array)) return { ok: false, reason: 'invalid', message: 'engine:request takes the encoded request bytes' };
    const peek = peekEnvelope(bytes);
    if (!peek || peek.kind !== 'request' || peek.seq === undefined) return { ok: false, reason: 'invalid', message: 'not an encoded EngineMessage{request}' };
    while (this.recovering) await this.recovering;
    this.hostSeq += 1;
    const seq = this.hostSeq;
    // A copy either way: the IPC buffer is not ours to keep while the pipe write is pending.
    const out = withEnvelopeSeq(bytes, seq);
    if (!out) return { ok: false, reason: 'invalid', message: 'not an encoded EngineMessage{request}' };
    this.inFlight.set(seq, { sender, seq: peek.seq });
    try {
      const res = await sup.request(out);
      const revision = peekEnvelope(res)?.revision ?? 0;
      this.commandLog.record(out, res, revision);
      return { ok: true, bytes: withEnvelopeSeq(res, peek.seq) ?? res };
    } catch (e) {
      if (e instanceof EngineGoneError) return { ok: false, reason: 'gone', message: e.message };
      return { ok: false, reason: 'invalid', message: e instanceof Error ? e.message : String(e) };
    } finally {
      // The response comes after its events (§8.1): nothing can still name this seq.
      this.inFlight.delete(seq);
    }
  }

  /**
   * An event batch to every mirror window. `causedBy` is main's seq: the window
   * that sent the request gets its own seq back; every other window gets the
   * batch without it and a `foreign` mark (its page replica refreshes).
   */
  private relayEvents(bytes: Uint8Array, causedBy: number | undefined): void {
    if (this.recovering) return;  // the documentReset{engineRestarted} after the replay covers these
    const origin = causedBy !== undefined ? this.inFlight.get(causedBy) : undefined;
    for (const w of this.windows()) {
      const mine = origin !== undefined && origin.sender !== undefined && origin.sender === w.webContents.id;
      const own = origin !== undefined && (mine || origin.sender === undefined);
      const payload = causedBy === undefined ? bytes : (withCausedBy(bytes, own ? origin!.seq : null) ?? bytes);
      w.webContents.send('engine:events', payload, { foreign: causedBy !== undefined && !own });
    }
  }

  /**
   * The engine came back EMPTY: replay the command log into it before any
   * window's request, then tell every window (with `replayedByHost`, so no
   * renderer client replays its own copy).
   */
  private async recoverRestarted(info: EngineRestartedInfo): Promise<void> {
    const sup = this.supervisor;
    const notice = { attempt: info.attempt, cause: info.cause, exitCode: info.exitCode, signal: info.signal, logTail: info.logTail.slice(-20) };
    if (!sup || (this.o.recordLog ?? true) === false) {
      this.push('engine:restarted', notice);
      return;
    }
    let done!: () => void;
    const gate = new Promise<void>((resolve) => { done = resolve; });
    this.recovering = gate;
    const t0 = Date.now();
    let replayed = 0;
    let mismatches = 0;
    try {
      for (const rec of this.commandLog.plan()) {
        if (sup.state !== 'running') break;  // crashed again mid-replay: the next restart starts over
        try {
          const res = await sup.request(rec.bytes);
          replayed += 1;
          if (peekEnvelope(res)?.revision !== rec.revisionAfter) mismatches += 1;
        } catch {
          mismatches += 1;
          break;
        }
      }
    } finally {
      this.recovering = null;
      done();
    }
    this.lastRecovery = { replayedByHost: true, replayed, mismatches, ms: Date.now() - t0 };
    this.push('engine:restarted', { ...notice, ...this.lastRecovery });
  }

  private windows(): BrowserWindow[] {
    const list = this.o.getWindows?.() ?? [this.o.getWindow()].filter((w): w is BrowserWindow => w !== null);
    return list.filter((w) => !w.isDestroyed() && !w.webContents.isDestroyed());
  }

  private push(channel: (typeof ENGINE_PUSH_CHANNELS)[number], payload: unknown): void {
    for (const w of this.windows()) w.webContents.send(channel, payload);
  }
}

/** Register the engine channels. `engine:status` always; the rest only when the host is enabled. */
export function registerEngineIpc(host: EngineHost): void {
  handle('engine:status', () => host.status());
  if (!host.enabled) return;
  handle('engine:request', (e: IpcMainInvokeEvent, bytes: Uint8Array) => host.request(bytes, e.sender.id));
  on('engine:receiverReady', (_e: IpcMainEvent, ready: boolean) => host.frames.setReceiverReady(ready === true));
}

/** `<userData>/engine.json` — the persistent switch (`{ "backend": "process" }`). */
export function enginePreferenceFile(userData: string): string {
  return path.join(userData, 'engine.json');
}
