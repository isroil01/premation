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
import {
  exportAudioEntries,
  renderSequenceZip,
  renderExrSequenceZip,
  renderVideo,
  downloadBlob,
  renderGifBlob,
  createResumableVideoRender,
  type ExportOptions,
  type ResumableVideoRender,
} from '@core/export/exportManager';
import { canEncodeLocally, type VideoFormat } from '@core/export/videoSink';
import { DEFAULT_COMPOSITION } from './compositionStore';
import { compSizeOf } from '@core/composition/compSizes';

export type RenderStatus = 'queued' | 'rendering' | 'done' | 'failed' | 'skipped';

export type OutputFormat = VideoFormat | 'png-sequence' | 'jpg-sequence' | 'exr-sequence';

export interface RenderJob {
  id: string;
  compositionName: string;
  /**
   * WHICH composition to render.
   *
   * Only `compositionName` existed — a label — so every job rendered whatever
   * comp happened to be active. Queue three comps, get three copies of one,
   * each correctly named.
   */
  compositionId?: string;
  outputPath: string;
  format: OutputFormat;
  status: RenderStatus;
  /** Render progress 0–1. */
  progress: number;
  /** Wall-clock render time in ms (set when done or failed). */
  elapsedMs?: number;
  error?: string;
  /** Output frame size. May differ from the composition's own size (half-res
   *  previews, oversized deliverables). */
  width: number;
  height: number;
  /**
   * The COMPOSITION's own size, which is not the same thing as the output size.
   *
   * These were conflated: the comp was described to the renderer as being
   * `width × height` — the output size — so a job rendered at anything other than
   * full resolution described a comp that did not exist. Every layer positioned
   * beyond the shrunken bounds fell outside the frame, and a half-resolution
   * render came out empty. Optional so jobs queued before this existed still run,
   * falling back to the output size.
   */
  compWidth?: number;
  compHeight?: number;
  fps: number;
  durationSec: number;
  transparent: boolean;
  /** The comp's own background. Was hardcoded '#101014' at render time. */
  background?: string;
  /** Encoder quality tier. Draft renders fast and looks it. */
  quality?: 'high' | 'medium' | 'draft';
  /**
   * A paused render's live state: the open sink (staged frames intact on disk)
   * and the offset the loop stops resuming at. Present only between a pause and
   * the resume/removal that consumes it; never serialized — the sink is an
   * in-memory handle, so quitting the app still loses a partial render (as AE's
   * queue does), but a PAUSE no longer does.
   */
  _resume?: { render: ResumableVideoRender; nextOffset: number };
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

  addJob: (job: Omit<RenderJob, 'id' | 'status' | 'progress'>) => string;
  removeJob: (id: string) => void;
  duplicateJob: (id: string) => void;
  updateJob: (id: string, patch: Partial<RenderJob>) => void;
  clearFinished: () => void;

  /** Native folder picker. Returns the chosen path, or null if cancelled. */
  chooseOutputDir: () => Promise<string | null>;
  startAll: () => void;
  pauseAll: () => void;
  skipJob: (id: string) => void;
}

/** Where the queue writes output, if the shell can pick a folder at all. */
export function canChooseOutputDir(): boolean {
  return typeof window !== 'undefined' && !!window.motionEditor?.render?.chooseOutputDir;
}

/**
 * The file extension a queued format produces.
 *
 * One home for this: the Export dialog hardcoded `.webm` for everything that
 * wasn't a sequence, so a GIF job was *named*.webm — matching the queue's old
 * behaviour of actually shipping a WebM under that name.
 */
export function outputExtFor(format: OutputFormat): string {
  switch (format) {
    case 'png-sequence':
    case 'jpg-sequence':
    case 'exr-sequence':
      return 'zip';
    default:
      return format;
  }
}

let jobSeq = 1;

/** The exporter options a queued job renders with. */
function jobOptions(job: RenderJob): ExportOptions {
  return {
    format: job.format,
    width: job.width,
    height: job.height,
    fps: job.fps,
    duration: job.durationSec,
    time: 0,
    quality: job.quality ?? 'high',
    comp: {
      // The COMPOSITION's size, so the comp→frame fit is right at any output
      // scale. See RenderJob.compWidth for what using the output size did.
      width: job.compWidth ?? job.width,
      height: job.compHeight ?? job.height,
      transparent: job.transparent,
      // The job's own comp and background — this rendered the ACTIVE comp on a
      // hardcoded '#101014' regardless of what was queued.
      background: job.background ?? DEFAULT_COMPOSITION.background,
      ...(job.compositionId ? { rootId: job.compositionId } : {}),
      compSizeOf,
    },
  };
}

/** What a finished job produced, and how to hand it to the user. */
type JobOutput =
  | { kind: 'blob'; blob: Blob; ext: string }
  | {
      kind: 'file';
      ext: string;
      frames: number;
      save(name: string): Promise<string | null>;
      saveTo(dir: string, name: string): Promise<string>;
      discard(): Promise<void>;
    };

