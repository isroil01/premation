/**
 * The supervisor, against a fake process.
 *
 * What is pinned here is the promise the native tier makes: a plugin can crash,
 * hang, lie about its ABI or refuse to start, and the editor keeps going. Every
 * one of those is a test below, and each one asserts the two things that matter
 * together — the caller got an answer, and nothing was left waiting.
 *
 * A fake `utilityProcess` rather than a real one, deliberately: a real child
 * needs a compiled addon to be interesting, and the behaviour being checked
 * (backoff arithmetic, the disable threshold, which pending calls are settled
 * by a crash) is the supervisor's, not the operating system's. What CANNOT be
 * covered this way is stated in the report: that `utilityProcess.fork` really
 * delivers these events, and that a segfault in a `.node` file really arrives
 * as `exit`.
 */

jest.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
}));

import {
  MAX_RESTARTS,
  NativePluginHost,
  endProcess,
  RESTART_BACKOFF_MS,
  type NativeHostEvent,
  type NativeProcessLike,
} from './pluginNativeHost';
import { NATIVE_ABI_VERSION, type NativeChildMessage, type NativeChildReply } from './pluginNativeAbi';

class FakeProcess implements NativeProcessLike {
  readonly sent: NativeChildMessage[] = [];
  killed = false;
  readonly pid = 4242;
  private readonly handlers: Record<string, Array<(arg: never) => void>> = {};

  postMessage(message: NativeChildMessage): void {
    this.sent.push(message);
  }

  on(event: 'message' | 'exit' | 'error', handler: (arg: never) => void): void {
    (this.handlers[event] ??= []).push(handler);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  /** The child answering. `id` defaults to the last thing it was asked. */
  reply(reply: NativeChildReply): void {
    for (const h of this.handlers.message ?? []) (h as (r: NativeChildReply) => void)(reply);
  }

  replyLoaded(ok = true, abi = NATIVE_ABI_VERSION): void {
    const id = this.lastId('load');
    this.reply(
      ok
        ? { type: 'loaded', id, ok: true, abi, describe: { name: 'fake', calls: ['effect'] } }
        : { type: 'loaded', id, ok: false, code: 'abi-mismatch', error: 'built for ABI 2.0' },
    );
  }

  replyResult(result: unknown): void {
    this.reply({ type: 'result', id: this.lastId('call'), ok: true, result });
  }

  /** The process dying, as `utilityProcess` reports it. */
  exit(code = 139): void {
    for (const h of this.handlers.exit ?? []) (h as (c: number) => void)(code);
  }

  lastId(type: NativeChildMessage['type']): number {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const m = this.sent[i]!;
      if (m.type === type) return m.id;
    }
    return -1;
  }
}

const CONFIG = {
  pluginId: 'studio.acme.fast',
  pluginName: 'Fast Things',
  version: '1.0.0',
  dir: '/plugins/fast',
  binaryPath: '/plugins/fast/bin/win32-x64/fast.node',
  abi: 1,
  appVersion: '0.8.3',
};

