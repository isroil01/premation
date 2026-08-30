/**
 * The batch-fill panel.
 *
 * Its logic is thin on purpose — parsing and coercion are unit-tested in
 * `dataTable.test.ts` / `dataFill.test.ts`. What is only testable HERE is the
 * wiring: that a bad file reports next to the picker instead of vanishing into
 * a toast, that stepping rows applies the row you are looking at, and that a
 * field with no column gets a warning rather than silently keeping its authored
 * value on every row.
 *
 * The batch half is the same argument. `batchRender.test.ts` owns the loop and
 * the naming rules; what is only testable here is that the panel REFUSES to
 * start a batch whose names do not vary — the failure that would otherwise
 * leave one file where forty were expected, with nothing reported.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DataFillSection } from './DataFillSection';
import type { TemplateField } from '@core/template/templateTypes';

type Row = Readonly<Record<string, string>>;
type FillResult = { filled: string[]; skippedKind: string[]; failed: string[] };

const applyDataRow = jest.fn<FillResult, [readonly TemplateField[], Row, string?]>(
  () => ({ filled: ['name'], skippedKind: [], failed: [] }),
);
jest.mock('@core/template/dataFill', () => ({
  applyDataRow: (fields: readonly TemplateField[], row: Row, label?: string) =>
    applyDataRow(fields, row, label),
}));

const notify = jest.fn();
jest.mock('@stores/uiStore', () => ({
  useUIStore: { getState: () => ({ notify }) },
}));

/*
  The batch renderer is mocked at its module boundary, not stubbed inside the
  component. It reaches the export manager, the composition store and a GPU
  sink — none of which exist under jsdom, and none of which this file is about.
  What IS about this file is whether the button calls it at all.
*/
type BatchSummary = { rows: Array<{ error?: string }>; rendered: number; failed: number };
const runEditorBatchRender = jest.fn<Promise<BatchSummary>, [Record<string, unknown>]>(
  async () => ({ rows: [], rendered: 2, failed: 0 }),
);
jest.mock('@core/template/batchRenderEditor', () => ({
  BATCH_FORMATS: [{ format: 'mp4', label: 'MP4 · H.264' }, { format: 'gif', label: 'Animated GIF' }],
  batchFileName: (pattern: string) => `${pattern}.mp4`,
  runEditorBatchRender: (opts: unknown) => runEditorBatchRender(opts as Record<string, unknown>),
}));

const chooseOutputDir = jest.fn(async () => '/out');
jest.mock('@stores/renderQueueStore', () => ({
  canChooseOutputDir: () => true,
  useRenderQueueStore: { getState: () => ({ outputDir: '/out', chooseOutputDir }) },
}));

const field = (id: string, kind: TemplateField['kind'] = 'text'): TemplateField =>
  ({ id, label: id, kind, default: '', target: { nodeId: 'n', componentType: 'Text', prop: 'content' } });

/**
 * A File whose `.text()` resolves to `content`.
 *
 * jsdom's File has no `text()`, and the component awaits it — without this the
 * change handler rejects and the test passes for the wrong reason.
 */
function fileOf(content: string, name: string): File {
  const f = new File([content], name, { type: 'text/csv' });
  Object.defineProperty(f, 'text', { value: () => Promise.resolve(content) });
  return f;
}

const pick = (file: File): void => {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
};

beforeEach(() => {
  applyDataRow.mockClear();
  notify.mockClear();
  runEditorBatchRender.mockClear();
  chooseOutputDir.mockClear();
});

