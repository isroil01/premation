import { confirmPlanChange, planIntent } from './planIntent';

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
