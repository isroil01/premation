/**
 * Resume ACROSS a restart — the contract that quitting the app is not the same
 * as discarding a render.
 *
 * Pause already kept the work within one session (renderQueuePauseResume.test),
 * but every part of that lived in memory: the open sink, the `jobId → dir` map
 * in main, the queue itself. Relaunching lost all three, and 900 staged frames
 * became unreachable files in a temp directory.
 *
 * Two things had to become durable, and both are tested here:
 *
 *   1. the queue's SPECS, so a job that was queued and never started comes back;
 *   2. the staging DIRECTORY, found again through its manifest and re-registered
 *      under its original id, so a job that was half-rendered comes back at the
 *      frame it stopped on.
 *
 * A "restart" is simulated the only way a jsdom test honestly can: the store is
 * reset to its initial state (as a fresh module would be) while `localStorage`
 * and the fake shell bridge — the two things that really do survive — are left
 * standing.
 */

import { act } from '@testing-library/react';

const mockRun = jest.fn();
const mockFinish = jest.fn();
const mockDispose = jest.fn(async () => undefined);
const mockStagingJobId = jest.fn(() => 'staging-1');

const fakeRender = {
  totalFrames: 100,
  run: mockRun,
  finish: mockFinish,
  dispose: mockDispose,
  stagingJobId: mockStagingJobId,
};

/**
 * The renders the exporter hands back, and what each was asked to adopt.
 *
 * `createResumableVideoRender`'s third argument is the whole point of this
 * suite: it is how a sink is pointed at a directory a previous process opened.
 */
const adoptions: Array<{ jobId: string; stagedFrames: number } | undefined> = [];

jest.mock('@core/export/exportManager', () => ({
  exportAudioEntries: jest.fn(async () => []),
  renderSequenceZip: jest.fn(),
  renderExrSequenceZip: jest.fn(),
  renderVideo: jest.fn(),
  downloadBlob: jest.fn(),
  renderGifBlob: jest.fn(),
  createResumableVideoRender: jest.fn(async (_opts: unknown, _fmt: unknown, adopt?: { jobId: string; stagedFrames: number }) => {
    adoptions.push(adopt);
    return fakeRender;
  }),
}));

jest.mock('@core/export/videoSink', () => ({
  canEncodeLocally: () => true,
}));

// The runner asks the document mirror (B4) which compositions the open project
// holds: a ready mirror whose comps are the ones `openProject` names.
const mockOpenComps = new Set<string>();
jest.mock('../documentMirror', () => ({
  documentMirror: () => ({
    status: 'ready',
    comp: (id: string) => (mockOpenComps.has(id) ? { id } : undefined),
  }),
}));

import { useRenderQueueStore, type RenderJob } from '../renderQueueStore';
import { useProjectStore, type CompositionSettings } from '../projectStore';

/** Open a project holding `comps` (the project store and the mirror agree). */
function openProject(comps: Record<string, CompositionSettings>): void {
  useProjectStore.setState({ comps });
  mockOpenComps.clear();
  for (const id of Object.keys(comps)) mockOpenComps.add(id);
}
import { createResumableVideoRender } from '@core/export/exportManager';

/**
 * The composition the fixtures were queued from. The runner refuses a job whose
 * comp is not in the open project (it would render a blank file), so the
 * project has to hold it — exactly as it would after the user reopened the
 * project the queue belongs to.
 */
const comp1 = {
  id: 'comp-1', name: 'Comp 1', width: 1920, height: 1080, fps: 30, durationSeconds: 2, background: '#101014',
} as CompositionSettings;

/** The JSON record of one job, as the settings blob holds it. */
function persistedRecord(id: string): Record<string, unknown> | undefined {
  const blob = JSON.parse(localStorage.getItem('motion-editor.settings') ?? '{}') as { 'renderQueue.jobs'?: Array<Record<string, unknown>> };
  return blob['renderQueue.jobs']?.find((j) => j['id'] === id);
}

