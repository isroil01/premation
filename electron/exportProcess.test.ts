/**
 * The export supervisor's state machine, against a fake window and a fake disk.
 *
 * What is asserted is the part a real Electron launch cannot show quickly:
 * every transition, what a crash does to the job and NOT to anything else,
 * that a cancel kills the encoder before the window, that concurrency holds
 * the second job back, that a retry re-enqueues the same spec, that priority
 * decides the order, and that the queue file round-trips with an interrupted
 * job coming back failed rather than "rendering".
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp/motion-export-test', on: () => undefined },
  BrowserWindow: class { static getAllWindows(): unknown[] { return []; } },
  dialog: { showSaveDialog: async () => ({ canceled: true }), showMessageBoxSync: () => 1 },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}));

import {
  ExportSupervisor,
  INTERRUPTED_MESSAGE,
  compareQueued,
  registerExportSupervisorIpc,
  validateSpec,
  exportEngineEnabled,
  type EngineLauncher,
  type ExportJobRecord,
  type ExportJobSpec,
  type ExportQueueEvent,
  type SupervisorDeps,
  type WorkerWindow,
} from './exportProcess';
import path from 'node:path';
import type { EngineExportCallbacks, EngineExportOutcome } from './engineExport';

/** An absolute path on THIS platform (the supervisor refuses relative ones; `C:\\…` is relative on POSIX). */
const abs = (...parts: string[]): string => path.join(process.platform === 'win32' ? 'C:\\' : '/', ...parts);

/** A window the test can crash, hang or complete at will. */
class FakeWindow implements WorkerWindow {
  static nextId = 1;
  readonly id = FakeWindow.nextId++;
  destroyed = false;
  loads = 0;
  private readonly cbs = new Map<string, Array<(d: string) => void>>();
  load(): Promise<void> { this.loads += 1; return Promise.resolve(); }
  destroy(): void { this.destroyed = true; }
  isDestroyed(): boolean { return this.destroyed; }
  on(event: 'gone' | 'unresponsive' | 'fail-load', cb: (detail: string) => void): void {
    this.cbs.set(event, [...(this.cbs.get(event) ?? []), cb]);
  }
  fire(event: 'gone' | 'unresponsive' | 'fail-load', detail = 'crashed'): void {
    for (const cb of this.cbs.get(event) ?? []) cb(detail);
  }
}

interface Harness {
  sup: ExportSupervisor;
  windows: FakeWindow[];
  disk: { text: string | null };
  aborted: number[];
  events: ExportQueueEvent[];
  clock: { now: number };
}

function harness(overrides: Partial<SupervisorDeps> = {}): Harness {
  const windows: FakeWindow[] = [];
  const disk = { text: null as string | null };
  const aborted: number[] = [];
  const events: ExportQueueEvent[] = [];
  const clock = { now: 1_000_000 };
  const sup = new ExportSupervisor({
    createWindow: () => { const w = new FakeWindow(); windows.push(w); return w; },
    persist: { read: async () => disk.text, write: async (t) => { disk.text = t; } },
    prepareSnapshot: async (id) => abs('snap', `${id}`, 'project.motion'),
    removeSnapshot: async () => undefined,
    abortRenderJobsOwnedBy: (id) => { aborted.push(id); },
    now: () => clock.now,
    log: () => undefined,
    ...overrides,
  });
  sup.subscribe((e) => events.push(e));
  return { sup, windows, disk, aborted, events, clock };
}

const spec = (n = 1, totalFrames = 24): ExportJobSpec => ({
  projectPath: abs('snap', `job${n}`, 'project.motion'),
  outPath: abs('out', `job${n}.mp4`),
  format: 'mp4',
  fps: 24,
  startFrame: 0,
  endFrame: totalFrames - 1,
  label: `Comp ${n} → job${n}.mp4`,
  totalFrames,
});

const status = (h: Harness, id: string): string => h.sup.get(id)!.status;

beforeEach(() => {
  jest.useFakeTimers();
  handlers.clear();
  FakeWindow.nextId = 1;
});
afterEach(() => jest.useRealTimers());

describe('validateSpec', () => {
  it('accepts the CLI request shape plus label and totalFrames', () => {
    const out = validateSpec(spec());
    expect(out.totalFrames).toBe(24);
    expect(out.label).toBe('Comp 1 → job1.mp4');
  });

  it('refuses relative paths and unknown quality', () => {
    expect(() => validateSpec({ ...spec(), outPath: 'job.mp4' })).toThrow(/absolute/);
    expect(() => validateSpec({ ...spec(), quality: 'best' })).toThrow(/quality/);
    expect(() => validateSpec(null)).toThrow(/spec/);
  });
});

