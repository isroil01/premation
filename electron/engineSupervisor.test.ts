// EngineSupervisor's state machine against a FAKE engine child: spawn args,
// handshake, heartbeat, crash → restart with backoff, hang detection, crash
// loop → fallback, cannot-start, version mismatch, requested restart, clean
// shutdown. The real process is exercised by engineTransport.test.ts.

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { codecs, decodeEngineMessage, encodeEngineMessage, type EngineMessage } from '@motion/engine-api';
import { FrameDecoder, frame } from './engineFraming';
import { EngineGoneError } from './engineTransport';
import {
  EngineSupervisor,
  chromiumGpuVendor,
  resolveEngineExecutable,
  type EngineChild,
  type EngineRestartedInfo,
  type FallbackInfo,
  type SupervisorState,
  type SupervisorTimers,
} from './engineSupervisor';

type Behaviour = {
  /** Answer Hello with Welcome (default) / Goodbye{versionMismatch} / nothing. */
  hello?: 'welcome' | 'mismatch' | 'silent';
  /** Answer pings. */
  pong?: boolean;
  /** Exit with this code right after spawning. */
  exitAtOnce?: number;
  /** Ignore Goodbye (forces the shutdown kill). */
  ignoreGoodbye?: boolean;
};

/** A child that behaves like premation-engine on its pipes. */
class FakeEngine extends EventEmitter implements EngineChild {
  readonly pid = 4242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly fd3 = new PassThrough();
  readonly fd4 = new PassThrough();
  readonly stdio: EngineChild['stdio'];
  killed = false;
  received: EngineMessage[] = [];
  releases: Array<[number, number]> = [];
  private exited = false;

  constructor(
    readonly args: string[],
    readonly b: Behaviour,
  ) {
    super();
    this.stdio = [this.stdin, this.stdout, this.stderr, this.fd3, this.fd4];
    const cmd = new FrameDecoder();
    this.stdin.on('data', (c: Buffer) => {
      for (const m of cmd.push(c)) this.onMessage(decodeEngineMessage(m));
    });
    const fr = new FrameDecoder();
    this.fd4.on('data', (c: Buffer) => {
      for (const p of fr.push(c)) {
        const m = codecs.FrameChannelMessage.decode(p);
        if (m.type === 'ping' && this.b.pong !== false) this.pong(m.nonce);
        if (m.type === 'release') this.releases.push([m.generation, m.slot]);
      }
    });
    if (b.exitAtOnce !== undefined) queueMicrotask(() => this.exit(b.exitAtOnce!, null));
  }

  private send(m: EngineMessage) {
    this.stdout.write(frame(encodeEngineMessage(m)));
  }

  private onMessage(m: EngineMessage) {
    this.received.push(m);
    if (m.kind === 'hello') {
      if (this.b.hello === 'silent') return;
      if (this.b.hello === 'mismatch') {
        this.send({ kind: 'goodbye', value: { reason: 'versionMismatch', message: 'protocol 9 not supported' } });
        return;
      }
      this.send({ kind: 'welcome', value: { protocolMajor: 1, protocolMinor: 0, engine: 'premation-engine', engineVersion: 'fake', revision: 0, sessionId: 's', capabilities: [] } });
    } else if (m.kind === 'request') {
      this.send({ kind: 'response', value: { seq: m.value.seq, revision: 0, outcome: { kind: 'error', value: { code: 'unsupported', message: 'fake' } } } });
    } else if (m.kind === 'goodbye' && !this.b.ignoreGoodbye) {
      this.exit(0, null);
    }
  }

  pong(nonce: number) {
    this.fd3.write(frame(codecs.FrameChannelMessage.encode({ type: 'pong', nonce, revision: 0, playing: false, queued: 0 })));
  }

  frameReady(generation: number, slot: number) {
    this.fd3.write(
      frame(
        codecs.FrameChannelMessage.encode({
          type: 'frameReady', generation, slot, viewport: 1, dropped: 0, frame: 0, time: 0, revision: 0, renderStartUs: 0, renderDoneUs: 0, width: 16, height: 16,
        }),
      ),
    );
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.exit(null, 'SIGTERM'));
    return true;
  }

  exit(code: number | null, signal: string | null) {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.emit('exit', code, signal);
  }
}

