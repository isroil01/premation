import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ReadOnlyBanner } from './ReadOnlyBanner';
import { useEntitlementStore } from '@stores/entitlementStore';

jest.mock('@core/project/exportBundle', () => ({
  exportCurrentProjectAsBundle: jest.fn(async () => ({})),
}));

const trialEnded = {
  read: true,
  write: false,
  reason: 'trial_expired' as const,
  daysRemaining: 0,
  writeEndsAt: null,
};

function renderBanner(): void {
  render(
    <MemoryRouter>
      <ReadOnlyBanner />
    </MemoryRouter>,
  );
}

describe('ReadOnlyBanner', () => {
  afterEach(() => useEntitlementStore.getState().reset());

  it('offers Subscribe to a trial-ended account while sales are open', () => {
    useEntitlementStore.setState({ access: trialEnded, message: '', salesOpen: true });
    renderBanner();
    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeInTheDocument();
  });

  it('treats an unknown catalog (older server) as open', () => {
    useEntitlementStore.setState({ access: trialEnded, message: '', salesOpen: null });
    renderBanner();
    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeInTheDocument();
  });

  it('shows a calm paused sentence and no Subscribe button while sales are closed', () => {
    useEntitlementStore.setState({
      access: trialEnded,
      // An older server's sentence still says "subscribe"; the bar must not repeat it.
      message: 'Your trial has ended. You can export them, or subscribe to keep working in the cloud.',
      salesOpen: false,
    });
    renderBanner();
    expect(screen.queryByRole('button', { name: 'Subscribe' })).not.toBeInTheDocument();
    expect(screen.getByText(/Premation Cloud subscriptions are paused/)).toBeInTheDocument();
    expect(screen.getByText(/export keeps working/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export .motion' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View plan' })).toBeInTheDocument();
  });

  it('keeps a server sentence that already avoids "subscribe"', () => {
    const sentence =
      'Your 5 months trial has ended. Pro subscriptions are paused for now — your projects stay available read-only, and export keeps working.';
    useEntitlementStore.setState({ access: trialEnded, message: sentence, salesOpen: false });
    renderBanner();
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });
});

describe('ReadOnlyBanner — project past the Free allowance', () => {
  afterEach(() => useEntitlementStore.getState().reset());

  const freeAccess = {
    read: true,
    write: true,
    reason: 'free' as const,
    daysRemaining: null,
    writeEndsAt: null,
  };
  const sentence =
    "This project is past the Free plan's 5 cloud projects, so it is read-only. Upgrade to Premation Cloud, or use Save As to keep working on it as a local file.";

  it('stays hidden for a free account whose open project is inside the allowance', () => {
    useEntitlementStore.setState({ access: freeAccess, projectLimit: null, salesOpen: true });
    renderBanner();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says why and offers Upgrade and export when the open project is past it', () => {
    useEntitlementStore.setState({ access: freeAccess, projectLimit: sentence, salesOpen: true });
    renderBanner();
    expect(screen.getByText(sentence)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export .motion' })).toBeInTheDocument();
  });

  it('does not point at a closed checkout while sales are paused', () => {
    useEntitlementStore.setState({ access: freeAccess, projectLimit: sentence, salesOpen: false });
    renderBanner();
    expect(screen.queryByRole('button', { name: 'Upgrade' })).not.toBeInTheDocument();
    expect(screen.getByText(/subscriptions are paused/)).toBeInTheDocument();
  });
});
