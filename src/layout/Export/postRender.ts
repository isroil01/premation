/**
 * AE's Post-Render Actions, run when main reports a job finished.
 *
 *   import          — the finished file(s) come into the project;
 *   importReplace   — …and every layer that used the rendered composition now
 *                     uses the first imported file instead (keeping its size,
 *                     keyframes, effects and masks): AE's "Import & Replace
 *                     Usage", the pre-render-a-heavy-precomp workflow.
 *
 * One engine gesture, one undo entry. Only files the editor can open as
 * footage are imported: a zipped image sequence is skipped and said so.
 * Each job's action runs once per window — `exportQueueStore` calls this only
 * on the live → completed transition, never for jobs already done at connect.
 */

import { engine } from '@core/engine/engineInstance';
import { reportEngineError } from '@core/engine/uiEdits';
import type { ExportJobRecord } from '@core/export/exportSupervisorClient';
import { documentMirror } from '@stores/documentMirror';
import { useUIStore } from '@stores/uiStore';
import { t } from '@core/i18n';

const ran = new Set<string>();

/** The files a job delivered, main output first. */
export function deliveredFiles(job: Pick<ExportJobRecord, 'spec'>): string[] {
  return [job.spec.outPath, ...(job.spec.extraOutputs ?? []).map((e) => e.outPath)];
}

/** The layers (in any comp) whose source is the composition `compId`. */
export function layersUsingComp(compId: string): string[] {
  const m = documentMirror();
  return m.layerIds().filter((id) => m.layer(id)?.source === compId);
}

export async function runPostRenderAction(job: ExportJobRecord): Promise<void> {
  const action = job.spec.postRender;
  if (!action || ran.has(job.id)) return;
  ran.add(job.id);
  const ui = useUIStore.getState();
  const files = deliveredFiles(job).filter((f) => !/\.zip$/i.test(f));
  if (files.length === 0) {
    ui.notify({ level: 'info', message: t('export.postRender.nothing', 'Post-render: an image-sequence archive is not imported — unzip it and import the frames.'), durationMs: 6000 });
    return;
  }
  const label = action === 'importReplace' ? 'Import & Replace Usage' : files.length === 1 ? 'Import File' : 'Import Files';
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return;
  }
  let ok = false;
  let replaced = 0;
  const imported = await client.execute({
    type: 'importFiles',
    files: files.map((path) => ({ path, asSequence: false, createComposition: false })),
  });
  if (!imported.ok) {
    reportEngineError(label, imported.error);
  } else {
    ok = true;
    const first = (imported.value as { items?: string[] }).items?.[0];
    if (action === 'importReplace' && first && job.spec.comp) {
      for (const layer of layersUsingComp(job.spec.comp)) {
        const res = await client.execute({ type: 'replaceLayerSource', layer, source: first, keepSize: true });
        if (res.ok) replaced++;
        else reportEngineError(label, res.error);
      }
    }
  }
  const closed = await client.endGesture(opened.value.gesture, ok);
  if (!closed.ok) reportEngineError(label, closed.error);
  if (!ok) return;
  ui.notify({
    level: 'success',
    message: action === 'importReplace'
      ? t('export.postRender.replaced', 'Imported the render and replaced {n} uses of the composition', { n: replaced })
      : t('export.postRender.imported', 'Imported {n} rendered file(s) into the project', { n: files.length }),
    durationMs: 4000,
  });
}