/** Render one queued job to a file — or pause partway, keeping its staged frames. */
async function renderJob(
  job: RenderJob,
  onProgress: (f: number) => void,
  signal: AbortSignal,
): Promise<JobOutput | { kind: 'paused'; resume: NonNullable<RenderJob['_resume']> }> {
  const opts = jobOptions(job);

  if (job.format === 'png-sequence' || job.format === 'jpg-sequence') {
    const ext = job.format === 'png-sequence' ? 'png' : 'jpg';
    const audio = await exportAudioEntries(opts);
    return { kind: 'blob', blob: await renderSequenceZip(opts, ext, onProgress, signal, audio), ext: 'zip' };
  }

  if (job.format === 'exr-sequence') {
    return { kind: 'blob', blob: await renderExrSequenceZip(opts, onProgress, signal), ext: 'zip' };
  }

  // GIF has no browser encoder path through the sink, so it keeps its own.
  if (job.format === 'gif' && !canEncodeLocally()) {
    return { kind: 'blob', blob: await renderGifBlob(opts, onProgress, signal), ext: 'gif' };
  }

  // ── The resumable path (desktop) ──
  // A paused job keeps its open sink — frames already staged on disk stay
  // there — and comes back at the exact frame the loop stopped on. Pausing
  // used to abort the render outright: the sink was disposed, the staging dir
  // deleted, and Resume meant re-rendering from frame 0.
  const render = job._resume?.render
    ?? await createResumableVideoRender(opts, job.format);
  if (render) {
    const from = job._resume?.nextOffset ?? 0;
    try {
      const res = await render.run(from, onProgress, signal);
      if (!res.done) return { kind: 'paused', resume: { render, nextOffset: res.nextOffset } };
      const result = await render.finish();
      return result.kind === 'blob'
        ? { kind: 'blob', blob: result.blob, ext: result.ext }
        : { kind: 'file', ext: result.ext, frames: result.frames, save: result.save, saveTo: result.saveTo, discard: result.discard };
    } catch (e) {
      // run() disposed on real errors; finish() failures still hold the sink.
      // Either way the job is FAILED now, so nothing may keep a resume handle.
      await render.dispose().catch(() => undefined);
      throw e;
    }
  }

  // Browser fallback: streaming sinks can't pause, so the one-shot path stays.
  const result = await renderVideo(opts, job.format, onProgress, signal);
  return result.kind === 'blob'
    ? { kind: 'blob', blob: result.blob, ext: result.ext }
    : {
        kind: 'file',
        ext: result.ext,
        frames: result.frames,
        save: result.save,
        saveTo: result.saveTo,
        discard: result.discard,
      };
}

export const useRenderQueueStore = create<RenderQueueState>((set, get) => ({
  jobs: [],
  isRunning: false,
  outputDir: null,
  _abort: null,

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
    // A removed job's paused sink must not leak its staging dir.
    const doomed = get().jobs.find((j) => j.id === id);
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
      jobs: [...s.jobs, { ...src, id: newId, status: 'queued', progress: 0, elapsedMs: undefined, error: undefined, _resume: undefined }],
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
      jobs: s.jobs.map((j) => (j.status === 'failed' ? { ...j, status: 'queued', error: undefined } : j)),
    }));

    // Serial async runner — renders each queued job for real, then saves it.
    void (async () => {
      // Ask for the destination ONCE, before any rendering, so nothing is left
      // waiting on a dialog after the work is done.
      if (canChooseOutputDir() && !get().outputDir) {
        const dir = await get().chooseOutputDir();
        if (!dir) {
          set({ isRunning: false, _abort: null });
          return;
        }
      }

      for (;;) {
        if (abort.signal.aborted) break;
        const job = get().jobs.find((j) => j.status === 'queued');
        if (!job) break;
        const started = Date.now();
        get().updateJob(job.id, { status: 'rendering', progress: 0 });
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
          const output = await renderJob(job, onProgress, abort.signal);
          if (output.kind === 'paused') {
            // Back to the queue holding its staged frames and its progress —
            // the whole point. `startAll` picks it up where it stopped.
            get().updateJob(job.id, {
              status: 'queued',
              progress: output.resume.nextOffset / output.resume.render.totalFrames,
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
            get().updateJob(job.id, { status: 'skipped', progress: 1, elapsedMs: Date.now() - started });
            continue;
          }
          get().updateJob(job.id, {
            status: 'done',
            progress: 1,
            elapsedMs: Date.now() - started,
            outputPath: savedTo,
            _resume: undefined,
          });
        } catch (e) {
          if (abort.signal.aborted) {
            // Non-resumable paths (sequences, browser sinks) still lose their
            // partial work on pause — the resumable path never reaches here
            // aborted, it returns 'paused' instead.
            get().updateJob(job.id, { status: 'queued', progress: 0 });
            break;
          }
          get().updateJob(job.id, {
            status: 'failed',
            progress: 0,
            error: e instanceof Error ? e.message : String(e),
            elapsedMs: Date.now() - started,
            _resume: undefined,
          });
        }
      }
      set({ isRunning: false, _abort: null });
    })();
  },

  pauseAll() {
    // The abort signal stops the frame loop. On the resumable (desktop) path
    // the sink STAYS OPEN — staged frames survive on disk, the job returns to
    // the queue carrying `_resume`, and Start picks it up at the exact frame it
    // stopped on. Non-resumable paths (sequences, browser streaming sinks)
    // still discard, as they always did.
    get()._abort?.abort();
    set({ isRunning: false, _abort: null });
  },

  skipJob(id) {
    // Skipping a paused job abandons its partial render — release the staging.
    const skipped = get().jobs.find((j) => j.id === id);
    void skipped?._resume?.render.dispose().catch(() => undefined);
    set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, status: 'skipped', _resume: undefined } : j)) }));
  },
}));
