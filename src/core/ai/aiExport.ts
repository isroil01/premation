/**
 * Export helper for the AI `export_video` tool and post-generative auto-export.
 *
 * Both modes put a Render Queue job on the list (reusable output folder); the
 * ENGINE renders it (main's export supervisor). `immediate` also hands it to
 * main's queue at once — there is no in-page render any more
 * (docs/TS_ENGINE_REMOVAL.md phase 4).
 */

import { useCompositionStore } from '@stores/compositionStore';
import {
  outputExtFor,
  useRenderQueueStore,
  type OutputFormat,
} from '@stores/renderQueueStore';
import { showRenderQueue } from '@stores/timelinePanelStore';

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

  showRenderQueue();

  let started = false;
  if (req.mode === 'immediate' || (req.start !== false && useRenderQueueStore.getState().outputDir)) {
    useRenderQueueStore.getState().startAll();
    started = true;
  }

  return { ok: true, mode: 'queue', jobId, started };
}

export async function exportCompositionVideo(req: AiExportRequest = {}): Promise<AiExportResult> {
  return Promise.resolve(queueCompositionVideo(req));
}
