/**
 * One render per data row — the loop `docs/TEMPLATE_DATA_BINDING_SCOPE.md` left
 * open, built the way that document recommended.
 *
 * ── Why this is a sequential driver and not N queued jobs ──────────────
 * The obvious implementation — apply row *i*, `addJob(...)`, repeat — produces
 * silently wrong files. A queued job carries SETTINGS, not a document: the
 * render reads the live scene graph when it runs, so forty jobs queued against
 * forty rows all render whatever the scene looks like at the end, which is the
 * last row. Forty identical files, each correctly named after a different row,
 * and nothing errors. That is the same class of defect the queue already fixed
 * once when `RenderJob` grew a `compositionId`; that fix made a job name its
 * composition, it did not make a job capture the composition's STATE.
 *
 * So the loop is strictly sequential: apply the row, await the whole render,
 * then apply the next. It never touches `addJob`, and it cannot interleave with
 * user-queued renders — which is the honest trade, and is why the alternative
 * (a captured document per job) is written down as the larger, more general fix
 * rather than pretended away here.
 *
 * ── The template is put back ───────────────────────────────────────────
 * Filling rows MUTATES the open document. A batch that ended with row 40's
 * copy left on the layers would quietly replace the user's authored text with
 * a stranger's name, and they would find out at the next save. Every field's
 * value is read before the loop and written back after it, as one undo entry.
 *
 * Pure name resolution lives here too (`resolveOutputName`), because "forty
 * files with the same name" is the failure this feature is most likely to have
 * and it is decidable without rendering anything.
 */

import { applyDataRow } from './dataFill';
import { readTemplateFieldValue, writeTemplateField } from './templateFields';
import { runAnimEdit } from '@core/animation/animationCommands';
import type { DataRow, DataTable } from './dataTable';
import type { TemplateField } from './templateTypes';
import type { FillResult } from './dataFill';

/**
 * Characters no mainstream filesystem accepts in a name, plus control codes.
 *
 * Spaces and hyphens are deliberately NOT here: "Ada Lovelace.mp4" is a good
 * filename, and it is the one the person who wrote the spreadsheet expects to
 * find on disk.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Longest a single substituted value may be, so a paragraph cell cannot
 *  produce a path the OS refuses (Windows caps a component at 255). */
const MAX_TOKEN_LENGTH = 80;

/**
 * Make one substituted value safe to put in a filename.
 *
 * Deliberately lossy and deliberately quiet: the point is that "Lovelace, Ada"
 * and "Q3 / Q4 results" both become usable names. A row whose every field
 * sanitises to nothing falls back to its index at the call site, so a batch can
 * never write two files to one path because two cells were both punctuation.
 */
