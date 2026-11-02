/**
 * The one line of terms every Premation Cloud paywall shows under its button:
 * "7 days free, then $9/month. Cancel anytime." — or the price alone when the
 * server advertises no trial.
 *
 * From the plan catalog the entitlement store loads (cached for an hour by the
 * API layer), so the price and trial on a paywall are always the server's.
 * Null while unknown or when nothing is on sale: a paywall without terms says
 * less, never something wrong.
 */

import { useEffect } from 'react';
import { useEntitlementStore } from '@stores/entitlementStore';
import { t } from '@core/i18n/t';

export function cloudOfferLine(offer: { priceLabel: string; trialDays: number } | null): string | null {
  if (!offer) return null;
  return offer.trialDays > 0
    ? t('billing.offer.trial', '{days} days free, then {price}/month. Cancel anytime.', {
        days: offer.trialDays,
        price: offer.priceLabel,
      })
    : t('billing.offer.price', '{price}/month. Cancel anytime — your projects are never deleted.', {
        price: offer.priceLabel,
      });
}

/** Free-trial days on a new subscription; 0 = none advertised. */
export function useCloudTrialDays(): number {
  return useEntitlementStore((s) => s.offer?.trialDays ?? 0);
}

export function useCloudOffer(): string | null {
  const offer = useEntitlementStore((s) => s.offer);
  useEffect(() => {
    void useEntitlementStore.getState().refreshSales();
  }, []);
  return cloudOfferLine(offer);
}
