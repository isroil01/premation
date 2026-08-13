/**
 * The report dialog.
 *
 * Everything asserted here is about a person who is already annoyed and may
 * abandon the flow at any point. The failures worth catching are not crashes —
 * they are the quiet ones where the dialog looks like it worked:
 *
 *   • Thanking someone for a report that never left the machine.
 *   • Filing a second copy because the dialog reopened holding the first.
 *   • Sending a report with no category, which lands in the queue untriageable.
 *   • Naming the reporter to the publisher they just accused.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@components/Tooltip';
import { ReportPluginDialog } from './ReportPluginDialog';
import { reportPlugin } from '@core/plugins/registry';

jest.mock('@core/plugins/registry', () => ({
  reportPlugin: jest.fn(),
}));

const mockReport = reportPlugin as jest.MockedFunction<typeof reportPlugin>;

/**
 * jsdom has no ResizeObserver, and Radix's dialog constructs one on mount.
 *
 * Without it every render throws before a single assertion runs — which reads
 * as "the dialog is broken" rather than "the test environment is missing a
 * browser API", and is a false alarm each of these tests would otherwise raise.
 */
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});

beforeEach(() => {
  mockReport.mockReset();
  mockReport.mockResolvedValue({ caseId: 'case_1', reportCount: 1 });
});

// The Modal renders a Radix dialog whose header uses Tooltip, which needs the
// provider the app mounts at its root. Without it every render here throws
// before a single assertion runs.
const show = (props: Partial<Parameters<typeof ReportPluginDialog>[0]> = {}) =>
  render(
    <TooltipProvider>
      <ReportPluginDialog
        pluginId="studio.acme.thing"
        pluginName="Easing Lab"
        open
        onClose={props.onClose ?? jest.fn()}
        {...props}
      />
    </TooltipProvider>,
  );

describe('sending a report', () => {
  it('will not send without a category', async () => {
    // A report with no category is one a reviewer cannot triage — it sits in
    // the queue behind everything that said what it was about.
    show();

    expect(screen.getByRole('button', { name: 'Send report' })).toBeDisabled();
  });

  it('sends the category, the version and the message', async () => {
    show({ version: '2.1.0' });

    fireEvent.click(screen.getByRole('radio', { name: /Malicious behaviour/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'It uploaded my project.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));

    await waitFor(() =>
      expect(mockReport).toHaveBeenCalledWith('studio.acme.thing', {
        category: 'malicious',
        version: '2.1.0',
        message: 'It uploaded my project.',
      }),
    );
  });

  it('omits an empty message rather than sending whitespace', async () => {
    // A message of "   " is not a message, and storing one makes the queue
    // show an empty quote where a reviewer expects detail.
    show();

    fireEvent.click(screen.getByRole('radio', { name: /Broken or abandoned/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));

    await waitFor(() =>
      expect(mockReport).toHaveBeenCalledWith('studio.acme.thing', { category: 'broken' }),
    );
  });

  it('omits the version when the reporter has not installed it', async () => {
    // Reporting from a browse listing. Sending a version they do not have
    // would open a case against a build they never ran.
    show();

    fireEvent.click(screen.getByRole('radio', { name: /Impersonation/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));

    await waitFor(() =>
      expect(mockReport).toHaveBeenCalledWith('studio.acme.thing', { category: 'impersonation' }),
    );
  });
});

describe('when it fails', () => {
  it('★ says so, and does not thank them', async () => {
    /*
      The single most important assertion in this file. A reporter told "thank
      you" for a report that never arrived has been actively misled — they stop
      worrying about the plugin, and they do not try again. Silence would be
      better than a false confirmation, and both are worse than the error.
    */
    mockReport.mockRejectedValue(new Error('Too many reports from this account in the last hour.'));
    show();

    fireEvent.click(screen.getByRole('radio', { name: /Malicious behaviour/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many reports/);
    expect(screen.queryByText(/Thank you/)).not.toBeInTheDocument();
  });

  it('lets them try again rather than trapping them on the error', async () => {
    mockReport.mockRejectedValueOnce(new Error('Network error'));
    show();

    fireEvent.click(screen.getByRole('radio', { name: /Malicious behaviour/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));

    await waitFor(() => expect(screen.getByText(/Thank you/)).toBeInTheDocument());
  });
});

describe('after it is sent', () => {
  it('confirms, and promises nothing it cannot keep', async () => {
    /*
      No case id, no queue position, no "we will email you". Each of those is a
      promise about a human process, and one the registry cannot keep is worse
      than saying nothing at all.
    */
    show();

    fireEvent.click(screen.getByRole('radio', { name: /Malicious behaviour/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));

    expect(await screen.findByText(/Thank you/)).toBeInTheDocument();
    expect(screen.queryByText(/case_1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/email/i)).not.toBeInTheDocument();
  });

  it('★ does not reopen holding the last report', async () => {
    /*
      A dialog that kept its state would let a mis-click file a second identical
      report — inflating the very count a reviewer reads as consensus, from one
      person.
    */
    const onClose = jest.fn();
    const { rerender } = show({ onClose });

    fireEvent.click(screen.getByRole('radio', { name: /Malicious behaviour/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await screen.findByText(/Thank you/);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onClose).toHaveBeenCalled();

    rerender(
      <TooltipProvider>
        <ReportPluginDialog
          pluginId="studio.acme.thing"
          pluginName="Easing Lab"
          open
          onClose={onClose}
        />
      </TooltipProvider>,
    );

    expect(screen.queryByText(/Thank you/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send report' })).toBeDisabled();
  });
});

describe('what the reporter is told', () => {
  it('★ says the publisher will not learn who reported them', async () => {
    /*
      A reporter's first worry is retaliation — and it is a rational one, since
      they are often reporting someone whose software they still have to use.
      Left unsaid, the safe assumption is that the accused finds out, and the
      report does not get filed.
    */
    show();

    expect(screen.getByText(/publisher is not told who reported/i)).toBeInTheDocument();
  });

  it('names the version the report is about', async () => {
    show({ version: '2.1.0' });

    expect(screen.getByText(/version 2\.1\.0/)).toBeInTheDocument();
  });

  it('offers every category with a plain-language explanation', () => {
    // Five radios, each with a hint. A category list that degrades to bare keys
    // is one people pick the first item from.
    show();

    for (const label of [
      /Malicious behaviour/,
      /Impersonation/,
      /Broken or abandoned/,
      /Inappropriate content/,
      /License violation/,
    ]) {
      expect(screen.getByRole('radio', { name: label })).toBeInTheDocument();
    }
  });
});
