import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WelcomePage } from '../WelcomePage';
import { useAuthStore, type AuthUser } from '@stores/authStore';
import { api } from '@core/api/client';

jest.mock('@core/api/client', () => ({
  api: { setSignupSource: jest.fn() },
}));

const setSignupSource = api.setSignupSource as jest.MockedFunction<typeof api.setSignupSource>;

const VERIFIED_UNANSWERED: AuthUser = {
  id: 'u1',
  email: 'a@b.com',
  name: 'Ada Lovelace',
  role: 'user',
  emailVerified: true,
  needsSignupSource: true,
};

function renderWelcome(user: AuthUser | null = VERIFIED_UNANSWERED) {
  useAuthStore.setState({
    status: user ? 'authenticated' : 'idle',
    user,
    error: null,
  });
  return render(
    <MemoryRouter initialEntries={['/welcome']}>
      <Routes>
        <Route path="/welcome" element={<WelcomePage />} />
        <Route path="/dashboard" element={<p>dashboard</p>} />
        <Route path="/verify-email" element={<p>verify</p>} />
        <Route path="/login" element={<p>login</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setSignupSource.mockReset();
  setSignupSource.mockResolvedValue({ signupSource: 'google' });
});

describe('the welcome question', () => {
  it('offers every channel, with the escape hatch last', () => {
    renderWelcome();

    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(8);
    // Last by construction: an escape hatch offered early is the one everyone
    // takes, and "other" answers are the ones that cannot be counted.
    expect(options[options.length - 1]).toHaveAttribute('value', 'other');
  });

  it('cannot be submitted until something is chosen — this question is required', () => {
    renderWelcome();

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('sends a preset answer with no write-in beside it', async () => {
    renderWelcome();

    fireEvent.click(screen.getByRole('radio', { name: /Google/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // `undefined`, not an empty string: the server refuses free text attached to
    // a counted channel, because that is how a closed set quietly reopens.
    await waitFor(() => expect(setSignupSource).toHaveBeenCalledWith('google', undefined));
  });

  it('asks for the detail when the answer is "something else", and holds until it has it', async () => {
    renderWelcome();

    fireEvent.click(screen.getByRole('radio', { name: /Something else/ }));

    const field = screen.getByLabelText('Where was that?');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    fireEvent.change(field, { target: { value: '  a podcast ad  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Trimmed here so the server is never asked to store the user's whitespace.
    await waitFor(() => expect(setSignupSource).toHaveBeenCalledWith('other', 'a podcast ad'));
  });

  it('drops the write-in when the user changes their mind back to a preset', async () => {
    renderWelcome();

    fireEvent.click(screen.getByRole('radio', { name: /Something else/ }));
    fireEvent.change(screen.getByLabelText('Where was that?'), { target: { value: 'a podcast' } });
    fireEvent.click(screen.getByRole('radio', { name: /YouTube/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Stale prose travelling with a preset answer is exactly what the server
    // rejects, so it must not survive the change of mind.
    await waitFor(() => expect(setSignupSource).toHaveBeenCalledWith('youtube', undefined));
  });

  it('takes the question down once answered, without re-reading /auth/me', async () => {
    renderWelcome();

    fireEvent.click(screen.getByRole('radio', { name: /friend or colleague/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByText('dashboard');
    expect(useAuthStore.getState().user?.needsSignupSource).toBe(false);
  });

  it('keeps the user on the question when the save fails', async () => {
    setSignupSource.mockRejectedValue(new Error('offline'));
    renderWelcome();

    fireEvent.click(screen.getByRole('radio', { name: /Google/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(screen.queryByText('dashboard')).not.toBeInTheDocument();
    // Re-armed rather than stuck: a failed save the user cannot retry is worse
    // than the failure.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });
});

describe('who the welcome question is for', () => {
  it('sends an unverified account back to the code screen', async () => {
    renderWelcome({ ...VERIFIED_UNANSWERED, emailVerified: false });

    expect(await screen.findByText('verify')).toBeInTheDocument();
  });

  it('does not linger once the answer is in', async () => {
    renderWelcome({ ...VERIFIED_UNANSWERED, needsSignupSource: false });

    expect(await screen.findByText('dashboard')).toBeInTheDocument();
  });

  it('sends a signed-out visitor to sign in', async () => {
    renderWelcome(null);

    expect(await screen.findByText('login')).toBeInTheDocument();
  });
});
