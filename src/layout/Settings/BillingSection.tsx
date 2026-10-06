/**
 * Plan, cloud allowance, and email confirmation.
 *
 * Everything here is server state. The panel renders what `/billing/me` says and
 * decides nothing: not which allowance applies, not whether the account may
 * write, not what sentence to show. That is deliberate — a client that computed
 * "am I inside my trial?" from a date would be a second implementation of the
 * paywall, and the two would disagree the first time either was edited.
 *
 * This replaces a version built around AI credits, which no longer exist: the
 * assistant is bring-your-own-key in both editions, so there is nothing metered
 * to display. What matters to a user now is whether they can save, and until when.
 *
 * Sales can be closed server-side (`purchasable: false` on a plan — the
 * PRO_SALES_OPEN switch). Then nothing here offers to start a subscription:
 * an account without one sees a calm "paused" note instead of the plan cards,
 * and an existing subscriber sees their plan, Manage billing, cancel and resume
 * exactly as before.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { customConfirm, DialogFooter } from '@components/Modal';
import {
  api,
  isAuthenticated,
  paidSalesOpen,
  type BillingSummary,
  type PlanDto,
} from '@core/api/client';
import { billingEnabled } from '@core/config/edition';
import { t } from '@core/i18n/t';
import { useEntitlementStore } from '@stores/entitlementStore';
import { openModal } from '@stores/modalStore';
import { cancelDialogCopy, confirmPlanChange, planIntent } from './planIntent';
import { CloudUsage } from './CloudUsage';
import styles from './BillingSection.module.css';

/**
 * Reasons the account cannot write. Today only `unverified`; the trial reasons
 * come only from servers that predate the permanent Free plan.
 */
const BLOCKED_REASONS = new Set(['unverified', 'trial_expired', 'lapsed', 'trial_not_started']);

type BillingInterval = 'month' | 'year';

/** The plan as it reads at the chosen billing period (yearly label when offered). */
function atInterval(plan: PlanDto, interval: BillingInterval): PlanDto {
  if (interval !== 'year' || plan.priceCents <= 0 || !plan.yearlyPriceLabel) return plan;
  return { ...plan, priceLabel: plan.yearlyPriceLabel, interval: 'year' };
}

/** "$7.50" — cents as dollars, trailing ".00" dropped (the server's own format). */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
}

/**
 * Whole months a yearly plan saves over twelve monthly payments, from the
 * server's two prices. 0 when there is no yearly price or no saving.
 */
export function yearlyMonthsFree(plan: Pick<PlanDto, 'priceCents' | 'yearlyPriceCents'>): number {
  if (!plan.yearlyPriceCents || plan.priceCents <= 0) return 0;
  const saved = plan.priceCents * 12 - plan.yearlyPriceCents;
  return saved > 0 ? Math.round(saved / plan.priceCents) : 0;
}

/**
 * The comparison table's rows, built from each plan's served `limits` rather
 * than from its marketing sentences — so "5" and "Unlimited" line up in one
 * row instead of appearing as two unrelated features. Null when any plan
 * lacks `limits` (an older server): the caller falls back to the sentences.
 */
function comparisonRows(plans: readonly PlanDto[]): { label: string; cells: (string | boolean)[] }[] | null {
  if (plans.length < 2 || plans.some((p) => !p.limits)) return null;
  return [
    {
      label: 'Cloud projects',
      cells: plans.map((p) => (p.limits?.cloudProjects == null ? 'Unlimited' : String(p.limits.cloudProjects))),
    },
    {
      label: 'Version history',
      cells: plans.map((p) => `${p.limits?.historyDays ?? 0} days`),
    },
    { label: 'The full editor — every effect, local projects and export', cells: plans.map(() => true) },
    { label: 'AI assistant with your own provider key', cells: plans.map(() => true) },
    {
      label: 'Past the project limit',
      cells: plans.map((p) => (p.limits?.cloudProjects == null ? false : 'Read-only, never deleted')),
    },
  ];
}

export function checkoutReturnState(params: URLSearchParams): 'success' | 'cancelled' | null {
  const value = params.get('checkout') ?? params.get('payment') ?? params.get('billing');
  if (value === 'success' || value === 'completed' || value === 'paid') return 'success';
  if (value === 'cancel' || value === 'cancelled' || value === 'canceled') return 'cancelled';
  return null;
}

