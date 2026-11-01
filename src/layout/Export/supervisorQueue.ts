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
import { extraOutputPaths, type ExtraOutput } from '@core/export/renderSpec';
import {
  buildSupervisorSpec,
  exportSupervisorAvailable,
  exportSupervisorClient,
  isFinishedStatus,
  type ExportJobRecord,
  type SupervisorSpecInput,
} from '@core/export/exportSupervisorClient';
import { uncarriableMedia } from '@core/export/snapshotPortability';
import { engine } from '@core/engine/engineInstance';
import { engineCanReadFootage, materializeUnreadableFootage } from '@core/engine/sessionFootage';
import { getProjectManager } from '@core/services/coreServices';
import { currentProjectKey } from '@core/export/renderProject';
import { documentMirror } from '@stores/documentMirror';
import { setExportCompletedHandler, useExportQueueStore } from '@stores/exportQueueStore';
import { runPostRenderAction } from './postRender';
import { canChooseOutputDir, setRenderQueueSubmitter, useRenderQueueStore, type RenderJob } from '@stores/renderQueueStore';
import { useUIStore } from '@stores/uiStore';
import { ensureFfmpegFor, useFfmpegStore } from '@stores/ffmpegStore';
import { isPluginFormat } from '@core/nativePlugins/pluginContrib';
import { t } from '@core/i18n';

/** The formats the engine export writes. The document exports (Lottie, JSON, the cut lists) are `runDataExport`'s. */
const ENGINE_FORMATS: ReadonlySet<string> = new Set<ExportFormat>([
  'mp4', 'hdr10', 'hlg', 'webm', 'mov', 'gif', 'png-sequence', 'jpg-sequence', 'exr-sequence', 'tiff-sequence', 'dpx-sequence', 'png', 'wav',
]);

/** Whether the engine export writes `format`. */
export function isEngineFormat(format: ExportFormat | string): boolean {
  // P7c: a native plugin's output module (`plugin:<id>/<module>`) writes through the engine too.
  return ENGINE_FORMATS.has(format) || isPluginFormat(format);
}

/**
 * Why nothing can be rendered right now, or null: only the desktop app has
 * the engine. Footage is not a refusal any more — see `stageWindowOnlyFootage`.
 */
export function engineExportRefusal(): string | null {
  if (!exportSupervisorAvailable()) return t('export.supervisor.needsDesktop', 'Rendering needs the desktop app: files are rendered by the engine.');
  return null;
}

/**
 * Footage only this window can read — a `blob:` object URL: an import into an
 * unsaved project, an AI-generated clip — used to REFUSE the export ("lives
 * only in this window… re-import it"), which is the user's problem turned into
 * a chore (owner 2026-10-18). The engine process cannot fetch a blob:, but the
 * page can: each such item's bytes go to the session-footage cache and the
 * item is relinked to that file (core/engine/sessionFootage — what engine
 * jobs already do), one undoable entry, so the export, the viewport and every
 * later job read it like any other file. Resolves what is still unreadable
 * after that (null = nothing): a message for the user.
 */
export async function stageWindowOnlyFootage(): Promise<string | null> {
  const stuck = uncarriableMedia(mirrorFootageMedia());
  if (stuck.length === 0) return null;
  const ids = stuck.map((a) => a.id);
  const client = engine();
  try {
    await materializeUnreadableFootage(client, ids);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return t('export.supervisor.footageWriteFailed', 'Some footage in this project lives only in this window and could not be written to disk ({why}). Save the project or re-import the file, then export again.', { why });
  }
  // The engine's own view of each item, not the mirror's (which follows a beat later).
  const res = await client.query({ type: 'getItems', items: ids });
  const left = res.ok ? res.value.items.filter((i) => !engineCanReadFootage(i.path)) : null;
  if (left !== null && left.length === 0) return null;
  const names = (left ?? []).map((i) => i.name).filter(Boolean).slice(0, 3).join(', ');
  return names
    ? t('export.supervisor.footageWindowOnlyNamed', 'Some footage in this project lives only in this window (it was never saved to disk): {names}. Re-import it from a file and export again.', { names })
    : t('export.supervisor.footageWindowOnly', 'Some footage in this project lives only in this window (it was never saved to disk). Re-import it from a file and export again.');
}

/** Video export is not set up on this machine and the person closed the repair dialog. */
export class FfmpegNotReadyError extends Error {
  constructor() {
    super(t('export.supervisor.ffmpegNotReady', "Video export isn't set up on this computer yet. Press Fix to repair it."));
    this.name = 'FfmpegNotReadyError';
  }
}

/**
 * Say why a render could not be queued. The ffmpeg case gets its Fix button
 * (the dialog was just closed — the way back must be one click, not a hunt).
 */
export function reportQueueFailure(err: unknown, fallback = t('export.supervisor.queueFailed', 'The render could not be queued')): void {
  const ui = useUIStore.getState();
  if (err instanceof FfmpegNotReadyError) {
    ui.notify({
      level: 'warning',
      message: err.message,
      durationMs: 0,
      group: 'ffmpeg-health',
      action: { label: t('export.ffmpegHealth.fix', 'Fix'), onSelect: () => useFfmpegStore.getState().openDialog() },
    });
    return;
  }
  ui.notify({ level: 'error', message: err instanceof Error ? err.message : fallback, durationMs: 8000 });
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
    ...(job.pluginOptions !== undefined ? { pluginOptions: job.pluginOptions } : {}),
    ...(job.postRender ? { postRender: job.postRender } : {}),
  };
}

/** The job's extra output modules, placed beside `outPath` (renderSpec `extraOutputPaths`). */
export function placeExtraOutputs(extras: ReadonlyArray<ExtraOutput> | undefined, outPath: string): Array<ExtraOutput & { outPath: string }> {
  if (!extras || extras.length === 0) return [];
  const paths = extraOutputPaths(outPath, extras.map((e) => e.format));
  return extras.map((e, i) => ({ ...e, outPath: paths[i]! }));
}

/**
 * Snapshot the project and put one job on main's queue. Throws on a refusal or
 * a failure before the job exists; everything after is the job's own record.
 */
export async function queueEngineRender(
  input: Omit<SupervisorSpecInput, 'projectPath'>,
  priority = 0,
): Promise<string> {
  const refusal = engineExportRefusal() ?? (await stageWindowOnlyFootage());
  if (refusal) throw new Error(refusal);
  // Can this machine write the format at all? If not, the repair dialog opens
  // and the export waits for it — rather than rendering everything first and
  // failing at the encode (src/stores/ffmpegStore.ts).
  if (!(await ensureFfmpegFor(input.format))) throw new FfmpegNotReadyError();
  const { id, projectPath } = await exportSupervisorClient.reserve();
  await getProjectManager().snapshotTo(projectPath);
  const projectKey = currentProjectKey();
  const spec = buildSupervisorSpec({ ...input, projectPath, ...(projectKey ? { projectKey } : {}) });
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
    const extraOutputs = placeExtraOutputs(job.extraOutputs, outPath);
    return await queueEngineRender({ ...specInput(job), outPath, ...(extraOutputs.length ? { extraOutputs } : {}) }, priority);
  } catch (err) {
    reportQueueFailure(err);
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
      else reject(new Error(job.error ?? t('export.supervisor.renderFailed', 'The render failed.')));
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
// Post-render actions (Import / Import & Replace Usage) when a job finishes.
setExportCompletedHandler((job) => { void runPostRenderAction(job); });