describe('the state machine', () => {
  it('runs queued → preparing → rendering → encoding → completed', () => {
    const h = harness();
    const job = h.sup.enqueue(spec(), 'a');
    // Dispatch is synchronous: the window exists and the job is preparing.
    expect(status(h, job.id)).toBe('preparing');
    expect(h.windows).toHaveLength(1);
    expect(h.windows[0]!.loads).toBe(1);

    const task = h.sup.takeJob(h.windows[0]!.id);
    expect(task).toEqual({ kind: 'render', job: expect.objectContaining({ outPath: abs('out', 'job1.mp4'), endFrame: 23 }) });
    expect(task!.job).not.toHaveProperty('label');
    expect(status(h, 'a')).toBe('rendering');

    h.clock.now += 1000;
    h.sup.reportProgress(h.windows[0]!.id, 0.5);
    expect(status(h, 'a')).toBe('rendering');
    h.clock.now += 1000;
    h.sup.reportProgress(h.windows[0]!.id, 1);
    expect(status(h, 'a')).toBe('encoding');
    const p = h.sup.get('a')!.progress;
    expect(p.frame).toBe(24);
    expect(p.fps).toBeGreaterThan(0);
    expect(p.etaSec).toBe(0);

    h.sup.reportDone(h.windows[0]!.id, { ok: true, outPath: abs('out', 'job1.mp4'), frames: 24, warnings: [] });
    expect(status(h, 'a')).toBe('completed');
    expect(h.windows[0]!.destroyed).toBe(true);
    // A completed job's render cleaned up after itself; nothing to abort.
    expect(h.aborted).toEqual([]);
    expect(h.sup.activeCount()).toBe(0);
  });

  it('measures frame, fps and eta from the reports', () => {
    const h = harness();
    h.sup.enqueue(spec(1, 100), 'a');
    const w = h.windows[0]!;
    h.sup.takeJob(w.id);
    h.sup.reportProgress(w.id, 0); // render starts now
    h.clock.now += 2000;
    h.sup.reportProgress(w.id, 0.4); // 40 frames in 2 s
    const p = h.sup.get('a')!.progress;
    expect(p.frame).toBe(40);
    expect(p.fps).toBe(20);
    expect(p.etaSec).toBe(3);
  });

  it('a worker report of failure fails the job with its message', () => {
    const h = harness();
    h.sup.enqueue(spec(), 'a');
    const w = h.windows[0]!;
    h.sup.takeJob(w.id);
    h.sup.reportDone(w.id, { ok: false, message: 'Composition "X" not found.' });
    expect(status(h, 'a')).toBe('failed');
    expect(h.sup.get('a')!.error).toMatch(/not found/);
    expect(h.aborted).toEqual([w.id]);
    expect(w.destroyed).toBe(true);
  });

  it('a worker that is not the job’s window gets nothing', () => {
    const h = harness();
    h.sup.enqueue(spec(), 'a');
    expect(h.sup.takeJob(999)).toBeNull();
    h.sup.reportProgress(999, 0.5);
    h.sup.reportDone(999, { ok: true, outPath: 'x', frames: 1 });
    expect(status(h, 'a')).toBe('preparing');
  });
});

