/**
 * The mirrored export queue: events from main become rows, and every job has
 * one tray entry for its lifetime.
 */

import { resetExportQueueForTest, useExportQueueStore } from './exportQueueStore';
import { useUIStore } from './uiStore';
import type { ExportJobRecord } from '@core/export/exportSupervisorClient';

function record(over: Partial<ExportJobRecord> = {}): ExportJobRecord {
  return {
    id: 'a',
    status: 'queued',
    priority: 0,
    createdAt: 1,
    attempts: 0,
    spec: { projectPath: 'C:\\s\\p.motion', outPath: 'C:\\o\\x.mp4', format: 'mp4', label: 'Comp → x.mp4', totalFrames: 48 },
    progress: { fraction: 0, frame: 0, totalFrames: 48, fps: null, etaSec: null },
    ...over,
  };
}

const trayJob = (id: string) => useUIStore.getState().jobs.find((j) => j.id === `export-job:${id}`);

beforeEach(() => {
  resetExportQueueForTest();
  useUIStore.setState({ jobs: [], notifications: [] });
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
});

describe('apply', () => {
  it('adds, then replaces by id', () => {
    const s = useExportQueueStore.getState();
    s.apply({ type: 'job', job: record() });
    s.apply({ type: 'job', job: record({ id: 'b' }) });
    s.apply({ type: 'job', job: record({ status: 'rendering', progress: { fraction: 0.5, frame: 24, totalFrames: 48, fps: 10, etaSec: 2 } }) });
    const jobs = useExportQueueStore.getState().jobs;
    expect(jobs.map((j) => j.id)).toEqual(['a', 'b']);
    expect(jobs[0]!.status).toBe('rendering');
  });

  it('a snapshot replaces the list', () => {
    const s = useExportQueueStore.getState();
    s.apply({ type: 'job', job: record() });
    s.apply({ type: 'snapshot', jobs: [record({ id: 'z' })] });
    expect(useExportQueueStore.getState().jobs.map((j) => j.id)).toEqual(['z']);
  });
});

describe('the tray mirror', () => {
  it('opens a tray job when a queue job appears, follows it, closes it on completion', () => {
    const s = useExportQueueStore.getState();
    s.apply({ type: 'job', job: record() });
    expect(trayJob('a')?.status).toBe('running');
    expect(trayJob('a')?.progress).toBe('indeterminate');

    s.apply({ type: 'job', job: record({ status: 'rendering', progress: { fraction: 0.25, frame: 12, totalFrames: 48, fps: 6, etaSec: 6 } }) });
    expect(trayJob('a')?.progress).toBe(0.25);
    expect(trayJob('a')?.label).toMatch(/Frame 12 \/ 48/);

    s.apply({ type: 'job', job: record({ status: 'completed', progress: { fraction: 1, frame: 48, totalFrames: 48, fps: 6, etaSec: 0 } }) });
    expect(trayJob('a')?.status).toBe('done');
  });

  it('a failure closes the tray job with the error', () => {
    const s = useExportQueueStore.getState();
    s.apply({ type: 'job', job: record({ status: 'rendering' }) });
    s.apply({ type: 'job', job: record({ status: 'failed', error: 'The export renderer stopped unexpectedly (oom).' }) });
    const t = trayJob('a');
    expect(t?.status).toBe('failed');
    expect(useUIStore.getState().notifications.some((n) => /oom/.test(n.message))).toBe(true);
  });

  it('a job that arrives already finished opens nothing', () => {
    useExportQueueStore.getState().apply({ type: 'job', job: record({ status: 'completed' }) });
    expect(trayJob('a')).toBeUndefined();
  });
});

describe('connect', () => {
  it('is a no-op without the bridge', async () => {
    await useExportQueueStore.getState().connect();
    expect(useExportQueueStore.getState().connected).toBe(false);
  });

  it('subscribes once and seeds the list', async () => {
    let subscribes = 0;
    let push: ((e: unknown) => void) | null = null;
    (window as unknown as { motionEditor: unknown }).motionEditor = {
      exportSupervisor: {
        reserve: async () => ({ id: 'x', projectPath: 'C:\\x' }),
        enqueue: async () => record(),
        cancel: async () => true,
        retry: async () => null,
        setPriority: async () => true,
        remove: async () => true,
        list: async () => [],
        subscribe: async () => { subscribes += 1; return [record({ id: 'seed' })]; },
        chooseOutputPath: async () => null,
        onEvent: (h: (e: unknown) => void) => { push = h; return () => undefined; },
      },
    };
    await Promise.all([useExportQueueStore.getState().connect(), useExportQueueStore.getState().connect()]);
    expect(subscribes).toBe(1);
    expect(useExportQueueStore.getState().jobs.map((j) => j.id)).toEqual(['seed']);
    push!({ type: 'job', job: record({ id: 'live' }) });
    expect(useExportQueueStore.getState().jobs.map((j) => j.id)).toEqual(['seed', 'live']);
  });
});
