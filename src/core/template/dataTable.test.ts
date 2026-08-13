/**
 * The data-table parser.
 *
 * Heavily tested because this is the layer that meets USER FILES, and the cases
 * that break naive CSV handling are exactly the ones this feature exists for:
 * a name column containing "Lovelace, Ada", a quoted title, a pasted
 * description with a newline in it. `split(',')` passes a demo and corrupts
 * real data.
 */

import { parseCsv, parseJsonTable, parseDataTable, matchColumns, DataTableError } from './dataTable';

describe('parseCsv', () => {
  it('reads a header row and its rows', () => {
    const t = parseCsv('name,title\nAda,Engine\nGrace,Compilers\n');
    expect(t.columns).toEqual(['name', 'title']);
    expect(t.rows).toEqual([
      { name: 'Ada', title: 'Engine' },
      { name: 'Grace', title: 'Compilers' },
    ]);
  });

  it('keeps a comma inside a quoted cell', () => {
    // The case the whole hand-written parser exists for.
    const t = parseCsv('name,title\n"Lovelace, Ada",Engine\n');
    expect(t.rows[0]).toEqual({ name: 'Lovelace, Ada', title: 'Engine' });
  });

  it('collapses a doubled quote into a literal one', () => {
    const t = parseCsv('name,title\n"She said ""hi""",Engine\n');
    expect(t.rows[0]!.name).toBe('She said "hi"');
  });

  it('keeps a newline inside a quoted cell in that cell', () => {
    // A plain split('\n') tears this into two malformed rows.
    const t = parseCsv('name,bio\nAda,"line one\nline two"\n');
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!.bio).toBe('line one\nline two');
  });

  it('handles CRLF without emitting blank rows', () => {
    const t = parseCsv('name,title\r\nAda,Engine\r\n');
    expect(t.rows).toHaveLength(1);
  });

  it('trims surrounding whitespace on cells', () => {
    const t = parseCsv('name, title\nAda , Engine\n');
    expect(t.columns).toEqual(['name', 'title']);
    expect(t.rows[0]).toEqual({ name: 'Ada', title: 'Engine' });
  });

  it('refuses a duplicate column instead of silently keeping one', () => {
    // Dropping a column the user can see in their file is the worst kind of
    // wrong, because nothing on screen says it happened.
    expect(() => parseCsv('name,name\na,b\n')).toThrow(DataTableError);
  });

  it('refuses a blank header cell', () => {
    expect(() => parseCsv('name,,title\na,b,c\n')).toThrow(DataTableError);
  });

  it('refuses a ragged row, naming which one', () => {
    expect(() => parseCsv('name,title\nAda\n')).toThrow(/Row 1 has 1 cells but there are 2/);
  });

  it('refuses an empty file and a headers-only file', () => {
    expect(() => parseCsv('')).toThrow(DataTableError);
    expect(() => parseCsv('name,title\n')).toThrow(/no rows/);
  });
});

describe('parseJsonTable', () => {
  it('reads an array of flat objects', () => {
    const t = parseJsonTable('[{"name":"Ada","n":3}]');
    expect(t.columns).toEqual(['name', 'n']);
    // Numbers are stringified here on purpose: the TABLE cannot know that a
    // field wants a number, so coercion happens per field kind at fill time.
    expect(t.rows[0]).toEqual({ name: 'Ada', n: '3' });
  });

  it('unions columns across rows with different keys', () => {
    const t = parseJsonTable('[{"a":1},{"b":2}]');
    expect(t.columns).toEqual(['a', 'b']);
  });

  it('turns null into an empty cell rather than the string "null"', () => {
    expect(parseJsonTable('[{"a":null}]').rows[0]).toEqual({ a: '' });
  });

  it('refuses nested values, an empty array and a non-array', () => {
    expect(() => parseJsonTable('[{"a":{"b":1}}]')).toThrow(/nested/);
    expect(() => parseJsonTable('[]')).toThrow(/empty/);
    expect(() => parseJsonTable('{"a":1}')).toThrow(/array of rows/);
    expect(() => parseJsonTable('not json')).toThrow(DataTableError);
  });
});

describe('parseDataTable', () => {
  it('routes on extension', () => {
    expect(parseDataTable('[{"a":1}]', 'rows.json').rows).toHaveLength(1);
    expect(parseDataTable('a\n1\n', 'rows.csv').rows).toHaveLength(1);
  });

  it('sniffs when there is no filename', () => {
    expect(parseDataTable('[{"a":1}]').columns).toEqual(['a']);
    expect(parseDataTable('a,b\n1,2\n').columns).toEqual(['a', 'b']);
  });
});

describe('matchColumns', () => {
  it('separates matched, unused columns and unfilled fields', () => {
    // Both halves get reported: an ignored column is usually fine, a field with
    // no column silently keeps its authored value on every row — which reads as
    // "the fill didn't work".
    const m = matchColumns(['name', 'notes'], ['name', 'title']);
    expect(m).toEqual({ matched: ['name'], unusedColumns: ['notes'], unfilledFields: ['title'] });
  });
});
