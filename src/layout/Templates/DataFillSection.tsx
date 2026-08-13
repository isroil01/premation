/**
 * Batch fill — load a table, step through its rows.
 *
 * The reachable half of data-driven templates. `dataTable.ts` parses and
 * `dataFill.ts` applies; this is only the surface, deliberately, so the rules
 * about quoting and coercion stay unit-tested rather than tangled in a
 * component.
 *
 * ── Why row-stepping and not a render button ───────────────────────────
 * Applying a row is instant and reversible, so stepping through rows lets you
 * SEE the template take each one before committing to forty renders. The batch
 * render loop (one queue job per row) is the natural next step and is not built
 * — which is stated in the UI rather than implied by a button that does not
 * exist.
 *
 * The column report is shown, not hidden: a column the template ignores is
 * usually fine, but a FIELD with no column keeps its authored value on every
 * row, which otherwise reads as "the fill didn't work".
 */

import { useState } from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { useUIStore } from '@stores/uiStore';
import { parseDataTable, matchColumns, DataTableError, type DataTable } from '@core/template/dataTable';
import { applyDataRow } from '@core/template/dataFill';
import type { TemplateField } from '@core/template/templateTypes';
import styles from './DataFillSection.module.css';

export function DataFillSection({ fields }: { fields: ReadonlyArray<TemplateField> }): JSX.Element {
  const [table, setTable] = useState<DataTable | null>(null);
  const [row, setRow] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const notify = (message: string, level: 'success' | 'warning' | 'error' = 'success'): void => {
    useUIStore.getState().notify({ level, message, durationMs: 3000 });
  };

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const parsed = parseDataTable(await file.text(), file.name);
      setTable(parsed);
      setRow(0);
      setError(null);
    } catch (err) {
      // A parse failure is ABOUT the file, so it belongs next to the picker
      // rather than in a toast that scrolls away while you look for the typo.
      setTable(null);
      setError(err instanceof DataTableError ? err.message : String(err));
    }
  };

  const apply = (index: number): void => {
    if (!table) return;
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
          <div className={styles.hint}>
            Rendering one file per row isn’t built yet — step through rows here to
            check the table, then export as usual.
          </div>
        </>
      )}
    </div>
  );
}
