/**
 * The supervisor: one process per native plugin, and what happens when it dies.
 *
 * ── The promise this file makes ──────────────────────────────────────────────
 *
 * A native plugin can crash, hang, refuse to load, or load and then behave
 * badly, and in every one of those cases the editor keeps rendering. That is
 * not a quality of the plugin; it is a property of this file. Everything here
 * is one of four mechanisms:
 *
 *   **Isolation.** The addon runs in an Electron `utilityProcess` — a real OS
 *   process with its own address space. A segfault in a stranger's binary ends
 *   that process and nothing else. The editor's window, the user's project and
 *   every other plugin are untouched, which is precisely what After Effects
 *   cannot say about its own plugin tier.
 *
 *   **A hard timeout.** Compiled code cannot be interrupted from outside; there
 *   is no preemption and no fuel. So a call that overruns is answered by
 *   killing the process running it. The call fails, the frame goes out with the
 *   layer unchanged, and the next call starts a fresh process.
 *
 *   **Backoff.** A process that died is not restarted on the next call, it is
 *   restarted after a delay that grows. Without this, one crash-on-load turns a
 *   scrub into a few hundred process launches, which is slower and louder than
 *   the plugin simply not working.
 *
 *   **A session disable.** After `MAX_RESTARTS` crashes the plugin's native
 *   module is off until the app restarts. A plugin that crashes three times in
 *   a row is not going to work on the fourth, and the right outcome is a clear
 *   message in its log rather than a machine that spends its afternoon starting
 *   processes.
 *
 * ── Lazy, and idle ──────────────────────────────────────────────────────────
 *
 * No process starts until something calls the plugin, and one that has not been
 * called for `idleTimeoutMs` is stopped. A user with six native plugins
 * installed and one in the comp pays for one process. The cost of being wrong
 * about this is real memory in a app that already holds a GPU device and a
 * decoder pool.
 *
 * ── What is NOT decided here ────────────────────────────────────────────────
 *
 * Whether the plugin is allowed to run at all. Trust, consent and containment
 * are `pluginNativeIpc.ts`, which hashes the file and refuses a path outside a
 * plugins root before this file is ever told about it. This one starts what it
 * is given and keeps the editor alive around it.
 */

import { checkAbi, type NativeChildMessage, type NativeChildReply } from './pluginNativeAbi';

/** The part of `UtilityProcess` this file uses. A seam for the fake in tests. */
export interface NativeProcessLike {
  postMessage(message: NativeChildMessage, transfer?: ArrayBufferLike[]): void;
  on(event: 'message', handler: (message: NativeChildReply) => void): void;
  on(event: 'exit', handler: (code: number) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  kill(): boolean;
  readonly pid?: number | undefined;
}

/** How long a killed child gets to exit before it is force-killed. */
const KILL_GRACE_MS = 2000;

/**
 * End a child for good. `UtilityProcess.kill()` sends SIGTERM on POSIX and,
 * from Electron 46, no longer escalates; a plugin stuck in native code that
 * survives it is sent SIGKILL after the grace period — only while the process
 * is verifiably still there (`pid` is undefined once it has exited, so a
 * reused pid is never hit).
 */
export function endProcess(proc: NativeProcessLike): void {
  let exited = false;
  try { proc.on('exit', () => { exited = true; }); } catch { /* no events: the pid check alone decides */ }
  try { proc.kill(); } catch { /* already gone */ }
  const timer = setTimeout(() => {
    const pid = proc.pid;
    if (exited || pid === undefined) return;
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone in between */ }
  }, KILL_GRACE_MS);
  (timer as { unref?: () => void }).unref?.();
}

export interface NativeSpawnRequest {
  pluginId: string;
  /** The package directory, which becomes the child's working directory. */
  dir: string;
}

export type NativeSpawn = (request: NativeSpawnRequest) => NativeProcessLike | null;