describe('crash isolation', () => {
  it('render-process-gone → failed with the reason, window destroyed, ffmpeg aborted', () => {
    const h = harness();
    h.sup.enqueue(spec(), 'a');
    const w = h.windows[0]!;
    h.sup.takeJob(w.id);
    w.fire('gone', 'oom');
    const job = h.sup.get('a')!;
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/stopped unexpectedly \(oom\)/);
    expect(w.destroyed).toBe(true);
    expect(h.aborted).toEqual([w.id]);
  });

  it('unresponsive → failed', () => {
    const h = harness();
    h.sup.enqueue(spec(), 'a');
    h.windows[0]!.fire('unresponsive');
    expect(h.sup.get('a')!.error).toMatch(/stopped responding/);
  });

  it('a crash after the job settled changes nothing', () => {
    const h = harness();
    h.sup.enqueue(spec(), 'a');
    const w = h.windows[0]!;
    h.sup.takeJob(w.id);
    h.sup.reportDone(w.id, { ok: true, outPath: 'x', frames: 24 });
    w.fire('gone', 'late');
    expect(status(h, 'a')).toBe('completed');
    expect(h.aborted).toEqual([]);
  });

  it('a window that never asks for its job is failed by the boot watchdog', () => {
    const h = harness({ bootTimeoutMs: 1000 });
    h.sup.enqueue(spec(), 'a');
    jest.advanceTimersByTime(999);
    expect(status(h, 'a')).toBe('preparing');
    jest.advanceTimersByTime(1);
    expect(status(h, 'a')).toBe('failed');
    expect(h.sup.get('a')!.error).toMatch(/did not start/);
  });

  it('a render that stops reporting is failed by the stall watchdog, which every report resets', () => {
    const h = harness({ bootTimeoutMs: 1000, stallTimeoutMs: 5000 });
    h.sup.enqueue(spec(), 'a');
    const w = h.windows[0]!;
    h.sup.takeJob(w.id);
    jest.advanceTimersByTime(4000);
    h.sup.reportProgress(w.id, 0.5);
    jest.advanceTimersByTime(4000);
    expect(status(h, 'a')).toBe('rendering');
    jest.advanceTimersByTime(1000);
    expect(status(h, 'a')).toBe('failed');
    expect(h.sup.get('a')!.error).toMatch(/no progress/);
  });
});

describe('cancel', () => {
  it('mid-render: aborts the window’s ffmpeg BEFORE destroying the window', () => {
    const h = harness();
    const order: string[] = [];
    const sup = new ExportSupervisor({
      createWindow: () => {
        const w = new FakeWindow();
        const destroy = w.destroy.bind(w);
        w.destroy = () => { order.push('window'); destroy(); };
        h.windows.push(w);
        return w;
      },
      persist: { read: async () => null, write: async () => undefined },
      prepareSnapshot: async () => abs('s', 'project.motion'),
      removeSnapshot: async () => undefined,
      abortRenderJobsOwnedBy: () => { order.push('ffmpeg'); },
      log: () => undefined,
    });
    sup.enqueue(spec(), 'a');
    sup.takeJob(h.windows[0]!.id);
    sup.reportProgress(h.windows[0]!.id, 0.3);
    expect(sup.cancel('a')).toBe(true);
    expect(sup.get('a')!.status).toBe('cancelled');
    expect(order).toEqual(['ffmpeg', 'window']);
    expect(sup.activeCount()).toBe(0);
  });

  it('a queued job cancels without ever opening a window', () => {
    const h = harness({ maxConcurrent: 1 });
    h.sup.enqueue(spec(1), 'a');
    h.sup.enqueue(spec(2), 'b');
    expect(h.sup.cancel('b')).toBe(true);
    expect(status(h, 'b')).toBe('cancelled');
    expect(h.windows).toHaveLength(1);
  });

  it('a completed job cannot be cancelled', () => {
    const h = harness();
    h.sup.enqueue(spec(), 'a');
    h.sup.takeJob(h.windows[0]!.id);
    h.sup.reportDone(h.windows[0]!.id, { ok: true, outPath: 'x', frames: 24 });
    expect(h.sup.cancel('a')).toBe(false);
  });

  it('cancelAll stops everything and nothing starts afterwards', () => {
    const h = harness();
    h.sup.enqueue(spec(1), 'a');
    h.sup.enqueue(spec(2), 'b');
    h.sup.cancelAll('quit');
    expect(status(h, 'a')).toBe('cancelled');
    expect(status(h, 'b')).toBe('cancelled');
    h.sup.retry('a');
    expect(status(h, 'a')).toBe('queued');
    expect(h.windows).toHaveLength(1);
  });
});

