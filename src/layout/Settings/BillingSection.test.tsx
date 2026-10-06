import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BillingSection, checkoutReturnState, currentPlanLine, yearlyMonthsFree } from './BillingSection';
import { api, type BillingSummary, type PlanDto } from '@core/api/client';
import { useModalStore } from '@stores/modalStore';

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
      changeBillingInterval: jest.fn(),
      refundSubscription: jest.fn(),
    },
  };
});

/**
 * The dialogs open through `openModal`; this stands in for ModalHost so a
 * test can press their buttons without Radix's portal and focus trap.
 */
function DialogStack(): JSX.Element {
  const stack = useModalStore((s) => s.stack);
  const close = useModalStore((s) => s.close);
  return (
    <>
      {stack.map((m) => {
        const doClose = (): void => {
          m.onClose?.();
          close(m.id);
        };
        return (
          <div role="dialog" key={m.id}>
            {m.title}
            {m.render(doClose)}
            {m.footer?.(doClose)}
          </div>
        );
      })}
    </>
  );
}

const renderBilling = (): ReturnType<typeof render> =>
  render(
    <MemoryRouter>
      <BillingSection />
      <DialogStack />
    </MemoryRouter>,
  );

const fmt = (iso: string): string => new Date(iso).toLocaleDateString();

const plans: PlanDto[] = [
  { id: 'free', name: 'Free', priceCents: 0, priceLabel: '$0', currency: 'usd', features: ['Editor'] },
  { id: 'pro', name: 'Pro', priceCents: 1900, priceLabel: '$19', currency: 'usd', features: ['Editor', 'Automation API'] },
];