export interface NativePluginConfig {
  pluginId: string;
  pluginName: string;
  version: string;
  dir: string;
  /** Absolute path to the binary. Already contained and hashed by the caller. */
  binaryPath: string;
  abi: number;
  appVersion: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface NativeLoadReply {
  ok: boolean;
  code?: string;
  error?: string;
  describe?: unknown;
}

export type NativeCallReply =
  | { ok: true; result: unknown; elapsedMs: number }
  | { ok: false; code: string; error: string };

export interface NativeProcessStatus {
  pluginId: string;
  running: boolean;
  restarts: number;
  disabled: boolean;
  lastError?: string;
  startedAt?: number;
  calls: number;
}

export interface NativeHostEvent {
  type: 'ready' | 'crashed' | 'disabled' | 'stopped';
  pluginId: string;
  message?: string;
  restarts?: number;
}

/**
 * How long one call may take before the process is presumed hung.
 *
 * Eight seconds, matching the CPU kernel pool's ceiling, and for the same
 * reason: it is far longer than any interactive call and far shorter than a
 * user's patience with a frozen effect. A plugin that legitimately needs longer
 * — a first-frame model load — declares `native.timeoutMs`.
 */
export const NATIVE_CALL_TIMEOUT_MS = 8000;

/** Bounds on what a manifest may ask for. A plugin does not get to disable this. */
export const MIN_CALL_TIMEOUT_MS = 100;
export const MAX_CALL_TIMEOUT_MS = 120_000;

/** Stopped after a minute with nothing to do. */
export const NATIVE_IDLE_TIMEOUT_MS = 60_000;
export const MIN_IDLE_TIMEOUT_MS = 5_000;
export const MAX_IDLE_TIMEOUT_MS = 600_000;

/**
 * Delay before a dead process is started again, by consecutive failure.
 *
 * Quarter of a second, a second, four seconds — then the plugin is disabled for
 * the session. The first step is short because the common cause of a single
 * crash is one bad frame, and making the user wait a second for a plugin that
 * is about to work fine reads as the editor being slow.
 */
export const RESTART_BACKOFF_MS = [250, 1000, 4000];

/** Crashes before the plugin's native module is off for the session. */
export const MAX_RESTARTS = 3;

interface Pending {
  resolve: (reply: NativeCallReply) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
}

interface Entry {
  config: NativePluginConfig;
  proc: NativeProcessLike | null;
  /** Resolved once the child answered `load`. Null while there is no process. */
  ready: Promise<NativeLoadReply> | null;
  describe: unknown;
  pending: Map<number, Pending>;
  restarts: number;
  disabled: boolean;
  lastError?: string;
  startedAt?: number;
  calls: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Epoch ms before which no restart is attempted. */
  nextRetryAt: number;
}

export class NativePluginHost {
  private seq = 0;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: NativeHostEvent) => void>();

  constructor(
    private readonly spawn: NativeSpawn,
    private readonly now: () => number = () => Date.now(),
  ) {}

