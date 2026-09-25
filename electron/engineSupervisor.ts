/**
 * EngineSupervisor — Electron main starts, watches and restarts
 * `premation-engine` (docs/NATIVE_CORE_PLAN.md §1 and §5 C2; the export
 * supervisor's pattern, exportProcess.ts).
 *
 * Lifecycle:
 *   stopped → starting → running ⇄ restarting → … → fallback | stopped
 *
 *  - **start**: resolve the executable (env override, packaged
 *    extraResources, dev build), ask Chromium which GPU it composits on and
 *    pass its PCI vendor id (`--gpu-vendor`): shared textures only work when
 *    the engine renders on the SAME adapter — C1 measured every transfer
 *    timing out and the page's renderer crashing on a mismatch
 *    (docs/VIEWPORT_ROUTE.md). `--host-pid` lets the engine duplicate slot
 *    handles into this process. Then Hello/Welcome with a protocol-major check.
 *  - **heartbeat**: a Ping on the frame channel every second, answered by the
 *    engine's document core thread (so a pong proves the core drains its
 *    queue, not just that the process exists). No pong for `hangMs` = hung:
 *    killed and treated as a crash.
 *  - **crash** (any exit we did not ask for, a hang, a lost GPU device):
 *    restart after a backoff (250 ms, 1 s, 4 s). Each successful restart
 *    emits `engine-restarted`: the engine came back EMPTY, so the UI must
 *    resync — replay its command log / reopen the document (C3) — and every
 *    request that was in flight was rejected with EngineGoneError.
 *  - **crash loop**: `crashLoop.count` crashes inside `crashLoop.windowMs`,
 *    exit code 2 (cannot start on this machine: no GPU, no stdio), a missing
 *    executable or a protocol-major mismatch → `fallback`: the app keeps
 *    running on the TypeScript engine and the reason is surfaced once.
 *  - **stop** (app quit): Goodbye, wait up to `shutdownMs` for a clean exit,
 *    then kill.
 *
 * Everything that touches Electron or the OS is injected (`SupervisorDeps`),
 * which is what lets engineSupervisor.test.ts drive the state machine with a
 * fake child process and fake timers.
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { HelloInfo, EngineFrameMessage, WelcomeInfo, GoodbyeReason } from './engineFraming';
import { EngineGoneError, EngineGoodbyeError, EngineTransport, type EventBatchBytes } from './engineTransport';

// ── dependencies ─────────────────────────────────────────────────────────────

/** The part of a ChildProcess the supervisor uses (stdio: pipe × 5). */
export interface EngineChild {
  readonly pid?: number | undefined;
  readonly stdio: readonly [Writable | null, Readable | null, Readable | null, ...unknown[]];
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface SupervisorTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface SupervisorDeps {
  spawn(exe: string, args: string[]): EngineChild;
  /** Absolute path of premation-engine, or null when it is not installed/built. */
  resolveExe(): string | null;
  /** PCI vendor id of the GPU Chromium composits on (app.getGPUInfo); undefined when unknown. */
  gpuVendor(): Promise<number | undefined>;
  /** Electron main's pid: shared slot handles are duplicated into it. */
  hostPid: number;
  hello: HelloInfo;
  log?(level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>): void;
  timers?: SupervisorTimers;
}

export interface SupervisorOptions {
  heartbeatMs: number;
  hangMs: number;
  handshakeMs: number;
  backoffMs: readonly number[];
  crashLoop: { count: number; windowMs: number };
  shutdownMs: number;
  /** Extra engine arguments (`--no-gpu`, `--log-level debug`, `--slots 4`). */
  extraArgs: readonly string[];
  /**
   * Release every FrameReady slot at once when nobody listens for frames —
   * a headless session (tests, CLI) must not starve the ring.
   */
  autoReleaseWithoutListeners: boolean;
}

export const DEFAULT_SUPERVISOR_OPTIONS: SupervisorOptions = {
  heartbeatMs: 1000,
  hangMs: 5000,
  handshakeMs: 10_000,
  backoffMs: [250, 1000, 4000],
  crashLoop: { count: 3, windowMs: 60_000 },
  shutdownMs: 2000,
  extraArgs: [],
  autoReleaseWithoutListeners: true,
};

/** Exit codes premation-engine documents (native/engine/src/engine_process.hpp). */
export const ENGINE_EXIT = { ok: 0, cannotStart: 2, deviceLost: 3, framing: 4, exception: 70 } as const;

export type SupervisorState = 'stopped' | 'starting' | 'running' | 'restarting' | 'stopping' | 'fallback';

export interface EngineRestartedInfo {
  /** 1 for the first restart after a crash, counting within the crash window. */
  attempt: number;
  cause: 'crash' | 'hang' | 'requested';
  exitCode: number | null;
  signal: string | null;
  welcome: WelcomeInfo;
  /** Last engine log lines before the crash (for a bug report). */
  logTail: string[];
}

export interface FallbackInfo {
  reason: string;
  logTail: string[];
}

export interface SupervisorEvents {
  state: [SupervisorState];
  ready: [WelcomeInfo];
  'engine-restarted': [EngineRestartedInfo];
  fallback: [FallbackInfo];
  events: [EventBatchBytes];
  frame: [EngineFrameMessage];
  log: [string];
}

const LOG_TAIL = 60;

// ── the supervisor ───────────────────────────────────────────────────────────

export class EngineSupervisor {
  private readonly emitter = new EventEmitter();
  private readonly opts: SupervisorOptions;
  private readonly timers: SupervisorTimers;
  private state_: SupervisorState = 'stopped';
  private child: EngineChild | null = null;
  private transport: EngineTransport | null = null;
  private heartbeat: unknown = null;
  private lastPong = 0;
  private lastTick = 0;
  private nonce = 0;
  private crashes: number[] = [];
  private pendingCause: EngineRestartedInfo['cause'] | null = null;
  private lastExit: { code: number | null; signal: string | null } = { code: null, signal: null };
  private restartTimer: unknown = null;
  private stopWaiters: Array<() => void> = [];
  private killTimer: unknown = null;
  private generation = 0;  // bumps per spawned child, so a late callback of an old one is ignored
  private readonly logTail: string[] = [];
  private stderrRest = '';