/** Manual clock: timers fire only when `advance` passes them. */
class ManualTimers implements SupervisorTimers {
  private t = 0;
  private next = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void; every: number }>();
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, fn, every: 0 });
    return id;
  }
  clearTimeout(h: unknown) {
    this.timers.delete(h as number);
  }
  setInterval(fn: () => void, ms: number) {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, fn, every: ms });
    return id;
  }
  clearInterval(h: unknown) {
    this.timers.delete(h as number);
  }
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      await flush();
      let id = -1;
      let at = Infinity;
      for (const [k, v] of this.timers) {
        if (v.at <= end && v.at < at) {
          at = v.at;
          id = k;
        }
      }
      if (id < 0) break;
      const timer = this.timers.get(id)!;
      this.t = timer.at;
      if (timer.every > 0) timer.at += timer.every;
      else this.timers.delete(id);
      timer.fn();
    }
    this.t = end;
    await flush();
  }
  /** A blocked event loop: time passes, due timers fire once, late. */
  stall(ms: number) {
    this.t += ms;
    for (const v of this.timers.values()) v.at = Math.max(v.at, this.t);
  }
}

/** Let stream deliveries (nextTick) and promise chains settle. */
async function flush() {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => process.nextTick(r));
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => process.nextTick(r));
}

function setup(behaviours: Behaviour[] = [], opts: { exe?: string | null } = {}) {
  const timers = new ManualTimers();
  const spawned: FakeEngine[] = [];
  const states: SupervisorState[] = [];
  const restarts: EngineRestartedInfo[] = [];
  const fallbacks: FallbackInfo[] = [];
  const sup = new EngineSupervisor({
    spawn: (_exe, args) => {
      const e = new FakeEngine(args, behaviours[spawned.length] ?? behaviours[behaviours.length - 1] ?? {});
      spawned.push(e);
      return e;
    },
    resolveExe: () => (opts.exe === undefined ? '/fake/premation-engine' : opts.exe),
    gpuVendor: async () => 0x10de,
    hostPid: 777,
    hello: { client: 'premation-ui', clientVersion: 'test', capabilities: ['frames.sharedTexture'] },
    timers,
  });
  sup.on('state', (s) => states.push(s));
  sup.on('engine-restarted', (i) => restarts.push(i));
  sup.on('fallback', (f) => fallbacks.push(f));
  return { sup, timers, spawned, states, restarts, fallbacks };
}

function requestBytes(seq: number) {
  return encodeEngineMessage({ kind: 'request', value: { seq, body: { kind: 'command', value: { type: 'undo' } }, origin: 'ui' } });
}