  onEvent(fn: (event: NativeHostEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  status(): NativeProcessStatus[] {
    return [...this.entries.values()].map((e) => ({
      pluginId: e.config.pluginId,
      running: e.proc !== null,
      restarts: e.restarts,
      disabled: e.disabled,
      calls: e.calls,
      ...(e.lastError ? { lastError: e.lastError } : {}),
      ...(e.startedAt ? { startedAt: e.startedAt } : {}),
    }));
  }

  /**
   * Register a plugin and bring its process up once, to check it.
   *
   * The process is started HERE rather than on the first call, even though
   * everything else in this file is lazy, because the answer the caller needs
   * — does this binary load, does its ABI match, what does it implement — can
   * only come from a process that ran it. The idle timer starts immediately, so
   * a plugin that is checked and then not used costs one short-lived process.
   */
  async load(config: NativePluginConfig): Promise<NativeLoadReply> {
    const existing = this.entries.get(config.pluginId);
    if (existing) {
      // A reload with a different binary is a different plugin as far as this
      // file is concerned: the old process is holding the old library mapped
      // and no amount of messaging will make it forget.
      const changed = existing.config.binaryPath !== config.binaryPath
        || existing.config.version !== config.version;
      if (changed) this.stop(existing, 'reload');
      existing.config = config;
      existing.disabled = false;
      existing.restarts = 0;
      existing.nextRetryAt = 0;
    } else {
      this.entries.set(config.pluginId, {
        config,
        proc: null,
        ready: null,
        describe: null,
        pending: new Map(),
        restarts: 0,
        disabled: false,
        calls: 0,
        idleTimer: null,
        nextRetryAt: 0,
      });
    }

    const entry = this.entries.get(config.pluginId)!;
    const reply = await this.ensure(entry);
    if (reply.ok) this.emit({ type: 'ready', pluginId: config.pluginId });
    return reply;
  }

  /**
   * Call a plugin, starting its process if it is not up.
   *
   * Never rejects. Every failure — no such plugin, disabled, still backing off,
   * crashed mid-call, timed out — comes back as `{ ok: false, code }`, because
   * the caller's job is to render a frame either way and an exception would
   * make that an error handler on the render path.
   */
  async call(
    pluginId: string,
    request: unknown,
    transfer: ArrayBufferLike[] = [],
  ): Promise<NativeCallReply> {
    const entry = this.entries.get(pluginId);
    if (!entry) {
      return { ok: false, code: 'not-declared', error: 'This plugin has no native module loaded.' };
    }
    if (entry.disabled) {
      return {
        ok: false,
        code: 'disabled',
        error: `${entry.config.pluginName}'s native module crashed repeatedly and is off for this session.`,
      };
    }

    const ready = await this.ensure(entry);
    if (!ready.ok) {
      return { ok: false, code: ready.code ?? 'failed', error: ready.error ?? 'The native module is not available.' };
    }
    const proc = entry.proc;
    if (!proc) {
      return { ok: false, code: 'crashed', error: 'The plugin\'s process stopped before the call was made.' };
    }

    const id = ++this.seq;
    entry.calls += 1;
    this.touchIdle(entry);

    const timeout = clamp(
      entry.config.timeoutMs ?? NATIVE_CALL_TIMEOUT_MS,
      MIN_CALL_TIMEOUT_MS,
      MAX_CALL_TIMEOUT_MS,
    );

    return new Promise<NativeCallReply>((resolve) => {
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        const message =
          `${entry.config.pluginName} did not answer within ${timeout} ms and its process was stopped.`;
        entry.lastError = message;
        // The only way to recover compiled code that will not return. Counted
        // as a crash, because from out here it is one: the process is gone and
        // whatever it was doing is lost.
        this.crash(entry, message);
        resolve({ ok: false, code: 'timeout', error: message });
      }, timeout);

      entry.pending.set(id, { resolve, timer, startedAt: this.now() });
      try {
        proc.postMessage({ type: 'call', id, request }, transfer);
      } catch (err) {
        clearTimeout(timer);
        entry.pending.delete(id);
        resolve({ ok: false, code: 'failed', error: (err as Error).message });
      }
    });
  }

  /** Stop a plugin's process and forget it entirely. */
  unload(pluginId: string, reason = 'unload'): void {
    const entry = this.entries.get(pluginId);
    if (!entry) return;
    this.stop(entry, reason);
    this.entries.delete(pluginId);
  }

  /** Stop everything. Called when the app quits. */
  dispose(): void {
    for (const entry of this.entries.values()) this.stop(entry, 'shutdown');
    this.entries.clear();
    this.listeners.clear();
  }

  // ── Process lifecycle ──────────────────────────────────────────────────────

