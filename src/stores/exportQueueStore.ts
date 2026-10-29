/**
 * The export queue as the UI sees it — a MIRROR of the one main owns.
 *
 * Main is the authority (electron/exportProcess.ts): it holds the jobs, runs
 * them and writes them down. This store subscribes once, keeps a copy, and
 * forwards the verbs. Nothing here is the queue; a reload of the editor
 * re-subscribes and gets the same list back, running job included.
 *
 * It also keeps the status-bar tray honest: every supervisor job has one
 * `uiStore` job for its lifetime, so "Exporting promo.mp4 · 40%" shows in the
 * same place a cache pass or a transcription would, and finishes there too.
 */

import { create } from 'zustand';
import {
  describeProgress,
  exportSupervisorAvailable,
  exportSupervisorClient,
  isFinishedStatus,
  type ExportJobRecord,
  type ExportQueueEvent,
} from '@core/export/exportSupervisorClient';
import { useUIStore, type JobOutcome } from './uiStore';
import { ensureFfmpegFor } from './ffmpegStore';
import { t } from '@core/i18n';

const TRAY_PREFIX = 'export-job:';

/**
 * Told once when a job this window watched finishes `completed` (not for jobs
 * already done when it connected): the post-render action runner, registered
 * by the layout (src/layout/Export/postRender.ts) — a store does not import it.
 */
let onCompleted: ((job: ExportJobRecord) => void) | null = null;
export function setExportCompletedHandler(fn: ((job: ExportJobRecord) => void) | null): void {
  onCompleted = fn;
}

export interface ExportQueueState {
  /** Newest last, the order main keeps them in. */
  jobs: ReadonlyArray<ExportJobRecord>;
  /** True once `connect` has subscribed; false in a build without the bridge. */
  connected: boolean;
  /** Subscribe to main, once. Safe to call from every host that shows the queue. */
  connect(): Promise<void>;
  /** Apply one push from main. Exported for tests; `connect` wires it. */
  apply(event: ExportQueueEvent): void;
  cancel(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  setPriority(id: string, priority: number): Promise<void>;
}

/** Keep the tray's job in step with a queue job's transition. */
function mirrorToTray(prev: ExportJobRecord | undefined, next: ExportJobRecord): void {
  const ui = useUIStore.getState();
  const trayId = `${TRAY_PREFIX}${next.id}`;
  const label = t('stores.exportQueue.exporting', 'Exporting {name}', { name: next.spec.label });
  const wasLive = prev ? !isFinishedStatus(prev.status) : false;
  const isLive = !isFinishedStatus(next.status);

  if (isLive && !wasLive) {
    ui.startJob({
      id: trayId,
      kind: 'export',
      label,
      progress: next.status === 'queued' ? 'indeterminate' : next.progress.fraction,
      // The supervisor's own Cancel: the job then arrives `cancelled` here.
      cancel: () => { void useExportQueueStore.getState().cancel(next.id); },
    });
    return;
  }
  if (isLive) {
    ui.updateJob(trayId, {
      progress: next.status === 'queued' || next.status === 'encoding' ? 'indeterminate' : next.progress.fraction,
      label: next.status === 'rendering' ? `${label} · ${describeProgress(next)}` : label,
    });
    return;
  }
  if (!wasLive) return;
  if (next.status === 'completed') {
    ui.finishJob(trayId, { status: 'done', message: t('stores.exportQueue.complete', 'Export complete — {path}', { path: next.spec.outPath }) });
    onCompleted?.(next);
  } else if (next.status === 'cancelled') {
    ui.finishJob(trayId, { status: 'cancelled', message: t('stores.exportQueue.cancelled', 'Export cancelled') });
  } else {
    ui.finishJob(trayId, { status: 'failed', message: next.error ?? t('stores.exportQueue.failed', 'Export failed'), ...failureAction(next) });
  }
}

/**
 * The one follow-up a failed export offers, by what failed (electron/exportFailure.ts):
 * the encoder missing → Fix (repair, then the job runs again by itself); a full
 * disk or a file open elsewhere → Retry once that is sorted. A folder that
 * cannot be written needs a new destination, which is a new export: no button.
 */
export function failureAction(job: ExportJobRecord): Pick<JobOutcome, 'action'> {
  switch (job.errorCode) {
    case 'ffmpeg-unavailable':
      return {
        action: {
          label: t('stores.exportQueue.fix', 'Fix'),
          onSelect: () => {
            void ensureFfmpegFor(job.spec.format).then((ready) => {
              if (ready) void useExportQueueStore.getState().retry(job.id);
            });
          },
        },
      };
    case 'disk-full':
    case 'output-busy':
      return { action: { label: t('stores.exportQueue.retry', 'Retry'), onSelect: () => { void useExportQueueStore.getState().retry(job.id); } } };
    default:
      return {};
  }
}

let connecting: Promise<void> | null = null;

export const useExportQueueStore = create<ExportQueueState>((set, get) => ({
  jobs: [],
  connected: false,

  async connect() {
    if (get().connected || !exportSupervisorAvailable()) return;
    if (connecting) return connecting;
    connecting = (async () => {
      const { jobs } = await exportSupervisorClient.subscribe((event) => get().apply(event));
      set({ jobs, connected: true });
    })().catch(() => { connecting = null; });
    return connecting;
  },

  apply(event) {
    if (event.type === 'snapshot') {
      set({ jobs: event.jobs });
      return;
    }
    const prev = get().jobs.find((j) => j.id === event.job.id);
    mirrorToTray(prev, event.job);
    set((s) => ({
      jobs: prev ? s.jobs.map((j) => (j.id === event.job.id ? event.job : j)) : [...s.jobs, event.job],
    }));
  },

  async cancel(id) { await exportSupervisorClient.cancel(id); },
  async retry(id) { await exportSupervisorClient.retry(id); },
  async remove(id) { await exportSupervisorClient.remove(id); },
  async setPriority(id, priority) { await exportSupervisorClient.setPriority(id, priority); },
}));

/** Test seam. */
export function resetExportQueueForTest(): void {
  connecting = null;
  useExportQueueStore.setState({ jobs: [], connected: false });
}