describe('concurrency and order', () => {
  it('concurrency 1 queues the second job until the first settles', () => {
    const h = harness({ maxConcurrent: 1 });
    h.sup.enqueue(spec(1), 'a');
    h.sup.enqueue(spec(2), 'b');
    expect(status(h, 'a')).toBe('preparing');
    expect(status(h, 'b')).toBe('queued');
    expect(h.windows).toHaveLength(1);

    h.sup.takeJob(h.windows[0]!.id);
    h.sup.reportDone(h.windows[0]!.id, { ok: true, outPath: 'x', frames: 24 });
    expect(status(h, 'b')).toBe('preparing');
    // A NEW window, never the first one's context.
    expect(h.windows).toHaveLength(2);
    expect(h.windows[1]).not.toBe(h.windows[0]);
    expect(h.windows[0]!.destroyed).toBe(true);
  });

  it('concurrency 2 runs two windows at once', () => {
    const h = harness({ maxConcurrent: 2 });
    h.sup.enqueue(spec(1), 'a');
    h.sup.enqueue(spec(2), 'b');
    h.sup.enqueue(spec(3), 'c');
    expect(h.windows).toHaveLength(2);
    expect(status(h, 'c')).toBe('queued');
  });

  it('higher priority runs first; ties go to the older job', () => {
    const h = harness({ maxConcurrent: 1 });
    h.sup.enqueue(spec(1), 'a');
    h.clock.now += 1;
    h.sup.enqueue(spec(2), 'b');
    h.clock.now += 1;
    h.sup.enqueue(spec(3), 'c');
    h.clock.now += 1;
    h.sup.enqueue(spec(4), 'd', 5);
    expect(h.sup.setPriority('c', 10)).toBe(true);

    const finishCurrent = (): void => {
      const w = h.windows[h.windows.length - 1]!;
      h.sup.takeJob(w.id);
      h.sup.reportDone(w.id, { ok: true, outPath: 'x', frames: 24 });
    };
    const started = (): string => [...h.sup.list()].find((j) => j.status === 'preparing')!.id;
    expect(started()).toBe('a');
    finishCurrent();
    expect(started()).toBe('c');
    finishCurrent();
    expect(started()).toBe('d');
    finishCurrent();
    expect(started()).toBe('b');
  });

  it('compareQueued is a total order', () => {
    const mk = (id: string, priority: number, createdAt: number): ExportJobRecord =>
      ({ id, priority, createdAt, spec: spec(), status: 'queued', progress: { fraction: 0, frame: 0, totalFrames: 1, fps: null, etaSec: null }, attempts: 0 });
    const list = [mk('x', 0, 5), mk('y', 3, 9), mk('z', 3, 2)].sort(compareQueued).map((j) => j.id);
    expect(list).toEqual(['z', 'y', 'x']);
  });
});

describe('retry', () => {
  it('re-enqueues a failed job with the same spec and counts the attempt', () => {
    const h = harness();
    const first = h.sup.enqueue(spec(), 'a');
    h.windows[0]!.fire('gone', 'oom');
    expect(status(h, 'a')).toBe('failed');
    const again = h.sup.retry('a');
    expect(again!.spec).toEqual(first.spec);
    expect(again!.error).toBeUndefined();
    expect(again!.progress.frame).toBe(0);
    // Started straight away — a new window, attempt 2.
    expect(status(h, 'a')).toBe('preparing');
    expect(h.sup.get('a')!.attempts).toBe(2);
    expect(h.windows).toHaveLength(2);
  });

  it('cannot retry a job that is running or completed', () => {
    const h = harness();
    h.sup.enqueue(spec(), 'a');
    expect(h.sup.retry('a')).toBeNull();
  });
});

describe('persistence', () => {
  it('round-trips through the queue file; an active job comes back failed as interrupted', async () => {
    const h = harness();
    h.sup.enqueue(spec(1), 'a');
    h.sup.enqueue(spec(2), 'b', 2);
    h.sup.takeJob(h.windows[0]!.id);
    h.sup.reportProgress(h.windows[0]!.id, 0.5);
    await h.sup.flushed();
    expect(h.disk.text).not.toBeNull();

    // A "new process" reads the same file.
    const restarted = harness({ persist: { read: async () => h.disk.text, write: async (t) => { h.disk.text = t; } } });
    await restarted.sup.load();
    const a = restarted.sup.get('a')!;
    const b = restarted.sup.get('b')!;
    expect(a.status).toBe('failed');
    expect(a.error).toBe(INTERRUPTED_MESSAGE);
    expect(a.spec).toEqual(spec(1));
    expect(b.status).toBe('queued');
    expect(b.priority).toBe(2);
    // Nothing starts on load — main dispatches once the editor is up.
    expect(restarted.windows).toHaveLength(0);
    restarted.sup.dispatch();
    expect(restarted.sup.get('b')!.status).toBe('preparing');
  });

  it('an unreadable queue file is ignored', async () => {
    const h = harness({ persist: { read: async () => '{not json', write: async () => undefined } });
    await h.sup.load();
    expect(h.sup.list()).toEqual([]);
  });

  it('remove drops a finished job and its snapshot', async () => {
    const removed: string[] = [];
    const h = harness({ removeSnapshot: async (id) => { removed.push(id); } });
    h.sup.enqueue(spec(), 'a');
    h.sup.cancel('a');
    expect(await h.sup.remove('a')).toBe(true);
    expect(removed).toEqual(['a']);
    expect(h.sup.list()).toEqual([]);
    expect(h.events.at(-1)).toEqual({ type: 'snapshot', jobs: [] });
  });
});

