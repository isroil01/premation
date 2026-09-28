/**
 * renderQueueStore — the Render Queue's PENDING list.
 *
 * Jobs are added here (Add Comp, Add to Queue from the Export form, the
 * assistant) and wait until Render All hands them, in order, to main's export
 * queue — the ENGINE renders every file (`premation-engine --export`,
 * electron/engineExport.ts). A handed-over job leaves this list: from then on
 * it is main's record, shown by the queue list under it (`exportQueueStore`),
 * which is where its progress, cancel and retry live.
 *
 * There is no in-window render any more (docs/TS_ENGINE_REMOVAL.md phase 4):
 * the frame loop, the staged/resumable sinks and the cross-restart adoption
 * that went with them are gone. The pause / stop / resume verbs remain for the
 * panel and act on the hand-over only.
 */

import { create } from 'zustand';
import { outputExtFor, type OutputFormat, type RenderJobSpec } from '@core/export/renderSpec';
import {
  isPersistedJob,
  isPersistedStatus,
  missingCompositionMessage,
  toPersistedJob,
  type PersistedRenderJob,
} from '@core/export/renderQueuePersist';
import { readPersisted, writePersisted } from '@core/settings/persistedValue';
import { documentMirror, type DocumentMirror } from './documentMirror';
import { useUIStore } from './uiStore';

// Re-exported so the panels, the Export dialog and the AI export tool keep
// importing the queue's vocabulary from the queue.
export { outputExtFor, type OutputFormat };

/**
 * Where a pending job is. `rendering` is the moment of hand-over; `paused` /
 * `stopped` are kept for records an older version wrote (they come back
 * `queued`).
 */
export type RenderStatus =
  | 'queued'
  | 'rendering'
  | 'paused'
  | 'stopped'
  | 'done'
  | 'failed'
  | 'skipped';

/** Nothing is held between sessions any more: no job is resumable. */
export function isResumable(status: RenderStatus): boolean {
  return status === 'paused' || status === 'stopped';
}

/** A pending render: what to render plus what the list shows about it. */
export interface RenderJob extends RenderJobSpec {
  id: string;
  status: RenderStatus;
  /** 0–1; a pending job is 0. */
  progress: number;
  elapsedMs?: number;
  error?: string;
  /** Always undefined (kept for the panel's resume readout of older records). */
  resumeFrame?: number;
  /**
   * Something the user should know before this job runs — set when its
   * composition is not in the open project. Cleared on hand-over.
   */
  attention?: string;
}

/** Where the queue's jobs live between sessions. See `persistedValue.ts`. */
const QUEUE_KEY = 'renderQueue.jobs';
/** And the folder they are written to, so a restored queue needs no dialog. */
const OUTPUT_DIR_KEY = 'renderQueue.outputDir';

let lastPersisted: string | null = null;
function persistJobs(jobs: RenderJob[]): void {
  const payload = JSON.stringify(jobs.filter((j) => isPersistedStatus(j.status)).map(toPersistedJob));
  if (payload === lastPersisted) return;
  lastPersisted = payload;
  writePersisted(QUEUE_KEY, JSON.parse(payload) as PersistedRenderJob[]);
}

/**
 * Is the composition this job renders in the open project? A job whose comp
 * is gone is left pending and flagged — the engine would render nothing.
 */
function compositionMissing(job: RenderJobSpec): boolean {
  if (!job.compositionId) return false;
  let m: DocumentMirror;
  try {
    m = documentMirror();
  } catch {
    return false;
  }
  if (m.status !== 'ready') return false;
  return !m.comp(job.compositionId);
}

/**
 * How a pending job reaches main's queue: `supervisorQueue.enqueueSupervisorJob`,
 * registered by that module (the layout owns the snapshot + enqueue; a store
 * does not import the layout). Resolves the job id, or null when nothing was
 * queued (a dialog cancelled, or a failure it already reported).
 */
type Submitter = (job: Omit<RenderJob, 'id' | 'status' | 'progress'>) => Promise<string | null>;
let submitter: Submitter | null = null;
export function setRenderQueueSubmitter(fn: Submitter | null): void {
  submitter = fn;
}

interface RenderQueueState {
  jobs: RenderJob[];
  /** True while Render All is handing jobs over. */
  isRunning: boolean;
  /**
   * Where finished renders are written. Chosen once and reused, because a
   * queue that opens a save dialog per job stops on the first one and waits.
   */
  outputDir: string | null;
  _stop: boolean;
  _restored: boolean;

  /** Bring back the jobs the last session left pending. Idempotent. */
  restoreFromLastSession: () => Promise<void>;
  addJob: (job: Omit<RenderJob, 'id' | 'status' | 'progress'>) => string;
  removeJob: (id: string) => void;
  duplicateJob: (id: string) => void;
  updateJob: (id: string, patch: Partial<RenderJob>) => void;
  clearFinished: () => void;

  /** Native folder picker. Returns the chosen path, or null if cancelled. */
  chooseOutputDir: () => Promise<string | null>;
  /** Hand every pending job to main's queue, in order. */
  startAll: () => void;
  /** Stop handing over (what is already on main's queue stays there). */
  pauseAll: () => void;
  stopAll: () => void;
  discardAll: () => void;
  pauseJob: (id: string) => void;
  /** Hand one job over now. */
  resumeJob: (id: string) => void;
  discardJobProgress: (id: string) => void;
  skipJob: (id: string) => void;
}

