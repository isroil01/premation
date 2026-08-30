/**
 * "Render every row" from inside the editor.
 *
 * The loop itself is `renderDataRows` — shared, unchanged, and identical to the
 * one the headless CLI drives. What differs, and all this module supplies, is
 * where a render comes FROM and where a file GOES: the active composition's own
 * settings, and the folder the desktop shell already asks the Render Queue for.
 *
 * Deliberately not part of the Render Queue. A queued job carries settings and
 * renders the LIVE scene graph when it runs, so N queued rows would all render
 * the last row's document — see `batchRender.ts` for the full argument. This
 * runs the rows itself, in order, awaiting each.
 */

import { renderJobOutput, outputExtFor, type OutputFormat, type RenderJobSpec } from '@core/export/renderJob';
import { downloadBlob } from '@core/export/exportManager';
import { useCompositionStore } from '@stores/compositionStore';
import { renderDataRows, resolveOutputName, type BatchRenderSummary } from './batchRender';
import type { DataTable } from './dataTable';
import type { TemplateField } from './templateTypes';

/** Formats offered for a batch. A short list on purpose — see below. */
export const BATCH_FORMATS: ReadonlyArray<{ format: OutputFormat; label: string }> = [
  { format: 'mp4', label: 'MP4 · H.264' },
  { format: 'webm', label: 'WebM · VP9' },
  { format: 'gif', label: 'Animated GIF' },
  { format: 'png-sequence', label: 'PNG sequence' },
];

export interface EditorBatchOptions {
  table: DataTable;
  fields: ReadonlyArray<TemplateField>;
  /** File-name pattern with `{token}`s — see `resolveOutputName`. */
  pattern: string;
  format: OutputFormat;
  /**
   * Folder every row lands in. Null in a browser build, where each row is
   * handed to the browser's download machinery instead.
   */
  outputDir: string | null;
  onRow?: (outcome: { index: number; outputPath: string; error?: string }, total: number) => void;
  onProgress?: (fraction: number) => void;
  /** Skip rows before this one — resuming a batch that was stopped. */
  startRow?: number;
  signal?: AbortSignal;
}

/**
 * The extension a batch writes, appended to the pattern rather than typed by
 * the user. A pattern is a NAME; making people also remember to type `.mp4`
 * after choosing MP4 is a way to produce forty files no player will open.
 */
export function batchFileName(pattern: string, format: OutputFormat): string {
  const ext = outputExtFor(format);
  return pattern.toLowerCase().endsWith(`.${ext}`) ? pattern : `${pattern}.${ext}`;
}

/** Render one file per row of `table` into `outputDir`. */
export async function runEditorBatchRender(opts: EditorBatchOptions): Promise<BatchRenderSummary> {
  const { table, fields, pattern, format, outputDir, onRow, onProgress, startRow, signal } = opts;
  const comp = useCompositionStore.getState().comp();

  const spec = (outputPath: string): RenderJobSpec => ({
    compositionName: comp.name,
    compositionId: comp.id,
    outputPath,
    format,
    width: comp.width,
    height: comp.height,
    compWidth: comp.width,
    compHeight: comp.height,
    fps: comp.fps,
    durationSec: comp.durationSeconds,
    transparent: comp.transparent,
    background: comp.background,
    quality: 'high',
  });

  return renderDataRows({
    table,
    fields,
    namer: (row, index) =>
      batchFileName(resolveOutputName(pattern, row, index, table.rows.length), format),
    renderRow: async (outputPath, rowProgress, rowSignal) => {
      const output = await renderJobOutput(spec(outputPath), rowProgress, rowSignal);
      if (output.kind === 'paused') {
        // Only reachable if the signal fires mid-row, and the loop stops on the
        // same signal — so treat it as the cancellation it is rather than
        // reporting a file that was never written.
        throw new Error('Cancelled');
      }
      if (output.kind === 'blob') {
        downloadBlob(output.blob, outputPath);
        return;
      }
      if (!outputDir) {
        // No folder to write into (a browser build): hand it over the same way
        // a blob result goes, rather than silently discarding a finished render.
        await output.save(outputPath);
        return;
      }
      // NOT overwriting, unlike the CLI. A person watching a panel has a folder
      // that may already hold last week's batch, and " (2)" is recoverable
      // where a replaced file is not. The CLI's opposite choice is about a
      // pipeline needing a knowable artifact path.
      await output.saveTo(outputDir, outputPath);
    },
    ...(onRow
      ? { onRow: (outcome, total) => onRow({ index: outcome.index, outputPath: outcome.outputPath, ...(outcome.error ? { error: outcome.error } : {}) }, total) }
      : {}),
    ...(onProgress ? { onProgress } : {}),
    ...(startRow !== undefined ? { startRow } : {}),
    ...(signal ? { signal } : {}),
  });
}
