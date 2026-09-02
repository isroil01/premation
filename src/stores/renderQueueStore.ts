/**
 * renderQueueStore — the After Effects–style Render Queue.
 *
 * Each job targets one composition and produces one real output file through the
 * same deterministic pipeline the Export dialog uses (offlineRenderer for frames,
 * a VideoSink for the encode), so a queued render and an immediate export of the
 * same comp are byte-for-byte the same work.
 *
 * Jobs run serially. On the desktop the encode happens in an ffmpeg child
 * process, so the only main-thread cost is rasterising frames — see
 * `FRAME_YIELD_MS` for how that is kept from monopolising the UI.
 */

import { create } from 'zustand';
import { downloadBlob } from '@core/export/exportManager';
import {
  outputExtFor,
  renderJobOutput,
  type JobResume,
  type OutputFormat,
  type RenderJobSpec,
} from '@core/export/renderJob';

// Re-exported so the panels, the Export dialog and the AI export tool keep
// importing the queue's vocabulary from the queue. The DEFINITIONS moved to
// @core/export/renderJob when the headless CLI became a second caller of the
// same render; where they are declared is not the panels' business.
export { outputExtFor, type OutputFormat };

/**
 * Tell plugins a render left the queue — a post-render action.
 *
 * Imported LAZILY, inside the notifier, for two reasons: the plugin host pulls
 * in the whole plugin runtime, which the render queue otherwise has no reason
 * to load; and a static import here is a cycle (the host reads the scene, the
 * scene stores read this). Fire-and-forget by construction — the queue must
 * never wait on a worker, and a plugin that throws must not fail a render that
 * already succeeded.
 */
function notifyPlugins(info: {
  status: 'done' | 'skipped' | 'failed';
  job: RenderJob;
  fileName: string | null;
  elapsedMs: number;
  error?: string;
}): void {
  void import('@core/plugins/PluginHost')
    .then(({ pluginHost }) => {
      pluginHost.notifyRenderFinished({
        status: info.status,
        compositionName: info.job.compositionName,
        fileName: info.fileName,
        format: info.job.format,
        width: info.job.width,
        height: info.job.height,
        fps: info.job.fps,
        durationSec: info.job.durationSec,
        elapsedMs: info.elapsedMs,
        ...(info.error === undefined ? {} : { error: info.error }),
      });
    })
    .catch(() => { /* the host is not up; a render still succeeded */ });
}

/**
 * Where a job is in its life.
 *
 * `paused` and `stopped` are the SAME state mechanically — a render that
 * stopped feeding frames while its sink stayed open, holding every frame it
 * had already staged. They differ only in who asked and what the panel says:
 * `paused` is "I pressed Pause on this job", `stopped` is "I stopped the whole
 * queue". Both carry `resumeFrame` and both are picked up again, ahead of
 * anything merely `queued`, by the next Render All.
 *
 * Losing the work is now its own verb — Discard — which is the only thing that
 * disposes a sink and sends a job back to `queued` at 0%.
 */
export type RenderStatus =
  | 'queued'
  | 'rendering'
  | 'paused'
  | 'stopped'
  | 'done'
  | 'failed'
  | 'skipped';

/** A stopped job still holds its staged frames and comes back where it was. */
export function isResumable(status: RenderStatus): boolean {
  return status === 'paused' || status === 'stopped';
}

/**
 * What the abort that is about to land MEANS.
 *
 * The frame loop is stopped the same way in all three cases — one
 * `AbortController` — so the intent has to travel beside the signal: the loop
 * reads it when `renderJobOutput` comes back `paused` and decides whether the
 * open sink is kept (pause/stop) or thrown away (discard).
 */
type StopIntent = 'pause' | 'stop' | 'discard';

/**
 * A queued render: what to render (`RenderJobSpec`) plus what a QUEUE has to
 * know about it. The render half is shared with the headless CLI, which has an
 * id-less, statusless, progressless version of the same work.
 */