const baseJob: Omit<RenderJob, 'id' | 'status' | 'progress'> = {
  compositionName: 'Comp 1',
  compositionId: 'comp-1',
  outputPath: 'hero.mp4',
  format: 'mp4',
  width: 1920,
  height: 1080,
  fps: 30,
  durationSec: 2,
  transparent: false,
};

/** Let the store's fire-and-forget runner drain its microtasks. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** What `render:listResumableJobs` will answer with. */
let resumable: Array<{
  jobId: string;
  spec: unknown;
  format: string;
  totalFrames: number;
  stagedFrames: number;
  createdAt: number;
}> = [];
const adoptJob = jest.fn(async (jobId: string) => {
  const found = resumable.find((r) => r.jobId === jobId);
  if (!found) return null;
  return {
    jobId,
    spec: found.spec,
    format: found.format,
    totalFrames: found.totalFrames,
    stagedFrames: found.stagedFrames,
    nextFrame: found.stagedFrames,
    frameExt: 'jpg' as const,
  };
});
const discardJob = jest.fn(async () => undefined);

/**
 * Quit and relaunch, as faithfully as a jsdom test can manage.
 *
 * The store goes back to what a freshly loaded module holds; localStorage is
 * put back exactly as it was BEFORE that reset, because emptying the store is
 * itself a change the queue persists — a real relaunch drops the in-memory
 * state without ever telling the disk about it, and a test that let the wipe
 * reach localStorage would be testing an app that deletes your queue on quit.
 */
function freshStore(): void {
  const onDisk = localStorage.getItem('motion-editor.settings');
  useRenderQueueStore.setState({
    jobs: [],
    isRunning: false,
    outputDir: null,
    _abort: null,
    _intent: 'pause',
    _resumeTarget: null,
    _restored: false,
  });
  if (onDisk === null) localStorage.removeItem('motion-editor.settings');
  else localStorage.setItem('motion-editor.settings', onDisk);
}

beforeEach(() => {
  jest.clearAllMocks();
  adoptions.length = 0;
  resumable = [];
  localStorage.clear();
  openProject({ 'comp-1': comp1 });
  (window as unknown as { motionEditor?: unknown }).motionEditor = {
    render: {
      listResumableJobs: jest.fn(async () => resumable),
      adoptJob,
      discardJob,
      beginJob: jest.fn(),
      stageFrame: jest.fn(),
      encode: jest.fn(),
    },
  };
  freshStore();
});

afterEach(() => {
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
});

describe('the queue itself survives a quit', () => {
  it('brings back a job that was queued and never started', async () => {
    act(() => { useRenderQueueStore.getState().addJob(baseJob); });
    expect(localStorage.getItem('motion-editor.settings')).toContain('hero.mp4');

    freshStore();
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });

    const jobs = useRenderQueueStore.getState().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      compositionName: 'Comp 1',
      outputPath: 'hero.mp4',
      format: 'mp4',
      width: 1920,
      status: 'queued',
      progress: 0,
    });
  });

  it('does not remember jobs that are finished business', async () => {
    let id = '';
    act(() => { id = useRenderQueueStore.getState().addJob(baseJob); });
    act(() => { useRenderQueueStore.getState().updateJob(id, { status: 'done', progress: 1 }); });

    freshStore();
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });
    expect(useRenderQueueStore.getState().jobs).toEqual([]);
  });

  it('restores exactly once, however many panels ask', async () => {
    act(() => { useRenderQueueStore.getState().addJob(baseJob); });
    freshStore();
    await act(async () => {
      await useRenderQueueStore.getState().restoreFromLastSession();
      await useRenderQueueStore.getState().restoreFromLastSession();
    });
    expect(useRenderQueueStore.getState().jobs).toHaveLength(1);
  });

  it('ignores rubbish in the settings blob rather than queueing it', async () => {
    localStorage.setItem(
      'motion-editor.settings',
      JSON.stringify({ 'renderQueue.jobs': [{ id: 'x' }, 'nonsense', null, 42] }),
    );
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });
    expect(useRenderQueueStore.getState().jobs).toEqual([]);
  });

  it('survives a browser build with no shell to ask', async () => {
    act(() => { useRenderQueueStore.getState().addJob(baseJob); });
    freshStore();
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });
    expect(useRenderQueueStore.getState().jobs).toHaveLength(1);
    expect(useRenderQueueStore.getState().jobs[0]?.status).toBe('queued');
  });
});

