import { cancelDialogCopy, confirmPlanChange, planIntent } from './planIntent';

describe('planIntent', () => {
  const free = { id: 'free', name: 'Free', priceCents: 0, priceLabel: '$0', interval: 'month' };
  const pro = { id: 'pro', name: 'Pro', priceCents: 2900, priceLabel: '$29', interval: 'month' };
  const automation = {
    id: 'automation',
    name: 'Automation',
    priceCents: 7900,
    priceLabel: '$79',
    interval: 'month',
  };

  it('subscribes a new account onto a paid plan', () => {
    expect(planIntent(free, pro, { cancelled: false, hasSubscription: false })).toEqual({
      kind: 'subscribe',
      label: 'Subscribe — $29/mo',
    });
  });

  it('upgrades and downgrades an active subscriber without a second checkout', () => {
    expect(planIntent(pro, automation, { cancelled: false, hasSubscription: true }).kind).toBe('upgrade');
    expect(planIntent(automation, pro, { cancelled: false, hasSubscription: true }).kind).toBe('downgrade');
    expect(planIntent(pro, free, { cancelled: false, hasSubscription: true }).kind).toBe('cancel');
  });

  it('offers resume on the current plan after a period-end cancellation', () => {
    expect(planIntent(pro, pro, { cancelled: true, hasSubscription: true })).toEqual({
      kind: 'resume',
      label: 'Keep Pro',
    });
  });

  describe('with sales closed (purchasable: false)', () => {
    const closedPro = { ...pro, purchasable: false };

    it('offers no subscribe to a new account', () => {
      expect(planIntent(free, closedPro, { cancelled: false, hasSubscription: false }).kind).toBe(
        'unavailable',
      );
    });

    it('offers no upgrade onto a closed plan', () => {
      expect(
        planIntent(pro, { ...automation, purchasable: false }, { cancelled: false, hasSubscription: true }).kind,
      ).toBe('unavailable');
    });

    it('leaves an existing subscriber their current plan, resume and cancel', () => {
      expect(planIntent(pro, closedPro, { cancelled: false, hasSubscription: true }).kind).toBe('current');
      expect(planIntent(pro, closedPro, { cancelled: true, hasSubscription: true }).kind).toBe('resume');
      expect(planIntent(pro, free, { cancelled: false, hasSubscription: true }).kind).toBe('cancel');
    });

    it('treats a missing flag (older server) as purchasable', () => {
      expect(planIntent(free, pro, { cancelled: false, hasSubscription: false }).kind).toBe('subscribe');
    });
  });
});

describe('confirmPlanChange', () => {
  it('warns that cancel keeps access until the paid-through date', () => {
    const copy = confirmPlanChange(
      { kind: 'cancel', label: 'Switch to Free' },
      { id: 'free', name: 'Free', priceCents: 0, priceLabel: '$0' },
      '2026-09-15T00:00:00.000Z',
    );
    expect(copy?.isDanger).toBe(true);
    expect(copy?.message).toMatch(/keep paid access until/i);
  });
});

describe('cancelDialogCopy', () => {
  const periodEnd = '2027-03-12T00:00:00.000Z';
  const until = new Date(periodEnd).toLocaleDateString();

  it('offers refund-now and period-end when the server says the payment is refundable', () => {
    const copy = cancelDialogCopy(
      { eligible: true, deadline: '2026-10-20T00:00:00.000Z', amountLabel: '$90.00', reason: null },
      periodEnd,
    );
    expect(copy.mode).toBe('choice');
    if (copy.mode !== 'choice') return;
    expect(copy.refundLabel).toBe('Cancel and refund $90.00 \u2014 access ends now');
    expect(copy.periodEndLabel).toBe(`Cancel at period end \u2014 keep access until ${until}`);
    expect(copy.message).toContain(`Refund available until ${new Date('2026-10-20T00:00:00.000Z').toLocaleDateString()}`);
  });

  it('says monthly plans are not refunded', () => {
    const copy = cancelDialogCopy({ eligible: false, deadline: null, amountLabel: null, reason: 'not_yearly' }, periodEnd);
    expect(copy.mode).toBe('confirm');
    expect(copy.message).toBe(`Monthly plans are not refunded. You keep access until ${until}.`);
  });

  it('names the deadline once the window has passed', () => {
    const deadline = '2026-09-01T00:00:00.000Z';
    const copy = cancelDialogCopy({ eligible: false, deadline, amountLabel: '$90.00', reason: 'window_passed' }, periodEnd);
    expect(copy.message).toBe(
      `The 14-day refund window ended on ${new Date(deadline).toLocaleDateString()}. You keep access until ${until}.`,
    );
  });

  it('falls back to the plain cancel copy without a refund block (older server)', () => {
    const copy = cancelDialogCopy(undefined, periodEnd);
    expect(copy.mode).toBe('confirm');
    expect(copy.message).toMatch(/keep paid access until/);
    expect(cancelDialogCopy({ eligible: false, deadline: null, amountLabel: null, reason: 'already_refunded' }, null).message).toBe(
      'This payment was already refunded.',
    );
  });
});