/** The file's one date format — the hero's "Member since" and every date beside it. */
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/**
 * The one-line reading of a live subscription: "Premation Cloud · Yearly ·
 * renews 12 Mar 2027", or "… · ends …" once a cancellation is scheduled.
 * `renewsAt`/`endsAt`/`interval` are newer server fields; an older server
 * falls back to `currentPeriodEnd` and drops the interval. Null without a
 * subscription to describe.
 */
export function currentPlanLine(summary: BillingSummary): string | null {
  if (!summary.hasSubscription && summary.plan.priceCents <= 0) return null;
  const ending = Boolean(summary.cancelAtPeriodEnd ?? summary.subscriptionCancelled);
  const date = (ending ? summary.endsAt : summary.renewsAt) ?? summary.currentPeriodEnd;
  const interval =
    summary.interval === 'year'
      ? t('billing.interval.yearly', 'Yearly')
      : summary.interval === 'month'
        ? t('billing.interval.monthly', 'Monthly')
        : null;
  const head = interval ? `${summary.plan.name} · ${interval}` : summary.plan.name;
  if (!date) return head;
  return ending
    ? t('billing.planLine.ends', '{plan} · ends {date}', { plan: head, date: fmtDate(date) })
    : t('billing.planLine.renews', '{plan} · renews {date}', { plan: head, date: fmtDate(date) });
}

/**
 * The last payment was refunded and the account is back on Free. The server
 * says so through `refund.reason`; `endsAt` is the moment access stopped.
 */
function isRefunded(summary: BillingSummary): boolean {
  return summary.refund?.reason === 'already_refunded' && summary.plan.priceCents <= 0;
}

/** How the person chose to cancel, or `null` for "keep my plan" / dismissed. */
type CancelChoice = 'refund' | 'period_end' | null;

/**
 * The cancel dialog. One confirm when there is nothing to refund (with the
 * sentence saying why); two ways out when the server says the last yearly
 * payment is refundable: refund now (destructive — access ends at once) or
 * cancel at the period end. Enter does nothing here on purpose: neither
 * choice is the safe default.
 */
function confirmCancel(summary: BillingSummary): Promise<CancelChoice> {
  const copy = cancelDialogCopy(summary.refund, summary.endsAt ?? summary.currentPeriodEnd);
  if (copy.mode === 'confirm') {
    return customConfirm(copy.title, copy.message, { confirmLabel: copy.confirmLabel, isDanger: true }).then(
      (ok) => (ok ? 'period_end' : null),
    );
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: CancelChoice, close: () => void): void => {
      settled = true;
      close();
      resolve(value);
    };
    openModal({
      title: copy.title,
      size: 'sm',
      persistent: true,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
      render: () => <p className={styles.dialogMessage}>{copy.message}</p>,
      footer: (close) => (
        <DialogFooter
          secondary={
            <Button variant="ghost" onClick={() => settle(null, close)}>
              {copy.keepLabel}
            </Button>
          }
          destructive={
            <Button variant="danger" onClick={() => settle('refund', close)}>
              {copy.refundLabel}
            </Button>
          }
          primary={
            <Button variant="secondary" onClick={() => settle('period_end', close)}>
              {copy.periodEndLabel}
            </Button>
          }
        />
      ),
    });
  });
}

/** Server-authored `{ code, message }` if there is one, else the raw error. */
function readError(err: unknown): string {
  const body = (err as { body?: { message?: string | { message?: string } } }).body;
  const msg = typeof body?.message === 'object' ? body.message.message : body?.message;
  return msg || (err instanceof Error ? err.message : 'Something went wrong.');
}

