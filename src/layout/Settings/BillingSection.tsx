/**
 * Plan, trial, and email confirmation.
 *
 * Everything here is server state. The panel renders what `/billing/me` says and
 * decides nothing: not whether the trial is over, not whether the account may
 * write, not what sentence to show. That is deliberate — a client that computed
 * "am I inside my trial?" from a date would be a second implementation of the
 * paywall, and the two would disagree the first time either was edited.
 *
 * This replaces a version built around AI credits, which no longer exist: the
 * assistant is bring-your-own-key in both editions, so there is nothing metered
 * to display. What matters to a user now is whether they can save, and until when.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { customConfirm } from '@components/Modal';
import { api, isAuthenticated, type BillingSummary, type PlanDto } from '@core/api/client';
import { billingEnabled } from '@core/config/edition';
import { useEntitlementStore } from '@stores/entitlementStore';
import { confirmPlanChange, planIntent } from './planIntent';
import styles from './BillingSection.module.css';

/** Reasons the account cannot write, in the order the UI cares about them. */
const BLOCKED_REASONS = new Set(['unverified', 'trial_expired', 'lapsed', 'trial_not_started']);

export function checkoutReturnState(params: URLSearchParams): 'success' | 'cancelled' | null {
  const value = params.get('checkout') ?? params.get('payment') ?? params.get('billing');
  if (value === 'success' || value === 'completed' || value === 'paid') return 'success';
  if (value === 'cancel' || value === 'cancelled' || value === 'canceled') return 'cancelled';
  return null;
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
    result: { action?: string; url?: string; planId?: string },
  ): Promise<void> => {
    if (result.url) {
      window.location.href = result.url;
      return;
    }
    await load(true);
    await useEntitlementStore.getState().refresh({ force: true });
    const messages: Record<string, string> = {
      upgraded: 'Plan upgraded. The new allowance applies on the next API request.',
      downgraded: 'Plan switched. The new rate applies on the next invoice.',
      cancelled: 'Cancellation scheduled. You keep paid access until the date shown above.',
      resumed: 'Cancellation stopped. Billing continues on this plan.',
      unchanged: 'You are already on this plan.',
    };
    setNotice(messages[result.action ?? ''] ?? 'Your plan is up to date.');
  };

  const choosePlan = (plan: PlanDto): Promise<void> => {
    if (!summary) return Promise.resolve();
    const intent = planIntent(summary.plan, plan, {
      cancelled: Boolean(summary.subscriptionCancelled),
      hasSubscription: summary.hasSubscription,
    });
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
      if (intent.kind === 'cancel') {
        await applyChange(await api.cancelSubscription());
        return;
      }
      await applyChange(await api.startCheckout(plan.id));
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
  const cancellationPending = Boolean(summary?.subscriptionCancelled);

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
                <h3 className={styles.currentPlanName}>{summary.plan.name} Plan</h3>
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
                      : access?.reason === 'trial'
                        ? `Trial (${access.daysRemaining ?? 0}d left)`
                        : isBeta
                          ? 'Beta Access'
                          : 'Active Subscription'}
                </span>
              </div>
              <p className={blocked ? styles.statusBlocked : styles.intro}>
                {summary.statusMessage}
              </p>
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
            <strong>
              Confirm your email to start your{' '}
              {summary.trialLabel ?? `${summary.trialDays}-day`} trial.
            </strong>
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

      {summary ? (
        <>
          {/* 3. Tiered Plan Cards */}
          <div className={styles.plansSectionHeader}>
            <h3 className={styles.sectionTitle}>Available Subscription Plans</h3>
            <p className={styles.sectionDesc}>
              Choose the plan that fits your production workflow. Upgrade or downgrade anytime.
            </p>
          </div>

          <div className={styles.plans}>
            {plans.map((p) => {
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
                  </div>

                  {p.description ? <p className={styles.planDescription}>{p.description}</p> : null}

                  <ul className={styles.features}>
                    {p.features.map((f) => (
                      <li key={f} className={styles.feature}>
                        <Icon name="check" size="sm" className={styles.featureTick} />
                        <span>{f}</span>
                      </li>
                    ))}
                    <li className={styles.feature}>
                      <Icon
                        name={p.apiEnabled ? 'check' : 'close'}
                        size="sm"
                        className={p.apiEnabled ? styles.featureTick : styles.featureCross}
                      />
                      <span>{p.apiEnabled ? 'Automation API & Webhooks' : 'No Automation API'}</span>
                    </li>
                  </ul>

                  <div className={styles.planFoot}>
                    {intent.kind === 'current' ? (
                      <Button variant="secondary" size="sm" fullWidth disabled>
                        {intent.label}
                      </Button>
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
                  {[...new Set(plans.flatMap((plan) => plan.features))].map((feature) => (
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
                  <tr>
                    <th scope="row">Automation API</th>
                    {plans.map((plan) => (
                      <td key={plan.id}>{plan.apiEnabled ? 'Included' : '—'}</td>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row">Render minutes / month</th>
                    {plans.map((plan) => (
                      <td key={plan.id}>
                        {plan.monthlyRenderMinutes
                          ? plan.monthlyRenderMinutes.toLocaleString()
                          : plan.apiEnabled
                            ? 'Unlimited'
                            : '—'}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row">API requests / month</th>
                    {plans.map((plan) => (
                      <td key={plan.id}>
                        {plan.monthlyApiRequests
                          ? plan.monthlyApiRequests.toLocaleString()
                          : plan.apiEnabled
                            ? 'Unlimited'
                            : '—'}
                      </td>
                    ))}
                  </tr>
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
              <span>Payments processed securely with Stripe / Lemon Squeezy. Cancel or change plans anytime.</span>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

export default BillingSection;

