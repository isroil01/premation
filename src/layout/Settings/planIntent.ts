export interface PlanIntentPlan {
  id: string;
  name: string;
  priceCents: number;
  priceLabel: string;
  interval?: string;
}

export type PlanIntent =
  | { kind: 'current'; label: string }
  | { kind: 'resume'; label: string }
  | { kind: 'subscribe'; label: string }
  | { kind: 'upgrade'; label: string }
  | { kind: 'downgrade'; label: string }
  | { kind: 'cancel'; label: string };

export function planIntent(
  current: Pick<PlanIntentPlan, 'id' | 'priceCents'>,
  target: PlanIntentPlan,
  opts: { cancelled: boolean; hasSubscription: boolean },
): PlanIntent {
  const period = shortInterval(target.interval ?? 'month');
  if (target.id === current.id) {
    if (opts.cancelled && target.priceCents > 0) {
      return { kind: 'resume', label: `Keep ${target.name}` };
    }
    return { kind: 'current', label: 'Current plan' };
  }
  if (target.priceCents <= 0) {
    if (opts.hasSubscription || current.priceCents > 0) {
      return { kind: 'cancel', label: 'Switch to Free' };
    }
    return { kind: 'current', label: 'Current plan' };
  }
  if (!opts.hasSubscription) {
    return { kind: 'subscribe', label: `Subscribe — ${target.priceLabel}/${period}` };
  }
  if (target.priceCents > current.priceCents) {
    return { kind: 'upgrade', label: `Upgrade — ${target.priceLabel}/${period}` };
  }
  return { kind: 'downgrade', label: `Switch to ${target.name}` };
}

export function confirmPlanChange(
  intent: PlanIntent,
  target: PlanIntentPlan,
  periodEnd: string | null,
): { title: string; message: string; confirmLabel: string; isDanger: boolean } | null {
  const until = periodEnd
    ? new Date(periodEnd).toLocaleDateString()
    : 'the end of the current period';
  switch (intent.kind) {
    case 'upgrade':
      return {
        title: `Upgrade to ${target.name}?`,
        message: `You'll move to ${target.name} now. Lemon Squeezy will charge the prorated difference on this billing cycle.`,
        confirmLabel: `Upgrade to ${target.name}`,
        isDanger: false,
      };
    case 'downgrade':
      return {
        title: `Switch to ${target.name}?`,
        message: `You'll switch to ${target.name}. The new rate applies on the next invoice; unused time on the current plan is credited.`,
        confirmLabel: `Switch to ${target.name}`,
        isDanger: false,
      };
    case 'cancel':
      return {
        title: 'Cancel subscription?',
        message: `You'll keep paid access until ${until}, then the account moves to Free. API keys stop working after that date.`,
        confirmLabel: 'Cancel subscription',
        isDanger: true,
      };
    case 'resume':
      return {
        title: `Keep ${target.name}?`,
        message: 'The scheduled cancellation will be stopped and billing continues as usual.',
        confirmLabel: `Keep ${target.name}`,
        isDanger: false,
      };
    default:
      return null;
  }
}

function shortInterval(interval: string): string {
  if (interval === 'year' || interval === 'yearly') return 'yr';
  return 'mo';
}
