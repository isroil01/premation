import { t } from '@core/i18n/t';

export interface PlanIntentPlan {
  id: string;
  name: string;
  priceCents: number;
  priceLabel: string;
  interval?: string;
  /** False when the server has closed new subscriptions to this plan. Missing = purchasable. */
  purchasable?: boolean;
  /** Free-trial days a new subscription starts with. Missing or 0 = none. */
  trialDays?: number;
}

export type PlanIntent =
  | { kind: 'current'; label: string }
  | { kind: 'resume'; label: string }
  | { kind: 'subscribe'; label: string }
  | { kind: 'upgrade'; label: string }
  | { kind: 'downgrade'; label: string }
  | { kind: 'cancel'; label: string }
  /** A new subscription to this plan would be needed and the server is not selling it. */
  | { kind: 'unavailable'; label: string };

export function planIntent(
  current: Pick<PlanIntentPlan, 'id' | 'priceCents'>,
  target: PlanIntentPlan,
  opts: { cancelled: boolean; hasSubscription: boolean },
): PlanIntent {
  const yearly = shortInterval(target.interval ?? 'month') === 'yr';
  if (target.id === current.id) {
    if (opts.cancelled && target.priceCents > 0) {
      return { kind: 'resume', label: t('billing.intent.keep', 'Keep {plan}', { plan: target.name }) };
    }
    return { kind: 'current', label: t('billing.intent.current', 'Current plan') };
  }
  if (target.priceCents <= 0) {
    if (opts.hasSubscription || current.priceCents > 0) {
      return { kind: 'cancel', label: t('billing.intent.switchToFree', 'Switch to Free') };
    }
    return { kind: 'current', label: t('billing.intent.current', 'Current plan') };
  }
  // Everything below starts or changes a paid subscription. When the server
  // has sales closed (PRO_SALES_OPEN), there is nothing to press: checkout
  // would refuse. Resume and cancel above are untouched — an existing
  // subscriber keeps both.
  if (target.purchasable === false) {
    return { kind: 'unavailable', label: t('billing.intent.paused', 'Paused for new subscriptions') };
  }
  if (!opts.hasSubscription) {
    if (target.trialDays && target.trialDays > 0) {
      return {
        kind: 'subscribe',
        label: t('billing.intent.startTrial', 'Start {days}-day free trial', { days: target.trialDays }),
      };
    }
    return {
      kind: 'subscribe',
      label: yearly
        ? t('billing.intent.subscribeYearly', 'Subscribe — {price}/yr', { price: target.priceLabel })
        : t('billing.intent.subscribeMonthly', 'Subscribe — {price}/mo', { price: target.priceLabel }),
    };
  }
  if (target.priceCents > current.priceCents) {
    return {
      kind: 'upgrade',
      label: yearly
        ? t('billing.intent.upgradeYearly', 'Upgrade — {price}/yr', { price: target.priceLabel })
        : t('billing.intent.upgradeMonthly', 'Upgrade — {price}/mo', { price: target.priceLabel }),
    };
  }
  return { kind: 'downgrade', label: t('billing.intent.switchTo', 'Switch to {plan}', { plan: target.name }) };
}

export function confirmPlanChange(
  intent: PlanIntent,
  target: PlanIntentPlan,
  periodEnd: string | null,
): { title: string; message: string; confirmLabel: string; isDanger: boolean } | null {
  const until = periodEnd
    ? new Date(periodEnd).toLocaleDateString()
    : t('billing.cancel.periodEndFallback', 'the end of the current period');
  switch (intent.kind) {
    case 'upgrade':
      return {
        title: t('billing.confirm.upgradeTitle', 'Upgrade to {plan}?', { plan: target.name }),
        message: t(
          'billing.confirm.upgradeMessage',
          "You'll move to {plan} now. Lemon Squeezy will charge the prorated difference on this billing cycle.",
          { plan: target.name },
        ),
        confirmLabel: t('billing.upgradeTo', 'Upgrade to {plan}', { plan: target.name }),
        isDanger: false,
      };
    case 'downgrade':
      return {
        title: t('billing.confirm.switchTitle', 'Switch to {plan}?', { plan: target.name }),
        message: t(
          'billing.confirm.switchMessage',
          "You'll switch to {plan}. The new rate applies on the next invoice; unused time on the current plan is credited.",
          { plan: target.name },
        ),
        confirmLabel: t('billing.intent.switchTo', 'Switch to {plan}', { plan: target.name }),
        isDanger: false,
      };
    case 'cancel':
      return {
        title: t('billing.cancel.title', 'Cancel subscription?'),
        message: t(
          'billing.cancel.plain',
          "You'll keep paid access until {date}, then the account moves to Free. Your projects are never deleted.",
          { date: until },
        ),
        confirmLabel: t('billing.cancel.confirm', 'Cancel subscription'),
        isDanger: true,
      };
    case 'resume':
      return {
        title: t('billing.confirm.keepTitle', 'Keep {plan}?', { plan: target.name }),
        message: t('billing.confirm.keepMessage', 'The scheduled cancellation will be stopped and billing continues as usual.'),
        confirmLabel: t('billing.intent.keep', 'Keep {plan}', { plan: target.name }),
        isDanger: false,
      };
    default:
      return null;
  }
}