describe('DataFillSection', () => {
  it('shows the row count once a table loads', async () => {
    render(<DataFillSection fields={[field('name')]} />);
    pick(fileOf('name\nAda\nGrace\n', 'rows.csv'));
    expect(await screen.findByText(/Row 1 of 2/)).toBeInTheDocument();
  });

  it('reports a parse failure beside the picker, not as a toast', async () => {
    // The error is ABOUT the file; a toast scrolls away while you hunt for the
    // typo, and there is nothing to step through in the meantime.
    render(<DataFillSection fields={[field('name')]} />);
    pick(fileOf('name,name\na,b\n', 'rows.csv'));

    expect(await screen.findByText(/both named/)).toBeInTheDocument();
    expect(notify).not.toHaveBeenCalled();
    expect(screen.queryByText(/Row 1 of/)).not.toBeInTheDocument();
  });

  it('applies the row currently shown', async () => {
    render(<DataFillSection fields={[field('name')]} />);
    pick(fileOf('name\nAda\nGrace\n', 'rows.csv'));
    await screen.findByText(/Row 1 of 2/);

    fireEvent.click(screen.getByText('Apply this row'));
    expect(applyDataRow.mock.calls[0]?.[1]).toEqual({ name: 'Ada' });
  });

  it('stepping to the next row applies THAT row', async () => {
    // Stepping is the whole point — you look at a row before committing to
    // forty renders, so Next must apply what it moves to, not the old index.
    render(<DataFillSection fields={[field('name')]} />);
    pick(fileOf('name\nAda\nGrace\n', 'rows.csv'));
    await screen.findByText(/Row 1 of 2/);

    fireEvent.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText(/Row 2 of 2/)).toBeInTheDocument());
    expect(applyDataRow.mock.calls[0]?.[1]).toEqual({ name: 'Grace' });
  });

  it('cannot step past either end', async () => {
    render(<DataFillSection fields={[field('name')]} />);
    pick(fileOf('name\nAda\n', 'rows.csv'));
    await screen.findByText(/Row 1 of 1/);

    // By ROLE, not by text: Button renders its label in a <span>, and
    // `getByText` returns that span — which is never disabled, so the
    // assertion would pass on a broken control.
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('warns about a field no column fills', async () => {
    // The quiet failure: that field keeps its authored value on every row, so
    // the fill looks broken rather than partial.
    render(<DataFillSection fields={[field('name'), field('title')]} />);
    pick(fileOf('name\nAda\n', 'rows.csv'));

    expect(await screen.findByText(/No column for: title/)).toBeInTheDocument();
  });

  it('mentions an ignored column without calling it a problem', async () => {
    render(<DataFillSection fields={[field('name')]} />);
    pick(fileOf('name,notes\nAda,hi\n', 'rows.csv'));

    expect(await screen.findByText(/Ignored columns: notes/)).toBeInTheDocument();
  });

  describe('render every row', () => {
    const load = async (): Promise<void> => {
      render(<DataFillSection fields={[field('name')]} />);
      pick(fileOf('name\nAda\nGrace\n', 'rows.csv'));
      await screen.findByText(/Row 1 of 2/);
    };

    it('offers a render for every row of the table', async () => {
      await load();
      expect(screen.getByRole('button', { name: 'Render 2 files' })).toBeEnabled();
    });

    it('previews what row 1 will be called, so a bad pattern is visible before the batch', async () => {
      await load();
      expect(screen.getByText(/Row 1 →/)).toBeInTheDocument();
    });

    it('refuses a pattern that does not vary, which would leave one file', async () => {
      await load();
      fireEvent.change(screen.getByLabelText('File name pattern'), { target: { value: 'promo' } });

      expect(screen.getByText(/same for every row/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Render 2 files' })).toBeDisabled();
    });

    it('reports an unknown column instead of naming every file the same', async () => {
      await load();
      fireEvent.change(screen.getByLabelText('File name pattern'), { target: { value: '{nmae}' } });

      expect(screen.getByText(/is not a column/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Render 2 files' })).toBeDisabled();
    });

    it('runs the batch with the table, the fields and the chosen pattern', async () => {
      await load();
      fireEvent.click(screen.getByRole('button', { name: 'Render 2 files' }));

      await waitFor(() => expect(runEditorBatchRender).toHaveBeenCalled());
      const opts = runEditorBatchRender.mock.calls[0]?.[0] as unknown as {
        pattern: string; outputDir: string; table: { rows: unknown[] };
      };
      expect(opts.pattern).toBe('{index}');
      expect(opts.outputDir).toBe('/out');
      expect(opts.table.rows).toHaveLength(2);
    });

    it('says how many files it wrote', async () => {
      await load();
      fireEvent.click(screen.getByRole('button', { name: 'Render 2 files' }));

      await waitFor(() =>
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: 'Rendered 2 files' })),
      );
    });
  });

  it('warns when a row matched no field at all', async () => {
    applyDataRow.mockReturnValueOnce({ filled: [], skippedKind: [], failed: [] });
    render(<DataFillSection fields={[field('name')]} />);
    pick(fileOf('name\nAda\n', 'rows.csv'));
    await screen.findByText(/Row 1 of 1/);

    fireEvent.click(screen.getByText('Apply this row'));
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning' }));
    });
  });
});