describe('idle', () => {
  it('onIdle fires once the queue drains', () => {
    const h = harness();
    const fired: number[] = [];
    h.sup.onIdle(() => fired.push(1));
    expect(fired).toEqual([1]);
    h.sup.enqueue(spec(), 'a');
    h.sup.onIdle(() => fired.push(2));
    expect(fired).toEqual([1]);
    h.sup.cancel('a');
    expect(fired).toEqual([1, 2]);
  });
});

describe('IPC', () => {
  it('registers the editor and worker channels through the guard, keyed by sender', async () => {
    const h = harness();
    registerExportSupervisorIpc(h.sup, async () => abs('out', 'picked.mp4'));
    const mainFrame = { url: 'file:///C:/app/dist/index.html' };
    const sent: unknown[] = [];
    const editor = { id: 50, mainFrame, isDestroyed: () => false, send: (_c: string, e: unknown) => sent.push(e), once: () => undefined };
    const editorEvent = { senderFrame: mainFrame, sender: editor };

    const invoke = (channel: string, event: unknown, ...args: unknown[]): unknown => handlers.get(channel)!(event, ...args);

    expect(await invoke('export:subscribe', editorEvent)).toEqual([]);
    expect(await invoke('export:chooseOutputPath', editorEvent, 'x.mp4')).toBe(abs('out', 'picked.mp4'));
    const job = (await invoke('export:enqueue', editorEvent, { id: 'a', spec: spec() })) as ExportJobRecord;
    expect(job.status).toBe('preparing');
    // queued, then preparing as dispatch opens its window — both pushed.
    expect(sent.map((e) => (e as { job: ExportJobRecord }).job.status)).toEqual(['queued', 'preparing']);

    const worker = { id: h.windows[0]!.id, mainFrame, isDestroyed: () => false, send: () => undefined, once: () => undefined };
    const workerEvent = { senderFrame: mainFrame, sender: worker };
    const task = await invoke('export:workerJob', workerEvent);
    expect(task).toEqual({ kind: 'render', job: expect.objectContaining({ format: 'mp4' }) });
    invoke('export:workerProgress', workerEvent, 0.5);
    expect(h.sup.get('a')!.status).toBe('rendering');
    invoke('export:workerDone', workerEvent, { ok: true, outPath: 'x', frames: 24 });
    expect(h.sup.get('a')!.status).toBe('completed');

    // The editor cannot pose as a worker.
    await expect(invoke('export:workerJob', editorEvent)).rejects.toThrow(/no export job/);
    // A subframe is refused before any handler body runs.
    await expect(invoke('export:list', { senderFrame: { url: mainFrame.url }, sender: editor })).rejects.toThrow(/not available/);
  });
});