describe('EngineSupervisor', () => {
  it('spawns on Chromium\'s GPU, handshakes and relays requests', async () => {
    const { sup, spawned } = setup();
    await sup.start();
    expect(sup.state).toBe('running');
    expect(spawned[0]!.args).toEqual(['--host-pid', '777', '--gpu-vendor', String(0x10de)]);
    const hello = spawned[0]!.received[0]!;
    expect(hello.kind).toBe('hello');
    expect(hello.kind === 'hello' && hello.value.capabilities).toEqual(['frames.sharedTexture']);
    const res = decodeEngineMessage(await sup.request(requestBytes(1)));
    expect(res.kind).toBe('response');
  });

  it('restarts a crashed engine after a backoff and tells the UI to resync', async () => {
    const { sup, timers, spawned, restarts } = setup();
    await sup.start();
    spawned[0]!.stderr.write('{"lvl":"error","ev":"about to crash"}\n');
    spawned[0]!.stdin.pause();  // the in-flight request will never be answered
    const inflight = sup.request(requestBytes(9));
    await flush();
    spawned[0]!.exit(null, 'SIGSEGV');
    await expect(inflight).rejects.toBeInstanceOf(EngineGoneError);
    expect(sup.state).toBe('restarting');
    await expect(sup.request(requestBytes(10))).rejects.toBeInstanceOf(EngineGoneError);
    await timers.advance(249);
    expect(spawned).toHaveLength(1);
    await timers.advance(1);
    expect(spawned).toHaveLength(2);
    expect(sup.state).toBe('running');
    expect(restarts).toHaveLength(1);
    expect(restarts[0]).toMatchObject({ attempt: 1, cause: 'crash', signal: 'SIGSEGV' });
    expect(restarts[0]!.logTail.join('\n')).toMatch(/about to crash/);
  });

  it('kills and restarts an engine that stops answering the heartbeat', async () => {
    const { sup, timers, spawned, restarts } = setup([{ pong: false }, {}]);
    await sup.start();
    await timers.advance(4000);
    expect(spawned[0]!.killed).toBe(false);
    await timers.advance(2500);
    expect(spawned[0]!.killed).toBe(true);
    await timers.advance(300);
    expect(sup.state).toBe('running');
    expect(restarts[0]!.cause).toBe('hang');
  });

  it('a stall of the host\'s own event loop is not blamed on the engine', async () => {
    const { sup, timers, spawned } = setup([{}, { pong: false }]);
    await sup.start();
    timers.stall(7000);
    await timers.advance(3000);
    expect(spawned[0]!.killed).toBe(false);
    expect(sup.state).toBe('running');
  });

  it('a hung engine is still killed after a host stall', async () => {
    const { sup, timers, spawned } = setup([{ pong: false }, {}]);
    await sup.start();
    timers.stall(7000);
    await timers.advance(1);
    expect(spawned[0]!.killed).toBe(false);
    await timers.advance(6000);
    expect(spawned[0]!.killed).toBe(true);
  });

  it('a healthy engine answering pings is never killed', async () => {
    const { sup, timers, spawned } = setup();
    await sup.start();
    await timers.advance(60_000);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.killed).toBe(false);
  });

  it('falls back to the TS engine after a crash loop', async () => {
    const { sup, timers, spawned, fallbacks } = setup();
    await sup.start();
    spawned[0]!.exit(70, null);
    await timers.advance(250);
    spawned[1]!.exit(70, null);
    await timers.advance(1000);
    spawned[2]!.exit(70, null);
    await timers.advance(10_000);
    expect(spawned).toHaveLength(3);
    expect(sup.state).toBe('fallback');
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.reason).toMatch(/crashed 3 times/);
  });

  it('crashes far apart are not a loop', async () => {
    const { sup, timers, spawned } = setup();
    await sup.start();
    for (let i = 0; i < 4; i++) {
      spawned[i]!.exit(3, null);  // device lost
      await timers.advance(61_000);
    }
    expect(sup.state).toBe('running');
    expect(spawned).toHaveLength(5);
  });

  it('exit code 2 (cannot run here) falls back at once', async () => {
    const { sup, spawned, fallbacks } = setup([{ exitAtOnce: 2 }]);
    await sup.start();
    await flush();
    expect(spawned).toHaveLength(1);
    expect(sup.state).toBe('fallback');
    expect(fallbacks[0]!.reason).toMatch(/cannot run/);
  });

  it('a protocol-major mismatch falls back without retrying', async () => {
    const { sup, spawned, fallbacks } = setup([{ hello: 'mismatch' }]);
    await sup.start();
    expect(sup.state).toBe('fallback');
    expect(fallbacks[0]!.reason).toMatch(/mismatch/);
    expect(spawned).toHaveLength(1);
  });

  it('a missing executable falls back', async () => {
    const { sup, spawned } = setup([], { exe: null });
    await sup.start();
    expect(sup.state).toBe('fallback');
    expect(spawned).toHaveLength(0);
  });

  it('a handshake that never completes is a crash (restart)', async () => {
    const { sup, timers, spawned } = setup([{ hello: 'silent' }, {}]);
    const started = sup.start();
    await timers.advance(10_000);
    await started;
    expect(spawned[0]!.killed).toBe(true);
    await timers.advance(300);
    expect(spawned).toHaveLength(2);
    expect(sup.state).toBe('running');
  });

  it('a requested restart (GPU process moved) is immediate and not counted as a crash', async () => {
    const { sup, timers, spawned, restarts } = setup();
    await sup.start();
    for (let i = 0; i < 5; i++) {
      sup.restart('gpu-process-gone');
      await timers.advance(1);
    }
    expect(spawned).toHaveLength(6);
    expect(sup.state).toBe('running');
    expect(restarts.every((r) => r.cause === 'requested')).toBe(true);
  });

  it('shuts down cleanly with Goodbye, and kills an engine that ignores it', async () => {
    const a = setup();
    await a.sup.start();
    await a.sup.stop();
    expect(a.sup.state).toBe('stopped');
    expect(a.spawned[0]!.received.some((m) => m.kind === 'goodbye')).toBe(true);
    expect(a.spawned[0]!.killed).toBe(false);

    const b = setup([{ ignoreGoodbye: true }]);
    await b.sup.start();
    const stopping = b.sup.stop();
    await b.timers.advance(2000);
    await stopping;
    expect(b.spawned[0]!.killed).toBe(true);
    expect(b.sup.state).toBe('stopped');
    expect(b.spawned).toHaveLength(1);  // never restarted
  });

  it('releases frame slots itself when nobody listens for frames', async () => {
    const { sup, spawned } = setup();
    await sup.start();
    spawned[0]!.frameReady(1, 2);
    await flush();
    expect(spawned[0]!.releases).toEqual([[1, 2]]);
    const seen: number[] = [];
    sup.on('frame', (f) => f.type === 'frameReady' && seen.push(f.slot));
    spawned[0]!.frameReady(1, 0);
    await flush();
    expect(seen).toEqual([0]);
    expect(spawned[0]!.releases).toHaveLength(1);  // the listener owns the release now
  });
});

