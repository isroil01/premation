import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AccountSection, formatRelative } from './AccountSection';
import { api, type AccountRecord, type SessionRecord } from '@core/api/client';
import { setSession } from '@core/api/session';
import { useModalStore } from '@stores/modalStore';

jest.mock('@core/api/client', () => {
  const actual = jest.requireActual('@core/api/client');
  return {
    ...actual,
    api: {
      updateProfile: jest.fn(),
      requestEmailChange: jest.fn(),
      confirmEmailChange: jest.fn(),
      resendEmailChange: jest.fn(),
      cancelEmailChange: jest.fn(),
      changePassword: jest.fn(),
      setPassword: jest.fn(),
      requestAccountDeletion: jest.fn(),
      confirmAccountDeletion: jest.fn(),
      listSessions: jest.fn(),
      revokeSession: jest.fn(),
      getBilling: jest.fn(),
      logout: jest.fn(),
    },
  };
});

jest.mock('@core/api/session', () => ({ setSession: jest.fn().mockResolvedValue(undefined) }));

const authActions = { logout: jest.fn(), adoptSession: jest.fn().mockResolvedValue(undefined) };
jest.mock('@stores/authStore', () => ({
  useAuthStore: { getState: () => authActions, setState: jest.fn() },
}));

const notify = jest.fn();
jest.mock('@stores/uiStore', () => ({ useUIStore: { getState: () => ({ notify }) } }));

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

/** Renders the modal stack's bodies the way ModalHost would, without Radix. */
function ModalStack(): JSX.Element {
  const stack = useModalStore((s) => s.stack);
  const close = useModalStore((s) => s.close);
  return (
    <>
      {stack.map((m) => (
        <div key={m.id} role="dialog" aria-label={typeof m.title === 'string' ? m.title : undefined}>
          {m.render(() => {
            m.onClose?.();
            close(m.id);
          })}
        </div>
      ))}
    </>
  );
}

const account = (over: Partial<AccountRecord> = {}): AccountRecord =>
  ({
    id: 'u1',
    email: 'ann@example.com',
    name: 'Ann',
    role: 'user',
    plan: 'free',
    access: { read: true, write: true, reason: 'free', daysRemaining: null, writeEndsAt: null },
    emailVerified: true,
    needsSignupSource: false,
    signupSource: null,
    trialEndsAt: null,
    storageBytes: 0,
    assetCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    hasPassword: true,
    pendingEmail: null,
    ...over,
  }) as AccountRecord;

const sessions: SessionRecord[] = [
  { id: 's1', family: 'f1', device: 'Windows · Premation', ip: '10.0.0.1', lastUsedAt: new Date().toISOString(), createdAt: '', expiresAt: '', current: true },
  { id: 's2', family: 'f2', device: 'macOS · Premation', ip: '10.0.0.2', lastUsedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), createdAt: '', expiresAt: '' },
  { id: 's3', family: 'f3', device: null, ip: null, lastUsedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), createdAt: '', expiresAt: '' },
];

const onAccountChanged = jest.fn();
const onOpenBilling = jest.fn();

function renderSection(acc: AccountRecord = account()): void {
  render(
    <MemoryRouter>
      <AccountSection account={acc} onAccountChanged={onAccountChanged} onOpenBilling={onOpenBilling} />
      <ModalStack />
    </MemoryRouter>,
  );
}

const dialog = (): HTMLElement => screen.getByRole('dialog');

