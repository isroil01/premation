/**
 * The export supervisor's state machine, against a fake engine and a fake disk.
 *
 * What is asserted is the part a real Electron launch cannot show quickly:
 * every transition, what an engine failure does to the job and NOT to anything
 * else, that concurrency holds the second job back, that a retry re-enqueues
 * the same spec, that priority decides the order, and that the queue file
 * round-trips with an interrupted job coming back failed rather than
 * "rendering". The engine is the only renderer: what it cannot render fails.
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
  type EngineLauncher,
  type ExportJobRecord,
  type ExportJobSpec,
  type ExportQueueEvent,
  type SupervisorDeps,
} from './exportProcess';
import path from 'node:path';
import type { EngineExportCallbacks, EngineExportOutcome } from './engineExport';

/** An absolute path on THIS platform (the supervisor refuses relative ones; `C:\\…` is relative on POSIX). */
const abs = (...parts: string[]): string => path.join(process.platform === 'win32' ? 'C:\\' : '/', ...parts);

/** An engine job the test finishes at will. */
interface FakeEngineRun {
  spec: ExportJobSpec;
  cb: EngineExportCallbacks;
  cancelled: boolean;
  finish(o: EngineExportOutcome): void;
}

interface Harness {
  sup: ExportSupervisor;
  runs: FakeEngineRun[];
  disk: { text: string | null };
  events: ExportQueueEvent[];
  clock: { now: number };
}

function fakeEngine(runs: FakeEngineRun[], ineligible: (s: ExportJobSpec) => string | null = () => null): EngineLauncher {
  return {
    ineligible,
    start: (_id, s, cb) => {
      let finish!: (o: EngineExportOutcome) => void;
      const done = new Promise<EngineExportOutcome>((r) => { finish = r; });
      const rec: FakeEngineRun = { spec: s, cb, cancelled: false, finish };
      runs.push(rec);
      return { done, cancel: () => { rec.cancelled = true; finish({ kind: 'cancelled' }); } };
    },
  };
}

function harness(overrides: Partial<SupervisorDeps> = {}, ineligible?: (s: ExportJobSpec) => string | null): Harness {
  const runs: FakeEngineRun[] = [];
  const disk = { text: null as string | null };
  const events: ExportQueueEvent[] = [];
  const clock = { now: 1_000_000 };
  const sup = new ExportSupervisor({
    engine: fakeEngine(runs, ineligible),
    persist: { read: async () => disk.text, write: async (t) => { disk.text = t; } },
    prepareSnapshot: async (id) => abs('snap', `${id}`, 'project.motion'),
    removeSnapshot: async () => undefined,
    now: () => clock.now,
    log: () => undefined,
    ...overrides,
  });
  sup.subscribe((e) => events.push(e));
  return { sup, runs, disk, events, clock };
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
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
/** Finish the newest engine run successfully. */
const complete = async (h: Harness): Promise<void> => {
  h.runs[h.runs.length - 1]!.finish({ kind: 'completed', frames: 24 });
  await flush();
};

beforeEach(() => {
  jest.useFakeTimers();
  handlers.clear();
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
  it('runs queued → preparing → rendering → encoding → completed in the engine', async () => {
    const h = harness();
    h.sup.enqueue(spec(), 'a');
    expect(h.runs).toHaveLength(1);
    expect(h.sup.get('a')!.renderer).toBe('engine');
    expect(status(h, 'a')).toBe('preparing');
    h.runs[0]!.cb.started?.({ frames: 24, width: 1920, height: 1080, fps: 24, alpha: false, depth: 8, audio: null, comp: 'c', compName: 'C' });
    h.clock.now += 1000;
    h.runs[0]!.cb.progress(0.5);
    expect(status(h, 'a')).toBe('rendering');
    expect(h.sup.get('a')!.progress.frame).toBe(12);
    h.clock.now += 1000;
    h.runs[0]!.cb.progress(1);
    expect(status(h, 'a')).toBe('encoding');
    const p = h.sup.get('a')!.progress;
    expect(p.fps).toBeGreaterThan(0);
    expect(p.etaSec).toBe(0);
    await complete(h);
    expect(status(h, 'a')).toBe('completed');
    expect(h.runs[0]!.cancelled).toBe(false);
    expect(h.sup.activeCount()).toBe(0);
  });

  it('measures frame, fps and eta from the reports', () => {
    const h = harness();
    h.sup.enqueue(spec(1, 100), 'a');
    h.runs[0]!.cb.progress(0); // render starts now
    h.clock.now += 2000;
    h.runs[0]!.cb.progress(0.4); // 40 frames in 2 s
    const p = h.sup.get('a')!.progress;
    expect(p.frame).toBe(40);
    expect(p.fps).toBe(20);
    expect(p.etaSec).toBe(3);
  });

  it('an export failure (the encoder) fails the job with its message', async () => {
    const h = harness();
    h.sup.enqueue(spec(), 'a');
    h.runs[0]!.finish({ kind: 'failed', message: 'The encode failed: ffmpeg exited 1' });
    await flush();
    expect(status(h, 'a')).toBe('failed');
    expect(h.sup.get('a')!.error).toMatch(/ffmpeg exited 1/);
  });

  it('what the engine cannot render (unported frame, no GPU, engine crash) fails — there is no window path', async () => {
    const h = harness();
    h.sup.enqueue(spec(), 'a');
    h.runs[0]!.cb.progress(0.25);
    h.runs[0]!.finish({ kind: 'fallback', reason: 'premation-engine stopped unexpectedly (exit code 3221225477)' });
    await flush();
    const job = h.sup.get('a')!;
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/engine could not render this export: premation-engine stopped unexpectedly/);
    expect(h.runs).toHaveLength(1);
  });

  it('an ineligible spec fails at once with the reason', () => {
    const h = harness({}, (s) => (s.format === 'jpg-sequence' ? 'the engine does not write "jpg-sequence"' : null));
    h.sup.enqueue({ ...spec(), format: 'jpg-sequence' }, 'a');
    expect(h.runs).toHaveLength(0);
    expect(status(h, 'a')).toBe('failed');
    expect(h.sup.get('a')!.error).toMatch(/cannot be rendered: the engine does not write/);
  });
});

