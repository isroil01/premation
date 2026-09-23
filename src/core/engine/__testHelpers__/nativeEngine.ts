/**
 * The real C++ engine (`premation-engine`) for tests: spawned and supervised by
 * the SAME `EngineSupervisor` Electron main uses, and exposed as the SAME
 * `EngineBridge` the preload gives the page — so a `ProcessEngineClient` over
 * it is the production path minus Chromium's IPC.
 *
 * Present only when it has been built (`node scripts/native.mjs build
 * --engine`); `nativeEngineExe()` is null otherwise and the suites that need it
 * say so and skip. `--no-gpu` by default: deterministic simulated frame slots,
 * no adapter needed.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { EngineBridge, EngineHostState, EngineRestartNotice } from '@motion/engine-api';
// Test-only reach into the Electron main sources: the supervisor is plain Node.
import { EngineGoneError } from '../../../../electron/engineTransport';
import {
  EngineSupervisor,
  resolveEngineExecutable,
  type EngineChild,
  type SupervisorOptions,
  type SupervisorTimers,
} from '../../../../electron/engineSupervisor';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');

// Captured at import, before a suite switches on fake timers: the supervisor's
// heartbeat, handshake deadline and restart backoff must run on real time.
const realTimers: SupervisorTimers = {
  now: Date.now.bind(Date),
  setTimeout: globalThis.setTimeout.bind(globalThis) as SupervisorTimers['setTimeout'],
  clearTimeout: globalThis.clearTimeout.bind(globalThis) as SupervisorTimers['clearTimeout'],
  setInterval: globalThis.setInterval.bind(globalThis) as SupervisorTimers['setInterval'],
  clearInterval: globalThis.clearInterval.bind(globalThis) as SupervisorTimers['clearInterval'],
};

export function nativeEngineExe(): string | null {
  return resolveEngineExecutable({
    isPackaged: false,
    resourcesPath: '',
    appPath: REPO,
    platform: process.platform,
    vars: process.env,
    exists: existsSync,
  });
}

export interface NativeEngine {
  supervisor: EngineSupervisor;
  bridge: EngineBridge;
  /** Kill the running engine process (a crash, as Task Manager would). */
  kill(): void;
  /** Pid of the running engine process. */
  pid(): number | undefined;
  stop(): Promise<void>;
}

export async function startNativeEngine(options: Partial<SupervisorOptions> = {}): Promise<NativeEngine> {
  const exe = nativeEngineExe();
  if (!exe) throw new Error('premation-engine is not built');
  let child: ChildProcess | null = null;
  const supervisor = new EngineSupervisor(
    {
      spawn: (file, args) => {
        child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true });
        return child as unknown as EngineChild;
      },
      resolveExe: () => exe,
      gpuVendor: async () => undefined,
      hostPid: process.pid,
      hello: { client: 'premation-test', clientVersion: '0', capabilities: [] },
      timers: realTimers,
    },
    { extraArgs: ['--no-gpu'], ...options },
  );
  const bridge: EngineBridge = {
    request: async (bytes) => {
      try {
        return { ok: true, bytes: await supervisor.request(Uint8Array.from(bytes)) };
      } catch (e) {
        return { ok: false, reason: e instanceof EngineGoneError ? 'gone' : 'invalid', message: e instanceof Error ? e.message : String(e) };
      }
    },
    status: async () => {
      const w = supervisor.welcome;
      return { enabled: true, state: supervisor.state as EngineHostState, ...(w ? { engine: w.engine, engineVersion: w.engineVersion, revision: w.revision } : {}) };
    },
    onEvents: (h) => supervisor.on('events', (b) => h(b.bytes)),
    onState: (h) => supervisor.on('state', (s) => h(s as EngineHostState)),
    onRestarted: (h) =>
      supervisor.on('engine-restarted', (i) => h({ attempt: i.attempt, cause: i.cause, exitCode: i.exitCode, signal: i.signal, logTail: i.logTail } satisfies EngineRestartNotice)),
    onFallback: (h) => supervisor.on('fallback', (i) => h({ reason: i.reason, logTail: i.logTail })),
  };
  await supervisor.start();
  return {
    supervisor,
    bridge,
    kill: () => {
      (child as ChildProcess | null)?.kill('SIGKILL');
    },
    pid: () => (child as ChildProcess | null)?.pid,
    stop: () => supervisor.stop(),
  };
}
