/**
 * The read-only bar.
 *
 * Shown across the top of the editor when this account may open and export its
 * work but not save it to the cloud — an unconfirmed email, a lapsed trial, an
 * ended subscription. It reads the entitlement decision from the store; it never
 * computes one, so it can only ever agree with the server's write guards.
 *
 * Two ways forward, and it offers both without preferring one, because they are
 * genuinely equal offers: subscribe and keep working in the cloud, or export the
 * project and run the free self-hosted build. The export button is the honest
 * half of that — see core/project/exportBundle — and it works offline with no
 * subscription, which is what stops "or self-host" from being a bluff.
 *
 * Renders nothing at all when the account can write, and nothing in the local
 * edition (where `access` is always null → allowed). Cheap to mount everywhere.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@components/Icon';
import { useEntitlementStore, canWriteCloud } from '@stores/entitlementStore';
import { exportCurrentProjectAsBundle } from '@core/project/exportBundle';
import styles from './ReadOnlyBanner.module.css';

/** Reasons where the CTA is "subscribe"; the rest just need a confirmed email. */
const PAYABLE = new Set(['trial_expired', 'lapsed', 'trial_not_started']);

export function ReadOnlyBanner(): JSX.Element | null {
  const access = useEntitlementStore((s) => s.access);
  const serverMessage = useEntitlementStore((s) => s.message);
  const navigate = useNavigate();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  if (canWriteCloud(access) || !access) return null;

  const canPay = PAYABLE.has(access.reason);
  const unverified = access.reason === 'unverified';

  // A sentence, in priority order: the server's if we have it (it knows the
  // dates), then a reason-specific fallback so the bar is never wordless during
  // the moment between a 403 and the refresh that fetches the real message.
  const message =
    serverMessage ||
    (unverified
      ? 'Confirm your email to start your trial. Your projects are read-only until then.'
      : canPay
        ? 'Your access has ended. Your projects are read-only — subscribe to keep working in the cloud, or export them and self-host.'
        : 'Your projects are read-only. Export them to keep working, or manage your plan.');

  const onExport = async (): Promise<void> => {
    setExporting(true);
    setExportError('');
    try {
      const res = await exportCurrentProjectAsBundle();
      // A cancelled save dialog is not a failure — say nothing.
      if (res.error) setExportError(res.error);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className={styles.bar} role="status">
      <Icon name="lock" size="sm" className={styles.icon} />
      <span className={styles.message}>{exportError || message}</span>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.export}
          disabled={exporting}
          onClick={() => void onExport()}
        >
          {exporting ? 'Exporting…' : 'Export .motion'}
        </button>
        {/*
          The plan and confirmation controls live in the dashboard's Settings
          tab, which takes a `?tab=settings` deep-link (see DashboardPage). The
          resend and subscribe buttons themselves are in BillingSection — this
          bar's job is to get the user there, not to duplicate them.
        */}
        <button
          type="button"
          className={styles.primary}
          onClick={() => navigate('/dashboard?tab=settings')}
        >
          {unverified ? 'Confirm email' : canPay ? 'Subscribe' : 'Manage plan'}
        </button>
      </div>
    </div>
  );
}

export default ReadOnlyBanner;