describe('AccountSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useModalStore.setState({ stack: [] });
    jest.mocked(api.listSessions).mockResolvedValue(sessions);
    jest.mocked(api.revokeSession).mockResolvedValue({ revoked: 1 });
    jest.mocked(api.getBilling).mockResolvedValue({ hasSubscription: false } as never);
  });

  it('renders the rows from the account and the devices from the server', async () => {
    renderSection();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Ann');
    expect(screen.getByText('ann@example.com')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Change…' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Delete account…' })).toBeInTheDocument();

    expect(await screen.findByText('Windows · Premation')).toBeInTheDocument();
    expect(screen.getByText('This device')).toBeInTheDocument();
    expect(screen.getByText('Unknown device')).toBeInTheDocument();
    expect(screen.getByText(/10\.0\.0\.2 · 3 h ago/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out of all other devices' })).toBeInTheDocument();
  });

  it('saves the name on Enter and reports it', async () => {
    jest.mocked(api.updateProfile).mockResolvedValue(account({ name: 'Ann B' }));
    renderSection();
    const name = screen.getByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: ' Ann B ' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    fireEvent.blur(name);
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith('Ann B'));
    await waitFor(() => expect(onAccountChanged).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'success' }));
  });

  it('changes the email: request with the current password, then confirm with the typed code', async () => {
    jest.mocked(api.requestEmailChange).mockResolvedValue({ pendingEmail: 'new@example.com', sent: true });
    jest.mocked(api.confirmEmailChange).mockResolvedValue({ email: 'new@example.com' });
    renderSection();

    fireEvent.click(screen.getAllByRole('button', { name: 'Change…' })[0]!);
    const d = dialog();
    expect(within(d).getByLabelText('Current password')).toBeInTheDocument();
    fireEvent.change(within(d).getByLabelText('New email'), { target: { value: 'new@example.com' } });
    fireEvent.change(within(d).getByLabelText('Current password'), { target: { value: 'hunter22' } });
    fireEvent.click(within(d).getByRole('button', { name: 'Send code' }));
    await waitFor(() => expect(api.requestEmailChange).toHaveBeenCalledWith('new@example.com', 'hunter22'));

    expect(await within(d).findByText(/code we sent to new@example.com/)).toBeInTheDocument();
    const confirm = within(d).getByRole('button', { name: 'Confirm new email' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(d).getByLabelText('Code'), { target: { value: '123456' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(api.confirmEmailChange).toHaveBeenCalledWith('123456'));
    await waitFor(() => expect(useModalStore.getState().stack).toHaveLength(0));
    expect(onAccountChanged).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'success', message: expect.stringContaining('new@example.com') }));
  });

  it('shows the server error inside the dialog and stays open', async () => {
    jest.mocked(api.requestEmailChange).mockRejectedValue(Object.assign(new Error('HTTP 400'), { body: { code: 'email_taken', message: 'That email is already in use.' } }));
    renderSection();
    fireEvent.click(screen.getAllByRole('button', { name: 'Change…' })[0]!);
    const d = dialog();
    fireEvent.change(within(d).getByLabelText('New email'), { target: { value: 'taken@example.com' } });
    fireEvent.change(within(d).getByLabelText('Current password'), { target: { value: 'pw' } });
    fireEvent.click(within(d).getByRole('button', { name: 'Send code' }));
    expect(await within(d).findByRole('alert')).toHaveTextContent('That email is already in use.');
    expect(useModalStore.getState().stack).toHaveLength(1);
  });

  it('offers Enter code / Resend / Cancel while a change is pending, and no password field for a Google-only account', async () => {
    jest.mocked(api.cancelEmailChange).mockResolvedValue({ ok: true });
    renderSection(account({ pendingEmail: 'next@example.com', hasPassword: false }));
    expect(screen.getByText('Pending: next@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change…' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel change' }));
    await waitFor(() => expect(api.cancelEmailChange).toHaveBeenCalled());
    expect(onAccountChanged).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Enter code' }));
    expect(within(dialog()).getByLabelText('Code')).toBeInTheDocument();
    expect(within(dialog()).queryByLabelText('Current password')).not.toBeInTheDocument();
  });

  it('shows "Set a password" when the account has none and adopts the returned session', async () => {
    const result = { token: 't', refreshToken: 'r', user: { id: 'u1', email: 'ann@example.com' } };
    jest.mocked(api.setPassword).mockResolvedValue(result as never);
    renderSection(account({ hasPassword: false }));
    expect(screen.getByText('No password — you sign in with Google.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set a password' }));

    const d = dialog();
    expect(within(d).queryByLabelText('Current password')).not.toBeInTheDocument();
    const submit = within(d).getByRole('button', { name: 'Set password' });
    fireEvent.change(within(d).getByLabelText('New password'), { target: { value: 'short' } });
    fireEvent.change(within(d).getByLabelText('Confirm new password'), { target: { value: 'short' } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(d).getByLabelText('New password'), { target: { value: 'longer12' } });
    expect(within(d).getByText('Passwords do not match.')).toBeInTheDocument();
    fireEvent.change(within(d).getByLabelText('Confirm new password'), { target: { value: 'longer12' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(api.setPassword).toHaveBeenCalledWith('longer12'));
    await waitFor(() => expect(setSession).toHaveBeenCalledWith(result));
    expect(authActions.adoptSession).toHaveBeenCalledWith(result.user);
    await waitFor(() => expect(useModalStore.getState().stack).toHaveLength(0));
  });

  it('changes the password with the current one', async () => {
    const result = { token: 't', refreshToken: 'r', user: { id: 'u1', email: 'ann@example.com' } };
    jest.mocked(api.changePassword).mockResolvedValue(result as never);
    renderSection();
    fireEvent.click(screen.getAllByRole('button', { name: 'Change…' })[1]!);
    const d = dialog();
    fireEvent.change(within(d).getByLabelText('Current password'), { target: { value: 'old12345' } });
    fireEvent.change(within(d).getByLabelText('New password'), { target: { value: 'new12345' } });
    fireEvent.change(within(d).getByLabelText('Confirm new password'), { target: { value: 'new12345' } });
    fireEvent.click(within(d).getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(api.changePassword).toHaveBeenCalledWith('old12345', 'new12345'));
    await waitFor(() => expect(setSession).toHaveBeenCalledWith(result));
  });

  it('signs out one device, and every other device at once', async () => {
    renderSection();
    await screen.findByText('macOS · Premation');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out macOS · Premation' }));
    await waitFor(() => expect(api.revokeSession).toHaveBeenCalledWith('s2'));

    const all = screen.getByRole('button', { name: 'Sign out of all other devices' });
    await waitFor(() => expect(all).toBeEnabled());
    jest.mocked(api.revokeSession).mockClear();
    fireEvent.click(all);
    await waitFor(() => expect(api.revokeSession).toHaveBeenCalledTimes(2));
    expect(api.revokeSession).toHaveBeenCalledWith('s2');
    expect(api.revokeSession).toHaveBeenCalledWith('s3');
    expect(api.revokeSession).not.toHaveBeenCalledWith('s1');
  });

  describe('delete account', () => {
    it('warns about a lost refund and links to Billing when one is still available', async () => {
      jest.mocked(api.getBilling).mockResolvedValue({
        hasSubscription: true,
        refund: { eligible: true, deadline: null, amountLabel: '$90.00', reason: null },
      } as never);
      renderSection();
      fireEvent.click(screen.getByRole('button', { name: 'Delete account…' }));
      const link = await within(dialog()).findByRole('button', { name: 'go to Billing first' });
      fireEvent.click(link);
      expect(onOpenBilling).toHaveBeenCalled();
      expect(useModalStore.getState().stack).toHaveLength(0);
    });

    it('states the no-refund consequence for a subscriber past the window', async () => {
      jest.mocked(api.getBilling).mockResolvedValue({
        hasSubscription: true,
        refund: { eligible: false, deadline: null, amountLabel: null, reason: 'window_passed' },
      } as never);
      renderSection();
      fireEvent.click(screen.getByRole('button', { name: 'Delete account…' }));
      expect(await within(dialog()).findByText('Your subscription is cancelled with no refund.')).toBeInTheDocument();
    });

    it('keeps the red button disabled until the typed email matches, then deletes, logs out and leaves', async () => {
      jest.mocked(api.requestAccountDeletion).mockResolvedValue({ sent: true });
      jest.mocked(api.confirmAccountDeletion).mockResolvedValue({ deleted: true });
      renderSection();
      fireEvent.click(screen.getByRole('button', { name: 'Delete account…' }));
      const d = dialog();
      const next = await within(d).findByRole('button', { name: 'Send code and continue' });
      await waitFor(() => expect(next).toBeEnabled());
      fireEvent.click(next);
      await waitFor(() => expect(api.requestAccountDeletion).toHaveBeenCalled());

      const del = await within(d).findByRole('button', { name: 'Delete my account' });
      fireEvent.change(within(d).getByLabelText('Code'), { target: { value: '654321' } });
      fireEvent.change(within(d).getByLabelText('Current password'), { target: { value: 'hunter22' } });
      expect(del).toBeDisabled();
      fireEvent.change(within(d).getByLabelText(/Type ann@example.com to confirm/), { target: { value: 'ann@examp' } });
      expect(del).toBeDisabled();
      fireEvent.change(within(d).getByLabelText(/Type ann@example.com to confirm/), { target: { value: 'Ann@Example.com' } });
      expect(del).toBeEnabled();

      await act(async () => {
        fireEvent.click(del);
      });
      await waitFor(() => expect(api.confirmAccountDeletion).toHaveBeenCalledWith('654321', 'hunter22'));
      await waitFor(() => expect(authActions.logout).toHaveBeenCalled());
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  it.each([
    ['2026-10-06T11:59:50Z', 'just now'],
    ['2026-10-06T11:45:00Z', '15 min ago'],
    ['2026-10-06T07:00:00Z', '5 h ago'],
    ['2026-10-01T12:00:00Z', '5 d ago'],
    ['garbage', ''],
  ])('%s → %s', (iso, expected) => {
    expect(formatRelative(iso, now)).toBe(expected);
  });
});
