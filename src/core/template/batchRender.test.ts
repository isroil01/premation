/**
 * The batch loop's rules, and the two failures it exists to prevent.
 *
 * Both are silent by nature, which is why they are tested rather than trusted:
 * forty rows rendering to one filename (a pattern that does not vary), and the
 * user's own template left holding the last row's copy after the batch (no
 * restore). Neither throws, and neither is visible until someone opens the
 * output folder or saves the project.
 *
 * The scene-touching calls are mocked at the module boundary — `applyDataRow`
 * and the field read/write are covered by `dataFill.test.ts` and the template
 * suites, and mocking them here is what lets the LOOP be tested without a
 * renderer, a GPU or a document.
 */

import type { TemplateField } from './templateTypes';
import type { DataTable } from './dataTable';

const applyDataRow = jest.fn(() => ({ filled: ['name'], skippedKind: [], failed: [] }));
jest.mock('./dataFill', () => ({
  applyDataRow: (...args: unknown[]) => applyDataRow(...(args as [])),
}));

const written: Array<{ id: string; value: string | number }> = [];
const currentValues = new Map<string, string | number>();
jest.mock('./templateFields', () => ({
  readTemplateFieldValue: (f: TemplateField) => currentValues.get(f.id),
  writeTemplateField: (f: TemplateField, v: string | number) => {
    written.push({ id: f.id, value: v });
    return true;
  },
}));

jest.mock('@core/animation/animationCommands', () => ({
  runAnimEdit: (_label: string, fn: () => void) => fn(),
}));

import {
  OutputPatternError,
  patternVariesPerRow,
  renderDataRows,
  resolveOutputName,
  sanitizeNameToken,
} from './batchRender';

const FIELDS: TemplateField[] = [
  { id: 'name', label: 'Name', kind: 'text', target: { nodeId: 'n1', componentType: 'Text', prop: 'content' }, default: 'Name' },
];

const TABLE: DataTable = {
  columns: ['name'],
  rows: [{ name: 'Ada' }, { name: 'Grace' }, { name: 'Katherine' }],
};

beforeEach(() => {
  applyDataRow.mockClear();
  written.length = 0;
  currentValues.clear();
});

describe('sanitizeNameToken', () => {
  it('keeps spaces and hyphens, which are perfectly good in a filename', () => {
    expect(sanitizeNameToken('Ada Lovelace-01')).toBe('Ada Lovelace-01');
  });

  it('removes the characters a filesystem refuses', () => {
    expect(sanitizeNameToken('Q3 / Q4: results?')).toBe('Q3 Q4 results');
  });

  it('collapses a comma-separated name into something openable', () => {
    expect(sanitizeNameToken('Lovelace, Ada')).toBe('Lovelace, Ada');
  });

  it('drops a trailing dot, which Windows can create and cannot open', () => {
    expect(sanitizeNameToken('Version 2.')).toBe('Version 2');
  });

  it('caps a paragraph-length cell', () => {
    expect(sanitizeNameToken('x'.repeat(500)).length).toBeLessThanOrEqual(80);
  });
});

describe('resolveOutputName', () => {
  it('substitutes a column', () => {
    expect(resolveOutputName('out/{name}.mp4', { name: 'Ada' }, 0, 3)).toBe('out/Ada.mp4');
  });

  it('zero-pads {index} to the table width so the folder sorts in table order', () => {
    expect(resolveOutputName('{index}.mp4', { name: 'Ada' }, 0, 40)).toBe('01.mp4');
    expect(resolveOutputName('{index}.mp4', { name: 'Ada' }, 39, 40)).toBe('40.mp4');
  });

  it('accepts {row} as an alias for {index}', () => {
    expect(resolveOutputName('{row}.mp4', { name: 'Ada' }, 4, 9)).toBe('5.mp4');
  });

  it('combines tokens', () => {
    expect(resolveOutputName('{index}-{name}.mp4', { name: 'Ada' }, 0, 10)).toBe('01-Ada.mp4');
  });

  it('falls back to the row number when a cell sanitises to nothing', () => {
    // Otherwise two rows whose names are both punctuation collide on one path,
    // and with an overwriting CLI the second silently replaces the first.
    expect(resolveOutputName('{name}.mp4', { name: '???' }, 6, 10)).toBe('07.mp4');
    expect(resolveOutputName('{name}.mp4', { name: '' }, 0, 10)).toBe('01.mp4');
  });

  it('throws for a token that is not a column, listing what is', () => {
    expect(() => resolveOutputName('{tilte}.mp4', { title: 'x' }, 0, 1)).toThrow(OutputPatternError);
    expect(() => resolveOutputName('{tilte}.mp4', { title: 'x' }, 0, 1)).toThrow(/title/);
  });
});

describe('patternVariesPerRow', () => {
  it('is the check that stops forty renders becoming one file', () => {
    expect(patternVariesPerRow('out/{name}.mp4')).toBe(true);
    expect(patternVariesPerRow('out/promo.mp4')).toBe(false);
  });
});

