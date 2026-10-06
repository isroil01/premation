import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthPage } from '../AuthPage';
import { useAuthStore } from '@stores/authStore';

function renderAuthPage(mode: 'login' | 'register' | 'forgot' | 'reset', initialEntries = ['/login']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthPage mode={mode} />
    </MemoryRouter>,
  );
}

describe('AuthPage UI & UX', () => {
  beforeEach(() => {
    useAuthStore.setState({
      status: 'idle',
      user: null,
      error: null,
    });
  });

  it('renders the sign-in screen with one way to switch to sign-up', () => {
    renderAuthPage('login');
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    // The Sign In / Create Account tabs are gone; the link under the form is the switch.
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute('href', '/register');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('renders the create-account screen with a Name field', () => {
    renderAuthPage('register', ['/register']);
    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('never offers GitHub: Google is the only provider', () => {
    renderAuthPage('login');
    expect(screen.queryByText(/GitHub/i)).not.toBeInTheDocument();
  });

  it('shows the password rules before anything is typed, on sign-up and on reset', () => {
    const { unmount } = renderAuthPage('register', ['/register']);
    expect(screen.getByText('8 or more characters')).toBeInTheDocument();
    expect(screen.getByText('A letter and a number')).toBeInTheDocument();
    unmount();

    renderAuthPage('reset', ['/reset-password?token=abc']);
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
    expect(screen.getByText('8 or more characters')).toBeInTheDocument();
  });

  it('does not show the password rules on sign-in', () => {
    renderAuthPage('login');
    expect(screen.queryByText('8 or more characters')).not.toBeInTheDocument();
  });

  it('toggles password visibility with a keyboard-reachable Show button', () => {
    renderAuthPage('login');
    const pwdInput = screen.getByLabelText('Password') as HTMLInputElement;
    expect(pwdInput.type).toBe('password');

    const toggleBtn = screen.getByRole('button', { name: /Show password/i });
    expect(toggleBtn).not.toHaveAttribute('tabindex', '-1');
    fireEvent.click(toggleBtn);
    expect(pwdInput.type).toBe('text');

    const hideBtn = screen.getByRole('button', { name: /Hide password/i });
    fireEvent.click(hideBtn);
    expect(pwdInput.type).toBe('password');
  });

  it('displays error alert when store reports an error', () => {
    useAuthStore.setState({ error: 'Invalid credentials provided.' });
    renderAuthPage('login');
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid credentials provided.');
  });
});