/** Where the queue writes output, if the shell can pick a folder at all. */
export function canChooseOutputDir(): boolean {
  return typeof window !== 'undefined' && !!window.motionEditor?.render?.chooseOutputDir;
}

let jobSeq = 1;

export const useRenderQueueStore = create<RenderQueueState>((set, get) => {
  /** Hand `ids` (in order) to main's queue; stops on a Stop or a cancelled dialog. */
  const handOver = async (ids: readonly string[]): Promise<void> => {
    if (get().isRunning) return;
    const submit = submitter;
    if (!submit) {
      useUIStore.getState().notify({ level: 'error', message: 'Rendering needs the desktop app: files are rendered by the engine.', durationMs: 6000 });
      return;
    }
    set({ isRunning: true, _stop: false });
    let leftBehind = 0;
    try {
      if (canChooseOutputDir() && !get().outputDir && !(await get().chooseOutputDir())) return;
      for (const id of ids) {
        if (get()._stop) break;
        const job = get().jobs.find((j) => j.id === id);
        if (!job || (job.status !== 'queued' && !isResumable(job.status))) continue;
        if (compositionMissing(job)) {
          leftBehind++;
          get().updateJob(id, { attention: missingCompositionMessage(job.compositionName) });
          continue;
        }
        get().updateJob(id, { status: 'rendering', attention: undefined });
        const { id: _id, status: _s, progress: _p, elapsedMs: _e, error: _err, resumeFrame: _r, attention: _a, ...spec } = job;
        void _id; void _s; void _p; void _e; void _err; void _r; void _a;
        const queued = await submit(spec);
        if (queued) {
          // Main's record from here on (the queue list shows it).
          set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
        } else {
          get().updateJob(id, { status: 'queued' });
          break;
        }
      }
    } finally {
      set({ isRunning: false });
    }
    if (leftBehind > 0) {
      useUIStore.getState().notify({
        level: 'warning',
        message: leftBehind === 1
          ? '1 queued render was skipped: its composition is not in the open project'
          : `${leftBehind} queued renders were skipped: their compositions are not in the open project`,
        durationMs: 5000,
      });
    }
  };

  return {
    jobs: [],
    isRunning: false,
    outputDir: readPersisted<string | null>(OUTPUT_DIR_KEY, null),
    _stop: false,
    _restored: false,

    async restoreFromLastSession() {
      if (get()._restored) return;
      set({ _restored: true });
      const stored = readPersisted<unknown[]>(QUEUE_KEY, []);
      const restored: RenderJob[] = (Array.isArray(stored) ? stored : []).filter(isPersistedJob).map((p): RenderJob => {
        const { id, stagingJobId, status, resumeFrame, ...spec } = p;
        void stagingJobId; void status; void resumeFrame;
        const job: RenderJob = { ...spec, id, status: 'queued', progress: 0 };
        if (compositionMissing(job)) job.attention = missingCompositionMessage(job.compositionName);
        return job;
      });
      if (restored.length === 0) return;
      set((st) => {
        const have = new Set(st.jobs.map((j) => j.id));
        return { jobs: [...st.jobs, ...restored.filter((j) => !have.has(j.id))] };
      });
    },

    async chooseOutputDir() {
      const dir = (await window.motionEditor?.render?.chooseOutputDir?.()) ?? null;
      if (dir) {
        set({ outputDir: dir });
        writePersisted(OUTPUT_DIR_KEY, dir);
      }
      return dir;
    },

    addJob(job) {
      const id = `rq_${Date.now()}_${jobSeq++}`;
      set((s) => ({ jobs: [...s.jobs, { ...job, id, status: 'queued', progress: 0 }] }));
      return id;
    },

    removeJob(id) {
      if (get().jobs.find((j) => j.id === id)?.status === 'rendering') return;
      set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
    },

    duplicateJob(id) {
      const src = get().jobs.find((j) => j.id === id);
      if (!src) return;
      const newId = `rq_${Date.now()}_${jobSeq++}`;
      set((s) => ({
        jobs: [...s.jobs, { ...src, id: newId, status: 'queued', progress: 0, elapsedMs: undefined, error: undefined, attention: undefined, resumeFrame: undefined }],
      }));
    },

    updateJob(id, patch) {
      set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) }));
    },

    clearFinished() {
      set((s) => ({ jobs: s.jobs.filter((j) => j.status !== 'done') }));
    },

    startAll() {
      set((s) => ({ jobs: s.jobs.map((j) => (j.status === 'failed' ? { ...j, status: 'queued', error: undefined } : j)) }));
      void handOver(get().jobs.map((j) => j.id));
    },

    pauseAll() {
      set({ _stop: true });
    },

    stopAll() {
      set({ _stop: true });
    },

    discardAll() {
      set({ _stop: true });
    },

    pauseJob() {
      set({ _stop: true });
    },

    resumeJob(id) {
      void handOver([id]);
    },

    discardJobProgress(id) {
      const job = get().jobs.find((j) => j.id === id);
      if (!job || !isResumable(job.status)) return;
      get().updateJob(id, { status: 'queued', progress: 0, resumeFrame: undefined, attention: undefined });
    },

    skipJob(id) {
      set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, status: 'skipped' } : j)) }));
    },
  };
});

/** The queue writes itself down whenever its SPECS change. */
useRenderQueueStore.subscribe((state, prev) => {
  if (state.jobs === prev.jobs) return;
  persistJobs(state.jobs);
});