describe('boot-time discovery of staged frames', () => {
  it('shows a half-rendered job as stopped, at the frame it reached', async () => {
    act(() => { useRenderQueueStore.getState().addJob(baseJob); });
    const persisted = useRenderQueueStore.getState().jobs[0]!;
    resumable = [
      {
        jobId: 'staging-1',
        spec: { ...baseJob },
        format: 'mp4',
        totalFrames: 100,
        stagedFrames: 40,
        createdAt: 1,
      },
    ];

    freshStore();
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });

    const jobs = useRenderQueueStore.getState().jobs;
    // One job, not two: the manifest and the persisted spec describe the SAME
    // render, matched on what they produce even though the app crashed before
    // it could write down the staging id.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: persisted.id,
      status: 'stopped',
      resumeFrame: 40,
      progress: 0.4,
      stagingJobId: 'staging-1',
    });
    expect(jobs[0]?._adopt).toEqual({ jobId: 'staging-1', stagedFrames: 40, nextFrame: 40 });
  });

  it('matches on the recorded staging id when there is one', async () => {
    let id = '';
    act(() => { id = useRenderQueueStore.getState().addJob(baseJob); });
    act(() => {
      // What a real pause writes down before the app closes.
      useRenderQueueStore.getState().updateJob(id, { status: 'paused', stagingJobId: 'staging-7' });
    });
    resumable = [
      // A spec that no longer matches (the user renamed the output between
      // sessions) — the id is what links them.
      { jobId: 'staging-7', spec: { ...baseJob, outputPath: 'renamed.mp4' }, format: 'mp4', totalFrames: 100, stagedFrames: 12, createdAt: 1 },
    ];

    freshStore();
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });

    const jobs = useRenderQueueStore.getState().jobs;
    expect(jobs).toHaveLength(1);
    // `paused`, not `stopped`: the record says the USER paused this one, and
    // that distinction survives the quit along with the staging id.
    expect(jobs[0]).toMatchObject({ id, status: 'paused', resumeFrame: 12 });
  });

  it('rebuilds a job from the manifest alone when the queue lost it', async () => {
    // The settings blob failed to write, or the user cleared it. The frames are
    // still real, and the manifest carries everything needed to finish them.
    resumable = [
      { jobId: 'orphan-1', spec: { ...baseJob, compositionName: 'Orphan' }, format: 'mp4', totalFrames: 50, stagedFrames: 25, createdAt: 1 },
    ];
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });

    const jobs = useRenderQueueStore.getState().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      compositionName: 'Orphan',
      status: 'stopped',
      resumeFrame: 25,
      progress: 0.5,
    });
  });

  it('leaves a non-resumable format queued rather than promising a resume', async () => {
    // A sequence export builds one zip in memory: there is no staging dir to
    // come back to, so offering Resume would silently mean "render from zero".
    resumable = [
      { jobId: 'seq-1', spec: { ...baseJob, format: 'png-sequence', outputPath: 'seq.zip' }, format: 'png-sequence', totalFrames: 50, stagedFrames: 25, createdAt: 1 },
    ];
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });

    const jobs = useRenderQueueStore.getState().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('queued');
    expect(jobs[0]?._adopt).toBeUndefined();
    expect(jobs[0]?.resumeFrame).toBeUndefined();
  });

  it('ignores a dir that turned out to hold no frames', async () => {
    resumable = [
      { jobId: 'empty-1', spec: { ...baseJob }, format: 'mp4', totalFrames: 100, stagedFrames: 0, createdAt: 1 },
    ];
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });
    expect(useRenderQueueStore.getState().jobs[0]?.status).toBe('queued');
  });
});

