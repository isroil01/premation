/** `premation render --data`: the table main reads and the names rows render to (the editor's rules). */

import { parseDataTable, patternVariesPerRow, resolveOutputName } from './dataTable';

describe('data tables for the CLI', () => {
  it('reads quoted CSV (commas, escaped quotes, newlines in cells) and flat JSON', () => {
    const csv = 'name,title\r\n"Lovelace, Ada","Say ""hi""\nthere"\r\nBabbage,Engineer\r\n';
    expect(parseDataTable(csv, 'people.csv')).toEqual({
      columns: ['name', 'title'],
      rows: [{ name: 'Lovelace, Ada', title: 'Say "hi"\nthere' }, { name: 'Babbage', title: 'Engineer' }],
    });
    expect(parseDataTable('[{"name":"A","age":3}]', 'rows.json')).toEqual({ columns: ['name', 'age'], rows: [{ name: 'A', age: '3' }] });
    expect(() => parseDataTable('a,a\n1,2', 'x.csv')).toThrow(/both named/);
    expect(() => parseDataTable('a,b\n1', 'x.csv')).toThrow(/Row 1 has 1 cells/);
  });

  it('names each row: padded index, sanitised cells, unknown tokens refused', () => {
    expect(resolveOutputName('out/{index}-{name}.mp4', { name: 'Q3 / Q4: results.' }, 4, 40)).toBe('out/05-Q3 Q4 results.mp4');
    expect(resolveOutputName('{name}.mp4', { name: '???' }, 0, 3)).toBe('1.mp4');
    expect(() => resolveOutputName('{nope}.mp4', { name: 'a' }, 0, 1)).toThrow(/not a column/);
    expect(patternVariesPerRow('out.mp4')).toBe(false);
    expect(patternVariesPerRow('{row}.mp4')).toBe(true);
  });
});
