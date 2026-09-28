/**
 * Every rendered file goes through main's export supervisor — the ENGINE
 * export (`premation-engine --export`, electron/engineExport.ts). There is no
 * in-window render any more (docs/TS_ENGINE_REMOVAL.md phase 4): the Export
 * dialog/panel, Add to Queue, the Render Queue panel's Render All, the data
 * batch and the assistant's export all end here.
 *
 * The editor's part: an output path, a snapshot of the project where main
 * said to write it, and a job on main's queue. `renderAndWait` additionally
 * follows the job to its end, for the callers that go row by row.
 */

import type { ExportFormat } from '@core/export/exportManager';
import {
  buildSupervisorSpec,
  exportSupervisorAvailable,
  exportSupervisorClient,
  isFinishedStatus,
  type ExportJobRecord,
  type SupervisorSpecInput,
} from '@core/export/exportSupervisorClient';
import { currentProjectSnapshotIsPortable } from '@core/export/snapshotPortability';
import { getProjectManager } from '@core/services/coreServices';
import { documentMirror } from '@stores/documentMirror';
import { useExportQueueStore } from '@stores/exportQueueStore';
import { canChooseOutputDir, setRenderQueueSubmitter, useRenderQueueStore, type RenderJob } from '@stores/renderQueueStore';
import { useUIStore } from '@stores/uiStore';

/** The formats the engine export writes. The document exports (Lottie, JSON, the cut lists) are `runDataExport`'s. */
const ENGINE_FORMATS: ReadonlySet<string> = new Set<ExportFormat>([
  'mp4', 'hdr10', 'hlg', 'webm', 'mov', 'gif', 'png-sequence', 'jpg-sequence', 'exr-sequence', 'png', 'wav',
]);

/** Whether the engine export writes `format`. */
export function isEngineFormat(format: ExportFormat | string): boolean {
  return ENGINE_FORMATS.has(format);
}

/**
 * Why nothing can be rendered right now, or null. Only the desktop app has the
 * engine; and the snapshot must carry the footage — a `blob:` URL only this
 * window can read would render as a black layer.
 */
export function engineExportRefusal(): string | null {
  if (!exportSupervisorAvailable()) return 'Rendering needs the desktop app: files are rendered by the engine.';
  // B4: portability is a test on each footage item's media (`ItemInfo.mediaUrl`).
  if (!currentProjectSnapshotIsPortable(mirrorFootageMedia())) {
    return 'Some footage in this project lives only in this window (it was never saved to disk), so the engine cannot read it. Re-import it from a file and export again.';
  }
  return null;
}

/** Whether an export of `format` can be queued on the engine now. */
export function shouldUseSupervisor(format: ExportFormat | string): boolean {
  return isEngineFormat(format) && engineExportRefusal() === null;
}

/** Every footage item's id and media URL ('' when it has none), project order. */
function mirrorFootageMedia(): Array<{ id: string; src: string }> {
  const out: Array<{ id: string; src: string }> = [];
  for (const i of documentMirror().items.values()) if (i.kind === 'footage') out.push({ id: i.id, src: i.mediaUrl ?? '' });
  return out;
}