describe('resuming after the restart', () => {
  /** Restore a queue holding one job with `staged` frames already on disk. */
  async function restoredWith(staged: number): Promise<RenderJob> {
    resumable = [
      { jobId: 'staging-1', spec: { ...baseJob }, format: 'mp4', totalFrames: 100, stagedFrames: staged, createdAt: 1 },
    ];
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });
    return useRenderQueueStore.getState().jobs[0]!;
  }

  it('adopts the dir and renders exactly the frames that are missing', async () => {
    const job = await restoredWith(60);
    mockRun.mockResolvedValueOnce({ done: true });
    mockFinish.mockResolvedValueOnce({ kind: 'file', ext: 'mp4', frames: 100, save: jest.fn(async () => '/out/hero.mp4'), saveTo: jest.fn(async () => '/out/hero.mp4'), discard: jest.fn() });

    await act(async () => {
      useRenderQueueStore.getState().resumeJob(job.id);
      await settle();
    });

    // Main was asked to re-register the ORIGINAL directory…
    expect(adoptJob).toHaveBeenCalledWith('staging-1');
    // …the sink was opened onto it rather than a new one…
    expect(adoptions[0]).toEqual({ jobId: 'staging-1', stagedFrames: 60 });
    // …and the frame loop started at the first missing frame, not at zero.
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun.mock.calls[0]?.[0]).toBe(60);
    expect(useRenderQueueStore.getState().jobs[0]).toMatchObject({ status: 'done', progress: 1 });
  });

  it('asks for a manifest-writing render, so the resumed run is resumable too', async () => {
    const job = await restoredWith(10);
    mockRun.mockResolvedValueOnce({ done: false, nextOffset: 55 });

    await act(async () => {
      useRenderQueueStore.getState().resumeJob(job.id);
      await settle();
      useRenderQueueStore.getState().stopAll();
      await settle();
    });

    // `resumeSpec` is what puts `resume.json` in the staging dir. Without it a
    // render resumed once could not be resumed again after a second restart.
    const opts = (createResumableVideoRender as jest.Mock).mock.calls[0]?.[0] as { resumeSpec?: unknown };
    expect(opts.resumeSpec).toMatchObject({ outputPath: 'hero.mp4', format: 'mp4' });
  });

  it('parks the resumed job again, now carrying its staging id', async () => {
    const job = await restoredWith(10);
    mockRun.mockResolvedValueOnce({ done: false, nextOffset: 55 });

    await act(async () => {
      useRenderQueueStore.getState().resumeJob(job.id);
      await settle();
    });

    const after = useRenderQueueStore.getState().jobs[0]!;
    expect(after).toMatchObject({ status: 'paused', resumeFrame: 55, stagingJobId: 'staging-1' });
    // The one-shot descriptor is consumed: a second Resume must not try to
    // adopt a directory this session already holds an open sink onto.
    expect(after._adopt).toBeUndefined();
    expect(after._resume).toBeDefined();
  });

  it('renders from zero when the directory vanished between sessions', async () => {
    const job = await restoredWith(60);
    // Someone emptied the staging root — a disk-cleanup tool, or the user.
    adoptJob.mockResolvedValueOnce(null);
    mockRun.mockResolvedValueOnce({ done: true });
    mockFinish.mockResolvedValueOnce({ kind: 'file', ext: 'mp4', frames: 100, save: jest.fn(async () => '/out/hero.mp4'), saveTo: jest.fn(async () => '/out/hero.mp4'), discard: jest.fn() });

    await act(async () => {
      useRenderQueueStore.getState().resumeJob(job.id);
      await settle();
    });

    // No adoption, and the loop starts at 0 — the honest answer, rather than
    // resuming at frame 60 into a directory that is not there.
    expect(adoptions[0]).toBeUndefined();
    expect(mockRun.mock.calls[0]?.[0]).toBe(0);
    expect(useRenderQueueStore.getState().jobs[0]?.status).toBe('done');
  });
});

