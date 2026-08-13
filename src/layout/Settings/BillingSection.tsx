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

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { api, isAuthenticated, type BillingSummary, type PlanDto } from '@core/api/client';
import { billingEnabled } from '@core/config/edition';
import styles from './BillingSection.module.css';

/** Reasons the account cannot write, in the order the UI cares about them. */
const BLOCKED_REASONS = new Set(['unverified', 'trial_expired', 'lapsed', 'trial_not_started']);

export function BillingSection(): JSX.Element | null {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [plans, setPlans] = useState<PlanDto[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<'checkout' | 'portal' | 'resync' | 'resend' | null>(null);

  const load = useCallback(async () => {
    if (!billingEnabled()) return;
    if (!isAuthenticated()) return;
    try {
      const [me, catalog] = await Promise.all([api.getBilling(), api.listPlans()]);
      setSummary(me);
      setPlans(catalog);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your plan.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  /** Server-authored `{ code, message }` if there is one, else the raw error. */
  const readError = (err: unknown): string => {
    const body = (err as { body?: { message?: string | { message?: string } } }).body;
    const msg = typeof body?.message === 'object' ? body.message.message : body?.message;
    return msg || (err instanceof Error ? err.message : 'Something went wrong.');
  };

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>): Promise<void> => {
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

  const upgrade = (): Promise<void> =>
    run('checkout', async () => {
      const { url } = await api.startCheckout('pro');
      window.location.href = url;
    });

  const portal = (): Promise<void> =>
    run('portal', async () => {
      const { url } = await api.openBillingPortal();
      window.location.href = url;
    });

  const resync = (): Promise<void> =>
    run('resync', async () => {
      const { resynced } = await api.resyncBilling();
      await load();
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

  return (
    <div className={styles.section}>
      {/*
        The status line, straight from the server.
        A previous version of this panel stated flatly that "there are no platform
        AI credits to manage" while the backend granted 25 on signup and metered
        every run against them — two halves of one product telling the user
        opposite things. The fix then was to read the real status; the fix now is
        that there is only one place the status is written at all.
      */}
      {summary ? (
        <p className={blocked ? styles.statusBlocked : styles.intro}>{summary.statusMessage}</p>
      ) : (
        <p className={styles.intro}>Loading your plan…</p>
      )}

      {/*
        Confirmation is the one thing the user can act on immediately, so it goes
        above the plan cards rather than below them. Verification gates writes on
        its own — before any plan does — so a paid account that skipped it would
        otherwise see "Pro" and still be unable to save, with no explanation in
        reach.
      */}
      {summary && !summary.emailVerified && !isBeta && (
        <div className={styles.callout}>
          {/* No `mail` glyph in the set; `info` is the closest honest one. */}
          <Icon name="info" size="sm" className={styles.calloutIcon} />
          <div className={styles.calloutBody}>
            <strong>Confirm your email to start your {summary.trialDays}-day trial.</strong>
            <span>
              Your projects are read-only until then — you can open and export them, but not save.
            </span>
          </div>
          <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void resend()}>
            {busy === 'resend' ? 'Sending…' : 'Resend email'}
          </Button>
        </div>
      )}

      {error ? <p className={styles.error}>{error}</p> : null}
      {notice ? <p className={styles.notice}>{notice}</p> : null}

      {summary ? (
        <>
          <div className={styles.usageRow}>
            <span>Member since {new Date(summary.memberSince).toLocaleDateString()}</span>
            {access?.writeEndsAt ? (
              <span>
                {access.write ? 'Full access until' : 'Ended'}{' '}
                {new Date(access.writeEndsAt).toLocaleDateString()}
              </span>
            ) : null}
          </div>

          <div className={styles.plans}>
            {plans.map((p) => {
              const current = p.id === summary.plan.id;
              return (
                <div key={p.id} className={`${styles.plan} ${current ? styles.planCurrent : ''}`}>
                  <div className={styles.planHead}>
                    <span className={styles.planName}>{p.name}</span>
                    <span className={styles.planPrice}>
                      {p.priceLabel}
                      {p.priceCents > 0 ? ' / month' : ''}
                    </span>
                    {current ? <span className={styles.currentTag}>Current</span> : null}
                  </div>

                  <ul className={styles.features}>
                    {p.features.map((f) => (
                      <li key={f} className={styles.feature}>
                        <Icon name="check" size="sm" className={styles.featureTick} />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>

                  <div className={styles.planFoot}>
                    {current && p.id === 'pro' ? (
                      <Button variant="secondary" size="sm" disabled>
                        Your plan
                      </Button>
                    ) : p.id === 'pro' ? (
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy !== null || !summary.paymentsEnabled}
                        onClick={() => void upgrade()}
                      >
                        {!summary.paymentsEnabled
                          ? 'Coming soon'
                          : busy === 'checkout'
                            ? 'Opening…'
                            : `Subscribe — ${p.priceLabel}/mo`}
                      </Button>
                    ) : current ? (
                      <Button variant="secondary" size="sm" disabled>
                        Your plan
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          <div className={styles.actions}>
            {/*
              Only shown when there is actually a subscription behind it. A
              "Manage subscription" button that answers `no_subscription` is worse
              than no button, and the server would refuse it anyway.
            */}
            {summary.hasSubscription && (
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void portal()}>
                {busy === 'portal' ? 'Opening…' : 'Manage subscription'}
              </Button>
            )}
            {/*
              The self-service repair for a webhook that never arrived. Someone who
              has paid and still sees "Trial" can fix it here instead of waiting on
              support, and it is safe to press repeatedly — applying a subscription
              snapshot is idempotent, and it can only ever make this account agree
              with the payment provider.
            */}
            {summary.hasSubscription && (
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void resync()}>
                {busy === 'resync' ? 'Checking…' : 'Already paid? Refresh'}
              </Button>
            )}
          </div>

          {!summary.paymentsEnabled ? (
            <p className={styles.note}>
              Paid plans aren't open yet. The self-hosted build is free and unlimited in the
              meantime — same editor, your own machine, your own API key.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export default BillingSection;
