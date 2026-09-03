/**
 * Pause / Resume / Stop / Discard, judged by the FRAMES that reached the sink.
 *
 * The other resume test (`renderQueueResume.test.ts`) asserts the store's
 * bookkeeping — who holds the handle, who disposes it. This one asserts the
 * only thing the user actually gets: that a render stopped halfway and picked
 * up again delivers every frame of the range exactly once, in order, into ONE
 * sink. A resume that re-staged frame 0 over an existing frame 0, or skipped
 * the frame the loop stopped on, would produce a playable file that is quietly
 * wrong — which no status-flag assertion can catch.
 *
 * The fake render is the real `ResumableVideoRender` contract, minus ffmpeg:
 * it stages frame indices into an array, honours `fromOffset`, and treats the
 * abort signal as PAUSE (resolving with the next offset) rather than failure —
 * exactly as `createResumableVideoRender` does.
 */

import { act } from '@testing-library/react';

/** Frames staged, in the order the sink received them, per render. */
let staged: number[] = [];
/** Every lifecycle event, so "which job ran first" is observable. */
let events: string[] = [];
let disposeCount = 0;
let finishCount = 0;
/**
 * "The user pressed a button at frame N": the fake calls this after staging
 * frame N, and the callback aborts through the store exactly as the panel does.
 */
let onFrame: ((frame: number) => void) | null = null;

const TOTAL = 12;

function makeFakeRender(total = TOTAL) {
  events.push('create');
  return {
    totalFrames: total,
    async run(
      fromOffset: number,
      onProgress?: (f: number) => void,
      signal?: AbortSignal,
    ): Promise<{ done: true } | { done: false; nextOffset: number }> {
      events.push(`run:${fromOffset}`);
      for (let i = fromOffset; i < total; i++) {
        // The signal is checked between frames — a pause takes effect after
        // the frame in flight, never mid-frame.
        if (signal?.aborted) return { done: false, nextOffset: i };
        staged.push(i);
        onProgress?.(((i + 1) / total) * 0.95);
        // Yield like the real loop, so a store action can land here.
        await Promise.resolve();
        onFrame?.(i);
      }
      return { done: true };
    },
    async finish() {
      finishCount++;
      events.push('finish');
      return {
        kind: 'file' as const,
        ext: 'mp4',
        frames: total,
        save: async () => 'C:/out/render.mp4',
        saveTo: async () => 'C:/out/render.mp4',
        discard: async () => undefined,
      };
    },
    // The staging dir this render owns — what makes a pause survive a restart
    // and not merely a stopped loop. A fake without it is not a
    // `ResumableVideoRender`, and the store would rightly fail the job.
    stagingJobId: () => 'staging-fake',
    async dispose() {
      disposeCount++;
      events.push('dispose');
    },
  };
}

jest.mock('@core/export/exportManager', () => ({
  exportAudioEntries: jest.fn(async () => []),
  renderSequenceZip: jest.fn(),
  renderExrSequenceZip: jest.fn(),
  renderVideo: jest.fn(),
  downloadBlob: jest.fn(),
  renderGifBlob: jest.fn(),
  createResumableVideoRender: jest.fn(async () => makeFakeRender()),
}));

jest.mock('@core/export/videoSink', () => ({
  canEncodeLocally: () => true,
}));

// The store tells plugins a render finished through a DYNAMIC import of the
// whole plugin runtime. Nothing here is about plugins, and compiling that graph
// inside a 5s test is how this suite times out on a cold cache — stub it.
jest.mock('@core/plugins/PluginHost', () => ({
  pluginHost: { notifyRenderFinished: jest.fn() },
}));

import { useRenderQueueStore, type RenderJob } from '../renderQueueStore';

const baseJob: Omit<RenderJob, 'id' | 'status' | 'progress'> = {
  compositionName: 'Comp 1',
  outputPath: 'out.mp4',
  format: 'mp4',
  width: 640,
  height: 360,
  fps: 12,
  durationSec: 1,
  transparent: false,
};

/**
 * Drain the runner's microtasks. The fake awaits once per frame and the store
 * awaits around each job, so this has to flush generously — it stops early
 * once the queue has parked itself.
 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    await Promise.resolve();
    if (!useRenderQueueStore.getState().isRunning && i > 8) return;
  }
};

const store = () => useRenderQueueStore.getState();

beforeEach(() => {
  jest.clearAllMocks();
  staged = [];
  events = [];
  disposeCount = 0;
  finishCount = 0;
  onFrame = null;
  useRenderQueueStore.setState({
    jobs: [], isRunning: false, outputDir: null, _abort: null, _intent: 'pause', _resumeTarget: null,
  });
});

/** Queue one job and run until it pauses itself after `pauseAfterFrame`. */
async function runUntilPaused(
  pauseAfterFrame: number,
  stop: (id: string) => void,
): Promise<string> {
  const id = store().addJob(baseJob);
  onFrame = (frame) => {
    if (frame === pauseAfterFrame) {
      onFrame = null;
      stop(id);
    }
  };
  await act(async () => {
    store().startAll();
    await settle();
  });
  return id;
}