describe('the record says what the job was doing — the disk says how far it got', () => {
  it('writes status and resumeFrame down the moment a job pauses, and only then', async () => {
    mockRun.mockResolvedValueOnce({ done: false, nextOffset: 40 });
    let id = '';
    act(() => { id = useRenderQueueStore.getState().addJob(baseJob); });
    // Queued: nothing to resume, nothing recorded.
    expect(persistedRecord(id)).toMatchObject({ status: 'queued' });
    expect(persistedRecord(id)).not.toHaveProperty('resumeFrame');

    await act(async () => {
      useRenderQueueStore.getState().startAll();
      await settle();
    });

    // Paused at 40 — the record now says so, and names the staging dir.
    expect(persistedRecord(id)).toMatchObject({ status: 'paused', resumeFrame: 40, stagingJobId: 'staging-1' });
    // Progress and the live handle stay out of the blob.
    expect(persistedRecord(id)).not.toHaveProperty('progress');
    expect(persistedRecord(id)).not.toHaveProperty('_resume');
  });

  it('a job the user paused comes back paused, not stopped, at the frame the disk holds', async () => {
    let id = '';
    act(() => { id = useRenderQueueStore.getState().addJob(baseJob); });
    act(() => {
      useRenderQueueStore.getState().updateJob(id, { status: 'paused', resumeFrame: 40, stagingJobId: 'staging-1' });
    });
    // The disk has fewer frames than the record — three were lost to a crash
    // after the pause was written. The disk wins: resuming at 40 would leave
    // a hole.
    resumable = [
      { jobId: 'staging-1', spec: { ...baseJob }, format: 'mp4', totalFrames: 100, stagedFrames: 37, createdAt: 1 },
    ];

    freshStore();
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });

    const job = useRenderQueueStore.getState().jobs[0]!;
    expect(job).toMatchObject({ id, status: 'paused', resumeFrame: 37, progress: 0.37 });
    expect(job.attention).toBeUndefined();
    // Restored, not started: nothing renders on launch.
    expect(useRenderQueueStore.getState().isRunning).toBe(false);
    expect(createResumableVideoRender).not.toHaveBeenCalled();
  });

  it('a job that was rendering when the app died comes back stopped', async () => {
    let id = '';
    act(() => { id = useRenderQueueStore.getState().addJob(baseJob); });
    act(() => { useRenderQueueStore.getState().updateJob(id, { status: 'rendering', progress: 0.3 }); });
    resumable = [
      { jobId: 'staging-1', spec: { ...baseJob }, format: 'mp4', totalFrames: 100, stagedFrames: 30, createdAt: 1 },
    ];

    freshStore();
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });
    expect(useRenderQueueStore.getState().jobs[0]).toMatchObject({ id, status: 'stopped', resumeFrame: 30 });
  });

  it('a paused job whose frames are gone comes back queued at 0, and says what was lost', async () => {
    let id = '';
    act(() => { id = useRenderQueueStore.getState().addJob(baseJob); });
    act(() => {
      useRenderQueueStore.getState().updateJob(id, { status: 'paused', resumeFrame: 400, stagingJobId: 'staging-1' });
    });
    // No staging dir survives — a disk-cleanup tool emptied the temp root.
    resumable = [];

    freshStore();
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });

    const job = useRenderQueueStore.getState().jobs[0]!;
    expect(job).toMatchObject({ id, status: 'queued', progress: 0 });
    expect(job.resumeFrame).toBeUndefined();
    expect(job._adopt).toBeUndefined();
    // The dead staging id is not carried forward to be looked for again.
    expect(job.stagingJobId).toBeUndefined();
    expect(job.attention).toMatch(/400 rendered frames from your last session/);
    expect(job.attention).toMatch(/starts again from the beginning/);
  });

  it('a queued job that never started needs no attention', async () => {
    act(() => { useRenderQueueStore.getState().addJob(baseJob); });
    freshStore();
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });
    expect(useRenderQueueStore.getState().jobs[0]?.attention).toBeUndefined();
  });

  it('the flag clears once the job actually renders', async () => {
    let id = '';
    act(() => { id = useRenderQueueStore.getState().addJob(baseJob); });
    act(() => { useRenderQueueStore.getState().updateJob(id, { status: 'paused', resumeFrame: 40, stagingJobId: 'staging-1' }); });
    freshStore();
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });
    expect(useRenderQueueStore.getState().jobs[0]?.attention).toBeDefined();

    mockRun.mockResolvedValueOnce({ done: true });
    mockFinish.mockResolvedValueOnce({ kind: 'file', ext: 'mp4', frames: 100, save: jest.fn(async () => '/out/hero.mp4'), saveTo: jest.fn(async () => '/out/hero.mp4'), discard: jest.fn() });
    await act(async () => {
      useRenderQueueStore.getState().startAll();
      await settle();
    });
    const job = useRenderQueueStore.getState().jobs[0]!;
    expect(job.status).toBe('done');
    expect(job.attention).toBeUndefined();
    // From frame 0 — the honest answer, since nothing was there to resume.
    expect(mockRun.mock.calls[0]?.[0]).toBe(0);
  });

  it('a real pause, a relaunch and a Resume continue from the recorded frame', async () => {
    // Session 1: render, pause at 40.
    mockRun.mockResolvedValueOnce({ done: false, nextOffset: 40 });
    let id = '';
    act(() => { id = useRenderQueueStore.getState().addJob(baseJob); });
    await act(async () => {
      useRenderQueueStore.getState().startAll();
      await settle();
    });
    expect(useRenderQueueStore.getState().jobs[0]).toMatchObject({ status: 'paused', resumeFrame: 40 });

    // Quit. The staging dir the pause named is still on disk with its frames.
    resumable = [
      { jobId: 'staging-1', spec: { ...baseJob }, format: 'mp4', totalFrames: 100, stagedFrames: 40, createdAt: 1 },
    ];
    freshStore();
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });
    expect(useRenderQueueStore.getState().jobs[0]).toMatchObject({ id, status: 'paused', resumeFrame: 40 });

    // Session 2: Resume.
    mockRun.mockResolvedValueOnce({ done: true });
    mockFinish.mockResolvedValueOnce({ kind: 'file', ext: 'mp4', frames: 100, save: jest.fn(async () => '/out/hero.mp4'), saveTo: jest.fn(async () => '/out/hero.mp4'), discard: jest.fn() });
    await act(async () => {
      useRenderQueueStore.getState().resumeJob(id);
      await settle();
    });

    expect(adoptJob).toHaveBeenCalledWith('staging-1');
    // The second run — the one after the relaunch — started at frame 40.
    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(mockRun.mock.calls[1]?.[0]).toBe(40);
    expect(useRenderQueueStore.getState().jobs[0]).toMatchObject({ status: 'done', progress: 1 });
    // Done is finished business: the record is gone from the blob.
    expect(persistedRecord(id)).toBeUndefined();
  });
});

