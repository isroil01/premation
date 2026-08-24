/**
 * Export helper for the AI `export_video` tool and post-generative auto-export.
 *
 * Default path queues a Render Queue job (pauseable, reusable output folder).
 * `immediate` still runs `runExport` for one-shot download/save.
 */

import { getTimelineController } from '@core/timeline/TimelineController';
import { runExport, type ExportOptions } from '@core/export/exportManager';
import type { VideoFormat } from '@core/export/videoSink';
import { useCompositionStore } from '@stores/compositionStore';
import { exportComp } from '@core/export/offlineRenderer';
import {
  outputExtFor,
  useRenderQueueStore,
  type OutputFormat,
} from '@stores/renderQueueStore';
import { useLayoutStore } from '@stores/layoutStore';

export interface AiExportRequest {
  format?: 'mp4' | 'webm' | 'gif';
  quality?: 'high' | 'medium' | 'draft';
  useWorkArea?: boolean;
  /** `queue` (default) adds a Render Queue job; `immediate` encodes now. */
  mode?: 'queue' | 'immediate';
  /** When queueing, start the queue if an output folder is already chosen. */
  start?: boolean;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export type AiExportResult =
  | { ok: true; mode: 'immediate'; videoCodec?: string }
  | { ok: true; mode: 'queue'; jobId: string; started: boolean }
  | { ok: false; message: string };

function fileStem(name: string): string {
  return name.replace(/[^\w-]+/g, '_').replace(/^_|_$/g, '') || 'output';
}

/** Queue the active composition for export (does not encode yet). */
export function queueCompositionVideo(req: AiExportRequest = {}): AiExportResult {
  const comp = useCompositionStore.getState().comp();
  const format = (req.format ?? 'mp4') as OutputFormat;
  if (format !== 'mp4' && format !== 'webm' && format !== 'gif') {
    return { ok: false, message: `Format '${String(format)}' cannot be queued from the assistant.` };
  }
  const ext = outputExtFor(format);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const store = useRenderQueueStore.getState();
  const jobId = store.addJob({
    compositionName: comp.name ?? 'Composition',
    compositionId: comp.id,
    background: comp.background,
    outputPath: `${fileStem(comp.name ?? 'output')}_${ts}.${ext}`,
    format,
    width: comp.width,
    height: comp.height,
    compWidth: comp.width,
    compHeight: comp.height,
    fps: comp.fps,
    durationSec: comp.durationSeconds,
    transparent: !!comp.transparent,
    quality: req.quality ?? 'high',
  });

  useLayoutStore.getState().openPanel('renderQueue');

  let started = false;
  if (req.start !== false && useRenderQueueStore.getState().outputDir) {
    useRenderQueueStore.getState().startAll();
    started = true;
  }

  return { ok: true, mode: 'queue', jobId, started };
}

export async function exportCompositionVideo(req: AiExportRequest = {}): Promise<AiExportResult> {
  const mode = req.mode ?? 'queue';
  if (mode === 'queue') return queueCompositionVideo(req);

  const tl = getTimelineController();
  const time = tl.currentSeconds;
  const compSettings = useCompositionStore.getState().comp();
  const format = (req.format ?? 'mp4') as VideoFormat;
  const opts: ExportOptions = {
    format,
    width: compSettings.width,
    height: compSettings.height,
    fps: compSettings.fps,
    duration: compSettings.durationSeconds,
    time,
    comp: exportComp({
      width: compSettings.width,
      height: compSettings.height,
      background: compSettings.background,
      transparent: compSettings.transparent,
    }),
    quality: req.quality ?? 'high',
    useWorkArea: req.useWorkArea ?? true,
    signal: req.signal,
    onProgress: req.onProgress,
  };

  try {
    const result = await runExport(opts);
    return { ok: true, mode: 'immediate', videoCodec: result.videoCodec };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}
