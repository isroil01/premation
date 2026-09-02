/**
 * Render-queue pause/resume — the contract that a pause KEEPS the work.
 *
 * Pausing used to abort the render outright: the sink was disposed, the ffmpeg
 * staging dir deleted, and Start meant frame 0 again. Now the resumable path
 * hands the store a `{kind:'paused'}` result carrying the OPEN sink and the
 * next offset, and Start feeds the same sink from there.
 *
 * The exporter is mocked at the module seam — these tests are about the
 * STORE's lifecycle decisions (who holds the handle, who disposes it, what a
 * duplicate inherits), not about rasterisation.
 */

import { act } from '@testing-library/react';

const mockRun = jest.fn();
const mockFinish = jest.fn();
// Async like the real interface — the store chains .catch on it.
const mockDispose = jest.fn(async () => undefined);

const fakeRender = {
  totalFrames: 100,
  run: mockRun,
  finish: mockFinish,
  dispose: mockDispose,
  // The staging dir this render owns. Real renders have one so a pause can be
  // written down and picked up after a restart; a fake without it is not a
  // `ResumableVideoRender` and the store would rightly fail the job.
  stagingJobId: () => 'staging-fake',
};

jest.mock('@core/export/exportManager', () => ({
  exportAudioEntries: jest.fn(async () => []),
  renderSequenceZip: jest.fn(),
  renderVideo: jest.fn(),
  downloadBlob: jest.fn(),
  renderGifBlob: jest.fn(),
  createResumableVideoRender: jest.fn(async () => fakeRender),
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
import { createResumableVideoRender } from '@core/export/exportManager';

const baseJob: Omit<RenderJob, 'id' | 'status' | 'progress'> = {
  compositionName: 'Comp 1',
  outputPath: 'out.mp4',
  format: 'mp4',
  width: 1920,
  height: 1080,
  fps: 30,
  durationSec: 2,
  transparent: false,
};

/** Let the store's fire-and-forget runner drain its microtasks. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  jest.clearAllMocks();
  useRenderQueueStore.setState({
    jobs: [], isRunning: false, outputDir: null, _abort: null, _intent: 'pause', _resumeTarget: null,
  });
});

describe('pause keeps the render', () => {
  it('a paused run parks the job as paused with its progress and resume handle', async () => {
    mockRun.mockResolvedValueOnce({ done: false, nextOffset: 40 });
    const s = useRenderQueueStore.getState();
    s.addJob(baseJob);
    await act(async () => {
      useRenderQueueStore.getState().startAll();
      await settle();
    });
    const job = useRenderQueueStore.getState().jobs[0]!;
    expect(job.status).toBe('paused');
    expect(job.progress).toBeCloseTo(0.4);
    expect(job.resumeFrame).toBe(40);
    expect(job._resume).toEqual({ render: fakeRender, nextOffset: 40 });
    // Nothing was thrown away.
    expect(mockDispose).not.toHaveBeenCalled();
    expect(useRenderQueueStore.getState().isRunning).toBe(false);
  });

  it('resume feeds the SAME sink from the recorded offset — no new render is created', async () => {
    mockRun.mockResolvedValueOnce({ done: false, nextOffset: 40 });
    useRenderQueueStore.getState().addJob(baseJob);
    await act(async () => {
      useRenderQueueStore.getState().startAll();
      await settle();
    });
    // Second start: complete from offset 40 and deliver.
    mockRun.mockResolvedValueOnce({ done: true });
    mockFinish.mockResolvedValueOnce({
      kind: 'file', ext: 'mp4', frames: 100,
      save: async () => 'C:/out/render.mp4',
      saveTo: async () => 'C:/out/render.mp4',
      discard: async () => undefined,
    });
    await act(async () => {
      useRenderQueueStore.getState().startAll();
      await settle();
    });
    expect(createResumableVideoRender).toHaveBeenCalledTimes(1); // reused, not recreated
    expect(mockRun).toHaveBeenLastCalledWith(40, expect.any(Function), expect.any(Object));
    const job = useRenderQueueStore.getState().jobs[0]!;
    expect(job.status).toBe('done');
    expect(job._resume).toBeUndefined();
  });
});

describe('the handle cannot leak or be shared', () => {
  const pausedJob = async (): Promise<string> => {
    mockRun.mockResolvedValueOnce({ done: false, nextOffset: 25 });
    useRenderQueueStore.getState().addJob(baseJob);
    await act(async () => {
      useRenderQueueStore.getState().startAll();
      await settle();
    });
    return useRenderQueueStore.getState().jobs[0]!.id;
  };

  it('removing a paused job disposes its sink', async () => {
    const id = await pausedJob();
    useRenderQueueStore.getState().removeJob(id);
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('skipping a paused job disposes its sink and drops the handle', async () => {
    const id = await pausedJob();
    useRenderQueueStore.getState().skipJob(id);
    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(useRenderQueueStore.getState().jobs[0]!._resume).toBeUndefined();
  });

  it('duplicating a paused job does NOT copy the resume handle', async () => {
    // Two jobs staging into one dir would interleave frames into a single file.
    const id = await pausedJob();
    useRenderQueueStore.getState().duplicateJob(id);
    const [, copy] = useRenderQueueStore.getState().jobs;
    expect(copy!._resume).toBeUndefined();
    expect(copy!.progress).toBe(0);
  });

  it('a failing resume clears the handle so a retry starts clean', async () => {
    mockRun.mockRejectedValueOnce(new Error('encoder exploded'));
    useRenderQueueStore.getState().addJob(baseJob);
    await act(async () => {
      useRenderQueueStore.getState().startAll();
      await settle();
    });
    const job = useRenderQueueStore.getState().jobs[0]!;
    expect(job.status).toBe('failed');
    expect(job._resume).toBeUndefined();
    expect(mockDispose).toHaveBeenCalled();
  });
});
