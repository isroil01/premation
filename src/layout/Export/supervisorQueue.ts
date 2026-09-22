/**
 * Where a queued or exported render runs: main's supervisor, or this window.
 *
 * One decision shared by the Export dialog/panel (Export and Add to Queue) and
 * the Render Queue panel's own Add Comp, so the three cannot disagree about
 * which builds render out of process.
 *
 * The in-window queue (`renderQueueStore`) is NOT retired by this. It is still
 * the whole queue on the web/hosted edition, with `exportInProcess` on, for
 * formats the headless render cannot write (HDR), for projects whose snapshot
 * could not carry their footage — and for every job an older version persisted
 * (`renderQueuePersist`), which reloads and resumes in-window exactly as before.
 */

import type { ExportFormat } from '@core/export/exportManager';
import { buildSupervisorSpec, exportSupervisorAvailable, exportSupervisorClient } from '@core/export/exportSupervisorClient';
import { currentProjectSnapshotIsPortable } from '@core/export/snapshotPortability';
import { getProjectManager } from '@core/services/coreServices';
import { useAssetStore } from '@stores/assetStore';
import { useExportQueueStore } from '@stores/exportQueueStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { canChooseOutputDir, useRenderQueueStore, type RenderJob } from '@stores/renderQueueStore';
import { useUIStore } from '@stores/uiStore';

/**
 * Formats the out-of-process path can take: everything the headless CLI can
 * render to a file. The rest (Lottie, WAV, the editorial formats, a single
 * PNG, the HDR presets) stay in-window.
 */
const SUPERVISED: ReadonlySet<string> = new Set<ExportFormat>(['mp4', 'webm', 'mov', 'gif', 'png-sequence', 'jpg-sequence', 'exr-sequence']);

/**
 * Whether an export of `format` should go to the main-owned queue.
 *
 * Desktop with the bridge and the preference at its default (off = out of
 * process). The web edition has no supervisor and takes the in-window path;
 * so does anyone who turned `exportInProcess` on.
 *
 * And only when the snapshot can carry the project to another window
 * (`currentProjectSnapshotIsPortable`): a non-local-first build writes a single
 * JSON whose footage is still `blob:` URLs only THIS window can read, and even a
 * local-first bundle cannot collect a layer's `blob:` with no library entry
 * behind it. Rendering those in the hidden window would deliver black layers
 * with a "completed" status, so they render in-window, as they always did.
 * Checked last — the scene walk is the only non-trivial cost here and every
 * other condition is a lookup.
 */
export function shouldUseSupervisor(format: ExportFormat | string, exportInProcess: boolean): boolean {
  return (
    !exportInProcess
    && SUPERVISED.has(format)
    && exportSupervisorAvailable()
    && currentProjectSnapshotIsPortable(useAssetStore.getState().assets)
  );
}

/** `dir` + `name` with the directory's own separator. */
export function joinOutputPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`;
}

/** What a queued render needs — the in-window queue's spec, minus its runtime fields. */
export type QueueJobInput = Omit<RenderJob, 'id' | 'status' | 'progress'>;

/**
 * Put a job on main's queue from a Render Queue spec: output folder (chosen once
 * and remembered, the queue's contract — see `renderQueueStore.outputDir`),
 * reserve, snapshot, enqueue. Resolves the job id, or null when nothing was
 * queued (folder dialog cancelled, or a failure already reported as a toast).
 *
 * Unlike the in-window queue this STARTS the render — main's queue runs what
 * it holds, one at a time, in priority order. That is the queue.
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
  const outPath = dir ? joinOutputPath(dir, fileName) : await exportSupervisorClient.chooseOutputPath(fileName);
  if (!outPath) return null;
  try {
    const { id, projectPath } = await exportSupervisorClient.reserve();
    await getProjectManager().snapshotTo(projectPath);
    const spec = buildSupervisorSpec({
      compositionId: job.compositionId ?? '',
      compositionName: job.compositionName,
      format: job.format,
      width: job.width,
      height: job.height,
      fps: job.fps,
      range: { startSec: job.rangeStartSec ?? 0, endSec: job.rangeEndSec ?? job.durationSec },
      quality: job.quality ?? 'high',
      ...(job.proresProfile ? { proresProfile: job.proresProfile } : {}),
      ...(job.videoEncoder ? { videoEncoder: job.videoEncoder } : {}),
      transparent: job.transparent,
      ...(job.chapters && job.chapters.length > 0 ? { chapters: job.chapters } : {}),
      projectPath,
      outPath,
    });
    await useExportQueueStore.getState().connect();
    await exportSupervisorClient.enqueue(id, spec, priority);
    return id;
  } catch (err) {
    ui.notify({ level: 'error', message: err instanceof Error ? err.message : 'The render could not be queued', durationMs: 8000 });
    return null;
  }
}

/**
 * Add a render to "the queue" — main's when this build and project can use it,
 * the in-window one otherwise. The single entry point for Add to Queue (Export
 * dialog/panel) and Add Comp (Render Queue panel).
 *
 * Synchronous on purpose: callers close their dialog on the answer. The
 * supervisor half continues in the background (a folder dialog may still
 * open, and failures arrive as toasts).
 */
export function addToRenderQueue(job: QueueJobInput): { where: 'supervisor' | 'window'; done: Promise<string | null> } {
  const { exportInProcess } = usePreferenceStore.getState();
  if (shouldUseSupervisor(job.format, exportInProcess)) {
    return { where: 'supervisor', done: enqueueSupervisorJob(job) };
  }
  const id = useRenderQueueStore.getState().addJob(job);
  return { where: 'window', done: Promise.resolve(id) };
}
