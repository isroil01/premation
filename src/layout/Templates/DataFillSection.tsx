/**
 * Batch fill — load a table, step through its rows.
 *
 * The reachable half of data-driven templates. `dataTable.ts` parses and
 * `dataFill.ts` applies; this is only the surface, deliberately, so the rules
 * about quoting and coercion stay unit-tested rather than tangled in a
 * component.
 *
 * ── Stepping AND rendering ─────────────────────────────────────────────
 * Applying a row is instant and reversible, so stepping through rows lets you
 * SEE the template take each one before committing to forty renders. "Render
 * every row" then runs the batch — sequentially, awaiting each render, never
 * through the Render Queue (a queued job carries settings, not a document, so N
 * queued rows would all render the last row's scene; see `batchRender.ts`).
 *
 * The naming pattern is a control rather than a convention, because "forty
 * files with the same name" is the failure this feature is most likely to have.
 * It is validated against real data before anything renders.
 *
 * The column report is shown, not hidden: a column the template ignores is
 * usually fine, but a FIELD with no column keeps its authored value on every
 * row, which otherwise reads as "the fill didn't work".
 */

import { useRef, useState } from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { Input } from '@components/Input';
import { Dropdown } from '@components/Dropdown';
import { useUIStore } from '@stores/uiStore';
import { parseDataTable, matchColumns, DataTableError, type DataTable } from '@core/template/dataTable';
import { applyDataRow } from '@core/template/dataFill';
import { patternVariesPerRow, OutputPatternError, resolveOutputName } from '@core/template/batchRender';
import { BATCH_FORMATS, batchFileName, runEditorBatchRender } from '@core/template/batchRenderEditor';
import { canChooseOutputDir, useRenderQueueStore } from '@stores/renderQueueStore';
import type { OutputFormat } from '@core/export/renderJob';
import type { TemplateField } from '@core/template/templateTypes';
import styles from './DataFillSection.module.css';

/**
 * The default naming pattern.
 *
 * `{index}` because it is the one token guaranteed to exist and to differ per
 * row — a default built from a column would be wrong for every table whose
 * first column is not a name, and wrong in the silent way (one file).
 */
const DEFAULT_PATTERN = '{index}';

/** Live batch progress, or null when no batch is running. */
interface BatchState {
  fraction: number;
  done: number;
  total: number;
}

