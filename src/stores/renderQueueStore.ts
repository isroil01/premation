/**
 * renderQueueStore — the After Effects–style Render Queue (Prompt 9).
 *
 * Each job targets one composition + range and produces one real output file
 * via the DETERMINISTIC offline renderer (fixed-timestep, reproducible). Jobs
 * run serially so the UI thread stays responsive; progress is real (driven by
 * the renderer's per-frame callback), and Pause aborts the in-flight render.
 */

import { create } from 'zustand';
import { renderSequenceZip, renderWebMBlob, downloadBlob, type ExportOptions } from '@core/export/exportManager';
import { api } from '@core/api/client';
import { useUIStore } from './uiStore';

export type RenderStatus = 'queued' | 'rendering' | 'done' | 'failed' | 'skipped';

export type OutputFormat = 'mp4' | 'webm' | 'gif' | 'png-sequence' | 'jpg-sequence';

export interface RenderJob {
  id: string;
  compositionName: string;
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
    comp: { width: job.width, height: job.height, transparent: job.transparent, background: '#101014' },
  };
  switch (job.format) {
    case 'png-sequence':
      return { blob: await renderSequenceZip(opts, 'png', onProgress, signal), ext: 'zip' };
    case 'jpg-sequence':
      return { blob: await renderSequenceZip(opts, 'jpg', onProgress, signal), ext: 'zip' };
    case 'mp4': {
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
    }
    case 'webm':
    default:
      return { blob: await renderWebMBlob(opts, onProgress, signal), ext: 'webm' };
    case 'gif':
      useUIStore.getState().notify({
        level: 'warning',
        message: 'GIF format falls back to WebM output (no local GIF encoder).',
        durationMs: 4000
      });
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
    set((s) => ({ jobs: s.jobs.filter((j) => j.status === 'queued' || j.status === 'rendering') }));
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
        try {
          const { blob, ext } = await renderJobBlob(
            job,
            (f) => get().updateJob(job.id, { progress: f }),
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
