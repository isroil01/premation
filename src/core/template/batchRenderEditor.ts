/**
 * "Render every row" from inside the editor.
 *
 * The loop itself is `renderDataRows` — fill a row, render it, next row, put
 * the template back. What this module supplies is the file naming and the
 * format list; the render of one row is injected (`renderFile`): the Data
 * panel hands each row to the ENGINE export (supervisorQueue.renderAndWait —
 * snapshot the filled document, queue it, wait for the file), so a row's file
 * is written by the same renderer as every other export.
 *
 * Deliberately not the Render Queue: a queued job renders the document as it
 * is when it RUNS, so N queued rows would all render the last row. This runs
 * the rows itself, in order, awaiting each.
 */

import { outputExtFor, type OutputFormat } from '@core/export/renderSpec';
import { renderDataRows, resolveOutputName, type BatchRenderSummary } from './batchRender';
import type { DataTable } from './dataTable';
import type { TemplateField } from './templateTypes';

/** Formats offered for a batch. A short list on purpose. */
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
  /** Render the current (filled) document to the file named `fileName`. Rejects on failure. */
  renderFile: (fileName: string, onProgress: (fraction: number) => void, signal: AbortSignal) => Promise<void>;
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

/** Render one file per row of `table`. */
export async function runEditorBatchRender(opts: EditorBatchOptions): Promise<BatchRenderSummary> {
  const { table, fields, pattern, format, renderFile, onRow, onProgress, startRow, signal } = opts;
  return renderDataRows({
    table,
    fields,
    namer: (row, index) =>
      batchFileName(resolveOutputName(pattern, row, index, table.rows.length), format),
    renderRow: (outputPath, rowProgress, rowSignal) => renderFile(outputPath, rowProgress, rowSignal),
    ...(onRow
      ? { onRow: (outcome, total) => onRow({ index: outcome.index, outputPath: outcome.outputPath, ...(outcome.error ? { error: outcome.error } : {}) }, total) }
      : {}),
    ...(onProgress ? { onProgress } : {}),
    ...(startRow !== undefined ? { startRow } : {}),
    ...(signal ? { signal } : {}),
  });
}