  constructor(
    private readonly deps: SupervisorDeps,
    options: Partial<SupervisorOptions> = {},
  ) {
    this.opts = { ...DEFAULT_SUPERVISOR_OPTIONS, ...options };
    this.timers = deps.timers ?? {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
  }

  on<K extends keyof SupervisorEvents>(event: K, listener: (...args: SupervisorEvents[K]) => void): () => void {
    this.emitter.on(event, listener as (...a: unknown[]) => void);
    return () => this.emitter.off(event, listener as (...a: unknown[]) => void);
  }

  get state(): SupervisorState {
    return this.state_;
  }

  get welcome(): WelcomeInfo | null {
    return this.transport?.session ?? null;
  }

  /** Start the engine. Resolves when it is running, or when it fell back (see `state`). */
  start(): Promise<void> {
    if (this.state_ !== 'stopped') return Promise.resolve();
    this.crashes = [];
    return this.launch(null);
  }

  /** Relay an encoded EngineMessage{request}; resolves with the encoded response. */
  request(message: Uint8Array, timeoutMs?: number): Promise<Uint8Array> {
    if (this.state_ !== 'running' || !this.transport) {
      return Promise.reject(new EngineGoneError(`engine is ${this.state_}`));
    }
    return this.transport.request(message, timeoutMs);
  }

  releaseSlot(generation: number, slot: number): void {
    this.transport?.releaseSlot(generation, slot);
  }

  /**
   * Restart on purpose — e.g. Chromium's GPU process restarted or moved to
   * another adapter (the engine must follow it). Not counted as a crash.
   */
  restart(reason: string): void {
    if (this.state_ !== 'running' || !this.child) return;
    this.log('info', 'engine_restart_requested', { reason });
    this.pendingCause = 'requested';
    this.child.kill();
  }

  /** Clean shutdown (app quit): Goodbye, wait, then kill. */
  stop(): Promise<void> {
    if (this.restartTimer) {
      this.timers.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.child || this.state_ === 'stopped' || this.state_ === 'fallback') {
      if (this.state_ !== 'fallback') this.setState('stopped');
      return Promise.resolve();
    }
    this.setState('stopping');
    this.stopHeartbeat();
    const child = this.child;
    // Waiter and kill timer first: the exit can arrive synchronously inside goodbye().
    const done = new Promise<void>((resolve) => this.stopWaiters.push(resolve));
    this.killTimer = this.timers.setTimeout(() => {
      this.log('warn', 'engine_shutdown_timeout', { ms: this.opts.shutdownMs });
      child.kill();
    }, this.opts.shutdownMs);
    this.transport?.goodbye('app quit');
    return done;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private setState(s: SupervisorState): void {
    if (this.state_ === s) return;
    this.state_ = s;
    this.emitter.emit('state', s);
  }

  private log(level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>): void {
    this.deps.log?.(level, event, data);
  }

  private async launch(restartOf: { cause: EngineRestartedInfo['cause']; attempt: number } | null): Promise<void> {
    this.setState(restartOf ? 'restarting' : 'starting');
    const exe = this.deps.resolveExe();
    if (!exe) {
      this.fallback('premation-engine executable not found');
      return;
    }
    let vendor: number | undefined;
    try {
      vendor = await this.deps.gpuVendor();
    } catch {
      vendor = undefined;
    }
    const afterVendor: SupervisorState = this.state_;  // stop() may have run during the await
    if (afterVendor === 'stopping' || afterVendor === 'stopped') return;
    const args = ['--host-pid', String(this.deps.hostPid)];
    if (vendor) args.push('--gpu-vendor', String(vendor));
    args.push(...this.opts.extraArgs);

    const gen = ++this.generation;
    let child: EngineChild;
    try {
      child = this.deps.spawn(exe, args);
    } catch (e) {
      this.fallback(`could not start premation-engine: ${(e as Error).message}`);
      return;
    }
    this.child = child;
    this.log('info', 'engine_spawned', { exe, args, pid: child.pid });
    child.on('error', (err) => {
      if (gen !== this.generation) return;
      this.log('error', 'engine_spawn_error', { message: err.message });
      this.onExit(gen, null, 'spawn-error');
    });
    child.on('exit', (code, signal) => this.onExit(gen, code, signal));
    const [stdin, stdout, stderr] = child.stdio;
    stderr?.on('data', (d: Buffer) => this.onStderr(d));
    const framesOut = (child.stdio[3] ?? null) as Readable | null;
    const framesIn = (child.stdio[4] ?? null) as Writable | null;
    if (!stdin || !stdout) {
      this.log('error', 'engine_stdio_missing');
      child.kill();
      return;
    }
    const transport = new EngineTransport(
      { commandIn: stdin, commandOut: stdout, framesOut, framesIn },
      {
        events: (b) => this.emitter.emit('events', b),
        frame: (m) => this.onFrame(m),
        goodbye: (reason: GoodbyeReason, message: string) => this.log('warn', 'engine_goodbye', { reason, message }),
      },
    );
    this.transport = transport;

    let welcome: WelcomeInfo;
    // The handshake deadline runs on the supervisor's clock (injectable), not the transport's.
    const handshakeTimer = this.timers.setTimeout(() => {
      if (gen !== this.generation) return;
      this.log('error', 'engine_handshake_timeout', { ms: this.opts.handshakeMs });
      child.kill();
    }, this.opts.handshakeMs);
    try {
      welcome = await transport.handshake(this.deps.hello, 0);
      this.timers.clearTimeout(handshakeTimer);
    } catch (e) {
      this.timers.clearTimeout(handshakeTimer);
      if (gen !== this.generation) return;
      if (e instanceof EngineGoodbyeError && e.reason === 'versionMismatch') {
        this.fallback(`engine protocol mismatch: ${e.message}`);
        return;
      }
      this.log('error', 'engine_handshake_failed', { message: (e as Error).message });
      child.kill();  // → onExit → restart or fallback
      return;
    }
    // `state_` may have moved while the handshake was awaited (stop() during start).
    const now: SupervisorState = this.state_;
    if (gen !== this.generation || now === 'stopping' || now === 'stopped') return;
    this.setState('running');
    this.lastPong = this.timers.now();
    this.startHeartbeat(gen);
    this.log('info', 'engine_ready', { engine: welcome.engineVersion, capabilities: welcome.capabilities });
    this.emitter.emit('ready', welcome);
    if (restartOf) {
      this.emitter.emit('engine-restarted', {
        attempt: restartOf.attempt,
        cause: restartOf.cause,
        exitCode: this.lastExit.code,
        signal: this.lastExit.signal,
        welcome,
        logTail: [...this.logTail],
      });
    }
  }

  private onFrame(m: EngineFrameMessage): void {
    if (m.type === 'pong') {
      this.lastPong = this.timers.now();
      return;
    }
    if (m.type === 'frameReady' && this.opts.autoReleaseWithoutListeners && this.emitter.listenerCount('frame') === 0) {
      this.transport?.releaseSlot(m.generation, m.slot);
      return;
    }
    this.emitter.emit('frame', m);
  }

  private onStderr(d: Buffer): void {
    const text = this.stderrRest + d.toString('utf8');
    const lines = text.split(/\r?\n/);
    this.stderrRest = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      this.logTail.push(line);
      if (this.logTail.length > LOG_TAIL) this.logTail.shift();
      this.emitter.emit('log', line);
    }
  }

  private startHeartbeat(gen: number): void {
    this.stopHeartbeat();
    this.lastTick = this.timers.now();
    this.heartbeat = this.timers.setInterval(() => {
      if (gen !== this.generation || this.state_ !== 'running') return;
      const now = this.timers.now();
      // A late tick means THIS process's event loop was blocked: the engine's
      // pong may be sitting unread, so it gets a fresh window, not a kill.
      if (now - this.lastTick > 2 * this.opts.heartbeatMs) this.lastPong = now;
      this.lastTick = now;
      if (now - this.lastPong > this.opts.hangMs) {
        this.log('error', 'engine_hung', { sincePongMs: now - this.lastPong });
        this.pendingCause = 'hang';
        this.stopHeartbeat();
        this.child?.kill();
        return;
      }
      this.transport?.ping(++this.nonce);
    }, this.opts.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) this.timers.clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private onExit(gen: number, code: number | null, signal: string | null): void {
    if (gen !== this.generation) return;
    this.generation++;  // any later callback of this child is stale
    this.stopHeartbeat();
    this.child = null;
    this.transport?.close(`engine exited (code ${code}, signal ${signal})`);
    this.transport = null;
    this.lastExit = { code, signal };
    if (this.killTimer) {
      this.timers.clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    if (this.state_ === 'stopping') {
      this.log('info', 'engine_stopped', { code, signal });
      this.setState('stopped');
      for (const w of this.stopWaiters.splice(0)) w();
      return;
    }
    if (this.state_ === 'fallback' || this.state_ === 'stopped') return;

    const cause = this.pendingCause ?? 'crash';
    this.pendingCause = null;
    this.log(cause === 'requested' ? 'info' : 'error', 'engine_exited', { code, signal, cause });
    if (code === ENGINE_EXIT.cannotStart) {
      this.fallback('premation-engine cannot run on this machine (no usable GPU or stdio)');
      return;
    }
    let attempt = 0;
    if (cause !== 'requested') {
      const now = this.timers.now();
      this.crashes = this.crashes.filter((t) => now - t < this.opts.crashLoop.windowMs);
      this.crashes.push(now);
      attempt = this.crashes.length;
      if (attempt >= this.opts.crashLoop.count) {
        this.fallback(`premation-engine crashed ${attempt} times within ${this.opts.crashLoop.windowMs / 1000} s`);
        return;
      }
    }
    const delay = cause === 'requested' ? 0 : this.opts.backoffMs[Math.min(attempt - 1, this.opts.backoffMs.length - 1)] ?? 1000;
    this.setState('restarting');
    this.restartTimer = this.timers.setTimeout(() => {
      this.restartTimer = null;
      void this.launch({ cause, attempt });
    }, delay);
  }

  private fallback(reason: string): void {
    this.log('error', 'engine_fallback', { reason });
    this.stopHeartbeat();
    const child = this.child;
    this.child = null;
    this.generation++;
    this.transport?.close(reason);
    this.transport = null;
    child?.kill();
    this.setState('fallback');
    this.emitter.emit('fallback', { reason, logTail: [...this.logTail] });
  }
}

// ── real-world wiring helpers (used by main.ts; see the C2 report for the exact wiring) ──

/**
 * Where premation-engine lives:
 *   1. PREMATION_ENGINE_PATH (developer override),
 *   2. packaged: <resources>/engine/premation-engine[.exe] — electron-builder
 *      `extraResources: [{ from: native/build/<preset>/engine, to: engine, filter: [premation-engine*, *.dll] }]`
 *      (dxcompiler.dll + dxil.dll must ship beside it on Windows),
 *   3. dev: <repo>/native/build/<os>-engine/engine/.
 */
export function resolveEngineExecutable(env: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform: NodeJS.Platform;
  vars: Record<string, string | undefined>;
  exists: (p: string) => boolean;
}): string | null {
  const exe = env.platform === 'win32' ? 'premation-engine.exe' : 'premation-engine';
  const override = env.vars.PREMATION_ENGINE_PATH;
  if (override) return env.exists(override) ? override : null;
  if (env.isPackaged) {
    const p = path.join(env.resourcesPath, 'engine', exe);
    return env.exists(p) ? p : null;
  }
  const preset =
    env.platform === 'win32' ? 'windows-clang-cl-engine' : env.platform === 'darwin' ? 'macos-clang-engine' : 'linux-clang-engine';
  const p = path.join(env.appPath, 'native', 'build', preset, 'engine', exe);
  return env.exists(p) ? p : null;
}

interface GpuInfoLike {
  gpuDevice?: Array<{ active?: boolean; vendorId?: number; deviceId?: number }>;
}

/** Chromium's active GPU's PCI vendor id, from `app.getGPUInfo('complete')` (as C1's proto-host did). */
export async function chromiumGpuVendor(getGPUInfo: (level: 'complete') => Promise<unknown>): Promise<number | undefined> {
  const info = (await getGPUInfo('complete')) as GpuInfoLike;
  const devices = info.gpuDevice ?? [];
  const active = devices.find((d) => d.active) ?? devices[0];
  return active?.vendorId || undefined;
}