describe('a job whose composition is not in the open project', () => {
  it('is flagged on restore and left alone by Render All', async () => {
    act(() => { useRenderQueueStore.getState().addJob(baseJob); });
    freshStore();
    // The user relaunched into a different project.
    openProject({ other: { ...comp1, id: 'other', name: 'Other' } });
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });

    const job = useRenderQueueStore.getState().jobs[0]!;
    expect(job.status).toBe('queued');
    expect(job.attention).toMatch(/“Comp 1” is not in the open project/);

    await act(async () => {
      useRenderQueueStore.getState().startAll();
      await settle();
    });
    // Nothing was rendered — a blank file with the right name is not a render.
    expect(createResumableVideoRender).not.toHaveBeenCalled();
    expect(useRenderQueueStore.getState().jobs[0]).toMatchObject({ status: 'queued', progress: 0 });
    expect(useRenderQueueStore.getState().isRunning).toBe(false);
  });

  it('renders once the right project is open again', async () => {
    act(() => { useRenderQueueStore.getState().addJob(baseJob); });
    freshStore();
    openProject({ other: { ...comp1, id: 'other', name: 'Other' } });
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });
    expect(useRenderQueueStore.getState().jobs[0]?.attention).toBeDefined();

    // The project it was queued from is opened.
    openProject({ 'comp-1': comp1 });
    mockRun.mockResolvedValueOnce({ done: true });
    mockFinish.mockResolvedValueOnce({ kind: 'file', ext: 'mp4', frames: 100, save: jest.fn(async () => '/out/hero.mp4'), saveTo: jest.fn(async () => '/out/hero.mp4'), discard: jest.fn() });
    await act(async () => {
      useRenderQueueStore.getState().startAll();
      await settle();
    });
    expect(useRenderQueueStore.getState().jobs[0]).toMatchObject({ status: 'done', attention: undefined });
  });

  it('a job with no composition id (queued by an older version) is not judged', async () => {
    const { compositionId: _drop, ...legacy } = baseJob;
    void _drop;
    act(() => { useRenderQueueStore.getState().addJob(legacy); });
    freshStore();
    openProject({});
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });
    expect(useRenderQueueStore.getState().jobs[0]?.attention).toBeUndefined();
  });
});