export interface RenderJob extends RenderJobSpec {
  id: string;
  status: RenderStatus;
  /** Render progress 0–1. */
  progress: number;
  /** Wall-clock render time in ms (set when done or failed). */
  elapsedMs?: number;
  error?: string;
  /**
   * The frame a paused/stopped job comes back at, 0-based within its export
   * range. The panel's honest answer to "how much of this is already on disk".
   *
   * Mirrors `_resume.nextOffset` deliberately: `_resume` is a live handle the
   * UI must not touch, and a plain number is what a status line, a tooltip and
   * a test can all read.
   */
  resumeFrame?: number;
  /**
   * A paused render's live state: the open sink (staged frames intact on disk)
   * and the offset the loop stops resuming at. Present only between a pause and
   * the resume/removal that consumes it; never serialized — the sink is an
   * in-memory handle, so quitting the app still loses a partial render (as AE's
   * queue does), but a PAUSE no longer does.
   */
  _resume?: JobResume;
}

interface RenderQueueState {
  jobs: RenderJob[];
  isRunning: boolean;
  /**
   * Where finished renders are written, on desktop builds.
   *
   * Chosen once and reused, because a queue that opens a save dialog per job
   * stops on the first one and waits — which defeats the entire purpose of
   * queueing renders and walking away.
   */
  outputDir: string | null;
  /** Aborts the in-flight render when the user pauses. */
  _abort: AbortController | null;
  /** What the pending abort means — see `StopIntent`. */
  _intent: StopIntent;
  /**
   * The job the next loop iteration must pick first.
   *
   * Resume is per-job in the panel, but the runner is one serial loop, so
   * "resume THIS one" cannot be expressed by a status alone when three jobs are
   * paused. Set by `resumeJob`, consumed by the loop on the iteration that
   * picks it up.
   */
  _resumeTarget: string | null;

  addJob: (job: Omit<RenderJob, 'id' | 'status' | 'progress'>) => string;
  removeJob: (id: string) => void;
  duplicateJob: (id: string) => void;
  updateJob: (id: string, patch: Partial<RenderJob>) => void;
  clearFinished: () => void;

  /** Native folder picker. Returns the chosen path, or null if cancelled. */
  chooseOutputDir: () => Promise<string | null>;
  startAll: () => void;
  /** Stop after the current frame, keeping the sink. Job → `paused`. */
  pauseAll: () => void;
  /** Same, but the whole queue was stopped. Job → `stopped`. */
  stopAll: () => void;
  /** The destructive one: kill the encode, delete the staging, back to 0%. */
  discardAll: () => void;
  /** Pause one job — only the rendering one can be paused. */
  pauseJob: (id: string) => void;
  /** Resume one paused/stopped job, ahead of everything else in the queue. */
  resumeJob: (id: string) => void;
  /** Throw away one paused/stopped job's staged frames; it restarts at 0. */
  discardJobProgress: (id: string) => void;
  skipJob: (id: string) => void;
}

/** Where the queue writes output, if the shell can pick a folder at all. */
export function canChooseOutputDir(): boolean {
  return typeof window !== 'undefined' && !!window.motionEditor?.render?.chooseOutputDir;
}

let jobSeq = 1;

