import { fireEvent, render, screen } from '@testing-library/react';
import { PlanCard, planStatusLabel } from './PlanCard';
import { api, type AccountRecord, type PlanDto } from '@core/api/client';

jest.mock('@core/api/client', () => {
  const actual = jest.requireActual('@core/api/client');
  return { ...actual, api: { listPlans: jest.fn() } };
});

const plans: PlanDto[] = [
  { id: 'free', name: 'Free', priceCents: 0, priceLabel: 'Free', currency: 'usd', limits: { cloudProjects: 5, historyDays: 7 }, features: [] },
  { id: 'pro', name: 'Premation Cloud', priceCents: 900, priceLabel: '$9', currency: 'usd', limits: { cloudProjects: null, historyDays: 90 }, features: [] },
];

const account = (over: Partial<AccountRecord> = {}): AccountRecord =>
  ({
    id: 'u1',
    email: 'a@b.c',
    name: 'A',
    role: 'user',
    plan: 'free',
    access: {
      read: true, write: true, reason: 'free', daysRemaining: null, writeEndsAt: null,
      limits: { cloudProjects: 5, historyDays: 7 },
    },
    emailVerified: true,
    needsSignupSource: false,
    signupSource: null,
    trialEndsAt: null,
    storageBytes: 0,
    assetCount: 0,
    projectCount: 4,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  }) as AccountRecord;

describe('PlanCard', () => {
  beforeEach(() => {
    jest.mocked(api.listPlans).mockResolvedValue(plans);
  });

  it('shows a Free account its usage and an upgrade into Billing', async () => {
    const onOpenBilling = jest.fn();
    render(<PlanCard account={account()} onOpenBilling={onOpenBilling} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade · $9/mo' }));
    expect(onOpenBilling).toHaveBeenCalled();
    expect(screen.getByRole('progressbar', { name: 'Cloud projects used' })).toHaveAttribute('aria-valuenow', '4');
    expect(screen.getByText('1 cloud project left on your plan.')).toBeInTheDocument();
  });

  it('shows a subscriber their plan, unlimited, and Manage plan', async () => {
    render(
      <PlanCard
        account={account({
          plan: 'pro',
          projectCount: 40,
          access: {
            read: true, write: true, reason: 'active', daysRemaining: 20, writeEndsAt: '2026-11-01T00:00:00.000Z',
            limits: { cloudProjects: null, historyDays: 90 },
          },
        })}
        onOpenBilling={() => {}}
      />,
    );
    expect(await screen.findByRole('button', { name: 'Manage plan' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Upgrade/ })).not.toBeInTheDocument();
    expect(screen.getByText('Premation Cloud')).toBeInTheDocument();
    expect(screen.getByText('· unlimited')).toBeInTheDocument();
  });

  it('offers no upgrade while sales are closed', async () => {
    jest.mocked(api.listPlans).mockResolvedValue([plans[0]!, { ...plans[1]!, purchasable: false }]);
    render(<PlanCard account={account()} onOpenBilling={() => {}} />);
    expect(await screen.findByRole('button', { name: 'View plans' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Upgrade/ })).not.toBeInTheDocument();
  });

  it('labels the plan from the server reason', () => {
    expect(planStatusLabel(account()).text).toBe('Free');
    expect(planStatusLabel(account({ access: { ...account().access, reason: 'beta' } })).text).toBe('Free during beta');
  });
});