describe('throwing a previous session’s work away', () => {
  async function restoredJob(): Promise<RenderJob> {
    resumable = [
      { jobId: 'staging-1', spec: { ...baseJob }, format: 'mp4', totalFrames: 100, stagedFrames: 60, createdAt: 1 },
    ];
    await act(async () => { await useRenderQueueStore.getState().restoreFromLastSession(); });
    return useRenderQueueStore.getState().jobs[0]!;
  }

  it('deletes the staging dir when the job is discarded', async () => {
    const job = await restoredJob();
    act(() => { useRenderQueueStore.getState().discardJobProgress(job.id); });
    // There is no sink to dispose — this session never opened one — so the
    // directory has to be deleted through main, or it is listed again forever.
    expect(discardJob).toHaveBeenCalledWith('staging-1');
    expect(useRenderQueueStore.getState().jobs[0]).toMatchObject({ status: 'queued', progress: 0 });
    expect(useRenderQueueStore.getState().jobs[0]?._adopt).toBeUndefined();
  });

  it('deletes it when the job is removed outright', async () => {
    const job = await restoredJob();
    act(() => { useRenderQueueStore.getState().removeJob(job.id); });
    expect(discardJob).toHaveBeenCalledWith('staging-1');
    expect(useRenderQueueStore.getState().jobs).toEqual([]);
  });

  it('deletes it when the job is skipped', async () => {
    const job = await restoredJob();
    act(() => { useRenderQueueStore.getState().skipJob(job.id); });
    expect(discardJob).toHaveBeenCalledWith('staging-1');
    expect(useRenderQueueStore.getState().jobs[0]?.status).toBe('skipped');
  });

  it('never lets a duplicate inherit the original’s frames', async () => {
    const job = await restoredJob();
    act(() => { useRenderQueueStore.getState().duplicateJob(job.id); });
    const copy = useRenderQueueStore.getState().jobs[1]!;
    expect(copy.stagingJobId).toBeUndefined();
    expect(copy._adopt).toBeUndefined();
    expect(copy.status).toBe('queued');
    // And the original still owns them.
    expect(useRenderQueueStore.getState().jobs[0]?._adopt).toBeDefined();
  });
});