export const useRenderQueueStore = create<RenderQueueState>((set, get) => ({
  jobs: [],
  isRunning: false,
  outputDir: null,
  _abort: null,
  _intent: 'pause',
  _resumeTarget: null,

  async chooseOutputDir() {
    const dir = (await window.motionEditor?.render?.chooseOutputDir?.()) ?? null;
    if (dir) set({ outputDir: dir });
    return dir;
  },

  addJob(job) {
    const id = `rq_${Date.now()}_${jobSeq++}`;
    set((s) => ({ jobs: [...s.jobs, { ...job, id, status: 'queued', progress: 0 }] }));
    return id;
  },

  removeJob(id) {
    const doomed = get().jobs.find((j) => j.id === id);
    // A job that is RENDERING right now cannot simply vanish: the loop keeps
    // rendering it, its progress writes become no-ops, and on completion a
    // file is written for a job the user deleted. Stop the queue first.
    if (doomed?.status === 'rendering') return;
    // A removed job's paused sink must not leak its staging dir.
    void doomed?._resume?.render.dispose().catch(() => undefined);
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
  },

  duplicateJob(id) {
    const src = get().jobs.find((j) => j.id === id);
    if (!src) return;
    const newId = `rq_${Date.now()}_${jobSeq++}`;
    set((s) => ({
      // `_resume` is stripped: it holds a live sink, and two jobs sharing one
      // staging dir would interleave their frames into a single file.
      jobs: [...s.jobs, { ...src, id: newId, status: 'queued', progress: 0, elapsedMs: undefined, error: undefined, _resume: undefined, resumeFrame: undefined }],
    }));
  },

  updateJob(id, patch) {
    set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) }));
  },

  clearFinished() {
    // "Clear Done" — remove only completed jobs. Failed/skipped jobs stay so a
    // failure isn't silently discarded (they were being deleted too).
    set((s) => ({ jobs: s.jobs.filter((j) => j.status !== 'done') }));
  },

  startAll() {
    if (get().isRunning) return;
    const abort = new AbortController();
    set((s) => ({
      isRunning: true,
      _abort: abort,
      // A fresh run starts with no pending stop; whichever control fires next
      // stamps its own meaning on this before aborting.
      _intent: 'pause',
      jobs: s.jobs.map((j) => (j.status === 'failed' ? { ...j, status: 'queued', error: undefined } : j)),
    }));
    // Epoch token: pauseAll flips isRunning while THIS loop is still parked on
    // an await. A Start pressed in that window began a SECOND loop, and the
    // first loop's trailing set() then stamped "not running" over it — the
    // panel showed Stopped while a render ran, and Stop could no longer reach
    // its controller. A loop only writes the trailing state if it is still
    // the CURRENT loop.
    const myAbort = abort;

    // Serial async runner — renders each queued job for real, then saves it.
    void (async () => {
      // Ask for the destination ONCE, before any rendering, so nothing is left
      // waiting on a dialog after the work is done.
      if (canChooseOutputDir() && !get().outputDir) {
        const dir = await get().chooseOutputDir();
        if (!dir) {
          if (get()._abort === myAbort) set({ isRunning: false, _abort: null });
          return;
        }
      }

      for (;;) {
        if (abort.signal.aborted) break;
        // Half-rendered work first, always: a paused/stopped job is holding a
        // staging dir and an open encoder, and starting an unrelated job ahead
        // of it means two sinks alive at once for no reason. A job the user
        // explicitly pressed Resume on jumps even that queue.
        const all = get().jobs;
        const target = get()._resumeTarget;
        const job =
          (target ? all.find((j) => j.id === target && isResumable(j.status)) : undefined)
          ?? all.find((j) => isResumable(j.status))
          ?? all.find((j) => j.status === 'queued');
        if (!job) break;
        if (job.id === target) set({ _resumeTarget: null });
        const started = Date.now();
        // Progress SURVIVES: a resumed job is already 40% encoded, and showing
        // 0% while ffmpeg's staging dir holds 400 frames was the visible half
        // of pause meaning "start over".
        get().updateJob(job.id, { status: 'rendering', progress: job._resume ? job.progress : 0 });
        // Coalesce progress writes: the renderer fires per-frame, and each write
        // rebuilds the jobs array and reconciles the panel. Writing only on ≥1%
        // moves (and always on completion) drops that from dozens/sec to ~100
        // total — frame rasterisation and the UI share one thread, so this is
        // part of what keeps the app (and the cursor) responsive during a render.
        let lastProgress = -1;
        const onProgress = (f: number): void => {
          if (f < 1 && lastProgress >= 0 && f - lastProgress < 0.01) return;
          lastProgress = f;
          get().updateJob(job.id, { progress: f });
        };
        try {
          const output = await renderJobOutput(job, onProgress, abort.signal, job._resume);
          if (output.kind === 'paused') {
            const intent = get()._intent;
            if (intent === 'discard') {
              // The only path that throws work away, and only because someone
              // asked for it by name: the sink is disposed (ffmpeg killed, the
              // staging dir removed) and the job goes back to the queue at 0.
              await output.resume.render.dispose().catch(() => undefined);
              get().updateJob(job.id, { status: 'queued', progress: 0, _resume: undefined, resumeFrame: undefined });
              break;
            }
            // Otherwise the job holds its staged frames and its progress — the
            // whole point. The next Render All picks it up where it stopped.
            get().updateJob(job.id, {
              status: intent === 'stop' ? 'stopped' : 'paused',
              progress: output.resume.nextOffset / output.resume.render.totalFrames,
              resumeFrame: output.resume.nextOffset,
              _resume: output.resume,
            });
            break;
          }
          const name = `${job.outputPath.replace(/\.[^/.]+$/, '').split('/').pop() || 'render'}.${output.ext}`;
          let savedTo: string | null = name;
          if (output.kind === 'blob') {
            downloadBlob(output.blob, name);
          } else {
            const dir = get().outputDir;
            savedTo = dir ? await output.saveTo(dir, name) : await output.save(name);
          }
          if (savedTo === null) {
            // The user dismissed the save dialog: the render succeeded but no
            // file exists, so calling it "done" would be a lie.
            const elapsedMs = Date.now() - started;
            get().updateJob(job.id, { status: 'skipped', progress: 1, elapsedMs });
            notifyPlugins({ status: 'skipped', job, fileName: null, elapsedMs });
            continue;
          }
          const doneMs = Date.now() - started;
          get().updateJob(job.id, {
            status: 'done',
            progress: 1,
            elapsedMs: doneMs,
            outputPath: savedTo,
            _resume: undefined,
            resumeFrame: undefined,
          });
          // `name`, not `savedTo`: the basename is what a plugin can use, and
          // the directory is something about the user's machine it has no use
          // for. See `RenderFinishedInfo`.
          notifyPlugins({ status: 'done', job, fileName: name, elapsedMs: doneMs });
        } catch (e) {
          if (abort.signal.aborted) {
            // Non-resumable paths (sequences, browser sinks) still lose their
            // partial work on pause — the resumable path never reaches here
            // aborted, it returns 'paused' instead. Back to `queued` at 0
            // rather than `paused`, because "paused at 37%" would be a lie
            // about a render that has nothing staged to come back to.
            get().updateJob(job.id, { status: 'queued', progress: 0, resumeFrame: undefined });
            break;
          }
          const failMs = Date.now() - started;
          const message = e instanceof Error ? e.message : String(e);
          get().updateJob(job.id, {
            status: 'failed',
            progress: 0,
            error: message,
            elapsedMs: failMs,
            _resume: undefined,
            resumeFrame: undefined,
          });
          notifyPlugins({ status: 'failed', job, fileName: null, elapsedMs: failMs, error: message });
        }
      }
      if (get()._abort === myAbort) set({ isRunning: false, _abort: null });
    })();
  },

  /**
   * Stop the frame loop, keep everything it produced.
   *
   * The abort signal stops the loop after the current frame. On the resumable
   * (desktop) path the sink STAYS OPEN — staged frames survive on disk, the job
   * keeps `_resume` and `resumeFrame`, and the next Render All picks it up at
   * the exact frame it stopped on. Non-resumable paths (sequences, browser
   * streaming sinks) still lose their partial work, as they always did.
   */
  pauseAll() {
    set({ _intent: 'pause' });
    get()._abort?.abort();
    set({ isRunning: false, _abort: null });
  },

  /** Stop the queue, keeping progress. Identical to pause but for the label. */
  stopAll() {
    set({ _intent: 'stop' });
    get()._abort?.abort();
    set({ isRunning: false, _abort: null });
  },

  /**
   * Abort AND throw the work away — what "Stop" used to do silently.
   *
   * Kills the ffmpeg child, deletes the staging dir, and puts the job back at
   * 0%. Kept as its own control so losing a forty-minute render is something a
   * user chooses rather than something a button quietly does.
   */
  discardAll() {
    set({ _intent: 'discard' });
    get()._abort?.abort();
    set({ isRunning: false, _abort: null });
    // Anything already parked as paused/stopped is discarded too — Discard
    // means the queue holds no half-rendered files afterwards.
    for (const j of get().jobs) {
      if (isResumable(j.status)) get().discardJobProgress(j.id);
    }
  },

  pauseJob(id) {
    // Only the in-flight job has a loop to stop; the rest are already parked.
    if (get().jobs.find((j) => j.id === id)?.status !== 'rendering') return;
    get().pauseAll();
  },

  resumeJob(id) {
    const job = get().jobs.find((j) => j.id === id);
    if (!job || !isResumable(job.status)) return;
    set({ _resumeTarget: id });
    get().startAll();
  },

  discardJobProgress(id) {
    const job = get().jobs.find((j) => j.id === id);
    if (!job || !isResumable(job.status)) return;
    void job._resume?.render.dispose().catch(() => undefined);
    get().updateJob(id, { status: 'queued', progress: 0, _resume: undefined, resumeFrame: undefined });
  },

  skipJob(id) {
    // Skipping a paused job abandons its partial render — release the staging.
    const skipped = get().jobs.find((j) => j.id === id);
    void skipped?._resume?.render.dispose().catch(() => undefined);
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === id ? { ...j, status: 'skipped', _resume: undefined, resumeFrame: undefined } : j,
      ),
    }));
  },
}));