export function DataFillSection({ fields }: { fields: ReadonlyArray<TemplateField> }): JSX.Element {
  const [table, setTable] = useState<DataTable | null>(null);
  const [row, setRow] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pattern, setPattern] = useState(DEFAULT_PATTERN);
  const [format, setFormat] = useState<OutputFormat>('mp4');
  const [batch, setBatch] = useState<BatchState | null>(null);
  /**
   * Where a stopped batch reached, so Resume does not re-render what is already
   * on disk. Null when there is nothing to resume.
   *
   * Cleared whenever the table or the naming changes: resuming into a different
   * table at row 30 would render rows nobody asked for, under names from a
   * pattern that no longer applies.
   */
  const [resumeFrom, setResumeFrom] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const notify = (message: string, level: 'success' | 'warning' | 'error' = 'success'): void => {
    useUIStore.getState().notify({ level, message, durationMs: 3000 });
  };

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const parsed = parseDataTable(await file.text(), file.name);
      setTable(parsed);
      setRow(0);
      setResumeFrom(null);
      setError(null);
    } catch (err) {
      // A parse failure is ABOUT the file, so it belongs next to the picker
      // rather than in a toast that scrolls away while you look for the typo.
      setTable(null);
      setError(err instanceof DataTableError ? err.message : String(err));
    }
  };

  const apply = (index: number): void => {
    if (!table || batch) return;
    const r = table.rows[index];
    if (!r) return;
    const result = applyDataRow(fields, r, `Fill row ${index + 1}`);
    setRow(index);
    if (result.filled.length === 0) {
      notify('Nothing in that row matched a field', 'warning');
    } else if (result.failed.length > 0) {
      notify(`Filled ${result.filled.length}, ${result.failed.length} could not be read`, 'warning');
    } else {
      notify(`Filled ${result.filled.length} field${result.filled.length === 1 ? '' : 's'}`);
    }
  };

  /**
   * What row 1 will be called.
   *
   * Shown live, because a pattern is only checkable against real data: a
   * mistyped column name is otherwise discovered after the batch, and a pattern
   * that does not vary is discovered when the folder holds one file.
   */
  const namePreview = ((): { name: string } | { problem: string } => {
    const first = table?.rows[0];
    if (!first) return { name: '' };
    if (!patternVariesPerRow(pattern)) {
      return {
        problem: 'This name is the same for every row, so each render would land on the last one. '
          + 'Add {index} or a column name.',
      };
    }
    try {
      return { name: batchFileName(resolveOutputName(pattern, first, 0, table.rows.length), format) };
    } catch (err) {
      return { problem: err instanceof OutputPatternError ? err.message : String(err) };
    }
  })();

  const startBatch = async (): Promise<void> => {
    if (!table || 'problem' in namePreview) return;

    // Asked ONCE, before any rendering, exactly as the Render Queue does — a
    // batch that opens a save dialog per row stops on the first one and waits,
    // which is the opposite of what a batch is for.
    let dir = useRenderQueueStore.getState().outputDir;
    if (!dir && canChooseOutputDir()) {
      dir = await useRenderQueueStore.getState().chooseOutputDir();
      if (!dir) return;
    }

    const abort = new AbortController();
    abortRef.current = abort;
    const from = resumeFrom ?? 0;
    setBatch({ fraction: from / table.rows.length, done: from, total: table.rows.length });
    try {
      const summary = await runEditorBatchRender({
        table,
        fields,
        pattern,
        format,
        outputDir: dir,
        startRow: from,
        signal: abort.signal,
        onProgress: (fraction) => setBatch((b) => (b ? { ...b, fraction } : b)),
        onRow: (_outcome, total) => setBatch((b) => (b ? { ...b, done: b.done + 1, total } : b)),
      });
      setResumeFrom(summary.nextRow);
      if (abort.signal.aborted) {
        notify(
          summary.nextRow === null
            ? `Stopped after ${summary.rendered} of ${table.rows.length} rows`
            : `Stopped at row ${summary.nextRow + 1} — Resume picks up there`,
          'warning',
        );
      } else if (summary.failed > 0) {
        // The first failure's own message, not just a count: that is what tells
        // someone whether the batch is worth re-running or the project is wrong.
        const firstError = summary.rows.find((r) => r.error)?.error ?? '';
        notify(`Rendered ${summary.rendered}, ${summary.failed} failed — ${firstError}`, 'error');
      } else {
        notify(`Rendered ${summary.rendered} file${summary.rendered === 1 ? '' : 's'}`);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      abortRef.current = null;
      setBatch(null);
    }
  };

  const report = table ? matchColumns(table.columns, fields.map((f) => f.id)) : null;

  return (
    <div className={styles.root}>
      <div className={styles.label}>Data</div>

      <label className={styles.picker}>
        <Icon name="grid" size="sm" />
        <span>{table ? 'Choose another file…' : 'Load CSV or JSON…'}</span>
        <input
          type="file"
          accept=".csv,.json,.tsv,text/csv,application/json"
          className={styles.fileInput}
          onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }}
        />
      </label>

      {error && <div className={styles.error}>{error}</div>}

      {table && report && (
        <>
          <div className={styles.rowNav}>
            <Button
              variant="secondary" size="sm"
              disabled={row === 0}
              onClick={() => apply(row - 1)}
            >
              Previous
            </Button>
            <span className={styles.rowCount}>
              Row {row + 1} of {table.rows.length}
            </span>
            <Button
              variant="secondary" size="sm"
              disabled={row >= table.rows.length - 1}
              onClick={() => apply(row + 1)}
            >
              Next
            </Button>
          </div>

          <Button variant="primary" size="sm" fullWidth onClick={() => apply(row)}>
            Apply this row
          </Button>

          {report.unfilledFields.length > 0 && (
            <div className={styles.warn}>
              No column for: {report.unfilledFields.join(', ')} — these keep their
              current value on every row.
            </div>
          )}
          {report.unusedColumns.length > 0 && (
            <div className={styles.hint}>
              Ignored columns: {report.unusedColumns.join(', ')}
            </div>
          )}
          <div className={styles.batch}>
            <div className={styles.label}>Render every row</div>

            <div className={styles.batchRow}>
              <Input
                size="sm"
                fullWidth
                value={pattern}
                onChange={(e) => { setPattern(e.target.value); setResumeFrom(null); }}
                aria-label="File name pattern"
                placeholder={DEFAULT_PATTERN}
                disabled={!!batch}
              />
              <Dropdown
                trigger={
                  <Button variant="secondary" size="sm" disabled={!!batch}>
                    {BATCH_FORMATS.find((f) => f.format === format)?.label ?? format}
                  </Button>
                }
                placement="bottom-end"
                items={BATCH_FORMATS.map((f) => ({
                  type: 'item' as const,
                  id: f.format,
                  label: f.label,
                  onSelect: () => { setFormat(f.format); setResumeFrom(null); },
                }))}
              />
            </div>

            {'problem' in namePreview ? (
              <div className={styles.warn}>{namePreview.problem}</div>
            ) : (
              <div className={styles.hint}>
                {'{index}'} is the row number; {'{' + (table.columns[0] ?? 'name') + '}'} is a column.
                {' '}Row 1 → <code>{namePreview.name}</code>
              </div>
            )}

            {batch ? (
              <>
                <div className={styles.progressTrack}>
                  <div
                    className={styles.progressFill}
                    style={{ width: `${Math.round(batch.fraction * 100)}%` }}
                  />
                </div>
                <div className={styles.rowNav}>
                  <span className={styles.rowCount}>
                    Rendering {Math.min(batch.done + 1, batch.total)} of {batch.total}
                  </span>
                  <Button variant="secondary" size="sm" onClick={() => abortRef.current?.abort()}>
                    Stop
                  </Button>
                </div>
              </>
            ) : (
              <div className={styles.batchRow}>
                <Button
                  variant="secondary"
                  size="sm"
                  fullWidth
                  disabled={'problem' in namePreview}
                  onClick={() => { void startBatch(); }}
                >
                  {resumeFrom === null
                    ? `Render ${table.rows.length} file${table.rows.length === 1 ? '' : 's'}`
                    : `Resume from row ${resumeFrom + 1}`}
                </Button>
                {resumeFrom === null ? null : (
                  <Button variant="secondary" size="sm" onClick={() => setResumeFrom(null)}>
                    Start over
                  </Button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