  private ensure(entry: Entry): Promise<NativeLoadReply> {
    if (entry.disabled) {
      return Promise.resolve({
        ok: false,
        code: 'disabled',
        error: `${entry.config.pluginName}'s native module is off for this session.`,
      });
    }
    if (entry.ready && entry.proc) return entry.ready;

    const wait = entry.nextRetryAt - this.now();
    if (wait > 0) {
      // Still backing off. Refused rather than delayed: a render that waits
      // four seconds for a plugin that is probably broken is worse than a
      // render that goes out without it.
      return Promise.resolve({
        ok: false,
        code: 'crashed',
        error: entry.lastError
          ?? `${entry.config.pluginName}'s native module is restarting.`,
      });
    }

    entry.ready = this.start(entry);
    return entry.ready;
  }

  private start(entry: Entry): Promise<NativeLoadReply> {
    let proc: NativeProcessLike | null = null;
    try {
      proc = this.spawn({ pluginId: entry.config.pluginId, dir: entry.config.dir });
    } catch (err) {
      proc = null;
      entry.lastError = (err as Error).message;
    }
    if (!proc) {
      entry.ready = null;
      const error = entry.lastError ?? 'The plugin process could not be started.';
      return Promise.resolve({ ok: false, code: 'failed', error });
    }

    entry.proc = proc;
    entry.startedAt = this.now();
    this.touchIdle(entry);

    proc.on('message', (reply) => this.receive(entry, reply));
    proc.on('error', (err) => this.crash(entry, err.message));
    proc.on('exit', (code) => {
      if (entry.proc !== proc) return; // already replaced
      this.crash(entry, `The plugin's process exited with code ${code}.`);
    });

    const id = ++this.seq;
    return new Promise<NativeLoadReply>((resolve) => {
      const timeout = clamp(
        entry.config.timeoutMs ?? NATIVE_CALL_TIMEOUT_MS,
        MIN_CALL_TIMEOUT_MS,
        MAX_CALL_TIMEOUT_MS,
      );
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        const message = `${entry.config.pluginName}'s native module did not finish loading within ${timeout} ms.`;
        this.crash(entry, message);
        resolve({ ok: false, code: 'timeout', error: message });
      }, timeout);

      entry.pending.set(id, {
        startedAt: this.now(),
        timer,
        resolve: (reply) => {
          if (reply.ok) {
            const described = reply.result as { describe?: unknown; abi?: unknown };
            // Second opinion on the version, from the side that did not ask the
            // binary. The child checked it too; this catches a child that was
            // built against a different ABI from the main process, which is
            // exactly what a partial upgrade on disk looks like.
            const abi = checkAbi(described?.abi);
            if (!abi.ok) {
              this.stop(entry, 'abi-mismatch');
              entry.lastError = abi.error;
              resolve({ ok: false, code: 'abi-mismatch', ...(abi.error ? { error: abi.error } : {}) });
              return;
            }
            entry.describe = described?.describe ?? null;
            entry.restarts = 0;
            entry.lastError = undefined;
            resolve({ ok: true, describe: entry.describe });
            return;
          }
          entry.lastError = reply.error;
          // A module that will not load will not load on the next call either.
          // Stopping the process now means the idle timer is not holding a
          // useless one open for a minute.
          this.stop(entry, 'load-failed');
          resolve({ ok: false, code: reply.code, error: reply.error });
        },
      });

      try {
        proc.postMessage({
          type: 'load',
          id,
          binaryPath: entry.config.binaryPath,
          host: {
            abi: entry.config.abi,
            app: 'Premation',
            appVersion: entry.config.appVersion,
            pluginId: entry.config.pluginId,
            pluginVersion: entry.config.version,
            pluginDir: entry.config.dir,
          },
        });
      } catch (err) {
        clearTimeout(timer);
        entry.pending.delete(id);
        this.stop(entry, 'spawn-failed');
        resolve({ ok: false, code: 'failed', error: (err as Error).message });
      }
    });
  }

  private receive(entry: Entry, reply: NativeChildReply): void {
    if (!reply || typeof reply !== 'object') return;
    const pending = entry.pending.get(reply.id);
    if (!pending) return; // timed out already, or a duplicate
    entry.pending.delete(reply.id);
    clearTimeout(pending.timer);

    if (reply.type === 'loaded') {
      pending.resolve(
        reply.ok
          ? { ok: true, result: { abi: reply.abi, describe: reply.describe }, elapsedMs: this.now() - pending.startedAt }
          : { ok: false, code: reply.code, error: reply.error },
      );
      return;
    }
    if (reply.type === 'result') {
      pending.resolve(
        reply.ok
          ? { ok: true, result: reply.result, elapsedMs: this.now() - pending.startedAt }
          : { ok: false, code: reply.code, error: reply.error },
      );
      return;
    }
    if (reply.type === 'disposed') {
      pending.resolve({ ok: true, result: null, elapsedMs: this.now() - pending.startedAt });
    }
  }

  /**
   * The process died, or is about to be killed because it will not answer.
   *
   * Everything outstanding fails with a named reason — silently dropping them
   * would leave a render awaiting a promise that can never settle, which is the
   * one failure mode worse than a wrong frame. Then the backoff is set, and the
   * crash is counted toward the session disable.
   */
  private crash(entry: Entry, message: string): void {
    entry.lastError = message;
    const proc = entry.proc;
    entry.proc = null;
    entry.ready = null;
    if (proc) {
      endProcess(proc); // already gone, the usual case, costs nothing
    }
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }

    for (const [id, pending] of entry.pending) {
      clearTimeout(pending.timer);
      entry.pending.delete(id);
      pending.resolve({ ok: false, code: 'crashed', error: message });
    }

    entry.restarts += 1;
    if (entry.restarts >= MAX_RESTARTS) {
      entry.disabled = true;
      this.emit({
        type: 'disabled',
        pluginId: entry.config.pluginId,
        message:
          `${entry.config.pluginName}'s native module stopped ${entry.restarts} times and is off for `
          + `this session. Last failure: ${message}`,
        restarts: entry.restarts,
      });
      return;
    }

    const backoff = RESTART_BACKOFF_MS[Math.min(entry.restarts - 1, RESTART_BACKOFF_MS.length - 1)]!;
    entry.nextRetryAt = this.now() + backoff;
    this.emit({
      type: 'crashed',
      pluginId: entry.config.pluginId,
      message,
      restarts: entry.restarts,
    });
  }

  /** A clean stop: tell the addon, then end the process. Not a crash. */
  private stop(entry: Entry, reason: string): void {
    const proc = entry.proc;
    entry.proc = null;
    entry.ready = null;
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }

    for (const [id, pending] of entry.pending) {
      clearTimeout(pending.timer);
      entry.pending.delete(id);
      pending.resolve({ ok: false, code: 'failed', error: `The plugin's process was stopped (${reason}).` });
    }

    if (!proc) return;
    try {
      // Best effort. `dispose` is the addon's chance to free what it allocated;
      // the kill goes out regardless, because a plugin that will not shut down
      // does not get to keep the process.
      proc.postMessage({ type: 'dispose', id: ++this.seq });
    } catch { /* the port is already gone */ }
    endProcess(proc);
    this.emit({ type: 'stopped', pluginId: entry.config.pluginId, message: reason });
  }

  private touchIdle(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    const idle = clamp(
      entry.config.idleTimeoutMs ?? NATIVE_IDLE_TIMEOUT_MS,
      MIN_IDLE_TIMEOUT_MS,
      MAX_IDLE_TIMEOUT_MS,
    );
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.pending.size > 0) return; // a call is in flight; it will re-arm
      this.stop(entry, 'idle');
    }, idle);
    // A stopped process must not hold the app open. `unref` exists on Node's
    // timers and not on the DOM's, which is what the test environment has.
    (entry.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  private emit(event: NativeHostEvent): void {
    for (const fn of [...this.listeners]) fn(event);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