describe('engine wiring helpers', () => {
  it('resolves the engine executable: override, packaged, dev', () => {
    const base = { isPackaged: false, resourcesPath: '/res', appPath: '/repo', platform: 'win32' as const, vars: {} };
    const all = () => true;
    expect(resolveEngineExecutable({ ...base, vars: { PREMATION_ENGINE_PATH: '/x/e.exe' }, exists: all })).toBe('/x/e.exe');
    expect(resolveEngineExecutable({ ...base, isPackaged: true, exists: all })).toMatch(/[\\/]res[\\/]engine[\\/]premation-engine\.exe$/);
    expect(resolveEngineExecutable({ ...base, exists: all })).toMatch(/native[\\/]build[\\/]windows-clang-cl-engine[\\/]engine[\\/]premation-engine\.exe$/);
    expect(resolveEngineExecutable({ ...base, platform: 'linux', exists: all })).toMatch(/linux-clang-engine[\\/]engine[\\/]premation-engine$/);
    expect(resolveEngineExecutable({ ...base, exists: () => false })).toBeNull();
  });

  it("reads Chromium's active GPU vendor", async () => {
    const info = { gpuDevice: [{ active: false, vendorId: 0x1002 }, { active: true, vendorId: 0x10de }] };
    await expect(chromiumGpuVendor(async () => info)).resolves.toBe(0x10de);
    await expect(chromiumGpuVendor(async () => ({}))).resolves.toBeUndefined();
  });
});

// ── with the real engine (skipped when it has not been built) ──────────────
const realExe = path.join(
  __dirname, '..', 'native', 'build',
  process.platform === 'win32' ? 'windows-clang-cl-engine' : process.platform === 'darwin' ? 'macos-clang-engine' : 'linux-clang-engine',
  'engine', process.platform === 'win32' ? 'premation-engine.exe' : 'premation-engine',
);
const describeReal = existsSync(realExe) ? describe : describe.skip;

describeReal('EngineSupervisor + real premation-engine', () => {
  it('a killed engine is restarted and answers again; quit is clean', async () => {
    const children: ChildProcess[] = [];
    const sup = new EngineSupervisor(
      {
        spawn: (exe, args) => {
          const c = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true });
          children.push(c);
          return c as unknown as EngineChild;
        },
        resolveExe: () => realExe,
        gpuVendor: async () => undefined,
        hostPid: process.pid,
        hello: { client: 'jest', clientVersion: '0', capabilities: [] },
      },
      { extraArgs: ['--no-gpu'] },
    );
    const restarted = new Promise<EngineRestartedInfo>((r) => sup.on('engine-restarted', r));
    await sup.start();
    expect(sup.state).toBe('running');
    const t0 = Date.now();
    children[0]!.kill('SIGKILL');  // TerminateProcess on Windows: a hard crash
    const info = await restarted;
    const restartMs = Date.now() - t0;
    expect(info.cause).toBe('crash');
    const res = decodeEngineMessage(await sup.request(encodeEngineMessage({ kind: 'request', value: { seq: 1, body: { kind: 'query', value: { type: 'getHistory' } }, origin: 'ui' } })));
    expect(res.kind).toBe('response');
    await sup.stop();
    expect(children[1]!.exitCode).toBe(0);
    console.log(`[C2] engine killed → restarted and answering in ${restartMs} ms (backoff 250 ms)`);
  }, 20_000);
});