describe('F1: engine jobs', () => {
  interface FakeEngineRun {
    spec: ExportJobSpec;
    cb: EngineExportCallbacks;
    cancelled: boolean;
    finish(o: EngineExportOutcome): void;
  }
  function engineHarness(ineligible: (s: ExportJobSpec) => string | null = () => null): Harness & { runs: FakeEngineRun[] } {
    const runs: FakeEngineRun[] = [];
    const engine: EngineLauncher = {
      ineligible,
      start: (_id, s, cb) => {
        let finish!: (o: EngineExportOutcome) => void;
        const done = new Promise<EngineExportOutcome>((r) => { finish = r; });
        const rec: FakeEngineRun = { spec: s, cb, cancelled: false, finish };
        runs.push(rec);
        return { done, cancel: () => { rec.cancelled = true; finish({ kind: 'cancelled' }); } };
      },
    };
    return { ...harness({ engine }), runs };
  }
  const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  it('an eligible job renders in the engine: no window, progress, completed', async () => {
    const h = engineHarness();
    h.sup.enqueue(spec(), 'a');
    expect(h.windows).toHaveLength(0);
    expect(h.runs).toHaveLength(1);
    expect(h.sup.get('a')!.renderer).toBe('engine');
    expect(status(h, 'a')).toBe('preparing');
    h.runs[0]!.cb.started?.({ frames: 24, width: 1920, height: 1080, fps: 24, alpha: false, audio: null, comp: 'c', compName: 'C' });
    h.clock.now += 1000;
    h.runs[0]!.cb.progress(0.5);
    expect(status(h, 'a')).toBe('rendering');
    expect(h.sup.get('a')!.progress.frame).toBe(12);
    h.runs[0]!.cb.progress(1);
    expect(status(h, 'a')).toBe('encoding');
    h.runs[0]!.finish({ kind: 'completed', frames: 24 });
    await flush();
    expect(status(h, 'a')).toBe('completed');
    expect(h.runs[0]!.cancelled).toBe(false);
    expect(h.sup.activeCount()).toBe(0);
  });

  it('a fallback (unported frame, no GPU, engine crash) continues the same attempt in a window', async () => {
    const h = engineHarness();
    h.sup.enqueue(spec(), 'a');
    h.runs[0]!.cb.progress(0.25);
    h.runs[0]!.finish({ kind: 'fallback', reason: 'premation-engine stopped unexpectedly (exit code 3221225477)' });
    await flush();
    expect(h.windows).toHaveLength(1);
    const job = h.sup.get('a')!;
    expect(job.renderer).toBe('chromium');
    expect(job.attempts).toBe(1);
    expect(job.status).toBe('preparing');
    expect(job.progress.frame).toBe(0);
    h.sup.takeJob(h.windows[0]!.id);
    h.sup.reportDone(h.windows[0]!.id, { ok: true, outPath: abs('out', 'job1.mp4'), frames: 24 });
    expect(status(h, 'a')).toBe('completed');
  });

  it('an export failure (the encoder) fails the job without a window', async () => {
    const h = engineHarness();
    h.sup.enqueue(spec(), 'a');
    h.runs[0]!.finish({ kind: 'failed', message: 'The encode failed: ffmpeg exited 1' });
    await flush();
    expect(status(h, 'a')).toBe('failed');
    expect(h.sup.get('a')!.error).toMatch(/ffmpeg exited 1/);
    expect(h.windows).toHaveLength(0);
  });

  it('cancel stops the engine job; a late outcome changes nothing', async () => {
    const h = engineHarness();
    h.sup.enqueue(spec(), 'a');
    expect(h.sup.cancel('a')).toBe(true);
    expect(h.runs[0]!.cancelled).toBe(true);
    expect(status(h, 'a')).toBe('cancelled');
    h.runs[0]!.finish({ kind: 'fallback', reason: 'late' });
    await flush();
    expect(h.windows).toHaveLength(0);
    expect(status(h, 'a')).toBe('cancelled');
  });

  it('an ineligible spec renders in a window from the start', () => {
    const h = engineHarness((s) => (s.format === 'png-sequence' ? 'the engine does not write "png-sequence"' : null));
    h.sup.enqueue({ ...spec(), format: 'png-sequence' }, 'a');
    expect(h.runs).toHaveLength(0);
    expect(h.windows).toHaveLength(1);
    expect(h.sup.get('a')!.renderer).toBe('chromium');
  });

  it('an engine that never starts rendering is failed by the boot watchdog', () => {
    const h = engineHarness();
    const sup = new ExportSupervisor({
      createWindow: () => new FakeWindow(),
      persist: { read: async () => null, write: async () => undefined },
      prepareSnapshot: async (id) => abs('snap', id, 'project.motion'),
      removeSnapshot: async () => undefined,
      abortRenderJobsOwnedBy: () => undefined,
      bootTimeoutMs: 1000,
      engine: { ineligible: () => null, start: () => ({ done: new Promise(() => undefined), cancel: () => undefined }) },
      log: () => undefined,
    });
    void h;
    sup.enqueue(spec(), 'a');
    jest.advanceTimersByTime(1000);
    expect(sup.get('a')!.status).toBe('failed');
    expect(sup.get('a')!.error).toMatch(/engine did not start/);
  });

  it('the flag is off unless PREMATION_EXPORT_ENGINE=1', () => {
    expect(exportEngineEnabled({})).toBe(false);
    expect(exportEngineEnabled({ PREMATION_EXPORT_ENGINE: '0' })).toBe(false);
    expect(exportEngineEnabled({ PREMATION_EXPORT_ENGINE: '1' })).toBe(true);
  });

  it('the renderer survives the queue file', async () => {
    const h = engineHarness();
    h.sup.enqueue(spec(), 'a');
    await h.sup.flushed();
    const again = harness();
    again.disk.text = h.disk.text;
    await again.sup.load();
    expect(again.sup.get('a')!.renderer).toBe('engine');
  });
});