describe('renderDataRows', () => {
  it('renders once per row, in order, sequentially', async () => {
    const order: string[] = [];
    const summary = await renderDataRows({
      table: TABLE,
      fields: FIELDS,
      namer: (row) => `${row.name}.mp4`,
      renderRow: async (outputPath) => { order.push(outputPath); },
    });

    expect(order).toEqual(['Ada.mp4', 'Grace.mp4', 'Katherine.mp4']);
    expect(summary.rendered).toBe(3);
    expect(summary.failed).toBe(0);
  });

  it('applies each row BEFORE its render, which is the whole point', async () => {
    const seen: Array<{ applied: number; rendered: string }> = [];
    await renderDataRows({
      table: TABLE,
      fields: FIELDS,
      namer: (row) => `${row.name}.mp4`,
      renderRow: async (outputPath) => {
        seen.push({ applied: applyDataRow.mock.calls.length, rendered: outputPath });
      },
    });
    // Row N's render happens after exactly N fills — never after all three,
    // which is what queueing the jobs instead of awaiting them would produce.
    expect(seen).toEqual([
      { applied: 1, rendered: 'Ada.mp4' },
      { applied: 2, rendered: 'Grace.mp4' },
      { applied: 3, rendered: 'Katherine.mp4' },
    ]);
  });

  it('keeps going past a failed row and reports it', async () => {
    const summary = await renderDataRows({
      table: TABLE,
      fields: FIELDS,
      namer: (row) => `${row.name}.mp4`,
      renderRow: async (outputPath) => {
        if (outputPath === 'Grace.mp4') throw new Error('ffmpeg exploded');
      },
    });

    expect(summary.rendered).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.rows[1]?.error).toMatch(/ffmpeg exploded/);
    // The third row still ran: 39 good files and one named failure beats one
    // error and no files.
    expect(summary.rows[2]?.error).toBeUndefined();
  });

  it('restores the template afterwards, so row 3 is not left on the layers', async () => {
    currentValues.set('name', 'AUTHORED');
    await renderDataRows({
      table: TABLE,
      fields: FIELDS,
      namer: (row) => `${row.name}.mp4`,
      renderRow: async () => undefined,
    });
    expect(written).toEqual([{ id: 'name', value: 'AUTHORED' }]);
  });

  it('restores the template even when the batch is aborted part-way', async () => {
    currentValues.set('name', 'AUTHORED');
    const abort = new AbortController();
    const summary = await renderDataRows({
      table: TABLE,
      fields: FIELDS,
      namer: (row) => `${row.name}.mp4`,
      renderRow: async () => { abort.abort(); },
      signal: abort.signal,
    });

    expect(summary.rendered).toBe(1);
    expect(written).toEqual([{ id: 'name', value: 'AUTHORED' }]);
  });

  it('restores the template even when naming throws mid-batch', async () => {
    currentValues.set('name', 'AUTHORED');
    await expect(
      renderDataRows({
        table: TABLE,
        fields: FIELDS,
        namer: (row, i) => {
          if (i === 1) throw new OutputPatternError('bad pattern');
          return `${row.name}.mp4`;
        },
        renderRow: async () => undefined,
      }),
    ).rejects.toThrow('bad pattern');
    expect(written).toEqual([{ id: 'name', value: 'AUTHORED' }]);
  });

  it('reports where a resume should start after an abort', async () => {
    // "Stop" used to mean "throw the work away", and the finished files were on
    // disk, so the loss was not even visible.
    const abort = new AbortController();
    let seen = 0;
    const summary = await renderDataRows({
      table: TABLE,
      fields: FIELDS,
      namer: (row) => `${row.name}.mp4`,
      renderRow: async () => { if (++seen === 2) abort.abort(); },
      signal: abort.signal,
    });

    expect(summary.rendered).toBe(2);
    expect(summary.nextRow).toBe(2);
  });

  it('reports nextRow null when the pass finished', async () => {
    const summary = await renderDataRows({
      table: TABLE,
      fields: FIELDS,
      namer: (row) => `${row.name}.mp4`,
      renderRow: async () => undefined,
    });
    expect(summary.nextRow).toBeNull();
  });

  it('resumes from a row, skipping what already landed', async () => {
    const rendered: string[] = [];
    const summary = await renderDataRows({
      table: TABLE,
      fields: FIELDS,
      namer: (row) => `${row.name}.mp4`,
      renderRow: async (outputPath) => { rendered.push(outputPath); },
      startRow: 2,
    });

    expect(rendered).toEqual(['Katherine.mp4']);
    expect(summary.rendered).toBe(1);
  });

  it('treats a start past the end as nothing left to do', async () => {
    const summary = await renderDataRows({
      table: TABLE,
      fields: FIELDS,
      namer: (row) => `${row.name}.mp4`,
      renderRow: async () => { throw new Error('should not render'); },
      startRow: 99,
    });
    expect(summary.rendered).toBe(0);
    expect(summary.nextRow).toBeNull();
  });

  it('reports progress across the whole batch, not per row', async () => {
    const seen: number[] = [];
    await renderDataRows({
      table: TABLE,
      fields: FIELDS,
      namer: (row) => `${row.name}.mp4`,
      renderRow: async (_out, onProgress) => { onProgress(0.5); },
      onProgress: (f) => seen.push(Number(f.toFixed(4))),
    });
    // Row 1 half-done is one sixth of three rows, not a half.
    expect(seen[0]).toBeCloseTo(1 / 6, 4);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('writes nothing back when there is nothing readable to restore', async () => {
    // A field whose target node has gone reads undefined; writing that back
    // would replace the last row's text with nothing at all.
    await renderDataRows({
      table: TABLE,
      fields: FIELDS,
      namer: (row) => `${row.name}.mp4`,
      renderRow: async () => undefined,
    });
    expect(written).toEqual([]);
  });
});
