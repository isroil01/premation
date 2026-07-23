/**
 * renderQueueStore — the After Effects–style Render Queue (Prompt 9).
 *
 * Each job targets one composition + range and produces one real output file
 * via the DETERMINISTIC offline renderer (fixed-timestep, reproducible). Jobs
 * run serially so the UI thread stays responsive; progress is real (driven by
 * the renderer's per-frame callback), and Pause aborts the in-flight render.
 */

import { create } from 'zustand';
import { renderSequenceZip, renderWebMBlob, renderGIFBlob, downloadBlob, type ExportOptions } from '@core/export/exportManager';
import { api } from '@core/api/client';
import { DEFAULT_COMPOSITION } from './compositionStore';

export type RenderStatus = 'queued' | 'rendering' | 'done' | 'failed' | 'skipped';

export type OutputFormat = 'mp4' | 'webm' | 'gif' | 'png-sequence' | 'jpg-sequence';

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
  /** Render parameters (from the composition when the job was queued). */
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  transparent: boolean;
  /** The comp's own background. Was hardcoded '#101014' at render time. */
  background?: string;
}

interface RenderQueueState {
  jobs: RenderJob[];
  isRunning: boolean;
  /** Aborts the in-flight render when the user pauses. */
  _abort: AbortController | null;
  /** Backend render-job id in flight (mp4), so pause can cancel it server-side. */
  _backendJobId: string | null;

  addJob: (job: Omit<RenderJob, 'id' | 'status' | 'progress'>) => void;
  removeJob: (id: string) => void;
  duplicateJob: (id: string) => void;
  updateJob: (id: string, patch: Partial<RenderJob>) => void;
  clearFinished: () => void;

  startAll: () => void;
  pauseAll: () => void;
  skipJob: (id: string) => void;
}

/**
 * The file extension a queued format produces.
 *
 * One home for this: the Export dialog hardcoded `.webm` for everything that
 * wasn't a sequence, so a GIF job was *named* .webm — matching the queue's old
 * behaviour of actually shipping a WebM. `renderJobBlob` returns the real
 * extension it produced; this is for naming the job before it runs.
 */
export function outputExtFor(format: OutputFormat): string {
  switch (format) {
    case 'png-sequence':
    case 'jpg-sequence':
      return 'zip';
    case 'gif':
      return 'gif';
    case 'mp4':
      return 'mp4';
    case 'webm':
    default:
      return 'webm';
  }
}

let jobSeq = 1;

/** Map a queue format + job to the exporter's options + the produced blob. */
async function renderJobBlob(
  job: RenderJob,
  onProgress: (f: number) => void,
  signal: AbortSignal,
  onBackendJob: (id: string | null) => void,
): Promise<{ blob: Blob; ext: string }> {
  const opts: ExportOptions = {
    format: 'webm',
    width: job.width,
    height: job.height,
    fps: job.fps,
    duration: job.durationSec,
    time: 0,
    comp: {
      width: job.width,
      height: job.height,
      transparent: job.transparent,
      // The job's own comp and background — this rendered the ACTIVE comp on a
      // hardcoded '#101014' regardless of what was queued.
      background: job.background ?? DEFAULT_COMPOSITION.background,
      ...(job.compositionId ? { rootId: job.compositionId } : {}),
    },
  };
  switch (job.format) {
    case 'png-sequence':
      return { blob: await renderSequenceZip(opts, 'png', onProgress, signal), ext: 'zip' };
    case 'jpg-sequence':
      return { blob: await renderSequenceZip(opts, 'jpg', onProgress, signal), ext: 'zip' };
    case 'mp4': {
      try {
        const renderJob = await api.createRender({
          format: 'mp4',
          width: opts.width,
          height: opts.height,
          fps: opts.fps,
          duration: opts.duration,
          transparent: job.transparent,
        });
        // Expose the backend job id so a pause/skip can cancel it server-side.
        onBackendJob(renderJob.id);
        try {
          const frameExt = job.transparent ? 'png' : 'jpg';
          const zipBlob = await renderSequenceZip(opts, frameExt, (f) => onProgress(f * 0.5), signal);
          if (signal.aborted) throw new Error('Aborted');
          onProgress(0.5);
          await api.uploadRenderFrames(renderJob.id, zipBlob, 'zip');
          while (true) {
            if (signal.aborted) throw new Error('Aborted');
            const status = await api.getRender(renderJob.id);
            if (status.status === 'completed' && status.resultUrl) {
              onProgress(1.0);
              const res = await fetch(status.resultUrl);
              return { blob: await res.blob(), ext: 'mp4' };
            }
            if (status.status === 'failed') throw new Error(status.error || 'Backend render failed');
            if (status.status === 'canceled') throw new Error('Aborted');
            onProgress(0.5 + status.progress * 0.45);
            await new Promise(r => setTimeout(r, 1000));
          }
        } finally {
          onBackendJob(null);
        }
      } catch (err) {
        const reason = (err as Error)?.message ?? String(err);
        const offline = err instanceof TypeError || /fetch|network|ECONNREFUSED|Failed to fetch/i.test(reason);
        if (offline) {
          const { renderMP4Blob } = await import('@core/export/exportManager');
          const blob = await renderMP4Blob(opts, onProgress, signal);
          return { blob, ext: 'mp4' };
        }
        throw err;
      }
    }
    case 'gif':
      // Renders a real GIF. This used to warn "no local GIF encoder" and ship a
      // .webm under a .gif request — while `renderGIFBlob` (a hand-written
      // GIF89a + LZW encoder) was already powering the Export dialog.
      return { blob: await renderGIFBlob({ ...opts, format: 'gif' }, onProgress, signal), ext: 'gif' };
    case 'webm':
    default:
      return { blob: await renderWebMBlob(opts, onProgress, signal), ext: 'webm' };
  }
}

