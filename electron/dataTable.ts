/**
 * `premation render --data rows.csv`: the table main reads, and the file name
 * each row renders to. The engine fills the template (`premation-engine
 * --prepare` `fill`); main owns the table and the names.
 *
 * The editor's rules (src/core/template/dataTable.ts, batchRender.ts —
 * duplicated rather than shared: electron/ cannot import src/): quoted CSV
 * cells, `""` escapes and quoted newlines, flat JSON arrays; `{index}` /
 * `{row}` zero-padded to the table's width, `{column}` sanitised for a file
 * name, an unknown token refused.
 */

/** One row: field id → the cell text. */
export type DataRow = Readonly<Record<string, string>>;

export interface DataTable {
  columns: readonly string[];
  rows: readonly DataRow[];
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
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

function splitCsvRows(text: string): string[] {
  const rows: string[] = [];
  let row = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') { quoted = !quoted; row += ch; continue; }
    if (!quoted && (ch === '\n' || ch === '\r')) {
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

export function parseCsv(text: string): DataTable {
  const lines = splitCsvRows(text.replace(/^\uFEFF/, ''));
  if (lines.length === 0) throw new Error('The file is empty.');
  const columns = splitCsvLine(lines[0]!);
  if (columns.some((c) => c === '')) throw new Error('One of the header cells is blank — every column needs a name.');
  const dupe = columns.find((c, i) => columns.indexOf(c) !== i);
  if (dupe !== undefined) throw new Error(`Two columns are both named “${dupe}”.`);
  if (lines.length === 1) throw new Error('The file has headers but no rows.');
  const rows: DataRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    if (cells.length !== columns.length) throw new Error(`Row ${i} has ${cells.length} cells but there are ${columns.length} columns.`);
    const row: Record<string, string> = {};
    columns.forEach((c, idx) => { row[c] = cells[idx]!; });
    rows.push(row);
  }
  return { columns, rows };
}

export function parseJsonTable(text: string): DataTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`That isn't valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of rows.');
  if (parsed.length === 0) throw new Error('The array is empty.');
  const rows: DataRow[] = [];
  const columns: string[] = [];
  for (const [i, entry] of parsed.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Row ${i + 1} is not an object.`);
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') throw new Error(`Row ${i + 1}, “${k}” is nested — rows must be flat.`);
      row[k] = v === null || v === undefined ? '' : String(v);
      if (!columns.includes(k)) columns.push(k);
    }
    rows.push(row);
  }
  return { columns, rows };
}

/** By extension, else by sniffing the first non-space character. */
export function parseDataTable(text: string, filename?: string): DataTable {
  const lower = (filename ?? '').toLowerCase();
  if (lower.endsWith('.json')) return parseJsonTable(text);
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return parseCsv(text);
  return text.trimStart().startsWith('[') ? parseJsonTable(text) : parseCsv(text);
}

// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g;
const MAX_TOKEN_LENGTH = 80;
const INDEX_TOKENS = new Set(['index', 'row']);

export function sanitizeNameToken(value: string): string {
  return value.replace(UNSAFE_FILENAME, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, MAX_TOKEN_LENGTH).trim();
}

/** `{index}` / `{row}` (1-based, padded) and `{column}` from `row`; an unknown token throws. */
export function resolveOutputName(pattern: string, row: DataRow, index: number, total: number): string {
  const width = Math.max(1, String(Math.max(1, total)).length);
  return pattern.replace(/\{([^{}]*)\}/g, (_match, rawToken: string) => {
    const token = rawToken.trim();
    if (INDEX_TOKENS.has(token.toLowerCase())) return String(index + 1).padStart(width, '0');
    const cell = row[token];
    if (cell === undefined) {
      throw new Error(`"{${token}}" is not a column in this table. Available: ${Object.keys(row).join(', ')} (plus {index}).`);
    }
    return sanitizeNameToken(cell) || String(index + 1).padStart(width, '0');
  });
}

/** True when a pattern varies per row — the check that stops a 40-into-1 batch. */
export function patternVariesPerRow(pattern: string): boolean {
  return /\{[^{}]*\}/.test(pattern);
}
