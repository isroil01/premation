import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BillingSection, checkoutReturnState } from './BillingSection';
import { api, type BillingSummary, type PlanDto } from '@core/api/client';

jest.mock('@core/config/edition', () => ({ billingEnabled: () => true }));
jest.mock('@core/api/client', () => {
  const actual = jest.requireActual('@core/api/client');
  return {
    ...actual,
    isAuthenticated: () => true,
    api: {
      getBilling: jest.fn(),
      listPlans: jest.fn(),
      resyncBilling: jest.fn(),
      startCheckout: jest.fn(),
      openBillingPortal: jest.fn(),
      cancelSubscription: jest.fn(),
      resumeSubscription: jest.fn(),
      resendVerification: jest.fn(),
    },
  };
});

const plans: PlanDto[] = [
  { id: 'free', name: 'Free', priceCents: 0, priceLabel: '$0', currency: 'usd', features: ['Editor'] },
  { id: 'pro', name: 'Pro', priceCents: 1900, priceLabel: '$19', currency: 'usd', features: ['Editor', 'Automation API'] },
];

const summary = (over: Partial<BillingSummary> = {}): BillingSummary => ({
  plan: plans[0]!,
  access: { read: true, write: true, reason: 'trial', daysRemaining: 5, writeEndsAt: null },
  statusMessage: 'Free trial — 5 days left.',
  emailVerified: true,
  trialEndsAt: null,
  trialDays: 14,
  subscriptionStatus: null,
  currentPeriodEnd: null,
  hasSubscription: false,
  memberSince: '2026-08-01T00:00:00.000Z',
  paymentsEnabled: true,
  ...over,
});

describe('BillingSection', () => {
  beforeEach(() => {
    jest.mocked(api.getBilling).mockResolvedValue(summary());
    jest.mocked(api.listPlans).mockResolvedValue(plans);
    jest.mocked(api.resyncBilling).mockResolvedValue({ resynced: false });
  });

  it('renders the server plan comparison and keeps resync visible before the webhook arrives', async () => {
    render(<MemoryRouter><BillingSection /></MemoryRouter>);

    expect(await screen.findByText('Compare plans')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Pro' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subscribe — $19/mo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Coming soon' })).not.toBeInTheDocument();
  });

  it('surfaces past-due grace and the current period end', async () => {
    jest.mocked(api.getBilling).mockResolvedValueOnce(
      summary({
        access: { read: true, write: true, reason: 'grace', daysRemaining: 3, writeEndsAt: '2026-08-20T00:00:00.000Z' },
        subscriptionStatus: 'past_due',
        currentPeriodEnd: '2026-08-20T00:00:00.000Z',
        hasSubscription: true,
      }),
    );
    render(<MemoryRouter><BillingSection /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Payment needs attention');
    await waitFor(() => expect(screen.getByText(/Current period ends/)).toBeInTheDocument());
  });

  describe('with Pro sales closed (purchasable: false)', () => {
    const closed: PlanDto[] = [plans[0]!, { ...plans[1]!, purchasable: false }];

    beforeEach(() => {
      jest.mocked(api.listPlans).mockResolvedValue(closed);
    });

    it('offers a trial user no Subscribe button, only a calm paused note', async () => {
      render(<MemoryRouter><BillingSection /></MemoryRouter>);
      expect(await screen.findByText('Pro subscriptions are paused')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Subscribe/ })).not.toBeInTheDocument();
      expect(screen.queryByText('Compare plans')).not.toBeInTheDocument();
    });

    it('tells a trial-ended user their work stays available and export works', async () => {
      jest.mocked(api.getBilling).mockResolvedValue(
        summary({
          access: { read: true, write: false, reason: 'trial_expired', daysRemaining: 0, writeEndsAt: null },
        }),
      );
      render(<MemoryRouter><BillingSection /></MemoryRouter>);
      expect(await screen.findByText(/stay available read-only, and export keeps working/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Subscribe|Upgrade/ })).not.toBeInTheDocument();
    });

    it('shows an existing Pro subscriber their plan and Manage billing as before', async () => {
      jest.mocked(api.getBilling).mockResolvedValue(
        summary({
          plan: closed[1]!,
          access: { read: true, write: true, reason: 'active', daysRemaining: 20, writeEndsAt: null },
          subscriptionStatus: 'active',
          hasSubscription: true,
        }),
      );
      render(<MemoryRouter><BillingSection /></MemoryRouter>);
      expect(await screen.findByText('Compare plans')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Manage payment method' })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Current plan' }).length).toBeGreaterThan(0);
      expect(screen.queryByText('Pro subscriptions are paused')).not.toBeInTheDocument();
    });
  });
});

describe('checkoutReturnState', () => {
  it.each([
    ['checkout=success', 'success'],
    ['payment=completed', 'success'],
    ['billing=cancelled', 'cancelled'],
    ['tab=settings', null],
  ])('reads %s', (query, expected) => {
    expect(checkoutReturnState(new URLSearchParams(query))).toBe(expected);
  });
});