export const useRenderQueueStore = create<RenderQueueState>((set, get) => ({
  jobs: [],
  isRunning: false,
  _abort: null,
  _backendJobId: null,

  addJob(job) {
    const id = `rq_${Date.now()}_${jobSeq++}`;
    set((s) => ({ jobs: [...s.jobs, { ...job, id, status: 'queued', progress: 0 }] }));
  },

  removeJob(id) {
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
  },

  duplicateJob(id) {
    const src = get().jobs.find((j) => j.id === id);
    if (!src) return;
    const newId = `rq_${Date.now()}_${jobSeq++}`;
    set((s) => ({
      jobs: [...s.jobs, { ...src, id: newId, status: 'queued', progress: 0, elapsedMs: undefined, error: undefined }],
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



    // Serial async runner — renders each queued job for real, then downloads it.
    void (async () => {
      for (;;) {
        if (abort.signal.aborted) break;
        const job = get().jobs.find((j) => j.status === 'queued');
        if (!job) break;
        const started = Date.now();
        get().updateJob(job.id, { status: 'rendering', progress: 0 });
        // Coalesce progress writes: the renderer fires per-frame, and each write
        // rebuilds the jobs array and reconciles the panel. Writing only on ≥1%
        // moves (and always on completion) drops that from dozens/sec to ~100
        // total — the render loop and the UI share one thread, so this is what
        // keeps the app (and cursor) responsive during an export.
        let lastProgress = -1;
        const onProgress = (f: number): void => {
          if (f < 1 && lastProgress >= 0 && f - lastProgress < 0.01) return;
          lastProgress = f;
          get().updateJob(job.id, { progress: f });
        };
        try {
          const { blob, ext } = await renderJobBlob(
            job,
            onProgress,
            abort.signal,
            (backendId) => set({ _backendJobId: backendId }),
          );
          const base = job.outputPath.replace(/\.[^/.]+$/, '');
          downloadBlob(blob, `${base.split('/').pop() || 'render'}.${ext}`);
          get().updateJob(job.id, { status: 'done', progress: 1, elapsedMs: Date.now() - started });
        } catch (e) {
          if (abort.signal.aborted) {
            get().updateJob(job.id, { status: 'queued', progress: 0 });
            break;
          }
          get().updateJob(job.id, { status: 'failed', error: e instanceof Error ? e.message : String(e) });
        }
      }
      set({ isRunning: false, _abort: null });
    })();
  },

  pauseAll() {
    get()._abort?.abort();
    // Cancel the backend mp4 job too, so a paused render doesn't linger
    // queued/running on the server (best-effort — the abort already stopped us).
    const backendId = get()._backendJobId;
    if (backendId) void api.cancelRender(backendId).catch(() => undefined);
    set({ isRunning: false, _abort: null, _backendJobId: null });
  },

  skipJob(id) {
    set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, status: 'skipped' } : j)) }));
  },
}));