describe('a paused render resumes into the same sink', () => {
  it('pause at frame N then resume stages 0..end exactly once, in order', async () => {
    const id = await runUntilPaused(4, (jobId) => store().pauseJob(jobId));

    // Paused mid-range, holding what it rendered.
    expect(staged).toEqual([0, 1, 2, 3, 4]);
    const paused = store().jobs.find((j) => j.id === id)!;
    expect(paused.status).toBe('paused');
    expect(paused.resumeFrame).toBe(5);
    expect(paused.progress).toBeGreaterThan(0);
    expect(disposeCount).toBe(0);

    await act(async () => {
      store().resumeJob(id);
      await settle();
    });

    // Every frame of the range, once each, in order — and ONE sink did it.
    expect(staged).toEqual([...Array(TOTAL).keys()]);
    expect(events.filter((e) => e === 'create')).toHaveLength(1);
    expect(events.filter((e) => e.startsWith('run:'))).toEqual(['run:0', 'run:5']);
    expect(finishCount).toBe(1);
    expect(disposeCount).toBe(0);
    expect(store().jobs.find((j) => j.id === id)!.status).toBe('done');
  });

  it('progress never goes backwards across the pause', async () => {
    const id = await runUntilPaused(6, (jobId) => store().pauseJob(jobId));
    const atPause = store().jobs.find((j) => j.id === id)!.progress;
    expect(atPause).toBeCloseTo(7 / TOTAL);

    const seen: number[] = [];
    const unsub = useRenderQueueStore.subscribe((s) => {
      const p = s.jobs.find((j) => j.id === id)?.progress;
      if (p !== undefined) seen.push(p);
    });
    await act(async () => {
      store().resumeJob(id);
      await settle();
    });
    unsub();
    // The resumed job never showed 0% — the old pause did exactly that.
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(atPause);
  });
});

describe('Stop keeps progress; Discard is the one that throws it away', () => {
  it('Stop parks the job as stopped and does NOT dispose the sink', async () => {
    const id = await runUntilPaused(3, () => store().stopAll());
    const job = store().jobs.find((j) => j.id === id)!;
    expect(job.status).toBe('stopped');
    expect(job.resumeFrame).toBe(4);
    expect(job._resume).toBeDefined();
    expect(disposeCount).toBe(0);
    expect(staged).toEqual([0, 1, 2, 3]);
  });

  it('a stopped job resumes on the next Render All, from where it stopped', async () => {
    await runUntilPaused(3, () => store().stopAll());
    await act(async () => {
      store().startAll();
      await settle();
    });
    expect(staged).toEqual([...Array(TOTAL).keys()]);
    expect(events.filter((e) => e === 'create')).toHaveLength(1);
  });

  it('Discard disposes the sink and sends the job back to 0', async () => {
    const id = await runUntilPaused(3, () => store().discardAll());
    expect(disposeCount).toBe(1);
    const job = store().jobs.find((j) => j.id === id)!;
    expect(job.status).toBe('queued');
    expect(job.progress).toBe(0);
    expect(job.resumeFrame).toBeUndefined();
    expect(job._resume).toBeUndefined();

    // And the restart really is a restart: a new sink, from frame 0.
    staged = [];
    await act(async () => {
      store().startAll();
      await settle();
    });
    expect(events.filter((e) => e === 'create')).toHaveLength(2);
    expect(staged).toEqual([...Array(TOTAL).keys()]);
  });

  it('discarding one paused job releases only that job', async () => {
    const id = await runUntilPaused(2, (jobId) => store().pauseJob(jobId));
    store().discardJobProgress(id);
    expect(disposeCount).toBe(1);
    expect(store().jobs.find((j) => j.id === id)!.status).toBe('queued');
  });
});

describe('Render All finishes half-done work before starting new work', () => {
  it('a stopped job renders before a job queued after it', async () => {
    await runUntilPaused(2, () => store().stopAll());
    store().addJob({ ...baseJob, outputPath: 'second.mp4' });

    await act(async () => {
      store().startAll();
      await settle();
    });

    // The stopped job resumed (run:3 into the existing sink) before the new
    // job's sink was ever created.
    expect(events.filter((e) => e === 'create' || e.startsWith('run:'))).toEqual([
      'create', 'run:0',   // the first job's original run
      'run:3',             // …resumed, same sink
      'create', 'run:0',   // only then the newly queued job
    ]);
    expect(store().jobs.map((j) => j.status)).toEqual(['done', 'done']);
  });
});
