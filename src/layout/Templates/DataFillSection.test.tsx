/**
 * The batch-fill panel.
 *
 * Its logic is thin on purpose — parsing and coercion are unit-tested in
 * `dataTable.test.ts` / `dataFill.test.ts`. What is only testable HERE is the
 * wiring: that a bad file reports next to the picker instead of vanishing into
 * a toast, that stepping rows applies the row you are looking at, and that a
 * field with no column gets a warning rather than silently keeping its authored
 * value on every row.
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

  it('says the batch render is not built rather than implying it is', async () => {
    render(<DataFillSection fields={[field('name')]} />);
    pick(fileOf('name\nAda\n', 'rows.csv'));

    expect(await screen.findByText(/isn’t built yet/)).toBeInTheDocument();
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
