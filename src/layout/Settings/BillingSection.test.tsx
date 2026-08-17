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