export function sanitizeNameToken(value: string): string {
  return value
    .replace(UNSAFE_FILENAME, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A trailing dot or space is legal to create on Windows and impossible to
    // open afterwards, which is a worse outcome than a slightly shorter name.
    .replace(/[. ]+$/, '')
    .slice(0, MAX_TOKEN_LENGTH)
    .trim();
}

/** Tokens every table gets, whatever its columns are called. */
const INDEX_TOKENS = new Set(['index', 'row']);

export class OutputPatternError extends Error {}

/**
 * Fill `{token}` placeholders in an output path from one row.
 *
 * `{index}` (and its alias `{row}`) is the 1-based row number, zero-padded to
 * the width of the table so a shell sorts the results in table order — 40 rows
 * give `01`…`40`, not `1`, `10`, `11`, `2`. Anything else names a column.
 *
 * Throws for an unknown token rather than substituting nothing. Silently
 * dropping it would give every row the same filename, and with an overwriting
 * CLI that is a batch that renders forty times and leaves one file.
 */
export function resolveOutputName(
  pattern: string,
  row: DataRow,
  index: number,
  total: number,
): string {
  const width = Math.max(1, String(Math.max(1, total)).length);
  return pattern.replace(/\{([^{}]*)\}/g, (_match, rawToken: string) => {
    const token = rawToken.trim();
    if (INDEX_TOKENS.has(token.toLowerCase())) {
      return String(index + 1).padStart(width, '0');
    }
    const cell = row[token];
    if (cell === undefined) {
      throw new OutputPatternError(
        `"{${token}}" is not a column in this table. Available: ${Object.keys(row).join(', ')}`
        + ' (plus {index}).',
      );
    }
    // An empty or punctuation-only cell would collapse the name; the row number
    // keeps every output distinct, which matters more than the name being pretty.
    return sanitizeNameToken(cell) || String(index + 1).padStart(width, '0');
  });
}

/** True when a pattern varies per row — the check that stops a 40-into-1 batch. */
export function patternVariesPerRow(pattern: string): boolean {
  return /\{[^{}]*\}/.test(pattern);
}

export interface BatchRowOutcome {
  /** 0-based row index. */
  index: number;
  /** Where this row's file went, or was going to. */
  outputPath: string;
  /** Which fields the row actually wrote. */
  fill: FillResult;
  /** Present when the row failed; the batch continues past it. */
  error?: string;
}

export interface BatchRenderSummary {
  rows: BatchRowOutcome[];
  rendered: number;
  failed: number;
  /**
   * The row a resume should start at, or null when the pass reached the end.
   *
   * A forty-row batch is exactly the length at which someone needs the machine
   * back, and re-rendering the thirty rows that already finished is the reason
   * they would not stop it. Absent this, "Stop" meant "throw away the work" —
   * and the files were on disk, so the loss was not even visible.
   */
  nextRow: number | null;
}

export interface BatchRenderOptions {
  table: DataTable;
  fields: ReadonlyArray<TemplateField>;
  /** Output path (or name) for each row — usually `resolveOutputName`. */
  namer: (row: DataRow, index: number) => string;
  /**
   * Render the document AS IT IS NOW to `outputPath`.
   *
   * Injected rather than built in, because delivery is the one part that
   * genuinely differs: the CLI writes an absolute path it was given, and the
   * panel writes into the folder the render queue already asked the user for.
   * The loop, the fill and the restore are the same either way.
   */
  renderRow: (
    outputPath: string,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Called as each row settles, for progress UI and logs. */
  onRow?: (outcome: BatchRowOutcome, total: number) => void;
  /** Per-row progress, already scaled across the whole batch (0–1). */
  onProgress?: (fraction: number) => void;
  /**
   * Skip every row before this one (0-based) — a resume.
   *
   * Rows, not files: the driver cannot know whether a given row's output
   * already exists, because delivery is the caller's. What it can do is start
   * where the last pass stopped, which is what `nextRow` reports.
   */
  startRow?: number;
  signal?: AbortSignal;
}

/** Snapshot the fields' current values so the batch can put them back. */
function captureFieldValues(
  fields: ReadonlyArray<TemplateField>,
): Array<{ field: TemplateField; value: string | number }> {
  const out: Array<{ field: TemplateField; value: string | number }> = [];
  for (const field of fields) {
    const value = readTemplateFieldValue(field);
    // Only values a write can restore. A field whose target has gone missing
    // reads undefined, and writing `undefined` back would be worse than
    // leaving whatever the last row put there.
    if (typeof value === 'string' || typeof value === 'number') out.push({ field, value });
  }
  return out;
}

/** Put the template back the way the user left it, as one undo entry. */
function restoreFieldValues(saved: ReturnType<typeof captureFieldValues>): void {
  if (saved.length === 0) return;
  runAnimEdit('Restore template after batch', () => {
    for (const { field, value } of saved) writeTemplateField(field, value);
  });
}

/**
 * Render one file per row of `table`.
 *
 * A row that fails is recorded and the batch continues — thirty-nine good files
 * and one named failure is a better morning than one error and no files. An
 * ABORT is different and stops immediately: the user asked it to stop.
 */
export async function renderDataRows(opts: BatchRenderOptions): Promise<BatchRenderSummary> {
  const { table, fields, namer, renderRow, onRow, onProgress, signal } = opts;
  const total = table.rows.length;
  const from = Math.max(0, Math.min(total, Math.floor(opts.startRow ?? 0)));
  const rows: BatchRowOutcome[] = [];
  const saved = captureFieldValues(fields);
  /** Where a resume would pick up. Null once the loop reaches the end. */
  let nextRow: number | null = from >= total ? null : from;

  try {
    for (let i = from; i < total; i++) {
      if (signal?.aborted) break;
      nextRow = i;
      const row = table.rows[i] as DataRow;
      const outputPath = namer(row, i);
      const fill = applyDataRow(fields, row, `Fill row ${i + 1}`);

      const outcome: BatchRowOutcome = { index: i, outputPath, fill };
      try {
        await renderRow(
          outputPath,
          (f) => onProgress?.((i + Math.max(0, Math.min(1, f))) / total),
          signal ?? new AbortController().signal,
        );
      } catch (err) {
        if (signal?.aborted) break;
        outcome.error = err instanceof Error ? err.message : String(err);
      }
      rows.push(outcome);
      onRow?.(outcome, total);
      onProgress?.((i + 1) / total);
      // Advanced only AFTER the row settled, so an abort mid-row resumes at
      // that row rather than skipping it — a half-written file is not a
      // delivered one.
      nextRow = i + 1 >= total ? null : i + 1;
    }
  } finally {
    // In a `finally`, so an abort or a thrown namer still hands the user their
    // own document back rather than the last row it happened to reach.
    restoreFieldValues(saved);
  }

  return {
    rows,
    rendered: rows.filter((r) => !r.error).length,
    failed: rows.filter((r) => r.error).length,
    nextRow,
  };
}