function harness(options: { spawnFails?: boolean } = {}) {
  const spawned: FakeProcess[] = [];
  const events: NativeHostEvent[] = [];
  let clock = 1_000_000;
  const host = new NativePluginHost(
    () => {
      if (options.spawnFails) return null;
      const proc = new FakeProcess();
      spawned.push(proc);
      return proc;
    },
    () => clock,
  );
  host.onEvent((e) => events.push(e));
  return {
    host,
    spawned,
    events,
    last: () => spawned[spawned.length - 1]!,
    advance: (ms: number) => { clock += ms; jest.advanceTimersByTime(ms); },
  };
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('bringing a plugin up', () => {
  it('starts one process, loads the binary in it, and reports what it describes', async () => {
    const h = harness();
    const loading = h.host.load(CONFIG);
    expect(h.spawned).toHaveLength(1);

    const load = h.last().sent[0];
    expect(load).toMatchObject({ type: 'load', binaryPath: CONFIG.binaryPath });
    // The addon is told where its package lives, which is where its models and
    // lookup tables are. It cannot derive that from __dirname when it was staged.
    expect((load as { host: { pluginDir: string } }).host.pluginDir).toBe('/plugins/fast');

    h.last().replyLoaded();
    await expect(loading).resolves.toMatchObject({ ok: true });
    expect(h.host.status()[0]).toMatchObject({ running: true, restarts: 0, disabled: false });
    expect(h.events.map((e) => e.type)).toContain('ready');
  });

  it('refuses a module built for another ABI, naming both versions', async () => {
    const h = harness();
    const loading = h.host.load(CONFIG);
    h.last().replyLoaded(false);
    const result = await loading;
    expect(result).toMatchObject({ ok: false, code: 'abi-mismatch' });
    expect(result.error).toContain('ABI 2.0');
    // A module that will not load must not leave a process behind for the idle
    // timer to babysit.
    expect(h.last().killed).toBe(true);
  });

  it('checks the version AGAIN on this side, in case the child was the stale half', async () => {
    const h = harness();
    const loading = h.host.load(CONFIG);
    // The child says "loaded fine" and reports an ABI the main process does not
    // speak — which is what a half-upgraded dist-electron looks like.
    h.last().replyLoaded(true, 9000);
    const result = await loading;
    expect(result).toMatchObject({ ok: false, code: 'abi-mismatch' });
    expect(result.error).toContain('9.0');
  });

  it('answers rather than throwing when no process can be started at all', async () => {
    const h = harness({ spawnFails: true });
    await expect(h.host.load(CONFIG)).resolves.toMatchObject({ ok: false, code: 'failed' });
  });
});

describe('calling', () => {
  async function loaded() {
    const h = harness();
    const loading = h.host.load(CONFIG);
    h.last().replyLoaded();
    await loading;
    return h;
  }

  it('carries the result back', async () => {
    const h = await loaded();
    const call = h.host.call(CONFIG.pluginId, { call: 'effect' });
    await Promise.resolve();
    h.last().replyResult({ call: 'effect', identity: true });
    await expect(call).resolves.toMatchObject({ ok: true, result: { identity: true } });
  });

  it('kills a process that will not answer, and says so', async () => {
    const h = await loaded();
    const call = h.host.call(CONFIG.pluginId, { call: 'effect' });
    await Promise.resolve();

    h.advance(9000);
    const result = await call;
    expect(result).toMatchObject({ ok: false, code: 'timeout' });
    expect(result.ok === false && result.error).toContain('Fast Things');
    // The ONLY way to recover compiled code that will not return.
    expect(h.last().killed).toBe(true);
  });

  it('honours a manifest timeout, clamped', async () => {
    const h = harness();
    const loading = h.host.load({ ...CONFIG, timeoutMs: 500 });
    h.last().replyLoaded();
    await loading;

    const call = h.host.call(CONFIG.pluginId, { call: 'effect' });
    await Promise.resolve();
    h.advance(400);
    // Still waiting at 400 ms — nothing has settled it.
    let settled = false;
    void call.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    h.advance(200);
    await expect(call).resolves.toMatchObject({ ok: false, code: 'timeout' });
  });

  it('settles every outstanding call when the process dies under them', async () => {
    const h = await loaded();
    const a = h.host.call(CONFIG.pluginId, { call: 'effect' });
    const b = h.host.call(CONFIG.pluginId, { call: 'invoke' });
    await Promise.resolve();

    h.last().exit(139);

    // Both, not one: a dropped promise on the render path is the one failure
    // mode worse than a wrong frame.
    await expect(a).resolves.toMatchObject({ ok: false, code: 'crashed' });
    await expect(b).resolves.toMatchObject({ ok: false, code: 'crashed' });
    expect(h.events.some((e) => e.type === 'crashed')).toBe(true);
  });
});

describe('restarting, and giving up', () => {
  async function loadedHarness() {
    const h = harness();
    const loading = h.host.load(CONFIG);
    h.last().replyLoaded();
    await loading;
    return h;
  }

  it('backs off before starting another process', async () => {
    const h = await loadedHarness();
    h.last().exit(139);
    expect(h.spawned).toHaveLength(1);

    // Immediately after a crash: refused, and no new process.
    await expect(h.host.call(CONFIG.pluginId, { call: 'effect' }))
      .resolves.toMatchObject({ ok: false, code: 'crashed' });
    expect(h.spawned).toHaveLength(1);

    h.advance(RESTART_BACKOFF_MS[0]! + 1);
    const retry = h.host.call(CONFIG.pluginId, { call: 'effect' });
    expect(h.spawned).toHaveLength(2);
    h.last().replyLoaded();
    await Promise.resolve();
    h.last().replyResult({ call: 'effect', identity: true });
    await expect(retry).resolves.toMatchObject({ ok: true });
  });

  it('turns the plugin off for the session rather than crash-looping', async () => {
    const h = await loadedHarness();

    // A module that dies as soon as its process is started, over and over. Each
    // round: the backoff is waited out, a call starts a process, the process
    // dies before answering, and the call settles. That is exactly the shape of
    // a scrub over a broken plugin.
    h.last().exit(139);
    for (let i = 1; i < MAX_RESTARTS; i += 1) {
      h.advance(RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1]! + 1);
      const call = h.host.call(CONFIG.pluginId, { call: 'effect' });
      h.last().exit(139);
      await expect(call).resolves.toMatchObject({ ok: false });
    }
    expect(h.host.status()[0]).toMatchObject({ disabled: true, restarts: MAX_RESTARTS });

    const spawnsBefore = h.spawned.length;
    await expect(h.host.call(CONFIG.pluginId, { call: 'effect' }))
      .resolves.toMatchObject({ ok: false, code: 'disabled' });
    // The point of the disable: no more process launches.
    expect(h.spawned).toHaveLength(spawnsBefore);
    const disabled = h.events.find((e) => e.type === 'disabled');
    expect(disabled?.message).toContain('off for');
  });

  it('forgets the crash count once a process loads cleanly again', async () => {
    const h = await loadedHarness();
    h.last().exit(139);
    expect(h.host.status()[0]).toMatchObject({ restarts: 1 });

    h.advance(RESTART_BACKOFF_MS[0]! + 1);
    const call = h.host.call(CONFIG.pluginId, { call: 'effect' });
    h.last().replyLoaded();
    await Promise.resolve();
    h.last().replyResult({ call: 'effect' });
    await call;
    // Otherwise three crashes spread across an afternoon would disable a plugin
    // that has been working the whole time.
    expect(h.host.status()[0]).toMatchObject({ restarts: 0 });
  });
});