export function BillingSection(): JSX.Element | null {
  const [searchParams, setSearchParams] = useSearchParams();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [plans, setPlans] = useState<PlanDto[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('month');
  const handledReturn = useRef(false);

  const load = useCallback(async (force = false) => {
    if (!billingEnabled()) return;
    if (!isAuthenticated()) return;
    try {
      const [me, catalog] = await Promise.all([api.getBilling({ force }), api.listPlans()]);
      setSummary(me);
      setPlans(catalog);
      useEntitlementStore.setState({
        access: me.access,
        message: me.access.write ? '' : me.statusMessage,
        salesOpen: paidSalesOpen(catalog),
      });
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your plan.');
    }
  }, []);

  useEffect(() => {
    // Checkout returns run their own resync-first flow below. Starting a normal
    // fetch in parallel can win the race with the webhook and briefly restore
    // stale plan data.
    if (checkoutReturnState(searchParams)) return;
    void load(true);
  }, [load, searchParams]);

  useEffect(() => {
    const returned = checkoutReturnState(searchParams);
    if (!returned || handledReturn.current || !billingEnabled() || !isAuthenticated()) return;
    handledReturn.current = true;

    const next = new URLSearchParams(searchParams);
    next.delete('checkout');
    next.delete('payment');
    next.delete('billing');

    if (returned === 'cancelled') {
      setNotice('Checkout was cancelled. Your current plan has not changed.');
      setSearchParams(next, { replace: true });
      return;
    }

    setBusy('resync');
    setNotice('Confirming your payment…');
    void api
      .resyncBilling()
      .catch(() => ({ resynced: false }))
      .then(async ({ resynced }) => {
        await load(true);
        await useEntitlementStore.getState().refresh({ force: true });
        setNotice(
          resynced
            ? 'Payment confirmed. Your plan and access are up to date.'
            : 'Checkout completed. We refreshed your account; payment confirmation may take a moment.',
        );
      })
      .catch((err) => setError(readError(err)))
      .finally(() => {
        setBusy(null);
        setSearchParams(next, { replace: true });
      });
  }, [load, searchParams, setSearchParams]);

  // There are no plans to be on in the local edition. Renders nothing at all —
  // after the hooks above, so hook order is identical in both editions — which
  // makes this safe to mount unconditionally from wherever settings are shown.
  if (!billingEnabled()) return null;

  if (!isAuthenticated()) {
    return (
      <div className={styles.section}>
        <p className={styles.intro}>Sign in to see your plan.</p>
      </div>
    );
  }

  const run = async (kind: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(kind);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(null);
    }
  };

  const applyChange = async (
    result: { action?: string; url?: string; planId?: string; interval?: string; amountLabel?: string },
  ): Promise<void> => {
    if (result.url) {
      window.location.href = result.url;
      return;
    }
    await load(true);
    await useEntitlementStore.getState().refresh({ force: true });
    const messages: Record<string, string> = {
      upgraded: 'Welcome to Premation Cloud. Unlimited cloud projects and the longer history apply now.',
      downgraded: 'Plan switched. The new rate applies on the next invoice.',
      cancelled: 'Cancellation scheduled. You keep paid access until the date shown above.',
      resumed: 'Cancellation stopped. Billing continues on this plan.',
      unchanged: 'You are already on this plan.',
      interval_changed:
        result.interval === 'year'
          ? t('billing.notice.nowYearly', 'Now billed yearly.')
          : t('billing.notice.nowMonthly', 'Now billed monthly.'),
      refunded: t('billing.notice.refunded', 'Refunded {amount}. Your access to Premation Cloud has ended.', {
        amount: result.amountLabel ?? '',
      }),
    };
    setNotice(messages[result.action ?? ''] ?? 'Your plan is up to date.');
  };

  /**
   * Cancel, from the standalone button or the Free card's "Switch to Free" —
   * one dialog either way, branching on the server's refund verdict.
   */
  const cancelFlow = (): Promise<void> => {
    if (!summary) return Promise.resolve();
    return run('cancel', async () => {
      const choice = await confirmCancel(summary);
      if (choice === 'refund') {
        await applyChange(await api.refundSubscription());
      } else if (choice === 'period_end') {
        await applyChange(await api.cancelSubscription());
      }
    });
  };

  /** Monthly ↔ yearly on the live subscription: immediate, prorated. */
  const switchInterval = (target: 'month' | 'year', paid: PlanDto): Promise<void> =>
    run('interval', async () => {
      const yearly = paid.yearlyPriceLabel ?? '';
      const ok =
        target === 'year'
          ? await customConfirm(
              t('billing.switch.toYearlyTitle', 'Switch to yearly billing?'),
              t(
                'billing.switch.toYearlyMessage',
                '{plan} becomes {price}/year. You are charged the prorated difference now; your renewal date moves to a year from today.',
                { plan: paid.name, price: yearly },
              ),
              { confirmLabel: t('billing.switch.toYearly', 'Switch to yearly') },
            )
          : await customConfirm(
              t('billing.switch.toMonthlyTitle', 'Switch to monthly billing?'),
              t(
                'billing.switch.toMonthlyMessage',
                '{plan} becomes {price}/month. The unused part of your year is credited now; your renewal date moves.',
                { plan: paid.name, price: paid.priceLabel },
              ),
              { confirmLabel: t('billing.switch.toMonthly', 'Switch to monthly') },
            );
      if (!ok) return;
      await applyChange(await api.changeBillingInterval(target));
    });

  const choosePlan = (plan: PlanDto): Promise<void> => {
    if (!summary) return Promise.resolve();
    const intent = planIntent(summary.plan, plan, {
      cancelled: Boolean(summary.subscriptionCancelled),
      hasSubscription: summary.hasSubscription,
    });
    if (intent.kind === 'cancel') return cancelFlow();
    return run(plan.id, async () => {
      const confirm = confirmPlanChange(intent, plan, summary.currentPeriodEnd);
      if (confirm) {
        const ok = await customConfirm(confirm.title, confirm.message, {
          confirmLabel: confirm.confirmLabel,
          isDanger: confirm.isDanger,
        });
        if (!ok) return;
      }
      if (intent.kind === 'resume') {
        await applyChange(await api.resumeSubscription());
        return;
      }
      await applyChange(await api.startCheckout(plan.id, plan.interval === 'year' ? 'year' : 'month'));
    });
  };

  const portal = (): Promise<void> =>
    run('portal', async () => {
      const { url } = await api.openBillingPortal();
      window.location.href = url;
    });

  const resync = (): Promise<void> =>
    run('resync', async () => {
      const { resynced } = await api.resyncBilling();
      await load(true);
      await useEntitlementStore.getState().refresh({ force: true });
      setNotice(
        resynced
          ? 'Checked with the payment provider — your plan is up to date.'
          : 'There is no subscription on this account to check.',
      );
    });

  const resend = (): Promise<void> =>
    run('resend', async () => {
      await api.resendVerification();
      setNotice('Confirmation email sent. Check your inbox, and your spam folder.');
    });

  const access = summary?.access;
  const blocked = access ? !access.write && BLOCKED_REASONS.has(access.reason) : false;
  // In the free beta the account can write regardless of verification, so the
  // "confirm your email or you're read-only" callout would be a plain lie. It
  // comes back the moment payments are live and verification actually gates.
  const isBeta = access?.reason === 'beta';
  const paymentNeedsAttention =
    summary?.subscriptionStatus === 'past_due' || access?.reason === 'grace';
  // After a refund the server reports the subscription as cancelled with the
  // account already on Free; that is the Free state, not a pending cancellation.
  const refunded = summary ? isRefunded(summary) : false;
  const cancellationPending = Boolean(summary?.subscriptionCancelled) && !refunded;
  const salesOpen = paidSalesOpen(plans);
  // With sales closed, the plan cards are only for someone who already has a
  // subscription (their plan, cancel/resume). Anyone else would be looking at a
  // price they cannot pay.
  const showCatalog =
    salesOpen || Boolean(summary?.hasSubscription) || (summary?.plan.priceCents ?? 0) > 0;
  // The monthly/yearly switch appears only when the server sells a yearly variant.
  const yearlyOffered = plans.some((p) => p.priceCents > 0 && Boolean(p.yearlyPriceLabel));
  const shownPlans = plans.map((p) => atInterval(p, yearlyOffered ? billingInterval : 'month'));
  const usage = summary?.cloudProjects;
  const monthsFree = Math.max(0, ...plans.map(yearlyMonthsFree));
  const rows = comparisonRows(plans);
  const freeCap = plans.find((p) => p.priceCents === 0)?.limits?.cloudProjects ?? null;
  // The one paid plan someone on Free can move to, at the period they picked.
  const upgradeTo =
    summary && summary.plan.priceCents === 0 && salesOpen
      ? shownPlans.find((p) => p.priceCents > 0 && p.purchasable !== false)
      : undefined;
  const planLine = summary && !refunded ? currentPlanLine(summary) : null;
  const subscriptionLive =
    Boolean(summary?.hasSubscription) &&
    (summary?.subscriptionStatus === 'active' || summary?.subscriptionStatus === 'on_trial');
  // The plan the subscription bills on, for its prices in the switch dialog.
  const paidPlan = summary ? plans.find((p) => p.id === summary.plan.id && p.priceCents > 0) : undefined;
  // Monthly <-> yearly needs a live subscription, a server that reports which
  // interval it bills on, and a yearly price to move to or from.
  const switchTarget: 'month' | 'year' | null =
    subscriptionLive && !cancellationPending && paidPlan?.yearlyPriceLabel && summary?.interval
      ? summary.interval === 'year'
        ? 'month'
        : 'year'
      : null;
  const canCancel = subscriptionLive && !cancellationPending && !refunded;

  return (
    <div className={styles.section}>
      {/* 1. Current Plan Status Hero */}
      {summary ? (
        <div className={styles.statusHero}>
          <div className={styles.statusHeroLeft}>
            <div className={styles.statusHeroIcon}>
              <Icon name="sparkles" size="md" />
            </div>
            <div>
              <div className={styles.planTitleRow}>
                <h3 className={styles.currentPlanName}>{summary.plan.name}</h3>
                <span
                  className={
                    paymentNeedsAttention
                      ? styles.badgeWarning
                      : cancellationPending
                        ? styles.badgeNeutral
                        : styles.badgeActive
                  }
                >
                  {paymentNeedsAttention
                    ? 'Payment Past Due'
                    : cancellationPending
                      ? 'Cancellation Scheduled'
                      : isBeta
                        ? 'Beta Access'
                        : access?.reason === 'active' || access?.reason === 'grace'
                          ? 'Active Subscription'
                          : access?.reason === 'staff'
                            ? 'Operator'
                            : 'Free Plan'}
                </span>
              </div>
              <p className={blocked ? styles.statusBlocked : styles.intro}>
                {summary.statusMessage}
              </p>
              {planLine ? <p className={styles.planLine}>{planLine}</p> : null}
              {refunded ? (
                <p className={styles.planLine}>
                  {summary.endsAt
                    ? t('billing.planLine.refundedOn', 'Refunded on {date} · access to Premation Cloud has ended.', {
                        date: fmtDate(summary.endsAt),
                      })
                    : t('billing.planLine.refunded', 'Refunded · access to Premation Cloud has ended.')}
                </p>
              ) : null}
              {switchTarget || canCancel ? (
                <div className={styles.heroActions}>
                  {switchTarget && paidPlan ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void switchInterval(switchTarget, paidPlan)}
                    >
                      {busy === 'interval'
                        ? 'Working…'
                        : switchTarget === 'year'
                          ? t('billing.switch.toYearly', 'Switch to yearly')
                          : t('billing.switch.toMonthly', 'Switch to monthly')}
                    </Button>
                  ) : null}
                  {canCancel ? (
                    <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void cancelFlow()}>
                      {busy === 'cancel' ? 'Working…' : t('billing.cancel.button', 'Cancel subscription')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className={styles.statusHeroMeta}>
            <div className={styles.metaStat}>
              <span className={styles.metaLabel}>Member since</span>
              <span className={styles.metaValue}>
                {new Date(summary.memberSince).toLocaleDateString()}
              </span>
            </div>
            {summary.currentPeriodEnd ? (
              <div className={styles.metaStat}>
                <span className={styles.metaLabel}>
                  {summary.subscriptionStatus === 'cancelled'
                    ? 'Access paid through'
                    : 'Current period ends'}
                </span>
                <span className={styles.metaValue}>
                  {new Date(summary.currentPeriodEnd).toLocaleDateString()}
                </span>
              </div>
            ) : null}
            {access?.writeEndsAt ? (
              <div className={styles.metaStat}>
                <span className={styles.metaLabel}>
                  {access.write ? 'Full access until' : 'Ended'}
                </span>
                <span className={styles.metaValue}>
                  {new Date(access.writeEndsAt).toLocaleDateString()}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className={styles.statusHero}>
          <p className={styles.intro}>Loading your plan details…</p>
        </div>
      )}

      {/* Cloud allowance: what the plan includes and how much of it is used. */}
      {summary && usage && !isBeta ? (
        <div className={styles.usageCard}>
          <CloudUsage
            used={usage.used}
            limit={usage.limit}
            historyDays={access?.limits?.historyDays}
            limitsFrom={access?.limitsFrom ?? null}
            freeLimit={freeCap}
            action={
              upgradeTo && (usage.limit !== null ? usage.used >= usage.limit - 1 : Boolean(access?.limitsFrom)) ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void choosePlan(upgradeTo)}
                >
                  {busy === upgradeTo.id ? 'Working…' : `Upgrade to ${upgradeTo.name}`}
                </Button>
              ) : null
            }
          />
        </div>
      ) : null}

      {/* 2. Alerts & Notices */}
      {summary && paymentNeedsAttention ? (
        <div className={styles.paymentWarning} role="alert">
          <Icon name="warning" size="sm" className={styles.warningIcon} />
          <div className={styles.calloutBody}>
            <strong>Payment needs attention</strong>
            <span>
              Your account is in a grace period. Update your payment method to avoid losing write
              access{summary.currentPeriodEnd ? ` after ${new Date(summary.currentPeriodEnd).toLocaleDateString()}` : ''}.
            </span>
          </div>
          {summary.hasSubscription ? (
            <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void portal()}>
              Update payment
            </Button>
          ) : null}
        </div>
      ) : null}

      {summary && cancellationPending && !paymentNeedsAttention ? (
        <div className={styles.paymentWarning} role="status">
          <Icon name="info" size="sm" className={styles.calloutIcon} />
          <div className={styles.calloutBody}>
            <strong>Cancellation scheduled</strong>
            <span>
              You keep {summary.plan.name} until{' '}
              {summary.currentPeriodEnd
                ? new Date(summary.currentPeriodEnd).toLocaleDateString()
                : 'the end of this period'}
              . Resume before then to stay on this plan.
            </span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() => void choosePlan(summary.plan)}
          >
            {busy === summary.plan.id ? 'Resuming…' : `Keep ${summary.plan.name}`}
          </Button>
        </div>
      ) : null}

      {summary && !summary.emailVerified && !isBeta && (
        <div className={styles.callout}>
          <Icon name="info" size="sm" className={styles.calloutIcon} />
          <div className={styles.calloutBody}>
            <strong>Confirm your email to save to the cloud.</strong>
            <span>
              Your projects are read-only until then — you can open and export them, but not save.
            </span>
          </div>
          <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void resend()}>
            {busy === 'resend' ? 'Sending…' : 'Resend email'}
          </Button>
        </div>
      )}

      {error ? (
        <div className={styles.errorAlert} role="alert">
          <Icon name="warning" size="sm" />
          <span>{error}</span>
        </div>
      ) : null}

      {notice ? (
        <div className={styles.noticeAlert} role="status">
          <Icon name="check" size="sm" />
          <span>{notice}</span>
        </div>
      ) : null}

      {summary && !showCatalog ? (
        <div className={styles.callout} role="status">
          <Icon name="info" size="sm" className={styles.calloutIcon} />
          <div className={styles.calloutBody}>
            <strong>Premation Cloud subscriptions are paused</strong>
            <span>
              {access?.write
                ? 'New subscriptions are not open right now. Your Free plan keeps working as normal, and export always works.'
                : 'Your projects stay available read-only, and export keeps working.'}
            </span>
          </div>
        </div>
      ) : null}

      {summary && !showCatalog ? (
        <div className={styles.footerManagement}>
          <div className={styles.actions}>
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void resync()}>
              {busy === 'resync' ? 'Checking…' : 'Already paid? Refresh status'}
            </Button>
          </div>
        </div>
      ) : null}

      {summary && showCatalog ? (
        <>
          {/* 3. Tiered Plan Cards */}
          <div className={styles.plansSectionHeader}>
            <h3 className={styles.sectionTitle}>
              {salesOpen ? 'Available Subscription Plans' : 'Your Plan'}
            </h3>
            <p className={styles.sectionDesc}>
              {salesOpen
                ? 'The editor is free. Premation Cloud is the hosting: more cloud projects and longer history. Cancel anytime.'
                : 'New subscriptions are paused for now. Your subscription, billing portal, cancel and resume work as usual.'}
            </p>
            {yearlyOffered && salesOpen ? (
              <div className={styles.actions} role="group" aria-label="Billing period">
                <Button
                  variant={billingInterval === 'month' ? 'primary' : 'ghost'}
                  size="sm"
                  aria-pressed={billingInterval === 'month'}
                  onClick={() => setBillingInterval('month')}
                >
                  Monthly
                </Button>
                <Button
                  variant={billingInterval === 'year' ? 'primary' : 'ghost'}
                  size="sm"
                  aria-pressed={billingInterval === 'year'}
                  onClick={() => setBillingInterval('year')}
                >
                  {monthsFree > 0 ? `Yearly · ${monthsFree} months free` : 'Yearly'}
                </Button>
              </div>
            ) : null}
          </div>

          <div className={styles.plans}>
            {shownPlans.map((p) => {
              const current = p.id === summary.plan.id;
              const intent = planIntent(summary.plan, p, {
                cancelled: cancellationPending,
                hasSubscription: summary.hasSubscription,
              });
              const thisBusy = busy === p.id;
              return (
                <article
                  key={p.id}
                  className={`${styles.plan} ${current ? styles.planCurrent : ''} ${p.highlighted ? styles.planHighlighted : ''}`}
                  aria-current={current ? 'true' : undefined}
                >
                  <div className={styles.planBadges}>
                    {p.highlighted ? <span className={styles.popularTag}>Recommended</span> : <span />}
                    {current ? <span className={styles.currentTag}>Current Plan</span> : null}
                  </div>
                  <div className={styles.planHead}>
                    <h4 className={styles.planName}>{p.name}</h4>
                    <p className={styles.priceBlock}>
                      <span className={styles.priceAmount}>{p.priceLabel}</span>
                      <span className={styles.priceInterval}>
                        {p.priceCents > 0 ? `/${p.interval === 'year' ? 'year' : 'month'}` : ' · no card'}
                      </span>
                    </p>
                    {p.interval === 'year' && p.yearlyPriceCents ? (
                      <p className={styles.priceSub}>
                        {dollars(Math.round(p.yearlyPriceCents / 12))}/month, billed yearly
                      </p>
                    ) : null}
                  </div>

                  {p.description ? <p className={styles.planDescription}>{p.description}</p> : null}

                  <ul className={styles.features}>
                    {p.features.map((f) => (
                      <li key={f} className={styles.feature}>
                        <Icon name="check" size="sm" className={styles.featureTick} />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>

                  <div className={styles.planFoot}>
                    {intent.kind === 'current' ? (
                      <Button variant="secondary" size="sm" fullWidth disabled>
                        {intent.label}
                      </Button>
                    ) : intent.kind === 'unavailable' ? (
                      <p className={styles.intro}>{intent.label}</p>
                    ) : (
                      <Button
                        variant={intent.kind === 'cancel' ? 'ghost' : 'primary'}
                        size="sm"
                        fullWidth
                        disabled={busy !== null}
                        onClick={() => void choosePlan(p)}
                      >
                        {thisBusy ? 'Working…' : intent.label}
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          {/* 4. Comparison Matrix */}
          {plans.length > 1 ? (
            <div className={styles.comparisonWrap}>
              <table className={styles.comparison}>
                <caption>Compare plans</caption>
                <thead>
                  <tr>
                    <th scope="col">Feature</th>
                    {plans.map((plan) => (
                      <th scope="col" key={plan.id}>
                        {plan.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows
                    ? rows.map((row) => (
                        <tr key={row.label}>
                          <th scope="row">{row.label}</th>
                          {row.cells.map((cell, i) => (
                            <td
                              key={plans[i]?.id ?? i}
                              aria-label={cell === true ? 'Included' : cell === false ? 'Not included' : undefined}
                            >
                              {cell === true ? (
                                <Icon name="check" size="sm" className={styles.featureTick} />
                              ) : cell === false ? (
                                <span aria-hidden="true">—</span>
                              ) : (
                                cell
                              )}
                            </td>
                          ))}
                        </tr>
                      ))
                    : [...new Set(plans.flatMap((plan) => plan.features))].map((feature) => (
                        <tr key={feature}>
                          <th scope="row">{feature}</th>
                          {plans.map((plan) => (
                            <td key={plan.id} aria-label={plan.features.includes(feature) ? 'Included' : 'Not included'}>
                              {plan.features.includes(feature) ? (
                                <Icon name="check" size="sm" className={styles.featureTick} />
                              ) : (
                                <span aria-hidden="true">—</span>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {/* 5. Secondary Management & Security Actions */}
          <div className={styles.footerManagement}>
            <div className={styles.actions}>
              {summary.hasSubscription && (
                <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void portal()}>
                  {busy === 'portal' ? 'Opening portal…' : 'Manage payment method'}
                </Button>
              )}
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void resync()}>
                {busy === 'resync' ? 'Checking…' : 'Already paid? Refresh status'}
              </Button>
            </div>
            <div className={styles.securityNote}>
              <Icon name="lock" size="sm" />
              <span>Payments processed securely by Lemon Squeezy. Cancel anytime — your projects are never deleted.</span>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

export default BillingSection;

