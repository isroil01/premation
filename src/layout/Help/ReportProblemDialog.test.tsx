/**
 * The dialog's whole cycle: refuses an empty report inline, sends a filled
 * one as multipart, and ends on the report's number.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const request = jest.fn();
jest.mock('@core/api/transport', () => ({
  ...jest.requireActual('@core/api/transport'),
  request: (...args: unknown[]) => request(...args),
}));

import { ReportProblemBody } from './ReportProblemDialog';
import { buildHelpCommands, HELP_REPORT_PROBLEM_COMMAND } from './helpCommands';

beforeEach(() => request.mockReset());

describe('Report a Problem', () => {
  it('shows what is wrong instead of sending an empty report', async () => {
    render(<ReportProblemBody initialShot={null} close={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByText('A few words, so we can find it again.')).toBeInTheDocument();
    expect(screen.getByText('Tell us what went wrong.')).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });

  it('sends the report and shows its number', async () => {
    request.mockResolvedValue({ id: 'r1', number: 'PR-42', status: 'new', attachments: 0 });
    const close = jest.fn();
    render(<ReportProblemBody initialShot={null} close={close} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Export' }));
    fireEvent.change(screen.getByPlaceholderText(/Viewer goes black/), { target: { value: 'Export stalls at 99%' } });
    fireEvent.change(screen.getByPlaceholderText(/What you saw/), { target: { value: 'ProRes export never finishes.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));

    expect(await screen.findByText('PR-42')).toBeInTheDocument();
    const [path, init] = request.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/problem-reports');
    const payload = JSON.parse(String((init.body as FormData).get('payload')));
    expect(payload).toMatchObject({ category: 'export', summary: 'Export stalls at 99%', includeProject: false });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(close).toHaveBeenCalled();
  });

  it('keeps the draft and explains a rate limit', async () => {
    request.mockRejectedValue(Object.assign(new Error('Too many'), { status: 429 }));
    render(<ReportProblemBody initialShot={null} close={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/Viewer goes black/), { target: { value: 'Crash on save' } });
    fireEvent.change(screen.getByPlaceholderText(/What you saw/), { target: { value: 'It closes.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Too many reports/));
    expect(screen.getByDisplayValue('Crash on save')).toBeInTheDocument();
  });

  it('is a Help command', () => {
    expect(buildHelpCommands().some((c) => c.id === HELP_REPORT_PROBLEM_COMMAND)).toBe(true);
  });
});