/** The server's verdict on refunding the last payment (`BillingSummary.refund`). */
export interface RefundState {
  eligible: boolean;
  deadline: string | null;
  amountLabel: string | null;
  reason: string | null;
}

export type CancelDialogCopy =
  | {
      /** Yearly inside the window: refund now, or keep access to the period end. */
      mode: 'choice';
      title: string;
      message: string;
      refundLabel: string;
      periodEndLabel: string;
      keepLabel: string;
    }
  | {
      /** One confirm, with the sentence that says why there is no refund. */
      mode: 'confirm';
      title: string;
      message: string;
      confirmLabel: string;
    };

/**
 * What the cancel dialog says, from the server's refund verdict. The window,
 * the amount and the eligibility are all the server's; this only picks the
 * sentence — so the dialog can never promise a refund the server will refuse.
 *
 * A free trial comes first: nothing has been paid, so "not refunded" and a
 * refund button would both be wrong whatever the verdict says.
 */
export function cancelDialogCopy(
  refund: RefundState | undefined,
  periodEnd: string | null,
  opts: { trial?: boolean } = {},
): CancelDialogCopy {
  const date = periodEnd ? new Date(periodEnd).toLocaleDateString() : t('billing.cancel.periodEndFallback', 'the end of the current period');
  if (opts.trial) {
    return {
      mode: 'confirm',
      title: t('billing.cancel.trialTitle', 'Cancel free trial?'),
      message: t(
        'billing.cancel.trial',
        "You won't be charged. You keep Premation Cloud until {date}, then the account moves to Free. Your projects are never deleted.",
        { date },
      ),
      confirmLabel: t('billing.cancel.trialConfirm', 'Cancel trial'),
    };
  }
  const title = t('billing.cancel.title', 'Cancel subscription?');
  if (refund?.eligible) {
    const amount = refund.amountLabel ?? '';
    const deadline = refund.deadline ? new Date(refund.deadline).toLocaleDateString() : date;
    return {
      mode: 'choice',
      title,
      message: t(
        'billing.cancel.refundAvailable',
        'Refund available until {deadline}. Refund now and your access to Premation Cloud ends immediately, or cancel at the period end and keep access until {date}. Your projects are never deleted.',
        { deadline, date },
      ),
      refundLabel: t('billing.cancel.refundNow', 'Cancel and refund {amount} — access ends now', { amount }),
      periodEndLabel: t('billing.cancel.atPeriodEnd', 'Cancel at period end — keep access until {date}', { date }),
      keepLabel: t('billing.cancel.keepPlan', 'Keep my plan'),
    };
  }
  let message: string;
  switch (refund?.reason) {
    case 'not_yearly':
      message = t('billing.cancel.notYearly', 'Monthly plans are not refunded. You keep access until {date}.', { date });
      break;
    case 'window_passed': {
      const deadline = refund?.deadline ? new Date(refund.deadline).toLocaleDateString() : '';
      message = t(
        'billing.cancel.windowPassed',
        'The 14-day refund window ended on {deadline}. You keep access until {date}.',
        { deadline, date },
      );
      break;
    }
    case 'already_refunded':
      message = t('billing.cancel.alreadyRefunded', 'This payment was already refunded.');
      break;
    default:
      message = t(
        'billing.cancel.plain',
        "You'll keep paid access until {date}, then the account moves to Free. Your projects are never deleted.",
        { date },
      );
  }
  return { mode: 'confirm', title, message, confirmLabel: t('billing.cancel.confirm', 'Cancel subscription') };
}

function shortInterval(interval: string): string {
  if (interval === 'year' || interval === 'yearly') return 'yr';
  return 'mo';
}
