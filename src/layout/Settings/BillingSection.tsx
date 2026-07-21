/**
 * Plan & credits.
 *
 * Everything here is server state: the plan catalog, the balance, and whether
 * checkout is even open. Nothing is decided client-side — this replaces a
 * hardcoded "Active Node: AE-9 Enterprise" badge, an
 * `alert('Subscription management portal opening...')` and an
 * `alert('Upgrade to Motion Studio Pro modal')`.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { api, isAuthenticated, type BillingSummary, type PlanDto } from '@core/api/client';
import styles from './BillingSection.module.css';

/** Warn while there's still time to do something about it. */
const LOW_CREDIT_FRACTION = 0.2;

export function BillingSection(): JSX.Element {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [plans, setPlans] = useState<PlanDto[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!isAuthenticated()) return;
    try {
      const [me, catalog] = await Promise.all([api.getBilling(), api.listPlans()]);
      setSummary(me);
      setPlans(catalog);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your plan.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!isAuthenticated()) {
    return (
      <div className={styles.section}>
        <p className={styles.intro}>Sign in to see your plan and credits.</p>
      </div>
    );
  }

  const upgrade = async (plan: 'pro'): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const { url } = await api.startCheckout(plan);
      window.location.href = url;
    } catch (err) {
      // The server says `coming_soon` until a payment provider is configured.
      const body = (err as { body?: { message?: string | { message?: string } } }).body;
      const msg = typeof body?.message === 'object' ? body.message.message : body?.message;
      setError(msg || (err instanceof Error ? err.message : 'Could not start checkout.'));
    } finally {
      setBusy(false);
    }
  };

  const allowance = summary?.plan.monthlyCredits ?? 0;
  const credits = summary?.credits ?? 0;
  const pct = allowance > 0 ? Math.min(100, (credits / allowance) * 100) : 0;
  const low = allowance > 0 && credits / allowance <= LOW_CREDIT_FRACTION;

  return (
    <div className={styles.section}>
      <p className={styles.intro}>
        Credits are only spent by Motion AI, our own AI account. Using your own provider API key
        costs nothing here — you pay your provider directly.
      </p>

      {error ? <p className={styles.error}>{error}</p> : null}

      {summary ? (
        <>
          <div>
            <div className={styles.balance}>
              <span className={styles.balanceValue}>{credits}</span>
              <span className={styles.balanceLabel}>
                Motion AI credits left{allowance > 0 ? ` of ${allowance}` : ''}
              </span>
            </div>
            {allowance > 0 ? (
              <div className={styles.meterTrack} style={{ marginTop: 8 }}>
                <div
                  className={`${styles.meterFill} ${low ? styles.meterLow : ''}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            ) : null}
          </div>

          <div className={styles.usageRow}>
            <span>Used in the last 30 days: {summary.creditsUsedLast30Days}</span>
            <span>Used all time: {summary.creditsUsedAllTime}</span>
            <span>Member since {new Date(summary.memberSince).toLocaleDateString()}</span>
          </div>

          <div className={styles.plans}>
            {plans.map((p) => {
              const current = p.id === summary.plan.id;
              return (
                <div key={p.id} className={`${styles.plan} ${current ? styles.planCurrent : ''}`}>
                  <div className={styles.planHead}>
                    <span className={styles.planName}>{p.name}</span>
                    <span className={styles.planPrice}>
                      {p.priceLabel}{p.priceCents > 0 ? ' / month' : ''}
                    </span>
                    {current ? <span className={styles.currentTag}>Current</span> : null}
                  </div>

                  <ul className={styles.features}>
                    {p.features.map((f) => (
                      <li key={f} className={styles.feature}>
                        <Icon name="check" size={11} className={styles.featureTick} />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>

                  <div className={styles.planFoot}>
                    {current ? (
                      <Button variant="secondary" size="sm" disabled>Your plan</Button>
                    ) : p.id === 'pro' ? (
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy || !summary.paymentsEnabled}
                        onClick={() => void upgrade('pro')}
                      >
                        {summary.paymentsEnabled ? `Upgrade — ${p.priceLabel}/mo` : 'Coming soon'}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          {!summary.paymentsEnabled ? (
            <p className={styles.note}>
              Paid plans aren't open yet. Until then the assistant is unlimited with your own
              provider API key — set one up under Assistant above.
            </p>
          ) : null}
        </>
      ) : (
        <p className={styles.intro}>Loading your plan…</p>
      )}
    </div>
  );
}

export default BillingSection;
