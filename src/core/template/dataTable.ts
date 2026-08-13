/**
 * Parsing a data table into rows a template can be filled from.
 *
 * The batch-fill half of "data-driven templates": you author one lower-third
 * and render forty from a spreadsheet. Deliberately scope A of
 * `docs/TEMPLATE_DATA_BINDING_SCOPE.md` — the table is EXTERNAL and applied at
 * fill time, so nothing is persisted, no schema moves, and no migration or
 * format-freeze item is owed.
 *
 * This module is pure and knows nothing about the scene: text in, rows out.
 * Applying a row is `applyDataRow` in dataFill.ts, which routes every value
 * through the existing `writeTemplateField`. A field is already a named, typed,
 * addressable write target — that is what makes this a SOURCE for an existing
 * mechanism rather than a new mechanism.
 *
 * ── Why the CSV parser is hand-written ─────────────────────────────────
 * Because quoting matters and `split(',')` gets it wrong on exactly the data
 * this feature exists for: a name field containing "Lovelace, Ada", or a title
 * with an escaped quote. A dependency would be the other reasonable answer, but
 * this is ~40 lines and the app already refuses to reach for one at the
 * expression layer for related reasons.
 */

/** One row: field id → the value to write. */
export type DataRow = Readonly<Record<string, string>>;

export interface DataTable {
  /** Column headers, in file order. These are matched against field ids. */
  columns: readonly string[];
  rows: readonly DataRow[];
}

export class DataTableError extends Error {}

/**
 * Split one CSV line, honouring double-quoted cells and `""` escapes.
 *
 * Returns cells with surrounding quotes removed and escapes collapsed. A
 * newline inside a quoted cell is handled by `splitCsvRows`, not here.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        // `""` inside a quoted cell is a literal quote, not the end of it.
        if (line[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  out.push(cell);
  return out.map((c) => c.trim());
}

/**
 * Split a CSV document into lines, keeping quoted newlines inside their cell.
 *
 * A plain `split('\n')` tears a multi-line cell into two malformed rows — and a
 * pasted description column is exactly where that shows up.
 */
function splitCsvRows(text: string): string[] {
  const rows: string[] = [];
  let row = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') { quoted = !quoted; row += ch; continue; }
    if (!quoted && (ch === '\n' || ch === '\r')) {
      // Swallow the \n of a \r\n pair rather than emitting an empty row.
      if (ch === '\r' && text[i + 1] === '\n') i++;
      rows.push(row);
      row = '';
      continue;
    }
    row += ch;
  }
  if (row.length) rows.push(row);
  return rows.filter((r) => r.trim().length > 0);
}

/** Parse CSV with a header row. Throws `DataTableError` on unusable input. */
export function parseCsv(text: string): DataTable {
  const lines = splitCsvRows(text);
  if (lines.length === 0) throw new DataTableError('The file is empty.');

  const columns = splitCsvLine(lines[0]!);
  if (columns.some((c) => c === '')) {
    throw new DataTableError('One of the header cells is blank — every column needs a name.');
  }
  const dupe = columns.find((c, i) => columns.indexOf(c) !== i);
  if (dupe !== undefined) {
    // Silently keeping the last would drop a column the user can see in their
    // file, which is the worst kind of wrong: invisible.
    throw new DataTableError(`Two columns are both named “${dupe}”.`);
  }
  if (lines.length === 1) throw new DataTableError('The file has headers but no rows.');

  const rows: DataRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    if (cells.length !== columns.length) {
      throw new DataTableError(
        `Row ${i} has ${cells.length} cells but there are ${columns.length} columns.`,
      );
    }
    const row: Record<string, string> = {};
    columns.forEach((c, idx) => { row[c] = cells[idx]!; });
    rows.push(row);
  }
  return { columns, rows };
}

/** Parse a JSON array of flat objects. Throws `DataTableError` on bad shape. */
export function parseJsonTable(text: string): DataTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new DataTableError(`That isn't valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new DataTableError('Expected a JSON array of rows.');
  if (parsed.length === 0) throw new DataTableError('The array is empty.');

  const rows: DataRow[] = [];
  const columns: string[] = [];
  for (const [i, entry] of parsed.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DataTableError(`Row ${i + 1} is not an object.`);
    }
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') {
        throw new DataTableError(`Row ${i + 1}, “${k}” is nested — rows must be flat.`);
      }
      // Everything becomes a string here and is coerced per FIELD KIND at fill
      // time. The table cannot know that `fontSize` wants a number, and a JSON
      // number in a text field would otherwise write a number into a string prop.
      row[k] = v === null || v === undefined ? '' : String(v);
      if (!columns.includes(k)) columns.push(k);
    }
    rows.push(row);
  }
  return { columns, rows };
}

/** Parse by extension, falling back to sniffing the first non-space character. */
export function parseDataTable(text: string, filename?: string): DataTable {
  const lower = (filename ?? '').toLowerCase();
  if (lower.endsWith('.json')) return parseJsonTable(text);
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return parseCsv(text);
  return text.trimStart().startsWith('[') ? parseJsonTable(text) : parseCsv(text);
}

/**
 * Which columns line up with the template's fields, and which do not.
 *
 * Reported rather than enforced: a table with a `notes` column the template
 * ignores is fine and common, but the user should be told it is being ignored
 * rather than wondering why nothing changed. A field with no column is the
 * more serious one — it keeps its authored value on every row.
 */
export function matchColumns(
  columns: readonly string[],
  fieldIds: readonly string[],
): { matched: string[]; unusedColumns: string[]; unfilledFields: string[] } {
  const matched = columns.filter((c) => fieldIds.includes(c));
  return {
    matched,
    unusedColumns: columns.filter((c) => !fieldIds.includes(c)),
    unfilledFields: fieldIds.filter((f) => !columns.includes(f)),
  };
}