describe('watchdogs', () => {
  it('an engine that never starts rendering is failed by the boot watchdog', () => {
    const h = harness({ bootTimeoutMs: 1000 });
    h.sup.enqueue(spec(), 'a');
    jest.advanceTimersByTime(999);
    expect(status(h, 'a')).toBe('preparing');
    jest.advanceTimersByTime(1);
    expect(status(h, 'a')).toBe('failed');
    expect(h.sup.get('a')!.error).toMatch(/engine did not start/);
    expect(h.runs[0]!.cancelled).toBe(true);
  });

  it('a render that stops reporting is failed by the stall watchdog, which every report resets', () => {
    const h = harness({ bootTimeoutMs: 1000, stallTimeoutMs: 5000 });
    h.sup.enqueue(spec(), 'a');
    h.runs[0]!.cb.started?.({ frames: 24, width: 2, height: 2, fps: 24, alpha: false, depth: 8, audio: null, comp: 'c', compName: 'C' });
    jest.advanceTimersByTime(4000);
    h.runs[0]!.cb.progress(0.5);
    jest.advanceTimersByTime(4000);
    expect(status(h, 'a')).toBe('rendering');
    jest.advanceTimersByTime(1000);
    expect(status(h, 'a')).toBe('failed');
    expect(h.sup.get('a')!.error).toMatch(/no progress/);
  });
});

describe('cancel', () => {
  it('stops the engine job; a late outcome changes nothing', async () => {
    const h = harness();
    h.sup.enqueue(spec(), 'a');
    h.runs[0]!.cb.progress(0.3);
    expect(h.sup.cancel('a')).toBe(true);
    expect(h.runs[0]!.cancelled).toBe(true);
    expect(status(h, 'a')).toBe('cancelled');
    h.runs[0]!.finish({ kind: 'failed', message: 'late' });
    await flush();
    expect(status(h, 'a')).toBe('cancelled');
    expect(h.sup.activeCount()).toBe(0);
  });

  it('a queued job cancels without ever starting the engine', () => {
    const h = harness({ maxConcurrent: 1 });
    h.sup.enqueue(spec(1), 'a');
    h.sup.enqueue(spec(2), 'b');
    expect(h.sup.cancel('b')).toBe(true);
    expect(status(h, 'b')).toBe('cancelled');
    expect(h.runs).toHaveLength(1);
  });

  it('a completed job cannot be cancelled', async () => {
    const h = harness();
    h.sup.enqueue(spec(), 'a');
    await complete(h);
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
    expect(h.runs).toHaveLength(1);
  });
});