/** `dir` + `name` with the directory's own separator. */
export function joinOutputPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`;
}

/** What a queued render needs — the Render Queue's spec, minus its runtime fields. */
export type QueueJobInput = Omit<RenderJob, 'id' | 'status' | 'progress'>;

function specInput(job: QueueJobInput): Omit<SupervisorSpecInput, 'projectPath' | 'outPath'> {
  return {
    compositionId: job.compositionId ?? '',
    compositionName: job.compositionName,
    format: job.format,
    width: job.width,
    height: job.height,
    fps: job.fps,
    range: { startSec: job.rangeStartSec ?? 0, endSec: job.rangeEndSec ?? job.durationSec },
    quality: job.quality ?? 'high',
    ...(job.proresProfile ? { proresProfile: job.proresProfile } : {}),
    ...(job.bitDepth === 16 ? { bitDepth: 16 as const } : {}),
    ...(job.videoEncoder ? { videoEncoder: job.videoEncoder } : {}),
    transparent: job.transparent,
    ...(job.chapters && job.chapters.length > 0 ? { chapters: job.chapters } : {}),
  };
}

/**
 * Snapshot the project and put one job on main's queue. Throws on a refusal or
 * a failure before the job exists; everything after is the job's own record.
 */
export async function queueEngineRender(
  input: Omit<SupervisorSpecInput, 'projectPath'>,
  priority = 0,
): Promise<string> {
  const refusal = engineExportRefusal();
  if (refusal) throw new Error(refusal);
  const { id, projectPath } = await exportSupervisorClient.reserve();
  await getProjectManager().snapshotTo(projectPath);
  const spec = buildSupervisorSpec({ ...input, projectPath });
  await useExportQueueStore.getState().connect();
  await exportSupervisorClient.enqueue(id, spec, priority);
  return id;
}

/**
 * Put a job on main's queue from a Render Queue spec: output folder (chosen once
 * and remembered — see `renderQueueStore.outputDir`), reserve, snapshot,
 * enqueue. Resolves the job id, or null when nothing was queued (folder dialog
 * cancelled, or a failure already reported as a toast). Main's queue runs what
 * it holds, one at a time, in priority order.
 */
export async function enqueueSupervisorJob(job: QueueJobInput, priority = 0): Promise<string | null> {
  const ui = useUIStore.getState();
  const rq = useRenderQueueStore.getState();
  const fileName = job.outputPath.replace(/^.*[\\/]/, '');
  let dir = rq.outputDir;
  if (!dir && canChooseOutputDir()) {
    dir = await rq.chooseOutputDir();
    // Cancelling the folder picker is cancelling the add — not a cue to ask
    // a second question with a different dialog.
    if (!dir) return null;
  }
  try {
    const outPath = dir ? joinOutputPath(dir, fileName) : await exportSupervisorClient.chooseOutputPath(fileName);
    if (!outPath) return null;
    return await queueEngineRender({ ...specInput(job), outPath }, priority);
  } catch (err) {
    ui.notify({ level: 'error', message: err instanceof Error ? err.message : 'The render could not be queued', durationMs: 8000 });
    return null;
  }
}

/**
 * Add a render to the queue — main's, always. The single entry point for Add
 * to Queue (Export dialog/panel) and Add Comp (Render Queue panel).
 *
 * Synchronous on purpose: callers close their dialog on the answer. The rest
 * continues in the background (a folder dialog may still open, and failures
 * arrive as toasts).
 */
export function addToRenderQueue(job: QueueJobInput): { where: 'supervisor'; done: Promise<string | null> } {
  return { where: 'supervisor', done: enqueueSupervisorJob(job) };
}

/**
 * Render one file on the engine and resolve when the job ends: `completed`
 * resolves, `failed` rejects with the job's error, `cancelled` (including an
 * abort of `signal`, which cancels the job) rejects with an AbortError.
 */
export async function renderAndWait(
  input: Omit<SupervisorSpecInput, 'projectPath'>,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<ExportJobRecord> {
  if (opts.signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
  await useExportQueueStore.getState().connect();
  const id = await queueEngineRender(input);
  return new Promise<ExportJobRecord>((resolve, reject) => {
    const onAbort = (): void => { void exportSupervisorClient.cancel(id); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const check = (jobs: ReadonlyArray<ExportJobRecord>): boolean => {
      const job = jobs.find((j) => j.id === id);
      if (!job) return false;
      opts.onProgress?.(job.progress.fraction);
      if (!isFinishedStatus(job.status)) return false;
      opts.signal?.removeEventListener('abort', onAbort);
      if (job.status === 'completed') resolve(job);
      else if (job.status === 'cancelled') reject(new DOMException('Render cancelled', 'AbortError'));
      else reject(new Error(job.error ?? 'The render failed.'));
      return true;
    };
    if (check(useExportQueueStore.getState().jobs)) return;
    const unsubscribe = useExportQueueStore.subscribe((s) => {
      if (check(s.jobs)) unsubscribe();
    });
  });
}

// Render All in the Render Queue panel hands its pending jobs over through this.
setRenderQueueSubmitter((job) => enqueueSupervisorJob(job));