describe('idle and shutdown', () => {
  it('stops a process that has had nothing to do', async () => {
    const h = harness();
    const loading = h.host.load({ ...CONFIG, idleTimeoutMs: 5000 });
    h.last().replyLoaded();
    await loading;

    h.advance(5001);
    expect(h.last().killed).toBe(true);
    // The addon was given its chance to free what it allocated first.
    expect(h.last().sent.some((m) => m.type === 'dispose')).toBe(true);
    expect(h.host.status()[0]).toMatchObject({ running: false });
  });

  it('starts a fresh process for the next call after an idle stop', async () => {
    const h = harness();
    const loading = h.host.load({ ...CONFIG, idleTimeoutMs: 5000 });
    h.last().replyLoaded();
    await loading;
    h.advance(5001);

    const call = h.host.call(CONFIG.pluginId, { call: 'effect' });
    expect(h.spawned).toHaveLength(2);
    h.last().replyLoaded();
    await Promise.resolve();
    h.last().replyResult({ call: 'effect' });
    await expect(call).resolves.toMatchObject({ ok: true });
  });

  it('kills everything on dispose, and refuses calls afterwards', async () => {
    const h = harness();
    const loading = h.host.load(CONFIG);
    h.last().replyLoaded();
    await loading;

    h.host.dispose();
    expect(h.last().killed).toBe(true);
    await expect(h.host.call(CONFIG.pluginId, { call: 'effect' }))
      .resolves.toMatchObject({ ok: false, code: 'not-declared' });
  });

  it('replaces the process when the binary changes under a reload', async () => {
    const h = harness();
    const first = h.host.load(CONFIG);
    h.last().replyLoaded();
    await first;
    const original = h.last();

    const second = h.host.load({ ...CONFIG, binaryPath: '/plugins/fast/bin/win32-x64/fast-v2.node' });
    // A native module cannot be unloaded from a process — the old library stays
    // mapped — so a reload IS a new process.
    expect(original.killed).toBe(true);
    expect(h.spawned).toHaveLength(2);
    h.last().replyLoaded();
    await expect(second).resolves.toMatchObject({ ok: true });
  });
});

describe('endProcess', () => {
  const fakeProc = (pid: number | undefined): { proc: NativeProcessLike; exit: () => void; killed: jest.Mock } => {
    let onExit: ((code: number) => void) | null = null;
    const state = { pid };
    const killed = jest.fn(() => true);
    const proc = {
      postMessage: () => {},
      on: (event: string, h: (code: number) => void) => { if (event === 'exit') onExit = h; },
      kill: killed,
      get pid() { return state.pid; },
    } as unknown as NativeProcessLike;
    return { proc, killed, exit: () => { state.pid = undefined; onExit?.(0); } };
  };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('force-kills a child that survives the polite kill', () => {
    const sig = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const f = fakeProc(4242);
    endProcess(f.proc);
    expect(f.killed).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(2000);
    expect(sig).toHaveBeenCalledWith(4242, 'SIGKILL');
  });

  it('leaves a child that exited alone (its pid may already be reused)', () => {
    const sig = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const f = fakeProc(4243);
    endProcess(f.proc);
    f.exit();
    jest.advanceTimersByTime(2000);
    expect(sig).not.toHaveBeenCalled();
  });
});