describe('concurrency and order', () => {
  it('concurrency 1 queues the second job until the first settles', async () => {
    const h = harness({ maxConcurrent: 1 });
    h.sup.enqueue(spec(1), 'a');
    h.sup.enqueue(spec(2), 'b');
    expect(status(h, 'a')).toBe('preparing');
    expect(status(h, 'b')).toBe('queued');
    expect(h.runs).toHaveLength(1);
    await complete(h);
    expect(status(h, 'b')).toBe('preparing');
    expect(h.runs).toHaveLength(2);
  });

  it('concurrency 2 runs two engine jobs at once', () => {
    const h = harness({ maxConcurrent: 2 });
    h.sup.enqueue(spec(1), 'a');
    h.sup.enqueue(spec(2), 'b');
    h.sup.enqueue(spec(3), 'c');
    expect(h.runs).toHaveLength(2);
    expect(status(h, 'c')).toBe('queued');
  });

  it('higher priority runs first; ties go to the older job', async () => {
    const h = harness({ maxConcurrent: 1 });
    h.sup.enqueue(spec(1), 'a');
    h.clock.now += 1;
    h.sup.enqueue(spec(2), 'b');
    h.clock.now += 1;
    h.sup.enqueue(spec(3), 'c');
    h.clock.now += 1;
    h.sup.enqueue(spec(4), 'd', 5);
    expect(h.sup.setPriority('c', 10)).toBe(true);
    const started = (): string => [...h.sup.list()].find((j) => j.status === 'preparing')!.id;
    expect(started()).toBe('a');
    await complete(h);
    expect(started()).toBe('c');
    await complete(h);
    expect(started()).toBe('d');
    await complete(h);
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
  it('re-enqueues a failed job with the same spec and counts the attempt', async () => {
    const h = harness();
    const first = h.sup.enqueue(spec(), 'a');
    h.runs[0]!.finish({ kind: 'failed', message: 'disk full' });
    await flush();
    expect(status(h, 'a')).toBe('failed');
    const again = h.sup.retry('a');
    expect(again!.spec).toEqual(first.spec);
    expect(again!.error).toBeUndefined();
    expect(again!.progress.frame).toBe(0);
    expect(status(h, 'a')).toBe('preparing');
    expect(h.sup.get('a')!.attempts).toBe(2);
    expect(h.runs).toHaveLength(2);
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
    h.runs[0]!.cb.progress(0.5);
    await h.sup.flushed();
    expect(h.disk.text).not.toBeNull();

    const restarted = harness({ persist: { read: async () => h.disk.text, write: async (t) => { h.disk.text = t; } } });
    await restarted.sup.load();
    const a = restarted.sup.get('a')!;
    const b = restarted.sup.get('b')!;
    expect(a.status).toBe('failed');
    expect(a.error).toBe(INTERRUPTED_MESSAGE);
    expect(a.spec).toEqual(spec(1));
    expect(a.renderer).toBe('engine');
    expect(b.status).toBe('queued');
    expect(b.priority).toBe(2);
    // Nothing starts on load — main dispatches once the editor is up.
    expect(restarted.runs).toHaveLength(0);
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
  it('registers the editor channels through the guard (no worker channels any more)', async () => {
    const h = harness();
    registerExportSupervisorIpc(h.sup, async () => abs('out', 'picked.mp4'));
    const mainFrame = { url: 'file:///C:/app/dist/index.html' };
    const sent: unknown[] = [];
    const editor = { id: 50, mainFrame, isDestroyed: () => false, send: (_c: string, e: unknown) => sent.push(e), once: () => undefined };
    const editorEvent = { senderFrame: mainFrame, sender: editor };
    const invoke = (channel: string, event: unknown, ...args: unknown[]): unknown => handlers.get(channel)!(event, ...args);

    expect(await invoke('export:subscribe', editorEvent)).toEqual([]);
    expect(await invoke('export:chooseOutputPath', editorEvent, 'x.mp4')).toBe(abs('out', 'picked.mp4'));
    expect(await invoke('export:capabilities', editorEvent)).toEqual({ engineExport: true, bitDepth16: true });
    const job = (await invoke('export:enqueue', editorEvent, { id: 'a', spec: spec() })) as ExportJobRecord;
    expect(job.status).toBe('preparing');
    expect(sent.map((e) => (e as { job: ExportJobRecord }).job.status)).toEqual(['queued', 'preparing']);
    expect(handlers.has('export:workerJob')).toBe(false);
    // A subframe is refused before any handler body runs.
    await expect(invoke('export:list', { senderFrame: { url: mainFrame.url }, sender: editor })).rejects.toThrow(/not available/);
  });
});

describe('F1: 16-bit output', () => {
  it('bitDepth is 8 or 16, and 16 only for mov', () => {
    expect(validateSpec({ ...spec(), format: 'mov', bitDepth: 16 }).bitDepth).toBe(16);
    expect(validateSpec({ ...spec(), bitDepth: 8 }).bitDepth).toBe(8);
    expect(() => validateSpec({ ...spec(), bitDepth: 16 })).toThrow(/mov/);
    expect(() => validateSpec({ ...spec(), format: 'mov', bitDepth: 10 })).toThrow(/8 or 16/);
  });
});