const summary = (over: Partial<BillingSummary> = {}): BillingSummary => ({
  plan: plans[0]!,
  access: { read: true, write: true, reason: 'free', daysRemaining: null, writeEndsAt: null },
  statusMessage: 'Free plan: 5 cloud projects and 7 days of history.',
  emailVerified: true,
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

  it('offers yearly billing when the server sells it, and checks out on the yearly variant', async () => {
    jest.mocked(api.listPlans).mockResolvedValue([
      plans[0]!,
      { ...plans[1]!, name: 'Premation Cloud', priceCents: 900, priceLabel: '$9', yearlyPriceLabel: '$90' },
    ]);
    jest.mocked(api.startCheckout).mockResolvedValue({ action: 'checkout' });
    render(<MemoryRouter><BillingSection /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Subscribe — $9/mo' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yearly' }));
    const yearly = screen.getByRole('button', { name: 'Subscribe — $90/yr' });
    fireEvent.click(yearly);
    await waitFor(() => expect(api.startCheckout).toHaveBeenCalledWith('pro', 'year'));
  });

  it('shows cloud project usage against the Free cap', async () => {
    jest.mocked(api.getBilling).mockResolvedValueOnce(summary({ cloudProjects: { used: 3, limit: 5 } }));
    render(<MemoryRouter><BillingSection /></MemoryRouter>);
    const meter = await screen.findByRole('progressbar', { name: 'Cloud projects used' });
    expect(meter).toHaveAttribute('aria-valuenow', '3');
    expect(meter).toHaveAttribute('aria-valuemax', '5');
    expect(screen.getByText('Free Plan')).toBeInTheDocument();
  });

  describe('with Pro sales closed (purchasable: false)', () => {
    const closed: PlanDto[] = [plans[0]!, { ...plans[1]!, purchasable: false }];

    beforeEach(() => {
      jest.mocked(api.listPlans).mockResolvedValue(closed);
    });

    it('offers a trial user no Subscribe button, only a calm paused note', async () => {
      render(<MemoryRouter><BillingSection /></MemoryRouter>);
      expect(await screen.findByText('Premation Cloud subscriptions are paused')).toBeInTheDocument();
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
      expect(screen.queryByText('Premation Cloud subscriptions are paused')).not.toBeInTheDocument();
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

describe('the Premation Cloud plans', () => {
  const cloudPlans: PlanDto[] = [
    {
      id: 'free', name: 'Free', priceCents: 0, priceLabel: 'Free', currency: 'usd',
      limits: { cloudProjects: 5, historyDays: 7 }, features: ['5 cloud projects'],
    },
    {
      id: 'pro', name: 'Premation Cloud', priceCents: 900, priceLabel: '$9', yearlyPriceCents: 9000,
      yearlyPriceLabel: '$90', currency: 'usd', limits: { cloudProjects: null, historyDays: 90 },
      features: ['Unlimited cloud projects'],
    },
  ];

  beforeEach(() => {
    jest.mocked(api.listPlans).mockResolvedValue(cloudPlans);
    jest.mocked(api.resyncBilling).mockResolvedValue({ resynced: false });
  });

  it('compares plans by their served limits, one row per limit', async () => {
    jest.mocked(api.getBilling).mockResolvedValue(
      summary({ plan: cloudPlans[0]!, cloudProjects: { used: 2, limit: 5 } }),
    );
    render(<MemoryRouter><BillingSection /></MemoryRouter>);
    const projectsRow = (await screen.findByRole('rowheader', { name: 'Cloud projects' })).closest('tr')!;
    expect(projectsRow).toHaveTextContent('5');
    expect(projectsRow).toHaveTextContent('Unlimited');
    expect(screen.getByRole('rowheader', { name: 'Version history' }).closest('tr')).toHaveTextContent('90 days');
  });

  it('offers the yearly price with its saving', async () => {
    jest.mocked(api.getBilling).mockResolvedValue(summary({ plan: cloudPlans[0]! }));
    render(<MemoryRouter><BillingSection /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Yearly · 2 months free' }));
    expect(screen.getByText('$7.50/month, billed yearly')).toBeInTheDocument();
  });

  it('shows usage and an upgrade when the Free allowance is full', async () => {
    jest.mocked(api.getBilling).mockResolvedValue(
      summary({
        plan: cloudPlans[0]!,
        access: {
          read: true, write: true, reason: 'free', daysRemaining: null, writeEndsAt: null,
          limits: { cloudProjects: 5, historyDays: 7 },
        },
        cloudProjects: { used: 7, limit: 5 },
      }),
    );
    render(<MemoryRouter><BillingSection /></MemoryRouter>);
    expect(await screen.findByText(/2 projects are past your plan and read-only/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Cloud projects used' })).toHaveAttribute('aria-valuenow', '5');
    expect(screen.getByRole('button', { name: 'Upgrade to Premation Cloud' })).toBeInTheDocument();
  });

  it('warns about the launch grace period before the Free limits apply', async () => {
    jest.mocked(api.getBilling).mockResolvedValue(
      summary({
        plan: cloudPlans[0]!,
        access: {
          read: true, write: true, reason: 'free', daysRemaining: null, writeEndsAt: null,
          limits: { cloudProjects: null, historyDays: 90 }, limitsFrom: '2026-10-22T00:00:00.000Z',
        },
        cloudProjects: { used: 8, limit: null },
      }),
    );
    render(<MemoryRouter><BillingSection /></MemoryRouter>);
    expect(await screen.findByText(/Free plan limits start on/)).toBeInTheDocument();
    expect(screen.getByText(/other 3 projects turn read-only/)).toBeInTheDocument();
  });
});

describe('subscription lifecycle', () => {
  const cloudPlans: PlanDto[] = [
    { id: 'free', name: 'Free', priceCents: 0, priceLabel: 'Free', currency: 'usd', features: [] },
    {
      id: 'pro', name: 'Premation Cloud', priceCents: 900, priceLabel: '$9', yearlyPriceCents: 9000,
      yearlyPriceLabel: '$90', currency: 'usd', features: [],
    },
  ];
  const renewsAt = '2027-03-12T00:00:00.000Z';
  const subscriber = (over: Partial<BillingSummary> = {}): BillingSummary =>
    summary({
      plan: cloudPlans[1]!,
      access: { read: true, write: true, reason: 'active', daysRemaining: 100, writeEndsAt: null },
      subscriptionStatus: 'active',
      currentPeriodEnd: renewsAt,
      hasSubscription: true,
      interval: 'year',
      renewsAt,
      endsAt: null,
      cancelAtPeriodEnd: false,
      refund: { eligible: false, deadline: null, amountLabel: null, reason: 'window_passed' },
      ...over,
    });

  beforeEach(() => {
    useModalStore.setState({ stack: [] });
    jest.mocked(api.cancelSubscription).mockClear();
    jest.mocked(api.refundSubscription).mockClear();
    jest.mocked(api.changeBillingInterval).mockClear();
    jest.mocked(api.listPlans).mockResolvedValue(cloudPlans);
    jest.mocked(api.cancelSubscription).mockResolvedValue({ action: 'cancelled' });
    jest.mocked(api.refundSubscription).mockResolvedValue({ action: 'refunded', amountLabel: '$90.00' });
    jest.mocked(api.changeBillingInterval).mockImplementation(async (interval) => ({ action: 'interval_changed', interval }));
  });

  it('reads the current plan line from the server interval and dates', () => {
    expect(currentPlanLine(subscriber())).toBe(`Premation Cloud \u00b7 Yearly \u00b7 renews ${fmt(renewsAt)}`);
    expect(
      currentPlanLine(subscriber({ cancelAtPeriodEnd: true, subscriptionCancelled: true, renewsAt: null, endsAt: renewsAt })),
    ).toBe(`Premation Cloud \u00b7 Yearly \u00b7 ends ${fmt(renewsAt)}`);
    // Older server: no interval or split dates, only currentPeriodEnd.
    expect(currentPlanLine(subscriber({ interval: undefined, renewsAt: undefined, endsAt: undefined }))).toBe(
      `Premation Cloud \u00b7 renews ${fmt(renewsAt)}`,
    );
    expect(currentPlanLine(summary())).toBeNull();
  });

  it('shows the plan line in the hero', async () => {
    jest.mocked(api.getBilling).mockResolvedValue(subscriber());
    renderBilling();
    expect(await screen.findByText(`Premation Cloud \u00b7 Yearly \u00b7 renews ${fmt(renewsAt)}`)).toBeInTheDocument();
  });

  it('switches a monthly subscriber to yearly after a confirm', async () => {
    jest.mocked(api.getBilling).mockResolvedValue(
      subscriber({ interval: 'month', refund: { eligible: false, deadline: null, amountLabel: null, reason: 'not_yearly' } }),
    );
    renderBilling();
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to yearly' }));
    expect(await screen.findByText(/charged the prorated difference now/)).toBeInTheDocument();
    expect(screen.getByText(/Premation Cloud becomes \$90\/year/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Switch to yearly' }).at(-1)!);
    await waitFor(() => expect(api.changeBillingInterval).toHaveBeenCalledWith('year'));
    expect(await screen.findByRole('status')).toHaveTextContent('Now billed yearly.');
  });

  it('offers "Switch to monthly" to a yearly subscriber and no switch without a yearly price', async () => {
    jest.mocked(api.getBilling).mockResolvedValue(subscriber());
    const { unmount } = renderBilling();
    expect(await screen.findByRole('button', { name: 'Switch to monthly' })).toBeInTheDocument();
    unmount();
    jest.mocked(api.listPlans).mockResolvedValue([cloudPlans[0]!, { ...cloudPlans[1]!, yearlyPriceLabel: null }]);
    renderBilling();
    expect(await screen.findByRole('button', { name: 'Cancel subscription' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch to (yearly|monthly)/ })).not.toBeInTheDocument();
  });

  it('offers refund-now and period-end when the yearly payment is refundable, and refunds', async () => {
    jest.mocked(api.getBilling)
      .mockResolvedValueOnce(
        subscriber({ refund: { eligible: true, deadline: '2026-10-20T00:00:00.000Z', amountLabel: '$90.00', reason: null } }),
      )
      .mockResolvedValue(
        summary({
          subscriptionStatus: 'cancelled',
          hasSubscription: true,
          subscriptionCancelled: true,
          cancelAtPeriodEnd: true,
          currentPeriodEnd: '2026-10-06T10:00:00.000Z',
          endsAt: '2026-10-06T10:00:00.000Z',
          refund: { eligible: false, deadline: null, amountLabel: '$90.00', reason: 'already_refunded' },
        }),
      );
    renderBilling();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel subscription' }));
    expect(await screen.findByText(/Refund available until/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Cancel at period end \u2014 keep access until ${fmt(renewsAt)}` })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel and refund $90.00 \u2014 access ends now' }));
    await waitFor(() => expect(api.refundSubscription).toHaveBeenCalled());
    expect(api.cancelSubscription).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent('Refunded $90.00. Your access to Premation Cloud has ended.');
    // Back on Free: no pending-cancellation badge, a refunded note instead.
    expect(screen.getByText('Free Plan')).toBeInTheDocument();
    expect(screen.queryByText('Cancellation Scheduled')).not.toBeInTheDocument();
    expect(screen.getByText(/Refunded on .* access to Premation Cloud has ended/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel subscription' })).not.toBeInTheDocument();
  });

  it('cancels at period end with the period-end choice', async () => {
    jest.mocked(api.getBilling).mockResolvedValue(
      subscriber({ refund: { eligible: true, deadline: '2026-10-20T00:00:00.000Z', amountLabel: '$90.00', reason: null } }),
    );
    renderBilling();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel subscription' }));
    fireEvent.click(await screen.findByRole('button', { name: /Cancel at period end/ }));
    await waitFor(() => expect(api.cancelSubscription).toHaveBeenCalled());
    expect(api.refundSubscription).not.toHaveBeenCalled();
  });

  it('tells a monthly subscriber there is no refund and cancels at period end', async () => {
    jest.mocked(api.getBilling).mockResolvedValue(
      subscriber({ interval: 'month', refund: { eligible: false, deadline: null, amountLabel: null, reason: 'not_yearly' } }),
    );
    renderBilling();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel subscription' }));
    expect(await screen.findByText(`Monthly plans are not refunded. You keep access until ${fmt(renewsAt)}.`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /refund/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel subscription' }).at(-1)!);
    await waitFor(() => expect(api.cancelSubscription).toHaveBeenCalled());
    expect(api.refundSubscription).not.toHaveBeenCalled();
  });

  it('names the deadline once the 14-day window has passed', async () => {
    const deadline = '2026-09-01T00:00:00.000Z';
    jest.mocked(api.getBilling).mockResolvedValue(
      subscriber({ refund: { eligible: false, deadline, amountLabel: '$90.00', reason: 'window_passed' } }),
    );
    renderBilling();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel subscription' }));
    expect(
      await screen.findByText(`The 14-day refund window ended on ${fmt(deadline)}. You keep access until ${fmt(renewsAt)}.`),
    ).toBeInTheDocument();
  });

  it('opens the same cancel dialog from the Free card', async () => {
    jest.mocked(api.getBilling).mockResolvedValue(
      subscriber({ refund: { eligible: true, deadline: '2026-10-20T00:00:00.000Z', amountLabel: '$90.00', reason: null } }),
    );
    renderBilling();
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to Free' }));
    expect(await screen.findByRole('button', { name: /Cancel and refund \$90\.00/ })).toBeInTheDocument();
  });

  it('keeps the resume path and hides switch/cancel while a cancellation is pending', async () => {
    jest.mocked(api.getBilling).mockResolvedValue(
      subscriber({ subscriptionCancelled: true, cancelAtPeriodEnd: true, renewsAt: null, endsAt: renewsAt }),
    );
    renderBilling();
    expect((await screen.findAllByRole('button', { name: 'Keep Premation Cloud' })).length).toBeGreaterThan(0);
    expect(screen.getByText(`Premation Cloud \u00b7 Yearly \u00b7 ends ${fmt(renewsAt)}`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel subscription' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch to (yearly|monthly)/ })).not.toBeInTheDocument();
  });
});

describe('yearlyMonthsFree', () => {
  it('is the whole months a yearly price saves', () => {
    expect(yearlyMonthsFree({ priceCents: 900, yearlyPriceCents: 9000 })).toBe(2);
    expect(yearlyMonthsFree({ priceCents: 900 })).toBe(0);
    expect(yearlyMonthsFree({ priceCents: 900, yearlyPriceCents: 10800 })).toBe(0);
  });
});
